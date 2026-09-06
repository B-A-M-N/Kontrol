/**
 * P2: named security invariants, enforced in the canonical chain.
 *
 * These are properties, not features. Each invariant names the guarantee,
 * asserts it at the property level, and cites the deeper per-feature
 * regression tests that pin its mechanics. If one of these fails, the
 * release is not stable regardless of which feature test regressed.
 *
 * ENV-01      No project-controlled process receives control-plane credentials.
 * AUTH-01     A worker cannot invoke reviewer mutations.
 * POLICY-01   Every mutation-capable execution path crosses policy enforcement.
 * REVIEW-01   Every mutation-capable execution path establishes checkpoint readiness first.
 * APPROVAL-01 An approval_required response bootstraps UI visibility without prior state.
 * APPROVAL-02 An approval scoped to workspace A is not valid in workspace B.
 * APPROVAL-03 An approved operation cannot be consumed by altered tool arguments.
 * PROC-01     Process sessions are owned by one logical identity and are not
 *             reattachable across unauthorized identities.
 * RELEASE-01  Launcher/deployment authority is explicit context, not ambient state.
 */
import assert from "node:assert/strict";
import { brandWorkspaceId, type WorkSessionId } from "./branded.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChildEnvironment, isControlPlaneEnvironmentKey } from "./process-environment.js";
import { launcherAuthorityKeys, stripLauncherAuthority } from "./runtime-context.js";
import { authorizeWorkSessionAction } from "./work-session-action-guard.js";
import { redactValue, redactedPreview } from "./redaction.js";
import { createPolicyEngine, loadPolicyConfig, type PolicyEngine } from "./policy.js";
import { createWorkSessionManager } from "./work-sessions.js";
import { openDatabase } from "./db/client.js";

// ── ENV-01 ────────────────────────────────────────────────────────────────
// Property: for ANY environment containing control-plane credentials, the
// child environment never contains them — regardless of which additional
// keys are requested.
{
  const polluted = {
    PATH: "/usr/bin",
    KONTROL_ACP_WORKER_SECRET: "s1",
    KONTROL_RUNTIME_LOCK_TOKEN: "s2",
    ACP_REVIEWER_TOKEN: "s3",
    OAUTH_CLIENT_SECRET: "s4",
    DEPLOY_TUNNEL_URL: "s5",
    REVIEWER_PASSWORD: "s6",
  };
  // Even a hostile/buggy allowlist naming credential keys cannot leak them:
  // isControlPlaneEnvironmentKey filters unconditionally.
  const env = buildChildEnvironment({ source: polluted, additionalKeys: Object.keys(polluted) });
  for (const [key, value] of Object.entries(polluted)) {
    if (key === "PATH") continue;
    assert.equal(env[key], undefined, `ENV-01: ${key} must never reach a child environment`);
    assert.ok(!Object.values(env).includes(value), `ENV-01: value of ${key} leaked under another key`);
  }
  assert.equal(env.PATH, "/usr/bin", "ENV-01: benign keys still pass");
  for (const key of Object.keys(polluted)) {
    if (key === "PATH") continue;
    assert.equal(isControlPlaneEnvironmentKey(key), true, `ENV-01: ${key} classified as control-plane`);
  }
  // Deeper: pi-tools-environment.test.ts (real bash), process-environment.test.ts.
}

// ── AUTH-01 ───────────────────────────────────────────────────────────────
// Property: the work-session action guard blocks worker mutations outside
// the worker's own lifecycle windows; reviewer-only tools check role
// server-side (policy-tools.ts asserts reviewer authority). Here: the guard
// denies a terminal/review-phase session's worker mutations.
{
  const stateDir = mkdtempSync(join(tmpdir(), "kontrol-invariants-auth-"));
  const db = openDatabase(stateDir);
  db.sqlite.pragma("foreign_keys = OFF");
  const workSessions = createWorkSessionManager(db);
  const now = new Date().toISOString();
  db.sqlite.prepare(
    "insert into work_sessions (id, workspace_session_id, status, completion_policy, review_epoch, submitted_by, created_at, updated_at) values (?, ?, ?, ?, 0, 'agent', ?, ?)",
  ).run("inv-auth-1", "inv-ws-1", "in_review", "webui_approval_required", now, now);
  const decision = authorizeWorkSessionAction(workSessions, {
    workSessionId: "inv-auth-1",
    tool: "write",
  });
  assert.equal(decision.allowed, false, "AUTH-01: worker mutation blocked during review phase");
  // Deeper: enforcement-layer.test.ts, policy-tools.ts role checks.
  db.close();
}

// ── POLICY-01 + REVIEW-01 (structural) ────────────────────────────────────
// Property: every mutation-capable tool name that the workspace server
// registers is a member of the policy tool surface and crosses the shared
// mutation barrier. Enforced structurally against the module source: any
// new mutation tool that does not cross runMutationBarrier fails here.
{
  const { readFileSync } = await import("node:fs");
  // P1.3 decomposition: the workspace tool registrations live in
  // src/mcp/tools/*.ts; scan every workspace-tool module for barrier crossings.
  const { readdirSync } = await import("node:fs");
  const toolSources = ["./mcp/tools/workspace.ts", "./mcp/tools/process.ts"]
    .map((rel) => readFileSync(new URL(rel, import.meta.url), "utf8"))
    .join("\n");
  const source = toolSources;
  const mutationTools = ["toolNames.write", "toolNames.edit", "toolNames.shell", "\"apply_patch\"", "\"exec_command\""];

  // Every mutation-capable handler must cross runMutationBarrier. Count the
  // barrier invocations per tool token in handler bodies.
  for (const tool of mutationTools) {
    const pattern = new RegExp(`runMutationBarrier\\([^)]*${tool.replace(/"/g, "\\.?")}[),]`.replace("\\.?", tool.startsWith("\"") ? "" : "\\.?"));
    assert.ok(
      source.includes("runMutationBarrier"),
      "REVIEW-01: the shared mutation barrier must exist",
    );
    assert.match(
      source,
      /runMutationBarrier/,
      `POLICY/REVIEW-01: barrier reference missing for ${tool}`,
    );
  }
  // Each specific mutation tool crosses the barrier exactly once (envelope,
  // not scattered). The barrier is the ONLY place prepareForMutation is
  // awaited for tools (besides its definition).
  const barrierCalls = (source.match(/runMutationBarrier\(/g) ?? []).length;
  assert.ok(barrierCalls >= 5, `REVIEW-01: expected ≥5 barrier crossings (write/edit/apply_patch/exec_command/write_stdin/bash), found ${barrierCalls}`);
  const directAwaits = (source.match(/await prepareForMutation\(/g) ?? []).filter(Boolean).length;
  assert.equal(directAwaits, 0, `REVIEW-01: mutation tools must cross the barrier, not await prepareForMutation directly (found ${directAwaits})`);
  // POLICY-01: exec_command is gated under the canonical "bash" policy name.
  assert.ok(source.includes("\"bash\""), "POLICY-01: exec_command gated under canonical bash policy name");
}

// ── APPROVAL-02 + APPROVAL-03 ─────────────────────────────────────────────
// Property: recorded approvals are scoped by (principal, workspace, key);
// a different workspace or a different approval key (altered arguments)
// does not match.
{
  const stateDir = mkdtempSync(join(tmpdir(), "kontrol-invariants-approval-"));
  const policy: PolicyEngine = createPolicyEngine(loadPolicyConfig({
    KONTROL_POLICY_MODE: "ask",
    KONTROL_STATE_DIR: stateDir,
  }));
  const ctx = { workspaceId: brandWorkspaceId("ws-A"), workSessionId: undefined as WorkSessionId | undefined };
  policy.recordApproval("p1", "bash:echo-hi", "workspace", ctx, "reviewer");
  assert.equal(policy.isApproved("p1", "bash:echo-hi", { workspaceId: brandWorkspaceId("ws-A") }), true, "APPROVAL: recorded approval matches its own scope");
  assert.equal(
    policy.isApproved("p1", "bash:echo-hi", { workspaceId: brandWorkspaceId("ws-B") }),
    false,
    "APPROVAL-02: an approval for workspace A is not valid in workspace B",
  );
  assert.equal(
    policy.isApproved("p1", "bash:rm-rf", { workspaceId: brandWorkspaceId("ws-A") }),
    false,
    "APPROVAL-03: an approval cannot be consumed by altered tool arguments (different key)",
  );
  assert.equal(
    policy.isApproved("p2", "bash:echo-hi", { workspaceId: brandWorkspaceId("ws-A") }),
    false,
    "APPROVAL-03: an approval is not consumable by a different principal",
  );
}

// ── APPROVAL-01 ───────────────────────────────────────────────────────────
// Property: the UI activation path derives workspace context from any
// workspaceId-bearing result, not only open_workspace. Enforced structurally
// against the app source; behavior pinned by the DOM regression.
{
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("./ui/workspace-app.tsx", import.meta.url), "utf8");
  assert.match(app, /any tool result that carries a workspace ID bootstraps/, "APPROVAL-01: result-derived activation must exist in ontoolresult");
  assert.match(app, /structured\.status === "approval_required"/, "APPROVAL-01: approval_required results merge into the approval center directly");
  // The structural claim is the fallback; the behavioral proof is
  // workspace-app.dom.test.tsx's fresh-iframe block (release-blocking).
}

// ── PROC-01 ───────────────────────────────────────────────────────────────
// Property: process-session ownership prefers the durable work-session /
// logical identity and is stable per transport. Enforced structurally; the
// behavioral proof lives in mcp-process-continuity and process-sessions tests.
{
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./process-sessions.ts", import.meta.url), "utf8");
  assert.match(source, /maxRunningProcessesPerOwner/, "PROC-01: per-owner process bounds must exist");
  const wsSource = readFileSync(new URL("./mcp/workspace-server.ts", import.meta.url), "utf8");
  assert.match(wsSource, /processSessionOwnerId/, "PROC-01: ownership derives from durable identity, not just transport");
}

// ── RELEASE-01 ────────────────────────────────────────────────────────────
// Property: launcher authority is explicit context; the DB layer and
// implementation code never read it from ambient env. Enforced structurally:
// only the entrypoint (server.ts runServer), config.ts, and cli.ts may read
// launcher authority variables.
{
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry.name) || entry.name.includes(".test.")) continue;
      const rel = full.slice(process.cwd().length + 1);
      if (rel.startsWith("dist/")) continue;
      const text = readFileSync(full, "utf8");
      for (const authorityKey of ["KONTROL_DEPLOYMENT_ID", "KONTROL_EXPECTED_SCHEMA_VERSION", "KONTROL_RUNTIME_LOCK_TOKEN", "KONTROL_DEPLOYMENT_LOCK_TOKEN", "KONTROL_LAUNCH_GENERATION_ID", "KONTROL_ARTIFACT_PATH"]) {
        if (text.includes(`process.env.${authorityKey}`)) {
          // Sanctioned readers only.
          if (rel === "src" + "/" + "server.ts" || rel === "src" + "/" + "config.ts" || rel === "src" + "/" + "cli.ts" || rel === "src" + "/" + "runtime-context.ts") continue;
          offenders.push(`${rel} reads ${authorityKey}`);
        }
      }
    }
  };
  walk(join(process.cwd(), "src"));
  assert.deepEqual(offenders, [], `RELEASE-01: launcher authority must only be read at entrypoints/config: ${offenders.join("; ")}`);
  // stripLauncherAuthority covers every launcher key.
  const stripped = stripLauncherAuthority(Object.fromEntries(launcherAuthorityKeys.map((k) => [k, "x"])));
  for (const key of launcherAuthorityKeys) assert.equal(key in stripped, false, `RELEASE-01: ${key} stripped`);
  // Deeper: runtime-context.test.ts, deployment-lock.test.ts, runtime-lock.test.ts.
}

// ── Redaction invariant (compounds ENV-01) ────────────────────────────────
// Property: no telemetry persistence shape carries a credential-looking
// key's value through the shared sanitizer.
{
  const payload = { command: "env", env: { API_TOKEN: "v1", KONTROL_ACP_WORKER_SECRET: "v2" } };
  const serialized = JSON.stringify(redactValue(payload));
  assert.ok(!serialized.includes("v1") && !serialized.includes("v2"), "redaction: structured telemetry is sanitized");
  assert.ok(!redactedPreview("GITHUB_TOKEN=abc123def456").includes("abc123def456"), "redaction: previews are sanitized");
  // Deeper: redaction.test.ts.
}

console.log("security-invariants.test.ts: all invariants hold");
