/**
 * PR-D probe tests: drive scripts/probe-ingress-bridge.mjs runProbe() against a
 * local mock bridge that implements the Caddyfile.example contract (route
 * allowlist, 401 challenge, 404 catch-all, SSE heartbeat). Covers the
 * pure guards directly: same-origin fence, forged authority headers, and
 * the 401 shape.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { runProbe, fencedFetch, isSameOrigin, assertUnauthorizedChallenge, takeSseFrames, qualifiesSseHeartbeats, createBridgeHealthObservation, bridgeObservationTier, readBoundedText, FORGED_AUTHORITY_HEADERS } from "./probe-ingress-bridge.mjs";

const ALLOWED = new Set(["/mcp", "/healthz", "/.well-known/oauth-protected-resource/mcp", "/authorize", "/token", "/register", "/revoke"]);

/** Mock bridge implementing the same behavior the Caddyfile asset must produce. */
function startMockBridge() {
	const sessions = new Set();
	let nextSession = 0;
	const server = http.createServer((req, res) => {
		const path = (req.url ?? "/").split("?")[0];
		if (!ALLOWED.has(path)) {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		if (path === "/healthz") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, name: "kontrol-public-mcp" }));
			return;
		}
		if (path === "/.well-known/oauth-protected-resource/mcp") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ resource: "http://" + (req.headers.host ?? "unknown") }));
			return;
		}
		if (path === "/mcp") {
			// Bearer gate: no/invalid authorization = 401 challenge. A forged
			// authority header must never substitute for the bearer token.
			const auth = req.headers.authorization;
			if (auth !== "Bearer good-token") {
				res.writeHead(401, { "www-authenticate": "Bearer" });
				res.end(JSON.stringify({ error: { code: "invalid_token" } }));
				return;
			}
			const isInitialize = req.method === "POST" && (req.headers["mcp-session-id"] ?? "") === "";
			if (!isInitialize && !sessions.has(req.headers["mcp-session-id"])) { res.writeHead(400); res.end("No valid MCP session"); return; }
			if (req.method === "GET") {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(": mock-heartbeat\r\n\r\n");
				const timer = setInterval(() => res.write(": mock-heartbeat\r\n\r\n"), 100);
				res.on("close", () => clearInterval(timer));
				return;
			}
			if (req.method === "DELETE") { sessions.delete(req.headers["mcp-session-id"]); res.writeHead(200); res.end(); return; }
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				const rpc = JSON.parse(body);
				if (rpc.method === "tools/call" && rpc.params?.name === "await_workspace_events") {
					res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": req.headers["mcp-session-id"], "x-kontrol-operation-id": "mock-op-1" });
					const timer = setInterval(() => res.write(": heartbeat\r\n\r\n"), 50);
					setTimeout(() => { clearInterval(timer); res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { structuredContent: { events: [], nextSeq: Number.MAX_SAFE_INTEGER } } })}\r\n\r\n`); res.end(); }, rpc.params.arguments.timeoutMs);
					return;
				}
				const result = rpc.method === "initialize" ? { serverInfo: { name: "mock" } } : rpc.method === "tools/list" ? { tools: [] } : rpc.params?.name === "open_workspace" ? { structuredContent: { workspaceId: "mock-workspace" } } : {};
				const sessionId = isInitialize ? `mock-session-${++nextSession}` : req.headers["mcp-session-id"];
				if (isInitialize) sessions.add(sessionId);
				res.writeHead(200, { "content-type": "application/json", ...(isInitialize ? { "mcp-session-id": sessionId } : {}) });
				res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
			});
			return;
		}
		res.writeHead(404);
		res.end();
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const server = await startMockBridge();
const port = server.address().port;
const base = "http://127.0.0.1:" + port;

// --- pure guards ---
assert.equal(isSameOrigin("https://x.test/a", "https://x.test/b"), true);
assert.equal(isSameOrigin("https://x.test/a", "https://y.test/b"), false);
assert.equal(isSameOrigin("not a url", base), false);
await assert.rejects(() => readBoundedText(new Response("too much"), 2), /bounded response size/);
assert.equal(FORGED_AUTHORITY_HEADERS["x-kontrol-role"], "reviewer");
{
	const checks = {
		healthz: true,
		"unauthenticated-initialize-401": true,
		"oauth-discovery": true,
		"authenticated-initialize": true,
		"authenticated-tools-list": true,
		"sse-heartbeat-within-cadence": true,
		"authenticated-long-post": true,
		"fresh-initialize-after-stream": true,
	};
	const observation = createBridgeHealthObservation({
		profileId: "bridge-main", buildId: "build-1", origin: "https://bridge.example.test", authorization: "Bearer secret-must-not-persist",
		observedChecks: checks, sessionIdentityHash: "a".repeat(64), operationId: "op-1", metrics: { latencyMs: 18, maxHeartbeatGapMs: 15000 },
	});
	assert.equal(observation.state, "READY");
	assert.equal(observation.sessionIdentityHash, "a".repeat(64));
	assert.equal(JSON.stringify(observation).includes("secret-must-not-persist"), false);
	assert.equal(createBridgeHealthObservation({ profileId: "bridge-main", buildId: "build-1", origin: "https://bridge.example.test", authorization: "Bearer t", observedChecks: { healthz: true }, failureClass: "authenticated-initialize" }).state, "DEGRADED");
	assert.equal(createBridgeHealthObservation({ profileId: "bridge-main", buildId: "build-1", origin: "https://bridge.example.test", observedChecks: { healthz: true } }).state, "UNVERIFIED");
}

// The recorded evidence tier is DERIVED from the origin the probe contacted:
// a loopback run can never be recorded as public-internet evidence.
assert.equal(bridgeObservationTier("https://bridge.example.test"), "public_internet");
assert.equal(bridgeObservationTier("https://node.tail8d285a.ts.net:8443"), "real_tailnet");
assert.equal(bridgeObservationTier("http://127.0.0.1:7678"), "local_integration");
assert.equal(bridgeObservationTier("https://localhost:8443"), "local_integration");
assert.equal(
	createBridgeHealthObservation({ profileId: "p", buildId: "b", origin: "http://127.0.0.1:7678", observedChecks: { healthz: true } }).evidenceTier,
	"local_integration",
	"a loopback observation is local integration evidence",
);
assert.equal(
	createBridgeHealthObservation({ profileId: "p", buildId: "b", origin: "https://node.tail8d285a.ts.net:8443", observedChecks: { healthz: true } }).evidenceTier,
	"real_tailnet",
	"a tailnet observation is real tailnet evidence",
);

{
	const first = takeSseFrames(": ping\r\n\ndata: partial");
	assert.equal(first.frames.length, 1, "SSE comments parse as a complete heartbeat frame");
	assert.deepEqual(first.frames[0].comments, ["ping"]);
	assert.equal(first.remainder, "data: partial", "partial frames survive chunk boundaries");
	const second = takeSseFrames(first.remainder + "\r\n\r\n");
	assert.deepEqual(second.frames[0].data, ["partial"]);
	assert.equal(second.remainder, "");
}
assert.equal(qualifiesSseHeartbeats([10], 100), false, "one initial SSE event cannot qualify a stable stream");
assert.equal(qualifiesSseHeartbeats([10, 110, 210], 100), true, "three regularly spaced comment heartbeats qualify");
assert.equal(qualifiesSseHeartbeats([10, 110, 400], 100), false, "an excessive heartbeat gap fails qualification");

// --- 401 shape guard ---
assertUnauthorizedChallenge(401, '{error":1}');
assert.throws(() => assertUnauthorizedChallenge(200, '{result":1}'));
assert.throws(() => assertUnauthorizedChallenge(403, ""));

// --- same-origin fence refuses cross-origin redirect targets ---
assert.equal(isSameOrigin("https://evil.example.invalid/steal", base), false, "cross-origin redirect target must be refused by the fence");

// --- redirect fence: cross-origin 302 refused, same-origin 302 followed ---
{
	let hop = 0;
	const redirectServer = http.createServer((req, res) => {
		hop += 1;
		if (hop === 1) { res.writeHead(302, { location: "https://evil.example.invalid/steal" }); res.end(); return; }
		if (hop === 2) { res.writeHead(302, { location: "/healthz" }); res.end(); return; }
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	});
	await new Promise((resolve) => redirectServer.listen(0, "127.0.0.1", resolve));
	const redirectPort = redirectServer.address().port;
	const redirectBase = "http://127.0.0.1:" + redirectPort;
	// Hop 1 redirects to another origin: the fence must refuse.
	await assert.rejects(
		() => fencedFetch(redirectBase + "/somewhere"),
		(error) => error instanceof Error && error.message.includes("redirect to another origin refused"),
	);
	// Hop 2 is a relative same-origin Location: the fence must follow it to 200.
	const followed = await fencedFetch(redirectBase + "/somewhere");
	assert.equal(followed.status, 200, "relative same-origin redirect must be followed");
	redirectServer.close();
}

// --- full probe flow against the compliant mock bridge ---
{
	const logs = [];
	const { origin, checks } = await runProbe({
		baseUrl: base,
		authorization: "Bearer good-token",
		heartbeatMs: 100,
		log: (line) => logs.push(line),
	});
	assert.equal(origin, base);
	const names = checks.map((check) => check.name);
	for (const expected of ["healthz", "unauthenticated-initialize-401", "forged-headers-still-401", "non-allowlisted-404", "oauth-discovery", "authenticated-initialize", "authenticated-tools-list", "sse-heartbeat-within-cadence", "fresh-initialize-after-stream"]) {
		assert.ok(names.includes(expected), "missing check: " + expected);
	}
	assert.ok(checks.every((check) => check.ok), "all checks must pass against the compliant mock bridge");
	assert.ok(!logs.join('\n').includes("good-token"), "the bearer token must never appear in probe output");
	const longPost = await runProbe({ baseUrl: base, authorization: "Bearer good-token", heartbeatMs: 100, longPostMs: 1000, workspacePath: "/tmp", log: () => {} });
	assert.ok(longPost.checks.find((check) => check.name === "authenticated-long-post")?.ok, "long POST must span multiple heartbeats and receive its final MCP response");
}

// --- failing bridge: open /mcp without auth must FAIL the probe ---
const open = http.createServer((req, res) => {
	const path = (req.url ?? "/").split("?")[0];
	if (path === "/healthz") { res.writeHead(200); res.end(JSON.stringify({ ok: true })); return; }
	if (path === "/mcp") { res.writeHead(200); res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })); return; }
	res.writeHead(404); res.end();
});
await new Promise((resolve) => open.listen(0, "127.0.0.1", resolve));
const openPort = open.address().port;
await assert.rejects(
	() => runProbe({ baseUrl: "http://127.0.0.1:" + openPort, authorization: undefined, heartbeatMs: 100, log: () => {} }),
	(error) => error instanceof Error && error.message.includes("401"),
	"a bridge that serves /mcp unauthenticated must FAIL the probe",
);
open.close();
server.close();
console.log("bridge probe tests passed");
