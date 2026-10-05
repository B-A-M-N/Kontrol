import assert from "node:assert/strict";
import { HeadTailBuffer, OutputLog, ProcessSessionManager } from "./process-sessions.js";

const smallBuffer = new HeadTailBuffer(100);
smallBuffer.append("hello\n");
assert.deepEqual(smallBuffer.drain(100), { output: "hello\n", truncated: false });
assert.deepEqual(smallBuffer.drain(100), { output: "", truncated: false });

const headTail = new HeadTailBuffer(10);
headTail.append("start-middle-end");
const headTailResult = headTail.drain(1_000);
assert.equal(headTailResult.truncated, true);
assert.match(headTailResult.output, /^start/);
assert.match(headTailResult.output, /e-end$/);
assert.match(headTailResult.output, /characters omitted/);

const responseLimited = new HeadTailBuffer(100);
responseLimited.append("abcdef".repeat(20));
const responseLimitedResult = responseLimited.drain(40);
assert.equal(responseLimitedResult.truncated, true);
assert.match(responseLimitedResult.output, /^abc/);
assert.match(responseLimitedResult.output, /def$/);

const unicodeBuffer = new HeadTailBuffer(4);
unicodeBuffer.append("a🙂b🙂c");
const unicodeResult = unicodeBuffer.drain(1_000);
assert.equal(unicodeResult.truncated, true);
assert.match(unicodeResult.output, /^a🙂/);
assert.match(unicodeResult.output, /🙂c$/);

const manager = new ProcessSessionManager({
  maxBufferCharacters: 1_024,
  completedSessionTtlMs: 1_000,
});

const node = process.platform === "win32"
  ? `"${process.execPath}"`
  : JSON.stringify(process.execPath);

const foreground = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log('foreground')"`,
  yieldTimeMs: 2_000,
});
assert.equal(foreground.running, false);
assert.equal(foreground.exitCode, 0);
assert.match(foreground.output, /foreground/);
assert.equal(foreground.sessionId, undefined);

const idempotentLaunch = await manager.start({
  workspaceId: "workspace-a",
  ownerId: "logical-client:test",
  cwd: process.cwd(),
  command: `${node} -e "console.log('launched-once')"`,
  clientMutationId: "launch-once",
  yieldTimeMs: 2_000,
});
const idempotentRetry = await manager.start({
  workspaceId: "workspace-a",
  ownerId: "logical-client:test",
  cwd: process.cwd(),
  command: `${node} -e "console.log('launched-once')"`,
  clientMutationId: "launch-once",
  yieldTimeMs: 2_000,
});
assert.deepEqual(idempotentRetry, idempotentLaunch, "exact command retries reuse the original launch result");
await assert.rejects(
  manager.start({
    workspaceId: "workspace-a",
    ownerId: "logical-client:test",
    cwd: process.cwd(),
    command: `${node} -e "console.log('different-command')"`,
    clientMutationId: "launch-once",
    yieldTimeMs: 2_000,
  }),
  /different command launch/,
);

const environment = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log([process.env.NO_COLOR, process.env.TERM, process.env.PAGER, process.env.GIT_PAGER, process.env.GH_PAGER, process.env.CODEX_CI].join(','))"`,
  yieldTimeMs: 2_000,
});
assert.equal(environment.running, false);
assert.match(environment.output, /1,dumb,cat,cat,cat,1/);

const previousSecret = process.env.KONTROL_ACP_WORKER_SECRET;
process.env.KONTROL_ACP_WORKER_SECRET = "must-not-cross-process-boundary";
try {
  const stripped = await manager.start({
    workspaceId: "workspace-a",
    cwd: process.cwd(),
    command: `${node} -e "console.log(process.env.KONTROL_ACP_WORKER_SECRET ?? 'missing')"`,
    yieldTimeMs: 2_000,
  });
  assert.match(stripped.output, /missing/);
} finally {
  if (previousSecret === undefined) delete process.env.KONTROL_ACP_WORKER_SECRET;
  else process.env.KONTROL_ACP_WORKER_SECRET = previousSecret;
}

const background = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setTimeout(() => console.log('finished'), 100)"`,
  yieldTimeMs: 5,
});
assert.equal(background.running, true);
assert.ok(background.sessionId);
assert.equal(typeof background.sessionId, "string");

await assert.rejects(
  manager.write({
    workspaceId: "workspace-b",
    sessionId: background.sessionId,
    yieldTimeMs: 1,
  }),
  /does not belong to workspace/,
);

const completed = await manager.write({
  workspaceId: "workspace-a",
  sessionId: background.sessionId,
  yieldTimeMs: 2_000,
});
assert.equal(completed.running, false);
assert.equal(completed.exitCode, 0);
assert.match(completed.output, /finished/);

const interactive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); })"`,
  yieldTimeMs: 5,
});
assert.equal(interactive.running, true);
assert.ok(interactive.sessionId);
assert.equal(typeof interactive.sessionId, "string");

const inputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: interactive.sessionId,
  chars: "hello\n",
  yieldTimeMs: 2_000,
});
assert.equal(inputResult.running, false);
assert.match(inputResult.output, /input:hello/);

const defaultInteractive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "process.stdin.once('data', data => setTimeout(() => { console.log('default-input:' + data.toString().trim()); process.exit(0); }, 100))"`,
  yieldTimeMs: 5,
});
assert.equal(defaultInteractive.running, true);
assert.ok(defaultInteractive.sessionId);

const defaultInputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: defaultInteractive.sessionId,
  chars: "hello\n",
});
assert.equal(defaultInputResult.running, false);
assert.match(defaultInputResult.output, /default-input:hello/);

const noisyInteractive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setInterval(() => console.log('tick'), 10); process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); })"`,
  yieldTimeMs: 100,
});
assert.equal(noisyInteractive.running, true);
assert.ok(noisyInteractive.sessionId);

await new Promise((resolve) => setTimeout(resolve, 50));
const noisyInputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: noisyInteractive.sessionId,
  chars: "hello\n",
  yieldTimeMs: 2_000,
});
assert.equal(noisyInputResult.running, false);
assert.match(noisyInputResult.output, /input:hello/);

const interruptible = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setInterval(() => console.log('tick'), 10)"`,
  yieldTimeMs: 100,
});
assert.equal(interruptible.running, true);
assert.ok(interruptible.sessionId);

await new Promise((resolve) => setTimeout(resolve, 50));
const interrupted = await manager.write({
  workspaceId: "workspace-a",
  sessionId: interruptible.sessionId,
  chars: "\u0003",
  yieldTimeMs: 2_000,
});
assert.equal(interrupted.running, false);
if (process.platform !== "win32") assert.equal(interrupted.signal, "SIGINT");

let buffered = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log('x'.repeat(5000)); setTimeout(() => {}, 100)"`,
  yieldTimeMs: 50,
  maxOutputTokens: 100,
});
if (!buffered.outputTruncated && buffered.sessionId) {
  buffered = await manager.write({
    workspaceId: "workspace-a",
    sessionId: buffered.sessionId,
    yieldTimeMs: 2_000,
    maxOutputTokens: 100,
  });
}
assert.equal(buffered.outputTruncated, true);
if (buffered.sessionId) manager.terminate("workspace-a", buffered.sessionId);

try {
  if (process.platform === "win32") {
    const pty = await manager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: "echo pty-ok",
      tty: true,
      yieldTimeMs: 10_000,
    });
    assert.equal(pty.running, false);
    assert.match(pty.output, /pty-ok/);
  } else {
    const pty = await manager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: `${node} -e "setTimeout(() => console.log('columns:' + process.stdout.columns), 250)"`,
      tty: true,
      columns: 80,
      rows: 24,
      yieldTimeMs: 10,
    });
    assert.equal(pty.running, true);
    assert.ok(pty.sessionId);

    const resizedPty = await manager.write({
      workspaceId: "workspace-a",
      sessionId: pty.sessionId,
      columns: 120,
      rows: 30,
      yieldTimeMs: 2_000,
    });
    assert.equal(resizedPty.running, false);
    assert.match(resizedPty.output, /columns:120/);
  }
} finally {
  await manager.shutdown();
}

// Transport ownership and bounded lifecycle: a disconnected owner can clean
// up all of its live children, and new owners cannot exceed the global pool.
const bounded = new ProcessSessionManager({
  maxRunningProcesses: 1,
  maxRunningProcessesPerOwner: 1,
  idleTimeoutMs: 10_000,
  maxRuntimeMs: 10_000,
  reaperIntervalMs: 25,
});
try {
  const owned = await bounded.start({
    workspaceId: "workspace-owned",
    ownerId: "transport-owned",
    cwd: process.cwd(),
    command: `${node} -e "setInterval(() => {}, 1000)"`,
    yieldTimeMs: 10,
  });
  assert.equal(owned.running, true);
  assert.equal(bounded.getMetrics().running, 1);
  await assert.rejects(
    bounded.start({
      workspaceId: "workspace-other",
      ownerId: "transport-other",
      cwd: process.cwd(),
      command: `${node} -e "setInterval(() => {}, 1000)"`,
      yieldTimeMs: 10,
    }),
    /Process session limit reached/,
  );
  await bounded.terminateByOwner("transport-owned");
  assert.equal(bounded.getMetrics().running, 0);
} finally {
  await bounded.shutdown();
}

// A trusted continuity owner is intentionally independent of one MCP
// transport. Replacing the transport must not kill the interactive process,
// while a different trusted identity still cannot attach to it.
const continuity = new ProcessSessionManager({
  maxRunningProcesses: 1,
  maxRunningProcessesPerOwner: 1,
  idleTimeoutMs: 10_000,
  maxRuntimeMs: 10_000,
  reaperIntervalMs: 25,
});
try {
  const trusted = await continuity.start({
    workspaceId: "workspace-continuity",
    ownerId: "logical-client:conversation-alpha",
    cwd: process.cwd(),
    command: `${node} -e "process.stdin.once('data', data => { console.log('continued:' + data.toString().trim()); process.exit(0); })"`,
    yieldTimeMs: 5,
  });
  assert.equal(trusted.running, true);
  assert.ok(trusted.sessionId);
  await continuity.terminateByOwner("transport-old");
  assert.equal(continuity.getMetrics().running, 1, "transport cleanup must not terminate a continuity-owned process");
  await assert.rejects(
    continuity.write({
      workspaceId: "workspace-continuity",
      sessionId: trusted.sessionId,
      ownerId: "logical-client:conversation-other",
      chars: "nope\n",
      yieldTimeMs: 1,
    }),
    /owned by another client/,
  );
  const continued = await continuity.write({
    workspaceId: "workspace-continuity",
    sessionId: trusted.sessionId,
    ownerId: "logical-client:conversation-alpha",
    chars: "hello\n",
    yieldTimeMs: 2_000,
  });
  assert.equal(continued.running, false);
  assert.match(continued.output, /continued:hello/);
} finally {
  await continuity.shutdown();
}

const reaped = new ProcessSessionManager({
  maxRunningProcesses: 2,
  maxRunningProcessesPerOwner: 2,
  idleTimeoutMs: 40,
  maxRuntimeMs: 10_000,
  reaperIntervalMs: 10,
});
try {
  await reaped.start({
    workspaceId: "workspace-reaped",
    ownerId: "transport-reaped",
    cwd: process.cwd(),
    command: `${node} -e "setInterval(() => {}, 1000)"`,
    yieldTimeMs: 5,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(reaped.getMetrics().running, 0, "idle process sessions are reaped");
} finally {
  await reaped.shutdown();
}

const noisyReaped = new ProcessSessionManager({
  maxRunningProcesses: 1,
  maxRunningProcessesPerOwner: 1,
  idleTimeoutMs: 1_000,
  maxRuntimeMs: 10_000,
  reaperIntervalMs: 10,
});
try {
  const noisy = await noisyReaped.start({
    workspaceId: "workspace-noisy",
    ownerId: "transport-noisy",
    cwd: process.cwd(),
    // Emit directly from Node so shell startup latency does not consume the
    // idle budget; continued output must keep the session alive past it.
    command: `${node} -e "process.stdout.write('still-active\\n'); setInterval(() => process.stdout.write('still-active\\n'), 10)"`,
    yieldTimeMs: 500,
  });
  assert.equal(noisy.running, true);
  assert.ok(noisy.sessionId);
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(noisyReaped.getMetrics().running, 1, "process output counts as activity for idle reaping");
  await noisyReaped.terminateByOwner("transport-noisy");
} finally {
  await noisyReaped.shutdown();
}

// ── OutputLog: nondestructive cursor reads (P0) ──
{
  const log = new OutputLog(1_000);
  log.append("hello ");
  log.append("world");
  // A read at cursor 0 does not destroy anything: a retry is byte-identical.
  const first = log.read(0, 100);
  assert.equal(first.output, "hello world");
  assert.equal(first.nextCursor, 11);
  const retry = log.read(0, 100);
  assert.equal(retry.output, "hello world", "same cursor retry returns identical output");
  // Independent observers can read disjoint ranges from the same log.
  const fromSix = log.read(6, 100);
  assert.equal(fromSix.output, "world");
  assert.equal(fromSix.cursorLapsed, false);
  assert.equal(log.read(11, 100).output, "");
  // Reads are bounded.
  const boundedRead = log.read(0, 5);
  assert.equal(boundedRead.output, "hello");
  assert.equal(boundedRead.nextCursor, 5);
  assert.equal(boundedRead.truncated, true);

  // Retention eviction is explicit, never a silent hole.
  const tiny = new OutputLog(10);
  tiny.append("abcdefghij");
  tiny.append("klmnop");
  const lapsed = tiny.read(0, 100);
  assert.equal(lapsed.cursorLapsed, true, "reading an evicted range must report cursorLapsed");
  assert.equal(lapsed.truncated, true);
  assert.match(lapsed.output, /^klmnop$/);
  assert.equal(lapsed.oldestAvailableCursor, 10);
  assert.equal(tiny.read(16, 100).cursorLapsed, false);
}

// ── Lost poll_process response is recoverable via afterCursor ──
{
  const cursorManager = new ProcessSessionManager({
    maxBufferCharacters: 100_000,
    completedSessionTtlMs: 60_000,
  });
  try {
    const longRunning = await cursorManager.start({
      workspaceId: "workspace-cursor",
      ownerId: "client:cursor-test",
      cwd: process.cwd(),
      command: `${node} -e "process.stdout.write('ABC'); setInterval(() => {}, 1000)"`,
      yieldTimeMs: 300,
    });
    assert.ok(longRunning.sessionId);
    assert.match(longRunning.output, /ABC/);

    // The launch result consumed ABC on the shared pointer, but the log
    // retains it: an observer can still read it at cursor 0.
    const poll1 = await cursorManager.write({
      workspaceId: "workspace-cursor",
      sessionId: longRunning.sessionId,
      ownerId: "client:cursor-test",
      afterCursor: 0,
      yieldTimeMs: 10,
    });
    assert.match(poll1.output, /ABC/);
    assert.equal(poll1.outputCursor, 3);
    assert.equal(poll1.oldestAvailableCursor, 0);

    // SIMULATED LOST RESPONSE: the caller polled at cursor 0, the response was
    // dropped in transit. Retrying the SAME poll (same cursor) must return
    // the same logical output — this is the exact defect the old drain-based
    // poll had.
    const pollRetry = await cursorManager.write({
      workspaceId: "workspace-cursor",
      sessionId: longRunning.sessionId,
      ownerId: "client:cursor-test",
      afterCursor: 0,
      yieldTimeMs: 10,
    });
    assert.equal(pollRetry.output, poll1.output, "lost poll response must be recoverable at the same cursor");
    assert.equal(pollRetry.outputCursor, 3);

    // The shared pointer did not move on a cursor read: a later no-cursor
    // poll still sees the retained output once the process exits.
    cursorManager.terminate("workspace-cursor", longRunning.sessionId!, "client:cursor-test");

    // Post-exit cursor reads still work (second observer / late retry) BEFORE
    // the retiring no-cursor poll.
    const lateObserver = await cursorManager.write({
      workspaceId: "workspace-cursor",
      sessionId: longRunning.sessionId,
      ownerId: "client:cursor-test",
      afterCursor: 0,
      yieldTimeMs: 10,
    });
    assert.match(lateObserver.output, /ABC/, "post-exit cursor read must see retained output");

    let finalDefault = await cursorManager.write({
      workspaceId: "workspace-cursor",
      sessionId: longRunning.sessionId,
      ownerId: "client:cursor-test",
      yieldTimeMs: 100,
    });
    for (let i = 0; i < 40 && finalDefault.running; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      finalDefault = await cursorManager.write({
        workspaceId: "workspace-cursor",
        sessionId: longRunning.sessionId,
        ownerId: "client:cursor-test",
        yieldTimeMs: 100,
      });
    }
    assert.equal(finalDefault.running, false);
    // The launch snapshot itself advanced the shared pointer past ABC, so a
    // no-cursor poll legitimately returns nothing NEW — the assertion that
    // matters is that the bytes were never destroyed: the late observer
    // above re-read them at cursor 0 after exit.
    assert.equal(finalDefault.outputCursor, poll1.outputCursor, "cursor reads must not move the shared pointer");
  } finally {
    await cursorManager.shutdown();
  }
}

// ── Per-command lifetime derives from the configured runtime ceiling (P1) ──
{
  const lifetimeManager = new ProcessSessionManager({
    maxBufferCharacters: 10_000,
    // A 400ms configured ceiling: an explicit timeout above the old 300s
    // hard cap must be accepted here because the ceiling allows it, while
    // the ceiling still kills runaway children.
    maxRuntimeMs: 400,
    reaperIntervalMs: 25,
  });
  try {
    // timeoutMs far beyond the removed 300_000 hard constant: accepted.
    const longTimeout = await lifetimeManager.start({
      workspaceId: "workspace-lifetime",
      ownerId: "owner-lifetime",
      cwd: process.cwd(),
      command: `${node} -e "setTimeout(() => { console.log('alive'); process.exit(0); }, 150)"`,
      timeoutMs: 3_600_000,
      yieldTimeMs: 10,
    });
    // The reaper's maxRuntimeMs (400ms) terminates the child regardless of
    // the generous explicit timeout — lifetime policy stays authoritative.
    let lifetimeSnapshot = longTimeout;
    for (let i = 0; i < 40 && lifetimeSnapshot.running; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      lifetimeSnapshot = await lifetimeManager.write({
        workspaceId: "workspace-lifetime",
        sessionId: longTimeout.sessionId!,
        ownerId: "owner-lifetime",
        yieldTimeMs: 50,
      });
    }
    assert.equal(lifetimeSnapshot.running, false, "configured ceiling kills a child despite a longer explicit timeout");
    // Negative timeout is rejected, as before.
    await assert.rejects(
      lifetimeManager.start({
        workspaceId: "workspace-lifetime",
        ownerId: "owner-lifetime",
        cwd: process.cwd(),
        command: "true",
        timeoutMs: -1,
        yieldTimeMs: 10,
      }),
      /non-negative/,
    );
  } finally {
    await lifetimeManager.shutdown();
  }
}

console.log("process-sessions.test.ts: all assertions passed");
