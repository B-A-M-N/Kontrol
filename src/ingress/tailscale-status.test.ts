import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertReadOnlyFactArgs, defaultTailscaleExec, readTailscaleFacts, type TailscaleExec } from "./tailscale-status.js";

interface FakeResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

function fakeExec(responses: Record<string, FakeResponse>): TailscaleExec & { calls: string[][] } {
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push([...args]);
    const response = responses[args.join(" ")] ?? {};
    return { stdout: response.stdout ?? "", stderr: response.stderr ?? "", exitCode: response.exitCode ?? 0 };
  };
  return Object.assign(exec, { calls });
}

// --- all commands OK with the real unconfigured fixtures ---
{
  const exec = fakeExec({
    "version": { stdout: "1.102.2\n  tailscale commit: 6cac918179d4d673bfebe2fc74f81183ddd73fea\n" },
    "status --json": {
      stdout: JSON.stringify({
        BackendState: "Running",
        Self: { DNSName: "pop-os.tail8d285a.ts.net.", HostName: "pop-os" },
      }),
    },
    "serve status --json": { stdout: "{}" },
    "funnel status --json": { stdout: "{}" },
  });
  const facts = await readTailscaleFacts(exec);
  assert.equal(facts.cliVersion, "1.102.2", "version parse takes the first line only");
  assert.equal(facts.backendState, "Running");
  assert.equal(facts.dnsName, "pop-os.tail8d285a.ts.net", "trailing dot stripped from DNSName");
  assert.deepEqual(facts.serveMappings, []);
  assert.deepEqual(facts.funnelMappings, []);
  assert.deepEqual(facts.warnings, []);
  assert.deepEqual(
    exec.calls,
    [["version"], ["status", "--json"], ["serve", "status", "--json"], ["funnel", "status", "--json"]],
    "only read-only subcommands/flags are ever passed to the tailscale binary",
  );
}

// --- configured serve status: REAL schema (Web HostPort keys, top-level
// AllowFunnel HostPort map with only TRUE entries) plus defensive collection
// across unknown shapes; the funnel command renders the SAME document ---
{
  const exec = fakeExec({
    "version": { stdout: "1.102.2\n" },
    "status --json": {
      stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: "node.tail8d285a.ts.net." } }),
    },
    "serve status --json": {
      stdout: JSON.stringify({
        Web: {
          "node.ts.net:443": {
            Handlers: {
              "/": { Proxy: "http://127.0.0.1:7677" },
              "/api": { Proxy: "http://localhost:9999" },
            },
          },
          "other.tailnet.ts.net:443": {
            Handlers: { "/": { Proxy: "http://10.0.0.9:3000" } },
          },
        },
        AllowFunnel: { "node.ts.net:443": true },
        Services: {
          "svc:9999": {
            Web: {
              "db.tailnet.ts.net:443": {
                Handlers: { "/": { Proxy: "http://127.0.0.1:9001" } },
              },
            },
          },
        },
        UnknownSection: { whatever: { deep: [1, 2, { Proxy: "http://[::1]:7000" }] } },
      }),
    },
    "funnel status --json": {
      // UPSTREAM FACT: funnel status --json renders the SAME ipn.ServeConfig
      // as serve status --json (runServeStatus is shared). Simulate that here.
      stdout: JSON.stringify({
        Web: {
          "node.ts.net:443": {
            Handlers: {
              "/": { Proxy: "http://127.0.0.1:7677" },
              "/api": { Proxy: "http://localhost:9999" },
            },
          },
          "other.tailnet.ts.net:443": {
            Handlers: { "/": { Proxy: "http://10.0.0.9:3000" } },
          },
        },
        AllowFunnel: { "node.ts.net:443": true },
        Services: {
          "svc:9999": {
            Web: {
              "db.tailnet.ts.net:443": {
                Handlers: { "/": { Proxy: "http://127.0.0.1:9001" } },
              },
            },
          },
        },
        UnknownSection: { whatever: { deep: [1, 2, { Proxy: "http://[::1]:7000" }] } },
      }),
    },
  });
  const facts = await readTailscaleFacts(exec);
  assert.equal(facts.warnings.length, 0);
  assert.deepEqual(facts.serveMappings, [
    { port: "443", path: "/", proxyTarget: "http://127.0.0.1:7677", hostPort: "node.ts.net:443", allowFunnel: true },
    { port: "443", path: "/api", proxyTarget: "http://localhost:9999", hostPort: "node.ts.net:443", allowFunnel: true },
    { port: "443", path: "/", proxyTarget: "http://10.0.0.9:3000", hostPort: "other.tailnet.ts.net:443" },
    { port: "443", path: "/", proxyTarget: "http://127.0.0.1:9001", hostPort: "db.tailnet.ts.net:443" },
    { port: "", path: "/", proxyTarget: "http://[::1]:7000" },
  ]);
  // Identical document -> identical bucket (the upstream behavior).
  assert.deepEqual(facts.funnelMappings, facts.serveMappings);
}

// --- per-command failures become warnings; never throws ---
{
  const exec = fakeExec({
    "version": { stdout: "", exitCode: 1, stderr: "boom" },
    "status --json": { stdout: "", exitCode: 1, stderr: "boom" },
    "serve status --json": { stdout: "not json at all", exitCode: 0 },
    "funnel status --json": { stdout: "", exitCode: 1 },
  });
  const facts = await readTailscaleFacts(exec);
  assert.equal(facts.cliVersion, null);
  assert.equal(facts.backendState, null);
  assert.equal(facts.dnsName, null);
  assert.deepEqual(facts.serveMappings, []);
  assert.deepEqual(facts.funnelMappings, []);
  assert.equal(facts.warnings.length, 4, `expected one warning per failed command, got ${JSON.stringify(facts.warnings)}`);
  // Warnings are STABLE CATEGORIES: no raw stderr/stdout/error detail, so
  // host paths, credentials, or terminal control sequences never leak.
  assert.match(facts.warnings[0], /^tailscale version failed \(exit 1\)$/);
  assert.match(facts.warnings[2], /^tailscale serve status --json returned malformed JSON$/);
  assert.match(facts.warnings[3], /^tailscale funnel status --json failed \(exit 1\)$/);
  assert.ok(!facts.warnings.some((warning) => warning.includes("boom")), "no raw subprocess output in warnings");
}

// --- exec exception path: category only, no error-message detail ---
{
  const exec = async () => {
    throw new Error("spawn failure with /home/someuser/secret/path inside");
  };
  const facts = await readTailscaleFacts(exec);
  assert.deepEqual(
    facts.warnings,
    [
      "tailscale version: failed",
      "tailscale status --json: failed",
      "tailscale serve status --json: failed",
      "tailscale funnel status --json: failed",
    ],
    "exception warnings carry a stable category only, one per command",
  );
  assert.ok(!facts.warnings.some((warning) => warning.includes("/home/someuser")), "no filesystem paths in warnings");
}

// --- proxy-target redaction: userinfo/query credentials never survive ---
{
  const exec = fakeExec({
    "version": { stdout: "1.102.2\n" },
    "status --json": { stdout: "{}" },
    "serve status --json": {
      stdout: JSON.stringify({
        Web: {
          "node.ts.net:443": {
            Handlers: {
              "/": { Proxy: "http://user:hunter2@127.0.0.1:7677/db?password=hunter2#frag" },
              "/x": { Proxy: "not a url at all" },
              "/y": { Proxy: "gopher://127.0.0.1:9" },
            },
          },
        },
      }),
    },
    "funnel status --json": { stdout: "{}" },
  });
  const facts = await readTailscaleFacts(exec);
  assert.equal(facts.warnings.length, 0);
  const [credentialled, garbage, weirdScheme] = facts.serveMappings;
  assert.equal(credentialled.proxyTarget, "http://127.0.0.1:7677", "userinfo and query credentials are dropped");
  assert.ok(!credentialled.proxyTarget.includes("hunter2"));
  assert.equal(garbage.proxyTarget, "(unrecognized target)", "unparseable targets collapse to the placeholder");
  assert.equal(weirdScheme.proxyTarget, "(unrecognized target)", "non-http schemes collapse to the placeholder");
}

// --- missing fields tolerated ---
{
  const exec = fakeExec({
    "version": { stdout: "1.102.2\nmore\n" },
    "status --json": { stdout: JSON.stringify({ Version: "1.102.2" }) },
    "serve status --json": { stdout: "{}" },
    "funnel status --json": { stdout: "{}" },
  });
  const facts = await readTailscaleFacts(exec);
  assert.equal(facts.backendState, null);
  assert.equal(facts.dnsName, null);
  assert.deepEqual(facts.warnings, []);
}

// --- default exec honors KONTROL_TAILSCALE_BIN (proven via /bin/echo, never
// a real tailscale spawn) and never rejects ---
{
  const previous = process.env.KONTROL_TAILSCALE_BIN;
  process.env.KONTROL_TAILSCALE_BIN = "/bin/echo";
  try {
    const facts = await readTailscaleFacts();
    // /bin/echo prints its arguments: "version" for the version call, so the
    // override was honored (the real binary would print 1.102.2).
    assert.equal(facts.cliVersion, "version");
    // "status --json" echoed back is not JSON -> malformed-JSON warnings.
    assert.equal(facts.backendState, null);
    assert.equal(facts.dnsName, null);
    assert.equal(facts.warnings.length, 3);
    assert.match(facts.warnings[0], /^tailscale status --json returned malformed JSON$/);
  } finally {
    if (previous === undefined) delete process.env.KONTROL_TAILSCALE_BIN;
    else process.env.KONTROL_TAILSCALE_BIN = previous;
  }
}

// --- default exec folds ENOENT into a result (missing binary, no spawn) ---
{
  const previous = process.env.KONTROL_TAILSCALE_BIN;
  process.env.KONTROL_TAILSCALE_BIN = "/nonexistent-kontrol-test-bin";
  try {
    const facts = await readTailscaleFacts();
    assert.equal(facts.cliVersion, null);
    assert.equal(facts.backendState, null);
    assert.equal(facts.dnsName, null);
    assert.equal(facts.warnings.length, 4, "every command failure is reported as a warning");
    assert.match(facts.warnings[0], /^tailscale version failed \(exit 127\)$/, "ENOENT maps to the conventional exit-127 category");
  } finally {
    if (previous === undefined) delete process.env.KONTROL_TAILSCALE_BIN;
    else process.env.KONTROL_TAILSCALE_BIN = previous;
  }
}

// --- no shell, ever (static enforcement of the exec contract) ---
{
  const source = readFileSync(fileURLToPath(new URL("./tailscale-status.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /shell:\s*true/, "the default exec must never use a shell");
  assert.doesNotMatch(source, /\bspawn(Sync)?\s*\(/, "execFile only; no generic spawn surface");
}

// --- the executor refuses non-read-only invocations at runtime ---
{
  assert.throws(() => assertReadOnlyFactArgs(["serve", "--bg", "--https=8443", "http://127.0.0.1:7677"]), "mutation commands are refused");
  assert.throws(() => assertReadOnlyFactArgs(["funnel", "--bg", "--https=443", "http://127.0.0.1:7678"]), "funnel --bg is refused");
  assert.throws(() => assertReadOnlyFactArgs(["down"]), "tailscale down is refused");
  assert.throws(() => assertReadOnlyFactArgs(["serve", "reset"]), "serve reset is refused");
  assert.throws(() => assertReadOnlyFactArgs(["funnel", "reset"]), "funnel reset is refused");
  assert.doesNotThrow(() => assertReadOnlyFactArgs(["version"]));
  assert.doesNotThrow(() => assertReadOnlyFactArgs(["status", "--json"]));
  assert.doesNotThrow(() => assertReadOnlyFactArgs(["serve", "status", "--json"]));
  assert.doesNotThrow(() => assertReadOnlyFactArgs(["funnel", "status", "--json"]));
}

// --- exec-guard WIRING is enforced (not just the unit contract) ---
{
  const source = readFileSync(fileURLToPath(new URL("./tailscale-status.ts", import.meta.url)), "utf8");
  assert.match(source, /READ_ONLY_FACT_ARGS/, "the read-only allowlist must exist");
  assert.match(source, /assertReadOnlyFactArgs\(args\);/, "safeExec must enforce the allowlist");
  // defaultTailscaleExec must call the guard BEFORE spawning: the guard
  // reference must appear inside the defaultTailscaleExec body.
  const execBodyStart = source.indexOf("export function defaultTailscaleExec");
  const execBodyEnd = source.indexOf("export async function readTailscaleFacts");
  const execBody = source.slice(execBodyStart, execBodyEnd);
  assert.match(execBody, /assertReadOnlyFactArgs\(args\);/, "defaultTailscaleExec must enforce the allowlist before spawn");
}

// --- defaultTailscaleExec REFUSES mutation commands before any spawn ---
{
  const previous = process.env.KONTROL_TAILSCALE_BIN;
  process.env.KONTROL_TAILSCALE_BIN = "/bin/echo";
  try {
    // The guard throws SYNCHRONOUSLY before any spawn/promise, so these are
    // assert.throws — a rejection would prove nothing about pre-spawn timing.
    assert.throws(
      () => defaultTailscaleExec(["serve", "--bg", "--https=8443", "http://127.0.0.1:7677"]),
      /read-only/,
      "a mutating invocation must be refused by the DEFAULT executor before spawn",
    );
    assert.throws(() => defaultTailscaleExec(["funnel", "--bg", "--https=443", "http://127.0.0.1:7678"]), /read-only/);
    assert.throws(() => defaultTailscaleExec(["down"]), /read-only/);
    assert.throws(() => defaultTailscaleExec(["serve", "reset"]), /read-only/);
    assert.throws(() => defaultTailscaleExec(["funnel", "reset"]), /read-only/);
    // Read-only invocations still work (echo resolves a result).
    const facts = await readTailscaleFacts();
    assert.equal(facts.cliVersion, "version");
  } finally {
    if (previous === undefined) delete process.env.KONTROL_TAILSCALE_BIN;
    else process.env.KONTROL_TAILSCALE_BIN = previous;
  }
}

console.log("tailscale-status: all assertions passed");
