import assert from "node:assert/strict";
import {
	assertValidAuthorization,
	evaluateRouteIdentity,
	qualifiesSseHeartbeats,
	scrubCredential,
	serveObservationTier,
	takeSseFrames,
} from "./probe-ingress-serve.mjs";

// --- the route comparison is exact ---
{
	const expected = {
		hostname: "node.tail8d285a.ts.net",
		listenPort: "8443",
		handlerPath: "/",
		upstreamScheme: "http",
		upstreamHost: "127.0.0.1",
		upstreamPort: "7678",
		upstreamPath: "/",
		allowFunnel: false,
	};
	assert.equal(evaluateRouteIdentity({ observed: { ...expected }, expected }).matched, true);
	// Wrong hostname, port, path, upstream, and exposure each fail.
	assert.equal(evaluateRouteIdentity({ observed: { ...expected, hostname: "other.tail8d285a.ts.net" }, expected }).matched, false);
	assert.equal(evaluateRouteIdentity({ observed: { ...expected, listenPort: "443" }, expected }).matched, false);
	assert.equal(evaluateRouteIdentity({ observed: { ...expected, handlerPath: "/other" }, expected }).matched, false);
	assert.equal(evaluateRouteIdentity({ observed: { ...expected, upstreamPort: "7677" }, expected }).matched, false);
	assert.equal(evaluateRouteIdentity({ observed: { ...expected, upstreamScheme: "https" }, expected }).matched, false);
	assert.equal(evaluateRouteIdentity({ observed: { ...expected, upstreamPath: "/mcp" }, expected }).matched, false);
	assert.equal(evaluateRouteIdentity({ observed: { ...expected, allowFunnel: true }, expected }).matched, false);
	assert.equal(evaluateRouteIdentity({ observed: null, expected }).matched, false);
	assert.match(evaluateRouteIdentity({ observed: { ...expected, listenPort: "443" }, expected }).reason, /listenPort/);
}

// --- the evidence tier is derived from the contacted origin ---
{
	assert.equal(serveObservationTier("https://node.tail8d285a.ts.net:8443"), "real_tailnet");
	assert.equal(serveObservationTier("http://127.0.0.1:7678"), "local_integration");
	assert.equal(serveObservationTier("https://bridge.example.com"), "public_internet");
}

// --- the SSE reader distinguishes heartbeats from real events ---
{
	// A frame boundary ends the frame; an unterminated tail stays buffered.
	const first = takeSseFrames(": ping\r\n\ndata: partial");
	assert.equal(first.frames.length, 1);
	assert.deepEqual(first.frames[0].comments, ["ping"]);
	assert.deepEqual(first.frames[0].data, []);
	assert.equal(first.remainder, "data: partial");
	const second = takeSseFrames(first.remainder + "\r\n\r\n");
	assert.equal(second.frames.length, 1);
	assert.deepEqual(second.frames[0].data, ["partial"]);
	assert.equal(second.remainder, "");
	const third = takeSseFrames("event: message\nid: 7\nretry: 100\ndata: {\"a\":1}\n\n");
	assert.equal(third.frames[0].event, "message");
	assert.equal(third.frames[0].id, "7");
	assert.equal(third.frames[0].retry, 100);
	assert.deepEqual(third.frames[0].comments, []);
}

// --- one initial SSE event never qualifies a stable stream ---
{
	assert.equal(qualifiesSseHeartbeats([10], 100), false);
	assert.equal(qualifiesSseHeartbeats([10, 50], 100), false);
	assert.equal(qualifiesSseHeartbeats([10, 50, 90], 100), true);
	assert.equal(qualifiesSseHeartbeats([10, 50, 400], 100), false, "an unbounded heartbeat gap fails");
}

// --- credentials never leak into output ---
{
	assert.throws(() => assertValidAuthorization("not-a-bearer"), /single-line Bearer/);
	assert.throws(() => assertValidAuthorization("Bearer a b"), /single-line Bearer/);
	assert.throws(() => assertValidAuthorization("Bearer tok\n"), /single-line Bearer/);
	assert.doesNotThrow(() => assertValidAuthorization("Bearer abc123"));
	assert.equal(scrubCredential("failed with Bearer abc123", "Bearer abc123"), "failed with [redacted]");
	assert.equal(scrubCredential("failed with abc123", "Bearer abc123"), "failed with [redacted]");
}

console.log("probe-ingress-serve.test.mjs: serve probe assertions passed");
