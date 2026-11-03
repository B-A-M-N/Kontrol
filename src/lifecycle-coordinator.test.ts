import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANAGED_TMUX_SESSIONS,
  SCHEMA_INCOMPATIBLE_EXIT_CODE,
  aggregateLifecycleStatus,
  buildLifecycleManifest,
  decideStackStart,
  isManagedTmuxSession,
  isPermanentConfigFailure,
  listTmuxSessions,
  planFencedTakeover,
  preflightArtifactCompatibility,
  resolveActiveBackend,
  startOrder,
  stopOrder,
} from "./lifecycle-coordinator.js";

// ── Manifest: single source both backends enumerate ──
{
  const manifest = buildLifecycleManifest({
    coreServiceName: "kontrol-core.service",
    components: [
      { name: "tunnel", kind: "tunnel", command: ["tunnel-client"], port: 7676 },
      { name: "crush", kind: "adapter", command: ["crush"] },
    ],
  });
  assert.equal(manifest.length, 3);
  assert.equal(manifest[0].name, "core");
  assert.equal(manifest[0].systemdUnit, "kontrol-core.service");
  assert.equal(manifest[0].tmuxSession, "kontrol-server");
  assert.equal(manifest[0].required, true);
  assert.equal(manifest[1].systemdUnit, "kontrol-tunnel.service");
  assert.equal(manifest[1].tmuxSession, "kontrol-tunnel");
  assert.equal(manifest[1].port, 7676);
  assert.equal(manifest[2].systemdUnit, "kontrol-crush.service");
  assert.equal(manifest[2].tmuxSession, "kontrol-adapter-crush");
  assert.deepEqual(startOrder(manifest).map((c) => c.name), ["core", "tunnel", "crush"]);
  assert.deepEqual(stopOrder(manifest).map((c) => c.name), ["crush", "tunnel", "core"]);
}

// ── Exact tmux ownership: no prefix collisions ──
{
  for (const session of ["kontrol-server", "kontrol-tunnel", "kontrol-supervisor", "kontrol-adapter", "kontrol-adapter-crush", "kontrol-adapter-hermes", "kontrol-adapter-muse", "kontrol-adapter-musefi", "kontrol-beta-soak"]) {
    assert.equal(isManagedTmuxSession(session), true, session);
  }
  assert.equal(MANAGED_TMUX_SESSIONS.length, 9);
  for (const innocent of ["kontrol-server-x", "xkontrol-server", "kontrol-adapter-evil", "my-session", "kontrol-stdio-rogue"]) {
    assert.equal(isManagedTmuxSession(innocent), false, innocent);
  }
}

// ── Backend resolution: fail closed on probe failure ──
{
  const ok = (names: string[]) => ({ status: "ok" as const, names });
  const down = (reason: string) => ({ status: "unavailable" as const, reason });

  const none = resolveActiveBackend({ listActiveSystemdUnits: () => ok([]), listTmuxSessions: () => ok([]) });
  assert.equal(none.backend, "none");
  assert.deepEqual(none.probeErrors, []);

  const systemdOnly = resolveActiveBackend({
    listActiveSystemdUnits: () => ok(["kontrol-core.service", "kontrol.target", "user@1000.service"]),
    listTmuxSessions: () => ok([]),
  });
  assert.equal(systemdOnly.backend, "systemd");
  assert.deepEqual(systemdOnly.systemdUnits.sort(), ["kontrol-core.service", "kontrol.target"]);

  const tmuxOnly = resolveActiveBackend({
    listActiveSystemdUnits: () => ok([]),
    listTmuxSessions: () => ok(["kontrol-server", "kontrol-tunnel", "unrelated"]),
  });
  assert.equal(tmuxOnly.backend, "tmux");
  assert.deepEqual(tmuxOnly.tmuxSessions.sort(), ["kontrol-server", "kontrol-tunnel"]);

  const mixed = resolveActiveBackend({
    listActiveSystemdUnits: () => ok(["kontrol-tunnel.service"]),
    listTmuxSessions: () => ok(["kontrol-server"]),
  });
  assert.equal(mixed.backend, "mixed");

  // A throwing probe is an unavailable backend, never an empty one:
  // resolution reports unknown instead of "none".
  const failed = resolveActiveBackend({
    listActiveSystemdUnits: () => { throw new Error("no systemd"); },
    listTmuxSessions: () => { throw new Error("no tmux"); },
  });
  assert.equal(failed.backend, "unknown");
  assert.equal(failed.probeErrors.length, 2);

  // An explicitly unavailable outcome is unknown even when the other
  // backend is positively empty.
  const halfBlind = resolveActiveBackend({
    listActiveSystemdUnits: () => down("systemctl bus is down"),
    listTmuxSessions: () => ok([]),
  });
  assert.equal(halfBlind.backend, "unknown");
}

// ── Start fencing: no bypass, unknown fails closed ──
{
  const ok = (names: string[]) => ({ status: "ok" as const, names });
  const idle = resolveActiveBackend({ listActiveSystemdUnits: () => ok([]), listTmuxSessions: () => ok([]) });
  assert.deepEqual(decideStackStart({ requested: "tmux", active: idle }), { ok: true });

  const systemdActive = resolveActiveBackend({
    listActiveSystemdUnits: () => ok(["kontrol-core.service"]),
    listTmuxSessions: () => ok([]),
  });
  const refused = decideStackStart({ requested: "tmux", active: systemdActive });
  assert.equal(refused.ok, false);
  assert.match((refused as { reason: string }).reason, /systemd.*already owns|kontrol-core\.service/);
  // Same-backend restart stays idempotent.
  assert.deepEqual(decideStackStart({ requested: "systemd", active: systemdActive }), { ok: true });

  // Unknown ownership refuses even the otherwise-idle backend.
  const unknown = resolveActiveBackend({
    listActiveSystemdUnits: () => ({ status: "unavailable" as const, reason: "bus down" }),
    listTmuxSessions: () => ok([]),
  });
  const unknownRefused = decideStackStart({ requested: "tmux", active: unknown });
  assert.equal(unknownRefused.ok, false);
  assert.match((unknownRefused as { reason: string }).reason, /unknown/);

  const mixed = resolveActiveBackend({
    listActiveSystemdUnits: () => ok(["kontrol-tunnel.service"]),
    listTmuxSessions: () => ok(["kontrol-server"]),
  });
  const mixedRefused = decideStackStart({ requested: "systemd", active: mixed });
  assert.equal(mixedRefused.ok, false);
  assert.match((mixedRefused as { reason: string }).reason, /both systemd.*and tmux/);
}

// ── Fenced takeover: stop-then-verify plan, never a bypass ──
{
  const ok = (names: string[]) => ({ status: "ok" as const, names });
  const idle = resolveActiveBackend({ listActiveSystemdUnits: () => ok([]), listTmuxSessions: () => ok([]) });
  assert.deepEqual(planFencedTakeover({ requested: "tmux", active: idle }), { status: "clear" });

  const systemdActive = resolveActiveBackend({
    listActiveSystemdUnits: () => ok(["kontrol-core.service"]),
    listTmuxSessions: () => ok([]),
  });
  assert.deepEqual(planFencedTakeover({ requested: "tmux", active: systemdActive }), {
    status: "takeover",
    stopBackend: "systemd",
    owned: ["kontrol-core.service"],
  });
  // Same-backend needs nothing.
  assert.deepEqual(planFencedTakeover({ requested: "systemd", active: systemdActive }), { status: "clear" });

  const mixed = resolveActiveBackend({
    listActiveSystemdUnits: () => ok(["kontrol-tunnel.service"]),
    listTmuxSessions: () => ok(["kontrol-server"]),
  });
  assert.deepEqual(planFencedTakeover({ requested: "tmux", active: mixed }), {
    status: "refused",
    reason: "takeover refused: both backends own live components; stop one stack explicitly first",
  });

  const unknown = resolveActiveBackend({
    listActiveSystemdUnits: () => ({ status: "unavailable" as const, reason: "bus down" }),
    listTmuxSessions: () => ok([]),
  });
  const unknownPlan = planFencedTakeover({ requested: "tmux", active: unknown });
  assert.equal(unknownPlan.status, "refused");
  assert.match((unknownPlan as { status: "refused"; reason: string }).reason, /unknown/);
}

// ── Aggregate status ──
{
  const ready = aggregateLifecycleStatus({
    components: [
      { name: "core", required: true, active: true, failed: false },
      { name: "tunnel", required: true, active: true, failed: false },
    ],
    coreReady: true,
  });
  assert.equal(ready.verdict, "READY");

  const running = aggregateLifecycleStatus({
    components: [{ name: "core", required: true, active: true, failed: false }],
    coreReady: false,
  });
  assert.equal(running.verdict, "RUNNING");

  const stopped = aggregateLifecycleStatus({ components: [{ name: "core", required: true, active: false, failed: false }], coreReady: false });
  assert.equal(stopped.verdict, "STOPPED");

  // The observed incident: core dead while the tunnel stays alive.
  const coreDead = aggregateLifecycleStatus({
    components: [
      { name: "core", required: true, active: false, failed: true, detail: "schema 116 exceeds read limit 113" },
      { name: "tunnel", required: true, active: true, failed: false },
    ],
    coreReady: false,
  });
  assert.equal(coreDead.verdict, "BLOCKED");
  assert.ok(coreDead.reasons.some((r) => r.includes("core is down while auxiliary components remain alive")));

  const degraded = aggregateLifecycleStatus({
    components: [
      { name: "core", required: true, active: true, failed: false },
      { name: "tunnel", required: true, active: false, failed: false },
    ],
    coreReady: true,
  });
  assert.equal(degraded.verdict, "DEGRADED");

  const blocked = aggregateLifecycleStatus({
    components: [{ name: "core", required: true, active: false, failed: false }],
    coreReady: false,
    permanentFailures: ["database schema 116 exceeds candidate read limit 113"],
  });
  assert.equal(blocked.verdict, "BLOCKED");
}

// ── Failure classification: permanent config failures never retry ──
{
  assert.equal(SCHEMA_INCOMPATIBLE_EXIT_CODE, 78);
  assert.equal(isPermanentConfigFailure({ exitCode: 78 }), true);
  assert.equal(isPermanentConfigFailure({ exitCode: 1 }), false);
  assert.equal(isPermanentConfigFailure({ exitCode: 1, stderr: "Kontrol database schema 116 is newer than this candidate can read (maximum 113); refusing startup before mutation." }), true);
  assert.equal(isPermanentConfigFailure({ exitCode: 1, stderr: "connection refused" }), false);
  assert.equal(isPermanentConfigFailure({}), false);
}

// ── Preflight: reject incompatible candidates before any mutation ──
{
  const candidate = { buildId: "167fc77c58ba349b", schemaVersion: 116, minReadableSchemaVersion: 0, maxReadableSchemaVersion: 116 };
  assert.deepEqual(preflightArtifactCompatibility(candidate, 116), { compatible: true });
  assert.deepEqual(preflightArtifactCompatibility(candidate, 113), { compatible: true });

  const stale = { buildId: "473f017ec90bd54f", schemaVersion: 111, minReadableSchemaVersion: 0, maxReadableSchemaVersion: 113 };
  const refused = preflightArtifactCompatibility(stale, 116);
  assert.equal(refused.compatible, false);
  assert.match((refused as { compatible: false; reason: string }).reason, /database schema 116 exceeds candidate read limit 113/);

  // The minimum bound is enforced too: a candidate that cannot read an
  // older live database is just as incompatible as one that cannot read
  // a newer one.
  const futureOnly = { buildId: "future", schemaVersion: 120, minReadableSchemaVersion: 118, maxReadableSchemaVersion: 120 };
  const tooOld = preflightArtifactCompatibility(futureOnly, 116);
  assert.equal(tooOld.compatible, false);
  assert.match((tooOld as { compatible: false; reason: string }).reason, /predates candidate minimum readable schema 118/);
  assert.deepEqual(preflightArtifactCompatibility(futureOnly, 118), { compatible: true });
  assert.deepEqual(preflightArtifactCompatibility(futureOnly, 120), { compatible: true });

  const unreadable = preflightArtifactCompatibility(candidate, Number.NaN);
  assert.equal(unreadable.compatible, false);
}

// ── Shell/coordinator parity: stop-all.sh owns exactly the managed set ──
{
  const stopAll = readFileSync(new URL("../stop-all.sh", import.meta.url), "utf8");
  for (const session of MANAGED_TMUX_SESSIONS) {
    assert.ok(stopAll.includes(`"${session}"`), `stop-all.sh must own ${session}`);
  }
  assert.ok(!stopAll.includes('-t "$s"'), "stop-all.sh must use exact-match (=name) tmux selectors");
  assert.ok(stopAll.includes('-t "=$s"'), "stop-all.sh must use exact-match (=name) tmux selectors");
}

// ── start-all.sh: a fence refusal must never enter rollback ──
{
  const startAll = readFileSync(new URL("../start-all.sh", import.meta.url), "utf8");
  // The fence sets the refusal flag before exiting ...
  assert.ok(startAll.includes("LIFECYCLE_FENCE_REFUSED=1"), "fence refusal sets LIFECYCLE_FENCE_REFUSED");
  // ... and on_exit honors it before any rollback path.
  const onExitStart = startAll.indexOf("on_exit() {");
  assert.ok(onExitStart >= 0, "on_exit exists");
  const fenceGuard = startAll.indexOf('LIFECYCLE_FENCE_REFUSED:-0', onExitStart);
  assert.ok(fenceGuard > onExitStart, "on_exit checks the fence-refusal flag");
  const rollbackCall = startAll.indexOf("\n    rollback", onExitStart);
  assert.ok(rollbackCall > fenceGuard, "fence-refusal short-circuit precedes rollback in on_exit");
}

// ── lifecycle-cli: real process, hermetic PATH shims ──
{
  const bin = mkdtempSync(join(tmpdir(), "kontrol-lifecycle-cli-"));
  const writeShim = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  // No systemd units, no tmux server (tmux reports "no server", which is a
  // genuinely empty backend — not a probe failure).
  writeShim("systemctl", "exit 0");
  writeShim("tmux", 'echo "no server running on /tmp/fixture" >&2\nexit 1');
  const repoRoot = new URL("..", import.meta.url).pathname;
  const runCli = (args: string[], extraPath?: string) => execFileSync(process.execPath, ["--import", "tsx", "src/lifecycle-cli.ts", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, PATH: `${extraPath ?? bin}${process.env.PATH ? `:${process.env.PATH}` : ""}` },
  });

  const resolved = JSON.parse(runCli(["resolve-backend"])) as { backend: string };
  assert.equal(resolved.backend, "none");

  const shellOut = runCli(["resolve-backend", "--format=shell"]);
  assert.match(shellOut, /LIFECYCLE_BACKEND='none'/);

  // check-start passes through on an idle machine.
  runCli(["check-start", "--backend=tmux"]);

  // Now simulate an active systemd core: tmux start must refuse (exit 3).
  const binConflict = mkdtempSync(join(tmpdir(), "kontrol-lifecycle-conflict-"));
  writeFileSync(join(binConflict, "systemctl"), '#!/bin/sh\necho "kontrol-core.service loaded active running"\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(binConflict, "tmux"), '#!/bin/sh\necho "no server running on /tmp/fixture" >&2\nexit 1\n', { mode: 0o755 });
  let refused: unknown = null;
  try {
    runCli(["check-start", "--backend=tmux"], binConflict);
  } catch (error) {
    refused = error;
  }
  assert.ok(refused instanceof Error, "check-start must fail on conflicting owner");
  assert.match(String((refused as { stderr?: string }).stderr ?? refused), /already owns/);
  // A blind takeover flag is rejected: the fence must be crossed through
  // the takeover transaction, never bypassed.
  let bypassed: unknown = null;
  try {
    runCli(["check-start", "--backend=tmux", "--takeover"], binConflict);
  } catch (error) {
    bypassed = error;
  }
  assert.ok(bypassed instanceof Error, "takeover flag must not bypass the fence");
  rmSync(bin, { recursive: true, force: true });
  rmSync(binConflict, { recursive: true, force: true });
}

// ── takeover-stack: stateful shim proves stop-then-verify ──
{
  const root = mkdtempSync(join(tmpdir(), "kontrol-takeover-"));
  try {
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const stateFile = join(root, "units.txt");
    writeFileSync(stateFile, "");
    // Stateful systemctl shim: list-units reflects the file; stop removes a line.
    writeFileSync(join(binDir, "systemctl"), `#!/bin/sh\nSTATE=${JSON.stringify(stateFile)}\ncase "$1 $2" in\n"--user list-units") [ -f "$STATE" ] && cat "$STATE"; exit 0 ;;\n"--user stop") [ -f "$STATE" ] && { grep -vx "$3" "$STATE" > "$STATE.tmp"; mv "$STATE.tmp" "$STATE"; }; exit 0 ;;\n*) exit 99 ;;\nesac\n`, { mode: 0o755 });
    writeFileSync(join(binDir, "tmux"), '#!/bin/sh\necho "no server running on /tmp/fixture" >&2\nexit 1\n', { mode: 0o755 });
    const repoRoot = new URL("..", import.meta.url).pathname;
    const runCli = (args: string[]) => execFileSync(process.execPath, ["--import", "tsx", "src/lifecycle-cli.ts", ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        PATH: `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ""}`,
        XDG_CONFIG_HOME: join(root, "home"),
        KONTROL_CONFIG_DIR: join(root, "config"),
        KONTROL_STATE_DIR: join(root, "state"),
      },
    });
    // The takeover flow emits one JSON receipt per step; the final line is
    // the takeover verdict.
    const lastJsonLine = (output: string) => output.trim().split("\n").filter(Boolean).at(-1) as string;
    // Idle target needs nothing.
    const idleOut = JSON.parse(lastJsonLine(runCli(["takeover-stack", "--to=tmux"]))) as { tookOver: boolean };
    assert.equal(idleOut.tookOver, false);
    // Conflicting owner is stopped and verified gone through the real CLI.
    writeFileSync(stateFile, "kontrol-core.service\n");
    const took = JSON.parse(lastJsonLine(runCli(["takeover-stack", "--to=tmux"]))) as { tookOver: boolean; stopped: string[] };
    assert.equal(took.tookOver, true);
    assert.deepEqual(took.stopped, ["kontrol-core.service"]);
    assert.equal(readFileSync(stateFile, "utf8"), "", "conflicting unit is actually stopped, not just planned");
    // And the fence now observes a clear stack.
    runCli(["check-start", "--backend=tmux"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── Real tmux probe: idle states are empty, failures are unavailable ──
{
  const root = mkdtempSync(join(tmpdir(), "kontrol-tmux-probe-"));
  const previousPath = process.env.PATH;
  try {
    const fakeBin = join(root, "bin");
    mkdirSync(fakeBin, { recursive: true });
    const fakeTmux = join(fakeBin, "tmux");
    const setFake = (body: string): void => {
      writeFileSync(fakeTmux, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    };
    process.env.PATH = `${fakeBin}${previousPath ? `:${previousPath}` : ""}`;
    // Sessions listed on stdout parse to names.
    setFake('printf "kontrol-server\\nkontrol-tunnel\\n"');
    assert.deepEqual(listTmuxSessions(), { status: "ok", names: ["kontrol-server", "kontrol-tunnel"] });
    // No daemon at all is a genuinely empty backend, not a probe failure.
    setFake('echo "no server running on /tmp/tmux-1000/default" >&2; exit 1');
    assert.deepEqual(listTmuxSessions(), { status: "ok", names: [] });
    // Daemon alive with zero sessions is likewise empty.
    setFake('echo "no sessions" >&2; exit 1');
    assert.deepEqual(listTmuxSessions(), { status: "ok", names: [] });
    // Socket errors stay unavailable: absence of evidence, never evidence.
    setFake('echo "error connecting to /tmp/tmux-1000/default: connection refused" >&2; exit 1');
    const refused = listTmuxSessions();
    assert.equal(refused.status, "unavailable");
    assert.match((refused as { reason: string }).reason, /exited 1/);
  } finally {
    process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
  // A missing tmux binary is unavailable, never an empty backend.
  {
    const empty = mkdtempSync(join(tmpdir(), "kontrol-no-tmux-"));
    const saved = process.env.PATH;
    try {
      process.env.PATH = empty;
      assert.equal(listTmuxSessions().status, "unavailable");
    } finally {
      process.env.PATH = saved;
      rmSync(empty, { recursive: true, force: true });
    }
  }
}

// ── takeover/stop-tmux: only managed sessions are ever touched ──
{
  const root = mkdtempSync(join(tmpdir(), "kontrol-tmux-takeover-"));
  try {
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const stateFile = join(root, "sessions.txt");
    const callsFile = join(root, "calls.txt");
    // kontrol-server is stubbled: SIGINT never drains it, kill-session does.
    // my-session is unrelated; kontrol-server-x only shares a prefix.
    writeFileSync(stateFile, "kontrol-server\nmy-session\nkontrol-server-x\n");
    writeFileSync(callsFile, "");
    writeFileSync(join(binDir, "tmux"), [
      "#!/bin/sh",
      `STATE=${JSON.stringify(stateFile)}`,
      `CALLS=${JSON.stringify(callsFile)}`,
      'target=""',
      'for arg in "$@"; do',
      '  case "$arg" in -t|-s) want_target=1;;',
      '    *) if [ "${want_target:-}" = 1 ]; then target="$arg"; want_target=0; fi;;',
      "  esac",
      "done",
      'case "$target" in =*) target="${target#=}";; esac',
      'case "$1" in',
      '  list-sessions) if [ -s "$STATE" ]; then cat "$STATE"; else echo "no server running" >&2; exit 1; fi ;;',
      '  has-session) grep -qx "$target" "$STATE" ;;',
      '  send-keys) echo "send-keys $target" >> "$CALLS"; exit 0 ;;',
      '  kill-session)',
      '    echo "kill-session $target" >> "$CALLS"',
      '    grep -vx "$target" "$STATE" > "$STATE.tmp"; mv "$STATE.tmp" "$STATE"; exit 0 ;;',
      '  *) exit 99 ;;',
      "esac",
    ].join("\n") + "\n", { mode: 0o755 });
    writeFileSync(join(binDir, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const repoRoot = new URL("..", import.meta.url).pathname;
    const runCli = (args: string[]) => execFileSync(process.execPath, ["--import", "tsx", "src/lifecycle-cli.ts", ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        PATH: `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ""}`,
        XDG_CONFIG_HOME: join(root, "home"),
        KONTROL_CONFIG_DIR: join(root, "config"),
        KONTROL_STATE_DIR: join(root, "state"),
      },
    });
    const lastJsonLine = (output: string) => output.trim().split("\n").filter(Boolean).at(-1) as string;
    // Take over systemd from the conflicting tmux stack: only the managed
    // session may be terminated; the escalation path must run because the
    // stubborn session ignores SIGINT.
    const took = JSON.parse(lastJsonLine(runCli(["takeover-stack", "--to=systemd"]))) as { tookOver: boolean };
    assert.equal(took.tookOver, true, "takeover from a conflicting tmux stack succeeds");
    const survivors = readFileSync(stateFile, "utf8").split("\n").filter(Boolean).sort();
    assert.deepEqual(survivors, ["kontrol-server-x", "my-session"], "only the managed session is terminated");
    const calls = readFileSync(callsFile, "utf8");
    assert.ok(calls.includes("send-keys kontrol-server"), "managed session gets graceful SIGINT first");
    assert.ok(calls.includes("kill-session kontrol-server"), "stubborn managed session is escalated");
    assert.ok(!calls.includes("my-session"), "unrelated session is never signaled or killed");
    assert.ok(!calls.includes("kontrol-server-x"), "prefix lookalike is never signaled or killed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("lifecycle-coordinator.test: PASSED");
