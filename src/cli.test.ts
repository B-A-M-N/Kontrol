import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { completePtyReviewMutationId, getOrCreatePtyReviewMutationId, readPtyReviewFeedback, readPtyReviewMutationId, readPtyReviewMutationIntent, readPtyReviewSubmission } from "./pty-review-cli.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};
const cliSource = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");

const validSubmission = readPtyReviewSubmission({ structuredContent: { submissionId: "submission-1", status: "awaiting_review" } });
assert.equal(validSubmission.ok, true, "a valid PTY review submission returns its durable receipt");
assert.equal(readPtyReviewSubmission({ isError: true, content: [{ type: "text", text: "token expired" }] }).ok, false,
  "MCP submission errors, including expired credentials, fail closed");
assert.equal(readPtyReviewSubmission({ structuredContent: { status: "awaiting_review" } }).ok, false,
  "a malformed submission response is not printed as a successful result");
assert.deepEqual(readPtyReviewMutationId(["submit", "--client-mutation-id", "review-retry-1"]), {
  ok: true,
  clientMutationId: "review-retry-1",
}, "PTY review retries can preserve a stable mutation identity");
assert.equal(readPtyReviewMutationId(["submit", "--client-mutation-id"]).ok, false,
  "a mutation identity cannot be omitted after its flag");
assert.equal(readPtyReviewMutationId(["submit", "--client-mutation-id", "x".repeat(201)]).ok, false,
  "mutation identity length matches the durable receipt contract");
assert.equal(readPtyReviewMutationId(["submit", "--client-mutation-id", "first", "--client-mutation-id", "second"]).ok, false,
  "duplicate mutation identity flags are rejected as ambiguous");
assert.match(cliSource, /clientMutationId = mutationId\.clientMutationId[\s\S]*getOrCreatePtyReviewMutationId/,
  "managed PTY submissions reuse pending identities or create one automatically");
assert.match(cliSource, /prior PTY review submission has an unresolved response/,
  "an explicit new identity cannot bypass an unresolved automatic submission");
assert.match(cliSource, /clientMutationId,\n\s*\},/,
  "every managed PTY review submission carries an idempotency identity");
assert.match(cliSource, /getOrCreatePtyReviewMutationId\(mutationIntentPath\)/,
  "managed PTY submissions persist a retry identity before contacting MCP");
assert.match(cliSource, /completePtyReviewMutationId\(mutationIntentPath, clientMutationId\)/,
  "managed PTY submissions clear the retry identity only after receiving a durable receipt");
assert.match(cliSource, /--client-mutation-id <stable-id>/,
  "PTY review help documents the retry identity option");
const intentDirectory = mkdtempSync(join(tmpdir(), "kontrol-pty-review-intent-"));
const intentPath = join(intentDirectory, "submission-intent");
try {
  const firstIntent = getOrCreatePtyReviewMutationId(intentPath);
  assert.equal(getOrCreatePtyReviewMutationId(intentPath), firstIntent,
    "a retry after losing the CLI response reuses its pending submission identity");
  assert.equal(readPtyReviewMutationIntent(intentPath), firstIntent,
    "pending submission identity can be checked before honoring an explicit override");
  assert.equal(statSync(intentPath).mode & 0o077, 0,
    "the persisted PTY retry identity is private to the agent process owner");
  completePtyReviewMutationId(intentPath, firstIntent);
  assert.equal(readPtyReviewMutationIntent(intentPath), undefined,
    "a confirmed receipt clears the pending identity");
  const nextIntent = getOrCreatePtyReviewMutationId(intentPath);
  assert.notEqual(nextIntent, firstIntent,
    "a later review round receives a fresh identity after the prior receipt is observed");
  assert.throws(() => completePtyReviewMutationId(intentPath, firstIntent), /changed before receipt cleanup/,
    "cleanup cannot erase a different pending submission after an unexpected race");
  completePtyReviewMutationId(intentPath, nextIntent);
} finally {
  rmSync(intentDirectory, { recursive: true, force: true });
}
const feedbackTimeout = readPtyReviewFeedback({ structuredContent: { status: "timeout", sessionId: "work-1" } });
assert.equal(feedbackTimeout.ok, true);
assert.equal(feedbackTimeout.status, "timeout", "feedback timeout stays distinguishable so the CLI can continue waiting");
assert.equal(readPtyReviewFeedback({ structuredContent: { status: "error", message: "Session cancelled" } }).ok, false,
  "cancellation is a failing feedback result rather than a successful stdout receipt");
assert.equal(readPtyReviewFeedback({ isError: true, content: [{ type: "text", text: "credential expired" }] }).ok, false,
  "MCP feedback errors are surfaced as failures");

assert.match(
  cliSource,
  /KONTROL_AUTH_MODE === "tunnel" && process\.env\.KONTROL_ALLOWED_ROOTS\?\.trim\(\)/,
  "tunnel mode with environment-provided roots must not enter interactive setup",
);

// P1 (audit): `kontrol init` must make auth/transport mode an explicit setup
// choice, generate the mode-specific credential (OAuth owner password vs
// tunnel reviewer secret), and validate the RESULTING configuration before
// finishing.
assert.match(
  cliSource,
  /How will MCP clients reach this Kontrol server\?/,
  "init must ask how clients reach the server (OAuth public URL vs Secure MCP Tunnel)",
);
assert.match(
  cliSource,
  /OpenAI Secure MCP Tunnel/,
  "init must offer the Secure MCP Tunnel as a first-class option",
);
assert.match(
  cliSource,
  /authMode,/,
  "init must persist the chosen auth mode into config.json",
);
assert.match(
  cliSource,
  /tunnelReviewerSecret/,
  "tunnel-mode init must collect and persist the reviewer assertion secret",
);
assert.match(
  cliSource,
  /generated configuration failed validation/,
  "init must validate the resulting configuration before finishing (and roll back on failure)",
);
assert.match(
  readFileSync(new URL("./user-config.ts", import.meta.url), "utf8"),
  /authMode\?: "oauth" \| "tunnel"/,
  "user config schema carries the auth mode",
);
assert.match(cliSource, /case "up":\s+runUp\(args\);/);
assert.match(cliSource, /const launcher = resolve\(process\.cwd\(\), "start-all\.sh"\);/);
assert.match(cliSource, /spawnSync\("bash", \[launcher\], \{ cwd: process\.cwd\(\), stdio: "inherit" \}\)/);
assert.match(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  /"build:copy-mjs"[\s\S]*scripts\/lib\/acp-worker-token\.mjs/,
  "the standalone worker-token implementation must be copied when that compatibility build helper is used",
);

// P0 #3 regression: an owner token WITHOUT explicit allowed roots must fail
// closed instead of inheriting process.cwd() as the filesystem boundary.
assert.match(
  cliSource,
  /KONTROL_OAUTH_OWNER_TOKEN is set but KONTROL_ALLOWED_ROOTS is not/,
  "environment-only startup with a credential but no roots must fail closed",
);
assert.match(
  cliSource,
  /process\.env\.KONTROL_OAUTH_OWNER_TOKEN && process\.env\.KONTROL_ALLOWED_ROOTS\?\.trim\(\)/,
  "both credential AND explicit roots are required for environment-only startup",
);

for (const flag of ["-v", "--version"]) {
  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", flag], {
    encoding: "utf8",
    env: { ...process.env, KONTROL_CONFIG_DIR: "/tmp/kontrol-cli-version-test" },
  }).trim();

  assert.equal(output, packageJson.version);
}

// P0 doctor regression: `kontrol doctor` must report a NON-ZERO exit code
// when any probe FAILs, and the Node/runtime probe must use a real status
// label (PASS/FAIL), not the raw semver range string. Asserts both stdout
// and the process exit code end to end through the real CLI.
{
  const { spawnSync } = await import("node:child_process");
  const runDoctor = (extraEnv: Record<string, string>, args: string[] = []) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "doctor", ...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        KONTROL_CONFIG_DIR: "/tmp/kontrol-cli-doctor-test",
        // Force a deterministic FAIL: missing required owner token under the
        // default oauth mode (no config file in the temp dir).
        KONTROL_OAUTH_OWNER_TOKEN: "",
        KONTROL_ALLOWED_ROOTS: "",
        ...extraEnv,
      },
    });

  const failing = runDoctor({});
  assert.equal(failing.status, 1, `doctor must exit 1 when a probe FAILs, got ${failing.status}; stdout:\n${failing.stdout}`);
  assert.match(failing.stdout ?? "", /\[FAIL\] Config:/, "the failing probe must be printed with a FAIL status");
  assert.match(failing.stdout ?? "", /Doctor summary: .* fail/, "a summary line must report the failure count");
  assert.doesNotMatch(
    failing.stdout ?? "",
    /\[\[?\d/,
    "no probe may print a non-status label (regression: the raw semver range was printed as the status)",
  );

  // The Node/runtime probe must be a real PASS here (this runtime satisfies
  // the supported range) — previously the range string itself was the label.
  assert.match(failing.stdout ?? "", /\[PASS\] Node\/runtime: supported/, "Node/runtime must print PASS with the range as detail");

  // The core automation invariant, environment-independent: the exit code
  // must equal whether any FAIL probe was reported in the summary.
  // (Build/staleness probes legitimately depend on checkout state; the
  // invariant must hold under any combination.)
  const passing = runDoctor(
    {
      KONTROL_OAUTH_OWNER_TOKEN: "doctor-test-owner-token-that-is-long-enough",
      KONTROL_ALLOWED_ROOTS: process.cwd(),
      KONTROL_PUBLIC_BASE_URL: "http://127.0.0.1:7676",
    },
  );
  const failMatches = (passing.stdout ?? "").match(/^\[FAIL\]/gm)?.length ?? 0;
  const summaryFail = Number((passing.stdout ?? "").match(/Doctor summary: .*?(\d+) fail/)?.[1] ?? Number.NaN);
  assert.ok(Number.isInteger(summaryFail), "doctor must print a fail count in its summary");
  assert.equal(summaryFail, failMatches, "summary fail count must equal the printed FAIL probes");
  assert.equal(passing.status, summaryFail > 0 ? 1 : 0,
    `doctor exit code (${passing.status}) must track FAIL count (${summaryFail}); stdout:\n${passing.stdout}`);

  // --strict: a WARN-only run exits 1 under strict. Use a loose state dir
  // permission to force at least one WARN deterministically: run against a
  // config whose state dir is mode 0755.
  const { mkdtempSync, chmodSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stateDir = mkdtempSync(join(tmpdir(), "kontrol-doctor-strict-"));
  chmodSync(stateDir, 0o755);
  const strictRun = runDoctor(
    {
      KONTROL_OAUTH_OWNER_TOKEN: "doctor-test-owner-token-that-is-long-enough",
      KONTROL_ALLOWED_ROOTS: process.cwd(),
      KONTROL_PUBLIC_BASE_URL: "http://127.0.0.1:7676",
      KONTROL_STATE_DIR: stateDir,
    },
    ["--strict"],
  );
  if (/\[WARN\]/.test(strictRun.stdout ?? "")) {
    assert.equal(strictRun.status, 1, `doctor --strict must exit 1 when WARN probes exist, got ${strictRun.status}`);
  }

  // Fresh-install semantics: the state directory and worktree root are
  // auto-created by the runtime on first use, so doctor must NOT fail on a
  // fresh environment whose parents exist — that exit-1 would break install
  // automation for a healthy deployment.
  const freshRoot = mkdtempSync(join(tmpdir(), "kontrol-doctor-fresh-"));
  const freshRun = runDoctor(
    {
      KONTROL_OAUTH_OWNER_TOKEN: "doctor-test-owner-token-that-is-long-enough",
      KONTROL_ALLOWED_ROOTS: process.cwd(),
      KONTROL_PUBLIC_BASE_URL: "http://127.0.0.1:7676",
      KONTROL_STATE_DIR: join(freshRoot, "state"),
      KONTROL_WORKTREE_ROOT: join(freshRoot, "worktrees"),
    },
  );
  const freshStdout = freshRun.stdout ?? "";
  assert.doesNotMatch(freshStdout, /\[FAIL\] State directory/, "missing state dir (creatable parent) must not FAIL");
  assert.doesNotMatch(freshStdout, /\[FAIL\] Worktree root writable/, "missing worktree root (creatable parent) must not FAIL");
  assert.match(freshStdout, /\[PASS\] State directory: .*not yet created/, "missing state dir must report PASS with creation note");
  assert.match(freshStdout, /\[PASS\] Worktree root writable: .*not yet created/, "missing worktree root must report PASS with creation note");

  // ...but a genuinely uncreatable location must still FAIL (parent absent).
  const orphanRun = runDoctor(
    {
      KONTROL_OAUTH_OWNER_TOKEN: "doctor-test-owner-token-that-is-long-enough",
      KONTROL_ALLOWED_ROOTS: process.cwd(),
      KONTROL_PUBLIC_BASE_URL: "http://127.0.0.1:7676",
      KONTROL_STATE_DIR: join(freshRoot, "does-not-exist", "state"),
    },
  );
  assert.match(orphanRun.stdout ?? "", /\[FAIL\] State directory/, "state dir under a missing parent must FAIL");
  assert.equal(orphanRun.status, 1, "uncreatable state dir must produce exit 1");
  rmSync(freshRoot, { recursive: true, force: true });
}

// P0 GC regression (end to end through the real CLI): `kontrol snapshots gc`
// must root from the durable SQLite database — a submitted filesystem snapshot
// that is referenced ONLY by work_session_submissions must survive a live GC
// that reclaims genuinely unpinned garbage from the same store.
{
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const stateDir = mkdtempSync(join(tmpdir(), "kontrol-cli-gc-state-"));
  const storeRoot = join(stateDir, "workspace-snapshots");
  const wsRoot = mkdtempSync(join(tmpdir(), "kontrol-cli-gc-ws-"));

  // 1. Capture the future submission snapshot with a THROWING root provider:
  // capture itself never enumerates roots, so this just seeds the store.
  const manifestDir = join(storeRoot, "manifests");
  mkdirSync(manifestDir, { recursive: true });

  // Seed the store by capturing through a store instance bound to this
  // stateDir (identical layout the CLI resolves). We spawn a tiny tsx inline
  // script so the CLI test stays a black box for the gc phase below.
  const seedScript = `
    import { FilesystemSnapshotStore } from "./src/filesystem-snapshot-store.js";
    const store = new FilesystemSnapshotStore({ storeRoot: process.argv[2] });
    const snap = await store.capture(process.argv[3]);
    console.log(snap.ref);
  `;
  const seed = spawnSync(process.execPath, ["--import", "tsx", "--eval", seedScript, "seed", storeRoot, wsRoot], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(seed.status, 0, `seeding capture must succeed; stderr: ${seed.stderr}`);
  const subRef = (seed.stdout ?? "").trim();

  // 2. Seed unpinned garbage in the same store (unique content per blob).
  const garbageDir = mkdtempSync(join(tmpdir(), "kontrol-cli-gc-garbage-"));
  const seedGarbage = `
    import { FilesystemSnapshotStore } from "./src/filesystem-snapshot-store.js";
    import { writeFileSync, mkdirSync } from "node:fs";
    import { join } from "node:path";
    const store = new FilesystemSnapshotStore({ storeRoot: process.argv[2] });
    for (let i = 0; i < 3; i++) {
      const d = join(process.argv[3], "g" + i);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "x.bin"), Buffer.alloc(4096, i));
      await store.capture(d);
    }
  `;
  const seedG = spawnSync(process.execPath, ["--import", "tsx", "--eval", seedGarbage, "seedg", storeRoot, garbageDir], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(seedG.status, 0, `garbage seeding must succeed; stderr: ${seedG.stderr}`);
  const blobsBefore = existsSync(join(storeRoot, "blobs"));

  // 3. Build the durable DB: a work session + a filesystem submission row
  // pointing at subRef, via the real migration path in a fresh database.
  const dbScript = `
    import { openDatabase } from "./src/db/client.js";
    import { eq } from "drizzle-orm";
    import { workspaceSessions, workSessions, workSessionSubmissions } from "./src/db/schema.js";
    const stateDir = process.argv[2];
    const subRef = process.argv[3];
    const db = openDatabase(stateDir);
    const now = new Date().toISOString();
    db.db.insert(workspaceSessions).values({
      id: "wss_cli_gc_test", root: "/tmp/kontrol-cli-gc-root", createdAt: now, lastUsedAt: now,
    }).run();
    db.db.insert(workSessions).values({
      id: "ws_cli_gc_test", workspaceSessionId: "wss_cli_gc_test", status: "in_progress",
      runtimeState: "running", submittedBy: "test", createdAt: now, updatedAt: now,
    }).run();
    db.db.insert(workSessionSubmissions).values({
      id: "wssub_cli_gc_test", workSessionId: "ws_cli_gc_test", submissionNumber: 1,
      snapshotKind: "filesystem", snapshotRef: subRef, reviewEpoch: 1, status: "pending", createdAt: now,
    }).run();
    db.close();
  `;
  const dbSeed = spawnSync(process.execPath, ["--import", "tsx", "--eval", dbScript, "dbseed", stateDir, subRef], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(dbSeed.status, 0, `db seeding must succeed; stderr: ${dbSeed.stderr}`);

  // 4. Run the real CLI GC (live, not dry-run) against this state dir.
  const gc = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "snapshots", "gc"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      KONTROL_CONFIG_DIR: "/tmp/kontrol-cli-gc-config",
      KONTROL_STATE_DIR: stateDir,
      KONTROL_OAUTH_OWNER_TOKEN: "cli-gc-test-owner-token-that-is-long-enough",
      KONTROL_ALLOWED_ROOTS: process.cwd(),
    },
  });
  assert.equal(gc.status, 0, `snapshots gc must exit 0; stderr: ${gc.stderr}\nstdout: ${gc.stdout}`);

  // 5. The DB-only submission manifest and its blobs must survive; garbage
  // manifests must be reclaimed.
  const refHash = subRef.replace(/^fs:sha256:/, "");
  const subManifestPath = join(manifestDir, `${refHash}.json`);
  assert.equal(existsSync(subManifestPath), true, "CLI GC must preserve the DB-only submission manifest");

  // Garbage manifests: any manifest file that is not the submission's.
  const remaining = readdirSync(manifestDir).filter((f) => f !== `${refHash}.json`);
  assert.ok(remaining.length < 4, `CLI GC must reclaim unpinned garbage manifests (remaining: ${remaining.join(", ")})`);
  assert.ok(blobsBefore, "blobs directory layout expected (sharded)");
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(wsRoot, { recursive: true, force: true });
  rmSync(garbageDir, { recursive: true, force: true });
}

// L04 CLI: review-loop controls operate on the authoritative route store.
{
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stateDir = mkdtempSync(join(tmpdir(), "kontrol-cli-review-loop-"));
  const dbScript = `
    const { openDatabase } = await import("./src/db/client.js");
    const db = openDatabase(${JSON.stringify(stateDir)});
    const now = new Date().toISOString();
    db.sqlite.prepare("insert into workspace_sessions (id, root, status, mode, managed, created_at, last_used_at) values (?, '/tmp', 'active', 'checkout', 'false', ?, ?)").run("wss_cli_rl", now, now);
    db.sqlite.prepare("insert into work_sessions (id, workspace_session_id, submitted_by, status, created_at, updated_at) values ('ws_cli_rl', 'wss_cli_rl', 'test', 'in_progress', ?, ?)").run(now, now);
    db.close();
  `;
  const seed = spawnSync(process.execPath, ["--import", "tsx", "--eval", dbScript, "dbseed"], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(seed.status, 0, `review-loop db seed must succeed; stderr: ${seed.stderr}`);
  const cliEnv = {
    ...process.env,
    KONTROL_CONFIG_DIR: join(stateDir, "config"),
    KONTROL_STATE_DIR: stateDir,
    KONTROL_OAUTH_OWNER_TOKEN: "cli-review-loop-owner-token-long-enough",
    KONTROL_ALLOWED_ROOTS: process.cwd(),
  };
  const runCli = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: repositoryRoot, encoding: "utf8", env: cliEnv });

  const on = runCli("review-loop", "on", "--session", "ws_cli_rl", "--max-rounds", "3", "--mode", "isolated_review");
  assert.equal(on.status, 0, `review-loop on must exit 0; stderr: ${on.stderr}`);
  assert.match(on.stdout, /Review loop active; round 0\/3/);

  const pause = runCli("review-loop", "pause", "--session", "ws_cli_rl");
  assert.equal(pause.status, 0, `review-loop pause must exit 0; stderr: ${pause.stderr}`);
  assert.match(pause.stdout, /paused/);

  const status = runCli("review-loop", "status", "--session", "ws_cli_rl");
  assert.equal(status.status, 0, `review-loop status must exit 0; stderr: ${status.stderr}`);
  const parsed = JSON.parse(status.stdout) as { status?: string; mode?: string; maxReviewRounds?: number };
  assert.equal(parsed.status, "paused", "status reflects the pause");
  assert.equal(parsed.mode, "isolated_review", "status preserves the mode");
  assert.equal(parsed.maxReviewRounds, 3, "status preserves the round budget");

  const resume = runCli("review-loop", "resume", "--session", "ws_cli_rl");
  assert.equal(resume.status, 0);
  assert.match(resume.stdout, /active/);

  const off = runCli("review-loop", "off", "--session", "ws_cli_rl");
  assert.equal(off.status, 0);
  assert.match(off.stdout, /disabled/);

  rmSync(stateDir, { recursive: true, force: true });
}

// Generic ACP agent registration CLI: add/list/remove persist durable config
// and refuse an unreachable or non-loopback endpoint.
{
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createServer } = await import("node:http");
  const configDir = mkdtempSync(join(tmpdir(), "kontrol-cli-agent-"));
  const cliEnv = { ...process.env, KONTROL_CONFIG_DIR: configDir };
  const runCli = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: repositoryRoot, encoding: "utf8", env: cliEnv });

  const empty = runCli("agent", "list");
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /No ACP agents registered/);

  // Non-loopback is rejected before any network attempt.
  const remote = runCli("agent", "add", "remote", "http://example.com:9000");
  assert.notEqual(remote.status, 0, "non-loopback agent URL is rejected");

  // Stand up a loopback ACP agent and register it.
  const port = 7991;
  const agent = createServer((req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); });
  await new Promise<void>((r) => agent.listen(port, "127.0.0.1", () => r()));
  try {
    const add = runCli("agent", "add", "generic-stdio", `http://127.0.0.1:${port}`, "generic adapter");
    assert.equal(add.status, 0, `agent add must exit 0; stderr: ${add.stderr}`);
    const addHealthy = runCli("agent", "add", "dead-agent", `http://127.0.0.1:7992`, "--require-healthy");
    assert.notEqual(addHealthy.status, 0, "--require-healthy fails closed on an unreachable endpoint");
    assert.match(add.stdout, /Registered ACP agent generic-stdio/);
    const list = runCli("agent", "list");
    assert.match(list.stdout, /generic-stdio\t+http:\/\/127\.0\.0\.1:7991/);
    const remove = runCli("agent", "remove", "generic-stdio");
    assert.equal(remove.status, 0);
    assert.match(runCli("agent", "list").stdout, /No ACP agents registered/);
  } finally {
    await new Promise<void>((r) => agent.close(() => r()));
  }
  rmSync(configDir, { recursive: true, force: true });
}

// P1-08: ingress inspect|plan — read-only Tailscale ingress CLI surface.
{
  // static wiring: command union, normalizeCommand, and the main switch
  assert.match(
    cliSource,
    /type Command = "serve"[^;]*"ingress"[^;]*"version";/,
    "ingress must be part of the Command union",
  );
  assert.match(cliSource, /command === "ingress"\) return "ingress";/, "normalizeCommand must accept ingress");
  assert.match(cliSource, /case "ingress":\s+await runIngressCommand\(args\);/, "main switch must dispatch ingress");
  assert.match(cliSource, /Usage: kontrol ingress <inspect\|plan\|apply\|disable\|reconcile\|doctor>/, "ingress help must expose observation and lifecycle commands");
  assert.match(cliSource, /requires --confirm to authorize a Tailscale route change/, "route mutations must require explicit operator authorization");

  // Mutation boundary gate: only the facts reader and the narrow controller
  // may spawn Tailscale; both use execFile without a shell. The controller's
  // argument grammar excludes resets and only accepts profile-scoped routes.
  // Two complementary invariants:
  // (1) tailscale-status.ts is the read-only facts executor and must never
  //     contain mutation flags. (2) controller.ts is the only mutation
  //     executor and keeps a narrow argument allowlist. (3) all other ingress
  //     modules remain free of child-process capability.
  const tailscaleStatusSource = readFileSync(fileURLToPath(new URL("./ingress/tailscale-status.ts", import.meta.url)), "utf8");
  for (const [banner, label] of [
    [new RegExp("--bg"), "the mutating --bg flag"],
    [new RegExp("funnel reset"), "funnel state reset"],
    [new RegExp("serve reset"), "serve state reset"],
    [new RegExp("shell:"), "shell-enabled exec"],
    [new RegExp("execSync"), "synchronous exec surface"],
  ] as Array<[RegExp, string]>) {
    assert.doesNotMatch(tailscaleStatusSource, banner, "tailscale-status.ts must never contain " + label);
  }
  // P3-C: pin the EXACT child_process import shape of tailscale-status.ts:
  // execFile only (never exec/spawn/execSync, which are shell-prone or
  // unguarded), and no require() escape hatch.
  assert.match(tailscaleStatusSource, new RegExp('import [{] execFile [}] from "node:child_process"'), "tailscale-status.ts must import ONLY execFile from child_process");
  assert.doesNotMatch(tailscaleStatusSource, new RegExp("require[(]"), "tailscale-status.ts must not use require()");
  const execFileCallSites = tailscaleStatusSource.split("execFile(").length - 1;
  assert.equal(execFileCallSites, 1, "tailscale-status.ts must have exactly ONE execFile call site (inside the guarded helper)");
  const controllerSource = readFileSync(fileURLToPath(new URL("./ingress/controller.ts", import.meta.url)), "utf8");
  assert.match(controllerSource, /import [{] execFile [}] from "node:child_process"/, "controller must use execFile, never a shell");
  assert.equal(controllerSource.split("execFile(").length - 1, 1, "controller must have one guarded execFile site");
  assert.match(controllerSource, /const allowed = \/\^\(serve\|funnel\)/, "controller must enforce exact Serve/Funnel argument grammar");
  assert.doesNotMatch(controllerSource, /execSync|spawnSync/, "controller must never use a synchronous shell surface");
  assert.match(controllerSource, /args\.some\(\(arg\) => arg === "reset"/, "controller explicitly rejects any reset argument");
  // P3-D: scan the ingress directory so new modules cannot gain child process
  // capability without being explicitly reviewed here.
  const ingressDir = fileURLToPath(new URL("./ingress/", import.meta.url));
  const pureIngressModules = readdirSync(ingressDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "tailscale-status.ts" && name !== "controller.ts")
    .sort()
    .map((name) => "./ingress/" + name);
  for (const gateFile of pureIngressModules) {
    const source = readFileSync(fileURLToPath(new URL(gateFile, import.meta.url)), "utf8");
    assert.doesNotMatch(source, new RegExp('from [\'\"]node:child_process|require[(][\'\"]node:child_process'), gateFile + " must never import child_process (pure logic only)");
  }
  // P1-B: cli.ts only calls the controller API. It must not gain a direct
  // mutating flag or pass the Tailscale binary to any child process.
  assert.doesNotMatch(cliSource, new RegExp("--bg"), "cli.ts must never contain the mutating --bg flag");
  assert.doesNotMatch(cliSource, new RegExp("serve reset"), "cli.ts must never reset serve state");
  assert.doesNotMatch(cliSource, new RegExp("funnel reset"), "cli.ts must never reset funnel state");
  // The ban covers any quoted form of the binary name, including a backtick
  // template, so the name cannot be smuggled into a spawn/exec call through a
  // different quoting style.
  assert.doesNotMatch(cliSource, new RegExp("[\\'\"\u0060]tailscale[\\'\"\u0060]"), "cli.ts must never pass the tailscale binary name to a spawn/exec call");

  const runIngress = (subcommand: "inspect" | "plan", envOverrides: Record<string, string | undefined>) =>
    spawnSync("npx", ["tsx", "src/cli.ts", "ingress", subcommand], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        KONTROL_CONFIG_DIR: "/tmp/kontrol-cli-ingress-test",
        KONTROL_OAUTH_OWNER_TOKEN: "cli-ingress-owner-token-that-is-long-enough",
        KONTROL_ALLOWED_ROOTS: process.cwd(),
        ...envOverrides,
      },
    });
  const runIngressPlan = (envOverrides: Record<string, string | undefined>) => runIngress("plan", envOverrides);

  // Functional e2e (hermetic — plan never spawns tailscale): a
  // secure_tunnel_listener-targeting profile is refused with a nonzero exit.
  const tunnelProfile = {
    id: "tunnel-1",
    kind: "secure_mcp_tunnel",
    audience: "owner_public",
    externalOrigin: "https://kontrol.example.com",
    target: "secure_tunnel_listener",
    enabled: true,
    allowedHosts: ["kontrol.example.com"],
  };
  const refused = runIngressPlan({
    KONTROL_AUTH_MODE: "tunnel",
    KONTROL_POLICY_MODE: "allow",
    KONTROL_PUBLIC_BASE_URL: "https://kontrol.example.com",
    KONTROL_INGRESS_PROFILES: JSON.stringify([tunnelProfile]),
  });
  assert.notEqual(refused.status, 0, "plan must exit nonzero when a profile is refused");
  assert.match(refused.stdout ?? "", /plan only, nothing was executed/, "plan output must be clearly labeled dry-run");
  assert.match(refused.stdout ?? "", /never proxy it through Tailscale/, "the tunnel-target refusal reason must be printed");

  // Unconfigured deployment: the empty-list note, exit 0, bit-identical to
  // the previous behavior apart from the new command itself.
  const unconfigured = runIngressPlan({ KONTROL_INGRESS_PROFILES: undefined });
  assert.equal(unconfigured.status, 0, "plan over an unconfigured profile list exits 0");
  assert.match(unconfigured.stdout ?? "", /KONTROL_INGRESS_PROFILES is not configured/);
  assert.doesNotMatch(unconfigured.stdout ?? "", /command:/, "an unconfigured plan must not print any command");

  // Spawn tripwire (authoritative for BOTH subcommands): the sentinel
  // APPENDS its argv to a hit file inside a PRIVATE os.tmpdir() scratch dir
  // (never the developer-scratch .tmp-scratch/). `ingress plan` must leave
  // NO hit file (it never spawns). `ingress inspect` must reach the facts
  // layer through the sentinel and produce EXACTLY the four read-only fact
  // invocations - catching any direct cli.ts spawn or allowlist bypass
  // implementation-agnostically.
  const scratch = mkdtempSync(join(tmpdir(), "kontrol-cli-tripwire-"));
  const sentinelScript = join(scratch, "sentinel.sh");
  const sentinelHit = join(scratch, "hit.txt");
  writeFileSync(
    sentinelScript,
    "#!/bin/sh\nprintf '%s\\n' \"$@\" >> " + JSON.stringify(sentinelHit) + "\nexit 0\n",
    { mode: 0o755 },
  );
  // The sentinel is a POSIX shell script. On Windows there is no /bin/sh, so
  // the sentinel cannot run and the tripwire cannot observe anything. The
  // platform guard follows the repository convention: the tripwire is a
  // POSIX-only assertion, and the rest of this suite still runs everywhere.
  const skipTripwire = process.platform === "win32";
  try {
    const serveProfile = {
      id: "serve-pub",
      kind: "tailscale_serve",
      audience: "owner_public",
      externalOrigin: "https://node.ts.net:8443",
      target: "public_oauth_listener",
      enabled: true,
      managedByKontrol: false,
      allowedHosts: ["node.ts.net:8443"],
    };
    const tripwireEnv = {
      KONTROL_TAILSCALE_BIN: sentinelScript,
      KONTROL_PUBLIC_BASE_URL: "https://node.ts.net:8443",
      KONTROL_INGRESS_PROFILES: JSON.stringify([serveProfile]),
    };
    if (skipTripwire) {
      console.log("cli.test.ts: spawn tripwire skipped on this platform (POSIX-only sentinel)");
    } else {
      const planTripwire = runIngressPlan(tripwireEnv);
      assert.ok(planTripwire.status !== undefined, "plan tripwire run must complete");
      assert.equal(existsSync(sentinelHit), false, "plan must NEVER spawn the tailscale binary");

      // Pre-run cleanup so an interrupted earlier run cannot false-fail here.
      rmSync(sentinelHit, { force: true });
      const inspectTripwire = runIngress("inspect", tripwireEnv);
      assert.ok(inspectTripwire.status !== undefined, "inspect tripwire run must complete");
      assert.ok(existsSync(sentinelHit), "inspect must reach the tailscale facts layer through the sentinel");
      // The sentinel appends one line per argv element (spawnSync passes the
      // args flat), so the expected file is the flattened, ordered sequence of
      // the four fact invocations. Any extra invocation or flag appends more
      // lines and fails the deepEqual.
      const invocations = readFileSync(sentinelHit, "utf8").split("\n").filter((line) => line !== "");
      assert.deepEqual(
        invocations,
        ["version", "status", "--json", "serve", "status", "--json", "funnel", "status", "--json"],
        "the facts layer may ONLY run the four read-only fact commands",
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
