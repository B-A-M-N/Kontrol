import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
