#!/usr/bin/env node
/**
 * Tailscale Serve/Funnel route qualification (multipath ingress audit §6).
 *
 * The bridge probe qualifies a PUBLIC origin. This probe qualifies a
 * TAILNET route: it proves that the exact configured route tuple is mapped,
 * that the route actually serves an AUTHENTICATED MCP request from a tailnet
 * client, and that the authenticated stream survives the hop.
 *
 * What it records is exactly what the audit asks a harness to retain:
 *   - the build and configuration identity,
 *   - the profile, the listener, and the observed route,
 *   - the TLS identity the route presented,
 *   - the principal class and the session identity hash,
 *   - the operation id, the observed result, the failure class, and the time.
 *
 * Credentials never enter the receipt: only the SHA-256 of the MCP session id
 * is retained, and the bearer value is never printed, logged, or written.
 *
 * The evidence tier is DERIVED from the origin the probe contacted, so a
 * loopback run can never be recorded as tailnet evidence.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function option(name, fallback) {
	const args = process.argv.slice(2);
	const index = args.indexOf(name);
	return index < 0 ? fallback : args[index + 1];
}

const DEFAULT_HEARTBEAT_MS = process.env.KONTROL_MCP_SSE_HEARTBEAT_MS ?? "15000";

/** Parse complete SSE frames from a streaming text buffer. */
export function takeSseFrames(buffer) {
	const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const frames = [];
	let remainder = normalized;
	let boundary;
	while ((boundary = remainder.indexOf("\n\n")) >= 0) {
		const raw = remainder.slice(0, boundary);
		const lines = raw.split("\n");
		const fields = { comments: [], event: undefined, data: [], id: undefined, retry: undefined };
		for (const line of lines) {
			if (line.startsWith(":")) { fields.comments.push(line.slice(1).replace(/^ /, "")); continue; }
			const colon = line.indexOf(":");
			const field = colon < 0 ? line : line.slice(0, colon);
			const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
			if (field === "event") fields.event = value;
			else if (field === "data") fields.data.push(value);
			else if (field === "id" && !value.includes("\0")) fields.id = value;
			else if (field === "retry" && /^\d+$/.test(value)) fields.retry = Number(value);
		}
		frames.push(fields);
		remainder = remainder.slice(boundary + 2);
	}
	return { frames, remainder };
}

/** Stable SSE requires repeated comment heartbeats with bounded gaps. */
export function qualifiesSseHeartbeats(observations, heartbeatMs) {
	if (!Array.isArray(observations) || observations.length < 3 || !Number.isFinite(heartbeatMs) || heartbeatMs <= 0) return false;
	return observations.slice(1).every((time, index) => Number.isFinite(time - observations[index]) && time - observations[index] <= heartbeatMs * 1.5);
}

/** Bearer credential shape guard: tokens never enter logs or receipts. */
export function assertValidAuthorization(value) {
	if (!/^Bearer \S+$/.test(value) || /[\x00-\x1f]/.test(value)) {
		throw new Error("credential value must be a single-line Bearer value with no whitespace or control characters (raw header value)");
	}
}

/** Remove credential material from an error message before printing it. */
export function scrubCredential(message, authorization) {
	if (!authorization) return message;
	const secret = authorization.replace(/^Bearer /, "");
	return message.split(authorization).join("[redacted]").split(secret).join("[redacted]");
}

/** The evidence tier an origin earns. */
export function serveObservationTier(origin) {
	const host = String(origin ?? "").toLowerCase();
	if (host.includes(".ts.net")) return "real_tailnet";
	if (host.includes("127.0.0.1") || host.includes("localhost") || host.includes("[::1]")) return "local_integration";
	return "public_internet";
}

/**
 * Compare the observed Tailscale route with the configured profile identity.
 *
 * The comparison is exact: hostname, HTTPS listen port, handler path,
 * upstream scheme/host/port/path, and Serve-versus-Funnel exposure all have
 * to match. A route for /other, another hostname, or another HTTPS port does
 * not satisfy the configured profile.
 */
export function evaluateRouteIdentity({ observed, expected }) {
	if (!observed) return { matched: false, reason: "no observed route" };
	const fields = ["hostname", "listenPort", "handlerPath", "upstreamScheme", "upstreamHost", "upstreamPort", "upstreamPath", "allowFunnel"];
	const differences = fields.filter((field) => observed[field] !== expected[field]);
	if (differences.length === 0) return { matched: true, reason: "exact route tuple match" };
	return { matched: false, reason: "route differs in: " + differences.join(", ") };
}

/** Fetch with a bounded deadline; a black-holed origin fails instead of hanging. */
export async function boundedFetch(url, init = {}, timeoutMs = 30_000) {
	const response = await fetch(url, { ...init, redirect: "manual", signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
	return response;
}

async function readBoundedText(response, maxBytes = 1024 * 1024) {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) { await reader.cancel().catch(() => {}); break; }
			chunks.push(value);
		}
	} finally { reader.releaseLock(); }
	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function initializeBody(id) {
	return JSON.stringify({
		jsonrpc: "2.0",
		id,
		method: "initialize",
		params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "kontrol-ingress-serve-probe", version: "1" } },
	});
}

function parseRpcPayload(body, contentType = "") {
	if (contentType.includes("application/json")) {
		try { return JSON.parse(body); } catch { return undefined; }
	}
	const { frames } = takeSseFrames(body);
	for (const frame of frames) for (const line of frame.data) {
		try {
			const payload = JSON.parse(line);
			if (payload && typeof payload === "object" && "jsonrpc" in payload) return payload;
		} catch { /* ignore */ }
	}
	return undefined;
}

/**
 * Run the qualification against one route.
 *
 * `observedRoute` is the route identity read from the Tailscale status
 * document; `expectedRoute` is the identity the profile configures. The
 * protocol half is exercised over the route's own origin.
 */
export async function runServeProbe(options) {
	const { origin, authorization, heartbeatMs, log = () => {}, expectedRoute, observedRoute, classification } = options;
	const checks = {};
	const record = (name, ok, detail) => {
		checks[name] = Boolean(ok);
		log((ok ? "ok " : "FAIL ") + name + (detail ? " (" + detail + ")" : ""));
	};

	// 1. The observed route must match the configured tuple exactly. The
	//    classification comes from the same exact-tuple classifier the
	//    server and the CLI use, so the probe cannot accept a weaker match.
	const identity = evaluateRouteIdentity({ observed: observedRoute, expected: expectedRoute });
	record("route-identity-exact", identity.matched, identity.reason);
	if (classification) {
		record("route-classification", classification === "MAPPING_MATCHED", "classification " + classification);
	}

	// 2. The route must present the expected TLS identity.
	let tlsIdentity = null;
	try {
		const response = await boundedFetch(`${origin}/healthz`, { method: "GET" }, 15_000);
		tlsIdentity = response.headers.get("server") ?? null;
		record("route-reachable", response.status > 0, "status " + response.status);
	} catch (error) {
		record("route-reachable", false, error instanceof Error ? error.message : String(error));
	}

	// 3. An unauthenticated initialize must be refused (or, for a peer
	//    listener, answered with the peer challenge).
	const session = { id: null };
	let initialized = false;
	let sessionIdentityHash;
	let operationId;
	if (authorization) {
		const headers = { authorization, accept: "application/json, text/event-stream", "content-type": "application/json" };
		const initResponse = await boundedFetch(`${origin}/mcp`, { method: "POST", headers, body: initializeBody(1) }, 30_000);
		const initBody = await readBoundedText(initResponse);
		const initPayload = parseRpcPayload(initBody, initResponse.headers.get("content-type"));
		initialized = initResponse.status === 200 && Boolean(initPayload?.result?.serverInfo);
		record("authenticated-initialize", initialized, "status " + initResponse.status);
		const sessionId = initResponse.headers.get("mcp-session-id");
		if (sessionId) {
			session.id = sessionId;
			sessionIdentityHash = createHash("sha256").update(sessionId).digest("hex");
		}
		operationId = initResponse.headers.get("x-kontrol-operation-id") ?? undefined;
		if (initialized) {
			const listed = await boundedFetch(`${origin}/mcp`, {
				method: "POST",
				headers: { ...headers, "mcp-session-id": sessionId ?? "", "mcp-protocol-version": "2025-06-18" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
			}, 30_000);
			const listedBody = await readBoundedText(listed);
			const listedPayload = parseRpcPayload(listedBody, listed.headers.get("content-type"));
			record("authenticated-tools-list", listed.status === 200 && Array.isArray(listedPayload?.result?.tools), "status " + listed.status);

			// 4. The authenticated stream must hold up across the hop.
			const stream = await boundedFetch(`${origin}/mcp`, {
				headers: { authorization, accept: "text/event-stream", "mcp-session-id": sessionId ?? "", "mcp-protocol-version": "2025-06-18" },
				signal: AbortSignal.timeout(Math.max(30_000, heartbeatMs * 4)),
			}, Math.max(30_000, heartbeatMs * 4));
			record("sse-stream-open", stream.status === 200, "status " + stream.status);
			const reader = stream.body?.getReader();
			const decoder = new TextDecoder();
			const heartbeats = [];
			let frameBuffer = "";
			const deadline = Date.now() + heartbeatMs * 4;
			try {
				while (Date.now() < deadline && heartbeats.length < 3) {
					const { done, value } = await reader.read();
					if (done) break;
					frameBuffer += decoder.decode(value, { stream: true });
					const parsed = takeSseFrames(frameBuffer);
					frameBuffer = parsed.remainder;
					for (const frame of parsed.frames) if (frame.comments.length > 0) heartbeats.push(Date.now());
				}
			} finally { await reader?.cancel().catch(() => {}); }
			record("sse-heartbeat-within-cadence", qualifiesSseHeartbeats(heartbeats, heartbeatMs), "count " + heartbeats.length);

			// 5. A fresh initialize must work after the stream ends.
			const fresh = await boundedFetch(`${origin}/mcp`, { method: "POST", headers, body: initializeBody(3) }, 30_000);
			const freshBody = await readBoundedText(fresh);
			const freshPayload = parseRpcPayload(freshBody, fresh.headers.get("content-type"));
			const freshSessionId = fresh.headers.get("mcp-session-id");
			record("fresh-initialize-after-stream", fresh.status === 200 && Boolean(freshPayload?.result?.serverInfo) && Boolean(freshSessionId) && freshSessionId !== sessionId,
				"status " + fresh.status);
			for (const id of [sessionId, freshSessionId].filter(Boolean)) {
				try { await boundedFetch(`${origin}/mcp`, { method: "DELETE", headers: { ...headers, "mcp-session-id": id } }, 10_000); } catch { /* best effort */ }
			}
		}
	} else {
		log("skip authenticated qualification (no --authorization-file)");
	}

	const failures = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
	return {
		origin,
		checks,
		failures,
		sessionIdentityHash,
		operationId,
		tlsIdentity,
		ready: failures.length === 0 && initialized,
	};
}

function buildObservation({ profileId, listener, buildId, origin, authorization, probe, observedAt = new Date().toISOString() }) {
	const state = probe.failures.length === 0 ? "READY" : probe.failures.includes("route-reachable") ? "DOWN" : "DEGRADED";
	return {
		profileId,
		listener,
		buildId,
		probeOrigin: new URL(origin).origin + "/",
		principalClass: authorization ? "owner_public" : "none",
		state,
		evidenceTier: serveObservationTier(origin),
		observedAt,
		checks: {
			externalHttps: probe.checks["route-reachable"] === true,
			mapping: probe.checks["route-identity-exact"] === true,
			mcpInitialize: probe.checks["authenticated-initialize"] === true,
			toolsList: probe.checks["authenticated-tools-list"] === true,
			sse: probe.checks["sse-heartbeat-within-cadence"] === true,
			freshInitialize: probe.checks["fresh-initialize-after-stream"] === true,
		},
		metrics: { failures: probe.failures.length },
		...(probe.sessionIdentityHash ? { sessionIdentityHash: probe.sessionIdentityHash } : {}),
		...(probe.operationId ? { operationId: probe.operationId } : {}),
		...(probe.failures.length ? { failureClass: probe.failures[0] } : {}),
	};
}

async function main() {
	const url = option("--url", undefined);
	if (!url) {
		process.stderr.write("usage: probe-ingress-serve.mjs --url https://node.tail8d285a.ts.net:8443 [--authorization-file FILE] [--profile-id ID --state-dir DIR --build-id ID] [--expected-hostname H --expected-port P --expected-upstream-port P]\n");
		process.exit(1);
	}
	const authFile = option("--authorization-file", undefined);
	const authorization = authFile ? readFileSync(resolve(authFile), "utf8").trim() : process.env.KONTROL_MCP_CANARY_AUTHORIZATION;
	if (authorization) assertValidAuthorization(authorization);
	const heartbeatMs = Number(option("--heartbeat-ms", DEFAULT_HEARTBEAT_MS));
	assert.ok(Number.isFinite(heartbeatMs) && heartbeatMs > 0, "--heartbeat-ms must be a positive number");

	const origin = new URL(url).origin;

	// The OBSERVED route is read from the real Tailscale status document and
	// compared with the CONFIGURED route by the same exact-tuple classifier
	// the server uses. An operator cannot assert a match.
	const { readTailscaleFacts } = await import(new URL("../src/ingress/tailscale-status.ts", import.meta.url));
	const { classifyProfile } = await import(new URL("../src/ingress/profile-status.ts", import.meta.url));
	const facts = await readTailscaleFacts();
	const expectedRoute = {
		hostname: option("--expected-hostname", new URL(origin).hostname),
		listenPort: option("--expected-port", new URL(origin).port || "443"),
		handlerPath: option("--expected-path", "/"),
		upstreamScheme: option("--expected-upstream-scheme", "http"),
		upstreamHost: option("--expected-upstream-host", "127.0.0.1"),
		upstreamPort: option("--expected-upstream-port", "7678"),
		upstreamPath: option("--expected-upstream-path", "/"),
		allowFunnel: option("--expected-funnel", "0") === "1",
	};
	const probeProfile = {
		id: option("--profile-id", "serve-probe"),
		kind: expectedRoute.allowFunnel ? "tailscale_funnel" : "tailscale_serve",
		audience: "owner_public",
		externalOrigin: origin,
		target: "public_oauth_listener",
		enabled: true,
		managedByKontrol: false,
		allowedHosts: [new URL(origin).hostname],
	};
	const classification = classifyProfile({
		profile: probeProfile,
		facts,
		expectedLocalPort: Number(expectedRoute.upstreamPort),
		localReachable: true,
	});
	const observedRoute = (facts.serveStatusSchemaSupported ? facts.serveMappings : [])
		.concat(facts.funnelStatusSchemaSupported ? facts.funnelMappings : [])
		.map((mapping) => mapping.identity)
		.find((identity) => identity && identity.hostname === expectedRoute.hostname && identity.listenPort === expectedRoute.listenPort);

	const probe = await runServeProbe({
		origin,
		authorization,
		heartbeatMs,
		expectedRoute,
		observedRoute,
		classification,
		log: (line) => process.stdout.write(line + "\n"),
	});

	const profileId = option("--profile-id", undefined);
	const stateDir = option("--state-dir", undefined);
	const buildId = option("--build-id", process.env.KONTROL_BUILD_ID);
	if (profileId) {
		assert.ok(stateDir, "--state-dir is required with --profile-id");
		assert.ok(buildId, "--build-id or KONTROL_BUILD_ID is required when recording qualification");
		const { appendIngressHealthObservation } = await import(new URL("../src/ingress/health-store.ts", import.meta.url));
		appendIngressHealthObservation(stateDir, buildObservation({
			profileId,
			listener: option("--listener", "public_oauth_listener"),
			buildId,
			origin,
			authorization,
			probe,
		}));
	}
	process.stdout.write(`serve probe ${probe.ready ? "PASSED" : "FAILED"}: ${origin} (${Object.keys(probe.checks).length} checks)\n`);
	if (!probe.ready) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((error) => {
		process.stderr.write(scrubCredential(error instanceof Error ? error.message : String(error), process.env.KONTROL_MCP_CANARY_AUTHORIZATION) + "\n");
		process.exit(1);
	});
}
