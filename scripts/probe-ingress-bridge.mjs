#!/usr/bin/env node
// Public HTTPS bridge qualification probe (PR-D, P1-09).
//
// Runs against the PUBLIC bridge origin (e.g. https://kontrol.example.com),
// never the upstream Serve listener directly. Asserts, end to end:
//   - /healthz liveness through the bridge;
//   - an unauthenticated /mcp initialize receives a 401 + WWW-Authenticate
//     challenge, and forged authority headers do NOT change that outcome;
//   - non-allowlisted paths return 404 at the bridge;
//   - OAuth discovery is reachable (RFC 9728 path-inserted URL, the one the
//     public MCP listener actually serves) and binds the canonical origin;
//   - an authenticated initialize + GET SSE stream (carrying the session id
//     the initialize returned) shows heartbeat bytes within the expected
//     cadence (default: the server's KONTROL_MCP_SSE_HEARTBEAT_MS, 15000).
//
// REDACTION: bearer tokens are never printed, never placed in URLs, and
// never logged. Redirects are followed ONLY within the original origin
// (redirect: manual + explicit same-origin check, bounded hop count) so a
// misconfigured bridge cannot exfiltrate credentials. Every request is
// deadline-bounded: a black-holed origin fails instead of hanging.
//
// LIMITATION (documented in deploy/bridge/README.md): a bridge that proxies
// EVERYTHING still passes these checks, because every probed path is also
// 404 at the upstream listener itself. Route isolation is proven by auditing
// the deployed Caddyfile against the audited example, not by this probe.
//
// This is a one-shot operator tool: no timers are left running, no state is
// persisted, and it never mutates the bridge or Kontrol.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
function option(name, fallback) {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : fallback;
}

/** The default stream cadence mirrors the server's heartbeat config. */
const DEFAULT_HEARTBEAT_MS = process.env.KONTROL_MCP_SSE_HEARTBEAT_MS ?? "15000";

/** Authority-bearing headers an attacker would forge at the edge. */
export const FORGED_AUTHORITY_HEADERS = Object.freeze({
	forwarded: "election=forge",
	"x-forwarded-for": "203.0.113.9",
	"x-forwarded-host": "evil.example.invalid",
	"x-kontrol-role": "reviewer",
	"tailscale-user-login": "attacker@example.invalid",
});

/** Max redirect hops inside the same origin before the fence refuses. */
const MAX_REDIRECT_HOPS = 5;
/** Per-request deadline: a black-holed origin must fail, never hang. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Parse complete SSE frames from a streaming text buffer. Incomplete trailing
 * frames remain buffered for the next network chunk. */
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

/** Stable SSE requires three actual comment heartbeats with bounded gaps. */
export function qualifiesSseHeartbeats(observations, heartbeatMs) {
	if (!Array.isArray(observations) || observations.length < 3 || !Number.isFinite(heartbeatMs) || heartbeatMs <= 0) return false;
	return observations.slice(1).every((time, index) => Number.isFinite(time - observations[index]) && time - observations[index] <= heartbeatMs * 1.5);
}

/** True when a URL string is same-origin with base (origin, not path). */
export function isSameOrigin(candidate, base) {
	try { return new URL(candidate).origin === new URL(base).origin; }
	catch { return false; }
}

/** Fetch with a hard same-origin redirect fence (bearer exfil guard). */
export async function fencedFetch(url, init, hops = 0) {
	if (hops > MAX_REDIRECT_HOPS) {
		throw new Error("redirect hop limit exceeded (possible redirect loop)");
	}
	// Honor a caller-provided signal (the stream phase sets a longer
	// deadline); only fall back to the default per-request deadline.
	const signal = init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const response = await fetch(url, {
		...init,
		redirect: "manual",
		signal,
	});
	if (response.status >= 301 && response.status <= 308) {
		const location = response.headers.get("location");
		if (!location) {
			throw new Error("redirect response without a location header");
		}
		// Resolve relative Locations; refuse anything leaving the origin.
		const target = new URL(location, url);
		if (target.origin !== new URL(url).origin) {
			throw new Error("redirect to another origin refused (bearer exfiltration guard)");
		}
		return fencedFetch(target.href, init, hops + 1);
	}
	return response;
}

/** The 401 challenge shape the public OAuth listener must produce. */
export function assertUnauthorizedChallenge(status, bodyText) {
	assert.equal(status, 401, "unauthenticated /mcp must receive 401, got " + status);
	assert.ok(!bodyText.includes('"result"'), "a 401 must never carry a JSON-RPC result body");
}

function initializeBody(id) {
	return JSON.stringify({
		jsonrpc: "2.0", id, method: "initialize",
		params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bridge-probe", version: "0.0.0" } },
	});
}
import { pathToFileURL } from "node:url";

/** Probe flow. log(line) prints one redacted line; returns check records. */
export async function runProbe(options) {
	const { baseUrl, authorization, heartbeatMs, log, onCheck = () => {}, onSessionId = () => {}, onOperationId = () => {}, onMetrics = () => {}, workspacePath, longPostMs } = options;
	const origin = new URL(baseUrl).origin;
	const results = [];
	const probeMetrics = { failures: 0 };
	const record = (name, ok, detail) => {
		const item = { name, ok: Boolean(ok), detail: detail ?? "" };
		results.push(item);
		if (!item.ok) probeMetrics.failures += 1;
		onCheck(item);
		if (!ok) throw new Error("probe failed at " + name + ": " + (detail ?? ""));
		log("ok " + name + (detail ? " (" + detail + ")" : ""));
	};

	// 1. Liveness through the bridge.
	{
		const healthStartedAt = Date.now();
		const res = await fencedFetch(origin + "/healthz");
		const body = await readBoundedText(res, 1024 * 1024);
		probeMetrics.latencyMs = Date.now() - healthStartedAt;
		record("healthz", res.status === 200 && body.includes('"ok"'), "status " + res.status);
	}

	// 2. Unauthenticated /mcp must be challenged with 401 + WWW-Authenticate;
	//    forged authority headers must not change that outcome.
	{
		const init = {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: initializeBody(1),
		};
		const plain = await fencedFetch(origin + "/mcp", init);
		const plainBody = await readBoundedText(plain, 1024 * 1024);
		assertUnauthorizedChallenge(plain.status, plainBody);
		assert.ok(plain.headers.has("www-authenticate"), "the 401 must carry a WWW-Authenticate challenge");
		record("unauthenticated-initialize-401", true, "www-authenticate: " + String(plain.headers.get("www-authenticate")));
		const poisoned = await fencedFetch(origin + "/mcp", { ...init, headers: { ...init.headers, ...FORGED_AUTHORITY_HEADERS } });
		const poisonedBody = await readBoundedText(poisoned, 1024 * 1024);
		assertUnauthorizedChallenge(poisoned.status, poisonedBody);
		record("forged-headers-still-401", true, "status " + poisoned.status);
	}

	// 3. Non-allowlisted path must 404 at the bridge.
	{
		const res = await fencedFetch(origin + "/diagnostics");
		record("non-allowlisted-404", res.status === 404, "status " + res.status);
	}

	// 4. OAuth discovery reachable and origin-consistent. The public MCP
	//    listener serves the RFC 9728 path-inserted metadata URL (the bare
	//    /.well-known/oauth-protected-resource is NOT mounted for a /mcp
	//    resource).
	{
		const res = await fencedFetch(origin + "/.well-known/oauth-protected-resource/mcp");
		const body = await readBoundedText(res, 1024 * 1024);
		let resource = null;
		try { resource = JSON.parse(body).resource ?? null; } catch { /* handled below */ }
		const ok = res.status === 200 && typeof resource === "string" && isSameOrigin(resource, origin);
		record("oauth-discovery", ok, ok ? resource : "status " + res.status + " resource " + String(resource));
	}

	// 5. Authenticated stream qualification (skipped without a token).
	//    authorization is the RAW header value (credential files store the
	//    full "Bearer ..." value, matching probe-mcp-tunnel.mjs convention).
	//    The GET carries the mcp-session-id the initialize returned: the
	//    listener rejects session-less non-initialize requests with 400.
	//    The bridge must keep the stream open and deliver heartbeat bytes
	//    within the expected cadence: a proxy with a short idle cutoff kills
	//    this stream before the first heartbeat.
	if (authorization) {
		const headers = { authorization, accept: "application/json, text/event-stream" };
		const initRes = await fencedFetch(origin + "/mcp", {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: initializeBody(2),
		});
		const initBody = await readBoundedText(initRes, 1024 * 1024);
		const initPayload = parseRpcPayload(initBody, initRes.headers.get("content-type"));
		record("authenticated-initialize", initRes.status === 200 && Boolean(initPayload?.result?.serverInfo), "status " + initRes.status);
		const sessionId = initRes.headers.get("mcp-session-id");
		assert.ok(sessionId, "the initialize response must carry an mcp-session-id header");
		onSessionId(createHash("sha256").update(sessionId).digest("hex"));
		const listed = await fencedFetch(origin + "/mcp", {
			method: "POST",
			headers: { ...headers, "content-type": "application/json", "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
		});
		const listedBody = await readBoundedText(listed, 1024 * 1024);
		const listedPayload = parseRpcPayload(listedBody, listed.headers.get("content-type"));
		record("authenticated-tools-list", listed.status === 200 && Array.isArray(listedPayload?.result?.tools), "status " + listed.status);
		if (workspacePath && longPostMs) {
			const opened = await fencedFetch(origin + "/mcp", {
				method: "POST",
				headers: { ...headers, "content-type": "application/json", "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "open_workspace", arguments: { path: workspacePath, mode: "checkout" } } }),
			});
			const openedBody = await readBoundedText(opened, 1024 * 1024);
			const openedPayload = parseRpcPayload(openedBody, opened.headers.get("content-type"));
			const workspaceId = openedPayload?.result?.structuredContent?.workspaceId ?? openedPayload?.result?.workspaceId;
			record("authenticated-workspace-context", opened.status === 200 && typeof workspaceId === "string", "status " + opened.status);
			const postStartedAt = Date.now();
			const post = await fencedFetch(origin + "/mcp", {
				method: "POST",
				headers: { ...headers, "content-type": "application/json", "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "await_workspace_events", arguments: { workspaceId, afterSeq: Number.MAX_SAFE_INTEGER, timeoutMs: longPostMs + heartbeatMs } } }),
				signal: AbortSignal.timeout(longPostMs + heartbeatMs + 15_000),
			});
			assert.equal(post.status, 200, "authenticated long-running POST must open");
			const postOperationId = post.headers.get("x-kontrol-operation-id");
			if (postOperationId) onOperationId(postOperationId);
			const reader = post.body?.getReader();
			assert.ok(reader, "long-running POST must have a response body");
			const decoder = new TextDecoder();
			const heartbeatAt = [];
			let frameBuffer = "";
			let responseSeen = false;
			let responseBytes = 0;
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					responseBytes += value.byteLength;
					if (responseBytes > 1024 * 1024) { await reader.cancel().catch(() => {}); throw new Error("long-running POST response exceeded the bounded response size"); }
					frameBuffer += decoder.decode(value, { stream: true });
					const parsed = takeSseFrames(frameBuffer);
					frameBuffer = parsed.remainder;
					for (const frame of parsed.frames) {
						if (frame.comments.length > 0) heartbeatAt.push(Date.now());
						for (const line of frame.data) { try { if (JSON.parse(line)?.id === 5) responseSeen = true; } catch { /* ignore */ } }
					}
				}
			} finally { reader.releaseLock(); }
			const durationMs = Date.now() - postStartedAt;
			const stableHeartbeats = qualifiesSseHeartbeats(heartbeatAt, heartbeatMs);
			probeMetrics.maxHeartbeatGapMs = Math.max(probeMetrics.maxHeartbeatGapMs ?? 0, ...heartbeatAt.slice(1).map((time, index) => time - heartbeatAt[index]), 0);
			probeMetrics.longPostDurationMs = durationMs;
			record("authenticated-long-post", responseSeen && stableHeartbeats && durationMs >= longPostMs * 0.9,
				`duration ${durationMs}ms; heartbeat-count ${heartbeatAt.length}; response ${responseSeen ? "complete" : "missing"}`);
		} else {
			log("skip authenticated long POST qualification (supply --workspace-path and --long-post-ms)");
		}
		// The stream phase may legitimately outlast REQUEST_TIMEOUT_MS when
		// the operator runs a long heartbeat: give it its own deadline.
		const stream = await fencedFetch(origin + "/mcp", {
			headers: { ...headers, "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" },
			signal: AbortSignal.timeout(Math.max(REQUEST_TIMEOUT_MS, heartbeatMs * 5)),
		});
		assert.equal(stream.status, 200, "GET /mcp SSE must open");
		const streamOperationId = stream.headers.get("x-kontrol-operation-id");
		if (streamOperationId) onOperationId(streamOperationId);
		const reader = stream.body.getReader();
		const decoder = new TextDecoder();
		const streamStartedAt = Date.now();
		const deadline = streamStartedAt + heartbeatMs * 4;
		let firstByteAt;
		let frameBuffer = "";
		const heartbeatAt = [];
		try {
			while (Date.now() < deadline) {
				const timeLeft = deadline - Date.now();
				if (timeLeft <= 0) break;
				let timer;
				const timeout = new Promise((resolve) => {
					timer = setTimeout(() => resolve({ timeout: true }), timeLeft);
				});
				const chunk = await Promise.race([reader.read(), timeout]);
				if (timer) clearTimeout(timer);
				if (!chunk || chunk.timeout) break;
				if (chunk.done) break;
				if (!chunk.value) continue;
				firstByteAt ??= Date.now();
				frameBuffer += decoder.decode(chunk.value, { stream: true });
				const parsed = takeSseFrames(frameBuffer);
				frameBuffer = parsed.remainder;
				for (const frame of parsed.frames) {
					if (frame.comments.length > 0) heartbeatAt.push(Date.now());
				}
				if (heartbeatAt.length >= 3) break;
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
		const gaps = heartbeatAt.slice(1).map((time, index) => time - heartbeatAt[index]);
		probeMetrics.maxHeartbeatGapMs = gaps.length ? Math.max(...gaps) : 0;
		probeMetrics.streamDurationMs = Date.now() - streamStartedAt;
		const streamDurationMs = Date.now() - streamStartedAt;
		const stable = qualifiesSseHeartbeats(heartbeatAt, heartbeatMs);
		record("sse-heartbeat-within-cadence", stable,
			`count ${heartbeatAt.length}; first-byte ${firstByteAt ? firstByteAt - streamStartedAt : "none"}ms; gaps ${gaps.join(",") || "none"}ms; duration ${streamDurationMs}ms; close ${heartbeatAt.length >= 3 ? "qualified" : "early-or-timeout"}`);
		// A closed streaming transport is recovered by a fresh MCP initialize.
		// The new transport must receive a distinct server session identity.
		const fresh = await fencedFetch(origin + "/mcp", {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: initializeBody(6),
		});
		const freshBody = await readBoundedText(fresh, 1024 * 1024);
		const freshPayload = parseRpcPayload(freshBody, fresh.headers.get("content-type"));
		const freshSessionId = fresh.headers.get("mcp-session-id");
		record("fresh-initialize-after-stream", fresh.status === 200 && Boolean(freshPayload?.result?.serverInfo) && Boolean(freshSessionId) && freshSessionId !== sessionId,
			`status ${fresh.status}; new-session ${Boolean(freshSessionId && freshSessionId !== sessionId)}`);
		// Resource hygiene: end the sessions we created (best-effort).
		for (const id of [sessionId, freshSessionId].filter(Boolean)) {
			try { await fencedFetch(origin + "/mcp", { method: "DELETE", headers: { ...headers, "mcp-session-id": id } }); }
			catch { /* best-effort */ }
		}
	} else {
		log("skip authenticated stream qualification (no --authorization-file / KONTROL_MCP_CANARY_AUTHORIZATION)");
	}

	onMetrics(probeMetrics);
	return { origin, checks: results };
}

/** Read bounded HTTP text so a broken edge cannot make the qualification process buffer an unbounded response. */
export async function readBoundedText(response, maxBytes) {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new Error("probe response exceeded the bounded response size");
			}
			chunks.push(value);
		}
	} finally { reader.releaseLock(); }
	const joined = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
	return new TextDecoder().decode(joined);
}

/** Accept ordinary JSON or JSON-RPC SSE data frames. */
export function parseRpcPayload(body, contentType = "") {
	if (contentType.includes("application/json")) {
		try { return JSON.parse(body); } catch { return undefined; }
	}
	const { frames } = takeSseFrames(body);
	for (const frame of frames) for (const line of frame.data) {
		try {
			const payload = JSON.parse(line);
			if (payload && typeof payload === "object" && "jsonrpc" in payload) return payload;
		} catch { /* ignore malformed or unrelated SSE data */ }
	}
	return undefined;
}

/**
 * The evidence tier a bridge observation earns.
 *
 * The tier is DERIVED from the origin the probe actually contacted: a
 * tailnet Serve route is real_tailnet evidence even when the probe file is
 * called "bridge", and a loopback target is local_integration evidence even
 * when the operator believed it was public. An operator cannot label a
 * local run as public-internet evidence.
 */
export function bridgeObservationTier(origin) {
  const host = String(origin ?? "").toLowerCase();
  if (host.includes(".ts.net")) return "real_tailnet";
  if (host.includes("127.0.0.1") || host.includes("localhost") || host.includes("[::1]")) return "local_integration";
  return "public_internet";
}

export function createBridgeHealthObservation({ profileId, buildId, origin, authorization, observedChecks, sessionIdentityHash, operationId, metrics = {}, failureClass, observedAt = new Date().toISOString() }) {
	const candidateChecks = {
		externalHttps: observedChecks.healthz,
		mapping: observedChecks["authenticated-initialize"],
		oauthChallenge: observedChecks["unauthenticated-initialize-401"] === true && observedChecks["oauth-discovery"] === true,
		mcpInitialize: observedChecks["authenticated-initialize"],
		toolsList: observedChecks["authenticated-tools-list"],
		sse: observedChecks["sse-heartbeat-within-cadence"],
		longPost: observedChecks["authenticated-long-post"],
		freshInitialize: observedChecks["fresh-initialize-after-stream"],
	};
	const checks = Object.fromEntries(Object.entries(candidateChecks).filter(([, value]) => value !== undefined));
	const passed = Object.values(observedChecks).every(Boolean);
	const required = ["externalHttps", "mapping", "oauthChallenge", "mcpInitialize", "toolsList", "sse", "longPost", "freshInitialize"];
	const complete = Boolean(authorization) && required.every((key) => checks[key] === true);
	const state = observedChecks.healthz === false ? "DOWN" : complete && passed ? "READY" : failureClass ? "DEGRADED" : "UNVERIFIED";
	return {
		profileId,
		listener: "public_oauth_listener",
		buildId,
		probeOrigin: new URL(origin).origin + "/",
		principalClass: authorization ? "owner_public" : "none",
		state,
		evidenceTier: bridgeObservationTier(origin),
		observedAt,
		checks,
		metrics: {
			...(Number.isFinite(metrics.latencyMs) ? { latencyMs: metrics.latencyMs } : {}),
			failures: Object.values(observedChecks).filter((value) => value === false).length,
			...(Number.isFinite(metrics.maxHeartbeatGapMs) ? { maxHeartbeatGapMs: metrics.maxHeartbeatGapMs } : {}),
		},
		...(sessionIdentityHash ? { sessionIdentityHash } : {}),
		...(operationId ? { operationId } : {}),
		...(failureClass ? { failureClass } : {}),
	};
}

/** Bearer credential shape guard: also keeps tokens out of undici error text. */
export function assertValidAuthorization(value) {
	if (!/^Bearer \S+$/.test(value) || /[\x00-\x1f]/.test(value)) {
		throw new Error("credential value must be a single-line Bearer value with no whitespace or control characters (raw header value)");
	}
}

/** Remove any credential material from an error message before printing. */
export function scrubCredential(message, authorization) {
	if (!authorization) return message;
	const secret = authorization.replace(/^Bearer /, "");
	return message.split(authorization).join("[redacted]").split(secret).join("[redacted]");
}

// The resolved credential, visible to the catch handler so the error
// message is scrubbed regardless of whether it came from a file or the
// environment (P2-3).
let activeCredential;

async function main() {
	const url = option("--url", undefined);
	if (!url) {
		process.stderr.write("usage: probe-ingress-bridge.mjs --url https://kontrol.example.com [--authorization-file FILE --workspace-path PATH] [--profile-id ID --state-dir DIR --build-id ID] [--heartbeat-ms MS] [--long-post-ms MS]\n");
		process.exit(1);
	}
	const authFile = option("--authorization-file", undefined);
	const authorization = authFile ? readFileSync(authFile, "utf8").trim() : process.env.KONTROL_MCP_CANARY_AUTHORIZATION;
	if (authorization) { assertValidAuthorization(authorization); activeCredential = authorization; }
	const heartbeatMs = Number(option("--heartbeat-ms", DEFAULT_HEARTBEAT_MS));
	assert.ok(Number.isFinite(heartbeatMs) && heartbeatMs > 0, "--heartbeat-ms must be a positive number");
	const profileId = option("--profile-id", undefined);
	const workspacePath = option("--workspace-path", undefined);
	const longPostMs = Number(option("--long-post-ms", "45000"));
	assert.ok(Number.isInteger(longPostMs) && longPostMs >= 1000 && longPostMs <= 100000, "--long-post-ms must be between 1000 and 100000");
	if (option("--long-post-ms", undefined) !== undefined) assert.ok(workspacePath, "--workspace-path is required with --long-post-ms");
	const stateDir = option("--state-dir", undefined);
	const buildId = option("--build-id", process.env.KONTROL_BUILD_ID);
	assert.ok(Boolean(profileId) === Boolean(stateDir), "--profile-id and --state-dir must be supplied together");
	if (profileId) assert.ok(buildId, "--build-id or KONTROL_BUILD_ID is required when recording qualification");
	const observedChecks = {};
	let sessionIdentityHash;
	let operationId;
	let metrics = {};
	let failureClass;
	let result;
	try {
		result = await runProbe({
			baseUrl: url,
			authorization,
			heartbeatMs,
			log: (line) => process.stdout.write(line + "\n"),
			onCheck: ({ name, ok }) => { observedChecks[name] = ok; },
			onSessionId: (hash) => { sessionIdentityHash = hash; },
			onOperationId: (id) => { operationId = id; },
			onMetrics: (value) => { metrics = value; },
			workspacePath,
			longPostMs: workspacePath ? longPostMs : undefined,
		});
	} catch (error) {
		failureClass = Object.keys(observedChecks).find((name) => observedChecks[name] === false) ?? "probe_error";
		throw error;
	} finally {
		if (profileId) {
			const { appendIngressHealthObservation } = await import(new URL("../dist/ingress/health-store.js", import.meta.url));
			const observation = createBridgeHealthObservation({ profileId, buildId, origin: url, authorization, observedChecks, sessionIdentityHash, operationId, metrics, failureClass });
			appendIngressHealthObservation(stateDir, observation);
		}
	}
	process.stdout.write("bridge probe passed: " + result.origin + " (" + result.checks.length + " checks)\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((error) => {
		process.stderr.write(scrubCredential(String(error && error.message ? error.message : error), activeCredential) + "\n");
		process.exit(1);
	});
}
