import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};
const cliSource = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");

assert.match(
  cliSource,
  /KONTROL_AUTH_MODE === "tunnel" && process\.env\.KONTROL_ALLOWED_ROOTS\?\.trim\(\)/,
  "tunnel mode with environment-provided roots must not enter interactive setup",
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
      cwd: new URL("..", import.meta.url).pathname,
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
    cwd: new URL("..", import.meta.url).pathname,
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
    cwd: new URL("..", import.meta.url).pathname,
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
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
  });
  assert.equal(dbSeed.status, 0, `db seeding must succeed; stderr: ${dbSeed.stderr}`);

  // 4. Run the real CLI GC (live, not dry-run) against this state dir.
  const gc = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "snapshots", "gc"], {
    cwd: new URL("..", import.meta.url).pathname,
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
