import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Hermetic behavior proof for stop-all.sh: the real script runs against
 * fake tmux/systemd shims on PATH, so session signaling, graceful
 * escalation, backend delegation, and partial-shutdown exit codes are
 * exercised without touching production state.
 */
const repoRoot = new URL("..", import.meta.url).pathname;

interface Fixture {
  root: string;
  bin: string;
  sessionsDir: string;
  unitsDir: string;
  callsLog: string;
  env: NodeJS.ProcessEnv;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "kontrol-stop-all-"));
  const bin = join(root, "bin");
  const sessionsDir = join(root, "sessions");
  const unitsDir = join(root, "units");
  mkdirSync(bin, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(unitsDir, { recursive: true });
  const callsLog = join(root, "calls.log");
  writeFileSync(callsLog, "");
  // Fake tmux: session presence is a file; send-keys C-c gracefully removes
  // it unless STUBBORN is set, kill-session always removes it.
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
log() { echo "tmux $*" >> "${callsLog}"; }
SESSIONS_DIR="${sessionsDir}"
name_of() { # last -t value, stripping a leading = (exact-match selector)
  prev=""; for a in "$@"; do
    if [ "$prev" = "-t" ]; then echo "$a" | sed 's/^=//'; return; fi
    prev="$a";
  done
}
case "$1" in
  has-session) log "$@"; n="\$(name_of "$@")"; [ -f "$SESSIONS_DIR/$n" ] ;;
  send-keys) log "$@"; n="\$(name_of "$@")"; [ -z "\${STUBBORN:-}" ] && rm -f "$SESSIONS_DIR/$n"; exit 0 ;;
  kill-session) log "$@"; n="\$(name_of "$@")"; rm -f "$SESSIONS_DIR/$n"; exit 0 ;;
  list-sessions) for f in "$SESSIONS_DIR"/*; do [ -f "$f" ] && basename "$f"; done; exit 0 ;;
  *) echo "unexpected tmux call: $*" >&2; exit 99 ;;
esac
`, { mode: 0o755 });
  // Fake systemctl: active units are files; stop removes them.
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh
log() { echo "systemctl $*" >> "${callsLog}"; }
UNITS_DIR="${unitsDir}"
case "$1 $2" in
  "--user list-units") log "$@"; for f in "$UNITS_DIR"/*; do [ -f "$f" ] && basename "$f"; done; exit 0 ;;
  "--user stop") log "$@"; rm -f "$UNITS_DIR/$3"; exit 0 ;;
  "--user is-active") log "$@"; [ -f "$UNITS_DIR/$4" ] ;;
  *) echo "unexpected systemctl call: $*" >&2; exit 99 ;;
esac
`, { mode: 0o755 });
  const home = join(root, "home");
  mkdirSync(join(home, "kontrol"), { recursive: true });
  writeFileSync(join(home, "kontrol", "environment"), "PORT=9\n", { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${process.env.PATH ? `:${process.env.PATH}` : ""}`,
    XDG_CONFIG_HOME: home,
    KONTROL_SERVICE_DATA_DIR: join(root, "data"),
    KONTROL_STATE_DIR: join(root, "state"),
    KONTROL_CONFIG_DIR: join(root, "config"),
    KONTROL_USER_ENV_FILE: join(home, "kontrol", "environment"),
    KONTROL_USER_SERVICE_NAME: "kontrol-e2e-stop.service",
  };
  return { root, bin, sessionsDir, unitsDir, callsLog, env };
}

function seedSessions(fixture: Fixture, names: string[]): void {
  for (const name of names) writeFileSync(join(fixture.sessionsDir, name), "live\n");
}

function seedUnits(fixture: Fixture, names: string[]): void {
  for (const name of names) writeFileSync(join(fixture.unitsDir, name), "active\n");
}

function runStopAll(fixture: Fixture, args: string[], extraEnv: NodeJS.ProcessEnv = {}): { exit: number; output: string } {
  try {
    const output = execFileSync("bash", ["stop-all.sh", ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...fixture.env, ...extraEnv },
    });
    return { exit: 0, output: String(output) };
  } catch (error) {
    const failure = error as { status?: number; stdout?: unknown; stderr?: unknown };
    return { exit: failure.status ?? 1, output: `${String(failure.stdout ?? "")}\n${String(failure.stderr ?? "")}` };
  }
}

function calls(fixture: Fixture): string {
  return readFileSync(fixture.callsLog, "utf8");
}

// 1. tmux-only: owned sessions stop, unrelated and prefix-lookalike sessions survive.
{
  const fixture = makeFixture();
  try {
    seedSessions(fixture, ["kontrol-server", "kontrol-adapter-muse", "my-session", "kontrol-server-x", "kontrol-adapter-evil"]);
    const result = runStopAll(fixture, ["--tmux-only"]);
    assert.equal(result.exit, 0, `stop-all.sh --tmux-only exits 0:\n${result.output}`);
    assert.equal(existsSync(join(fixture.sessionsDir, "kontrol-server")), false);
    assert.equal(existsSync(join(fixture.sessionsDir, "kontrol-adapter-muse")), false);
    assert.equal(existsSync(join(fixture.sessionsDir, "my-session")), true, "unrelated session survives");
    assert.equal(existsSync(join(fixture.sessionsDir, "kontrol-server-x")), true, "prefix lookalike survives exact-match stop");
    assert.equal(existsSync(join(fixture.sessionsDir, "kontrol-adapter-evil")), true, "unowned adapter-like session survives");
    assert.ok(calls(fixture).includes("tmux kill-session") || !calls(fixture).includes("STUBBORN"), "escalation path available");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

// 2. Stubborn session: graceful SIGINT fails, kill escalation is used.
{
  const fixture = makeFixture();
  try {
    seedSessions(fixture, ["kontrol-server"]);
    const result = runStopAll(fixture, ["--tmux-only"], { STUBBORN: "1" });
    assert.equal(result.exit, 0, `stubborn session still stops:\n${result.output}`);
    assert.equal(existsSync(join(fixture.sessionsDir, "kontrol-server")), false);
    assert.ok(calls(fixture).includes("tmux send-keys"), "graceful SIGINT attempted first");
    assert.ok(calls(fixture).includes("tmux kill-session"), "escalation kills the survivor");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

// 3. systemd stack stops through the coordinator in reverse order.
{
  const fixture = makeFixture();
  try {
    seedUnits(fixture, ["kontrol-e2e-stop.service", "kontrol.target"]);
    const result = runStopAll(fixture, []);
    assert.equal(result.exit, 0, `systemd stack stops:\n${result.output}`);
    const log = calls(fixture);
    assert.ok(log.includes("systemctl --user stop"), `saw systemctl stop calls:\n${log}`);
    assert.equal(existsSync(join(fixture.unitsDir, "kontrol-e2e-stop.service")), false);
    assert.equal(existsSync(join(fixture.unitsDir, "kontrol.target")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

// 4. Partial shutdown is a failure: an unconfigured-but-live unit survives.
{
  const fixture = makeFixture();
  try {
    // No component configuration exists, so the coordinator only owns the
    // core unit + target; the live tunnel unit is outside the manifest and
    // the stop reports it instead of claiming success.
    seedUnits(fixture, ["kontrol-e2e-stop.service", "kontrol.target", "kontrol-tunnel.service"]);
    const result = runStopAll(fixture, []);
    assert.notEqual(result.exit, 0, "partial shutdown exits nonzero");
    assert.match(result.output, /kontrol-tunnel\.service/, "survivor is named");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

// 5. --systemd-only verifies only the systemd scope: surviving tmux
// sessions are the requested outcome, not a failure.
{
  const fixture = makeFixture();
  try {
    seedSessions(fixture, ["kontrol-server"]);
    const result = runStopAll(fixture, ["--systemd-only"]);
    assert.equal(result.exit, 0, `systemd-only ignores tmux survivors:\n${result.output}`);
    assert.equal(existsSync(join(fixture.sessionsDir, "kontrol-server")), true, "tmux session intentionally survives");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

// 6. --systemd-only still fails when a systemd unit survives.
{
  const fixture = makeFixture();
  try {
    seedUnits(fixture, ["kontrol-tunnel.service"]);
    const result = runStopAll(fixture, ["--systemd-only"]);
    assert.notEqual(result.exit, 0, "systemd survivor fails systemd-only");
    assert.match(result.output, /kontrol-tunnel\.service/, "survivor is named");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

// 7. --core-only stops just the core: surviving auxiliaries on either
// backend are the requested outcome, not a failure.
{
  const fixture = makeFixture();
  try {
    seedUnits(fixture, ["kontrol-e2e-stop.service", "kontrol.target", "kontrol-tunnel.service"]);
    seedSessions(fixture, ["kontrol-tunnel"]);
    const result = runStopAll(fixture, ["--core-only"]);
    assert.equal(result.exit, 0, `core-only ignores auxiliaries:\n${result.output}`);
    assert.equal(existsSync(join(fixture.unitsDir, "kontrol-e2e-stop.service")), false, "core unit stopped");
    assert.equal(existsSync(join(fixture.unitsDir, "kontrol-tunnel.service")), true, "tunnel unit intentionally survives");
    assert.equal(existsSync(join(fixture.unitsDir, "kontrol.target")), true, "target intentionally survives core-only");
    assert.equal(existsSync(join(fixture.sessionsDir, "kontrol-tunnel")), true, "auxiliary session intentionally survives");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

// 8. --core-only fails when the core itself survives the stop.
{
  const fixture = makeFixture();
  try {
    seedUnits(fixture, ["kontrol-e2e-stop.service"]);
    // Stub systemctl stop as a no-op for the core unit so it survives.
    const stub = readFileSync(join(fixture.bin, "systemctl"), "utf8");
    writeFileSync(join(fixture.bin, "systemctl"), stub.replace(
      '"--user stop") log "$@"; rm -f "$UNITS_DIR/$3"; exit 0 ;;',
      '"--user stop") log "$@"; exit 0 ;;',
    ), { mode: 0o755 });
    const result = runStopAll(fixture, ["--core-only"]);
    assert.notEqual(result.exit, 0, "surviving core fails core-only");
    assert.match(result.output, /kontrol-e2e-stop\.service/, "surviving core is named");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

// 9. --tmux-only verifies only the tmux scope: a live systemd stack is
// the requested outcome, not a failure.
{
  const fixture = makeFixture();
  try {
    seedUnits(fixture, ["kontrol-tunnel.service"]);
    const result = runStopAll(fixture, ["--tmux-only"]);
    assert.equal(result.exit, 0, `tmux-only ignores systemd survivors:\n${result.output}`);
    assert.equal(existsSync(join(fixture.unitsDir, "kontrol-tunnel.service")), true, "systemd unit intentionally survives");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

// 10. Concurrent invocations never share scratch state and never write
// temporary files into the checkout.
{
  const fixture = makeFixture();
  try {
    const first = runStopAll(fixture, ["--tmux-only"]);
    const second = runStopAll(fixture, ["--tmux-only"]);
    assert.equal(first.exit, 0);
    assert.equal(second.exit, 0);
    const litter = readdirSync(repoRoot).filter((name) => name.startsWith(".stop-all-"));
    assert.deepEqual(litter, [], "no shared temporary files in the checkout");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

console.log("lifecycle-stop-all.test: PASSED");
