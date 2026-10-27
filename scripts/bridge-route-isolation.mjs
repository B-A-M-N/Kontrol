#!/usr/bin/env node
/**
 * Bridge route-isolation qualification (audit P1-01).
 *
 * The live bridge probe can only prove "a forbidden path returns 404" if the
 * UPSTREAM also returns 404 for that path. A proxy that forwards EVERY path
 * therefore passes that check while forwarding arbitrary traffic to the
 * Kontrol listener. The audit requires the opposite: "Test route isolation
 * against a controlled upstream that deliberately responds on forbidden paths.
 * The proxy must still return its own 404."
 *
 * This harness does exactly that. It starts a CONTROLLED upstream that
 * answers 200 on EVERY path (including the forbidden ones), points a Caddy
 * instance at the real configuration under test, and asserts:
 *
 *   - an allowlisted route reaches the upstream;
 *   - a forbidden route returns the BRIDGE's own 404, never the upstream's
 *     success;
 *   - the upstream never sees a forged authority header (X-Kontrol-*,
 *     X-Forwarded-*, Tailscale-User-*, Forwarded);
 *   - Authorization, Mcp-Session-Id and Last-Event-ID survive the edge;
 *   - the upstream sees the PINNED Host, never the client's Host.
 *
 * Only the site address and the upstream target are rewritten for the test;
 * the route allowlist, the header rules, and the handle blocks are the exact
 * bytes of the configuration under test.
 *
 * The receipt is redacted: no credentials, no response bodies.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ALLOWED_PATHS = ["/mcp", "/.well-known/*", "/authorize", "/token", "/register", "/revoke", "/healthz"];
const FORBIDDEN_PROBE_PATHS = ["/diagnostics", "/", "/admin", "/peer/healthz", "/.well-known/openid-configuration"];
const FORWARDED_HEADERS = [
  "x-kontrol-role",
  "x-kontrol-workspace-session",
  "x-kontrol-worker-token",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "tailscale-user-login",
  "tailscale-user-name",
  "tailscale-user",
  "forwarded",
];
const PRESERVED_HEADERS = ["authorization", "mcp-session-id", "last-event-id", "accept", "content-type"];

export function option(name, fallback) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}

/**
 * Rewrite ONLY the site address and the upstream target of a Caddyfile.
 *
 * The route allowlist, the header rules, the handle blocks, and every other
 * directive are copied byte for byte, so the isolation behavior under test is
 * the behavior of the real configuration.
 */
export function renderIsolationConfig(configText, { siteAddress, upstreamUrl }) {
  const lines = configText.split(/\r?\n/);
  let replacedSite = false;
  let replacedUpstream = false;
  // A plain-HTTP controlled upstream cannot carry the upstream TLS timeout:
  // Caddy treats `tls_timeout` inside `transport http` as a request for
  // HTTP+TLS. That directive is dropped for the test ONLY; it governs
  // upstream TLS, not routing or header behavior, and the deployed
  // configuration keeps it byte for byte.
  const plainHttpUpstream = upstreamUrl.startsWith("http://");
  const rendered = lines.map((line) => {
    // The site block is the only top-level "<host> {" line in the audited
    // configuration. A comment or a nested directive never matches it.
    if (!replacedSite && /^[^\s{}#][^\s]*\s*\{$/.test(line)) {
      replacedSite = true;
      return `${siteAddress} {`;
    }
    if (!replacedUpstream && /^[ \t]*reverse_proxy\s+\S+/.test(line)) {
      replacedUpstream = true;
      return line.replace(/^([ \t]*reverse_proxy\s+)\S+/, `$1${upstreamUrl}`);
    }
    if (plainHttpUpstream && /^[ \t]*tls_timeout\s+\S+/.test(line)) return null;
    return line;
  }).filter((line) => line !== null);
  if (!replacedSite) throw new Error("the configuration under test has no site block to bind");
  if (!replacedUpstream) throw new Error("the configuration under test has no reverse_proxy directive to retarget");
  return rendered.join("\n");
}

/**
 * Decide whether one observed request proves route isolation.
 *
 * `upstreamStatus` is what the CONTROLLED upstream answered. The bridge's own
 * 404 must be a 404 even though the upstream answered 200 on that path.
 */
export function evaluateIsolationObservation({ path: probePath, bridgeStatus, upstreamStatus }) {
  const allowlisted = ALLOWED_PATHS.some((pattern) => (
    pattern.endsWith("/*")
      ? probePath === pattern.slice(0, -1) || probePath.startsWith(pattern.slice(0, -1))
      : probePath === pattern
  ));
  if (allowlisted) {
    return {
      ok: bridgeStatus === 200 && upstreamStatus === 200,
      detail: `allowlisted route proxied to the controlled upstream (bridge ${bridgeStatus}, upstream ${upstreamStatus})`,
    };
  }
  return {
    ok: bridgeStatus === 404,
    detail: `forbidden route answered by the bridge with ${bridgeStatus} while the controlled upstream answered ${upstreamStatus}`,
  };
}

/** True when the upstream saw a header it must never receive. */
export function leakedAuthorityHeaders(seenHeaders) {
  const seen = new Set(Object.keys(seenHeaders).filter((name) => seenHeaders[name] !== undefined).map((name) => name.toLowerCase()));
  return FORWARDED_HEADERS.filter((name) => seen.has(name));
}

/** True when a header the MCP contract needs did not survive the edge. */
export function missingPreservedHeaders(seenHeaders) {
  const seen = new Set(Object.keys(seenHeaders).filter((name) => seenHeaders[name] !== undefined).map((name) => name.toLowerCase()));
  return PRESERVED_HEADERS.filter((name) => !seen.has(name));
}

async function readBody(response) {
  // Bounded: the controlled upstream answers a tiny JSON body, but a broken
  // edge must never make this harness buffer an unbounded response.
  const text = await response.text();
  return text.length > 64 * 1024 ? text.slice(0, 64 * 1024) : text;
}

async function startControlledUpstream() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) headers[name] = value;
    requests.push({ method: request.method, url: request.url, headers });
    // The controlled upstream answers SUCCESS on EVERY path, including the
    // forbidden ones. A proxy that forwards everything therefore fails the
    // isolation check.
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ controlled: true, path: request.url }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    requests,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const { connect } = await import("node:net");
  while (Date.now() < deadline) {
    const reachable = await new Promise((resolveReachable) => {
      const socket = connect({ host: "127.0.0.1", port }, () => { socket.end(); resolveReachable(true); });
      socket.on("error", () => resolveReachable(false));
      socket.setTimeout(500, () => { socket.destroy(); resolveReachable(false); });
    });
    if (reachable) return;
    await new Promise((resolveTick) => setTimeout(resolveTick, 100));
  }
  throw new Error(`the bridge never bound 127.0.0.1:${port}`);
}

async function requestBridge(port, path, headers) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers, redirect: "manual" });
  const body = await readBody(response);
  return { status: response.status, body };
}

export async function runRouteIsolation(options) {
  const { caddyBinary, configText, configPath, buildId, timeoutMs = 30_000 } = options;
  const upstream = await startControlledUpstream();
  const workDir = resolve(options.workDir ?? "/tmp");
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const sitePort = 18_000 + (process.pid % 2_000);
  const siteAddress = `http://127.0.0.1:${sitePort}`;
  const renderedConfig = renderIsolationConfig(configText, { siteAddress, upstreamUrl: `http://127.0.0.1:${upstream.port}` });
  const renderedPath = resolve(workDir, `bridge-isolation-${randomUUID()}.caddy`);
  writeFileSync(renderedPath, renderedConfig, { mode: 0o600 });

  const child = spawn(caddyBinary, ["run", "--config", renderedPath, "--adapter", "caddyfile"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? "" },
  });
  const stderrChunks = [];
  child.stderr?.on("data", (chunk) => { if (stderrChunks.length < 40) stderrChunks.push(String(chunk)); });

  const observations = [];
  const findings = [];
  try {
    await waitForPort(sitePort, timeoutMs);

    // 1. An allowlisted route must reach the controlled upstream.
    const allowed = await requestBridge(sitePort, "/mcp", { accept: "application/json" });
    const allowedUpstream = upstream.requests.filter((entry) => entry.url === "/mcp");
    observations.push({
      path: "/mcp",
      allowlisted: true,
      bridgeStatus: allowed.status,
      upstreamStatus: allowedUpstream.length ? 200 : 0,
      ...evaluateIsolationObservation({ path: "/mcp", bridgeStatus: allowed.status, upstreamStatus: allowedUpstream.length ? 200 : 0 }),
    });

    // 2. Every forbidden route must return the BRIDGE's own 404 while the
    //    controlled upstream answered 200 on the same path.
    for (const probePath of FORBIDDEN_PROBE_PATHS) {
      const before = upstream.requests.length;
      const response = await requestBridge(sitePort, probePath, { accept: "application/json" });
      const reached = upstream.requests.length > before;
      const observation = evaluateIsolationObservation({
        path: probePath,
        bridgeStatus: response.status,
        upstreamStatus: reached ? 200 : 0,
      });
      observations.push({
        path: probePath,
        allowlisted: false,
        bridgeStatus: response.status,
        upstreamStatus: reached ? 200 : 0,
        ...observation,
      });
    }

    // 3. Forged authority headers must not reach the upstream; the MCP
    //    contract headers must survive.
    const forged = {
      authorization: "Bearer isolation-fixture-token",
      "mcp-session-id": "isolation-session",
      "last-event-id": "42",
      accept: "application/json",
      "content-type": "application/json",
      "x-kontrol-role": "reviewer",
      "x-kontrol-workspace-session": "forged-session",
      "x-kontrol-worker-token": "forged-worker-token",
      "x-forwarded-for": "203.0.113.9",
      "x-forwarded-host": "evil.example.invalid",
      "x-forwarded-proto": "https",
      "x-real-ip": "203.0.113.9",
      "cf-connecting-ip": "203.0.113.9",
      "true-client-ip": "203.0.113.9",
      "tailscale-user-login": "attacker@example.invalid",
      "tailscale-user-name": "attacker",
      "tailscale-user": "attacker",
      forwarded: "for=203.0.113.9",
    };
    await requestBridge(sitePort, "/mcp", forged);
    const upstreamCall = upstream.requests.find((entry) => entry.headers.authorization === "Bearer isolation-fixture-token");
    const leaked = upstreamCall ? leakedAuthorityHeaders(upstreamCall.headers) : FORWARDED_HEADERS;
    const missing = upstreamCall ? missingPreservedHeaders(upstreamCall.headers) : PRESERVED_HEADERS;
    const pinnedHost = upstreamCall?.headers.host ?? null;
    const hostPinned = pinnedHost !== null && pinnedHost !== `127.0.0.1:${sitePort}`;
    if (leaked.length) findings.push(`authority headers reached the upstream: ${leaked.join(", ")}`);
    if (missing.length) findings.push(`required headers were stripped at the edge: ${missing.join(", ")}`);
    if (!hostPinned) findings.push(`the upstream saw the client Host (${pinnedHost}) instead of the pinned authority`);

    const passed = observations.every((observation) => observation.ok) && findings.length === 0;
    return {
      schemaVersion: 1,
      qualificationId: randomUUID(),
      qualifiedAt: new Date().toISOString(),
      buildId,
      configPath: resolve(configPath),
      configSha256: createHash("sha256").update(configText).digest("hex"),
      effectiveConfigSha256: createHash("sha256").update(renderedConfig).digest("hex"),
      caddyVersion: options.caddyVersion ?? null,
      evidenceTier: "local_integration",
      routeAllowlist: ALLOWED_PATHS,
      controlledUpstream: { answeredSuccessOnEveryPath: true, requests: upstream.requests.length },
      observations,
      findings,
      passed,
    };
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => { child.on("exit", resolveExit); setTimeout(resolveExit, 3_000); });
    await upstream.close();
  }
}

function persistReceipt(path, receipt) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.tmp.${process.pid}.${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`); }
  finally { closeSync(fd); }
  renameSync(temporary, absolute);
}

async function main() {
  const configPath = option("--config");
  const caddyBinary = option("--caddy", process.env.KONTROL_CADDY_BIN ?? "caddy");
  const receiptPath = option("--receipt");
  const buildId = option("--build-id", process.env.KONTROL_BUILD_ID);
  if (!configPath || !receiptPath || !buildId) {
    throw new Error("usage: bridge-route-isolation.mjs --config PATH [--caddy PATH] --build-id ID --receipt PATH");
  }
  const configText = readFileSync(resolve(configPath), "utf8");
  const version = await new Promise((resolveVersion, rejectVersion) => {
    const child = spawn(caddyBinary, ["version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (chunk) => { out += String(chunk); });
    child.on("error", rejectVersion);
    child.on("exit", (code) => (code === 0 ? resolveVersion(out.trim()) : rejectVersion(new Error("caddy version failed"))));
  });
  const receipt = await runRouteIsolation({
    caddyBinary,
    caddyVersion: version,
    configText,
    configPath,
    buildId,
    workDir: option("--work-dir", "/tmp"),
  });
  persistReceipt(receiptPath, receipt);
  for (const observation of receipt.observations) {
    console.log(`${observation.ok ? "PASS" : "FAIL"} ${observation.path}: ${observation.detail}`);
  }
  for (const finding of receipt.findings) console.log(`FAIL ${finding}`);
  console.log(`route isolation ${receipt.passed ? "QUALIFIED" : "FAILED"}; receipt=${resolve(receiptPath)}`);
  if (!receipt.passed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => { process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n"); process.exitCode = 1; });
}
