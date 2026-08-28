/**
 * PolicyEngine — tool + filesystem approval policy for Kontrol.
 *
 * Modes:
 *   allow  — tool/path always allowed
 *   deny   — tool/path always blocked
 *   ask    — requires human approval (once / work_session / workspace)
 *
 * Per-session approvals: when a human approves, the approval is cached so
 * repeat calls in the same scope don't require re-approval.
 *
 * SECURITY MODEL
 * --------------
 * `evaluate()` returns the CANONICAL approval key for the matched rule:
 *   - matched path rule  -> `path:<rule.pattern>`   (NOT the concrete path)
 *   - matched tool rule  -> `tool:<canonicalTool>`
 *   - default `ask`      -> `default:<canonicalTool>`
 * Recording/checking approvals MUST use this key, never a reconstructed key
 * from the raw invocation. Otherwise "approve for session" stores
 * `path:src/server.ts` while the next call checks `path:src/**` and re-prompts.
 *
 * Approvals are scoped and keyed by (principalId, scope, scopeId, approvalKey):
 *   - `once`         : not cached (each call needs approval)
 *   - `work_session`: cached for the exact work session until it is terminal
 *   - `workspace`    : cached for the workspace until explicitly revoked
 */

import { randomUUID } from "node:crypto";
import type { ApprovalOption, ApprovalRequestManager } from "./approval-requests.js";
import { DEFAULT_DIRECT_APPROVAL_REATTACH_GRACE_MS } from "./policy-approval-defaults.js";

export type PolicyMode = "allow" | "deny" | "ask";
export type PolicySource = "path" | "tool" | "default";
export type ApprovalScope = "once" | "work_session" | "workspace";

/**
 * A path after workspace resolution. Keep both spellings so policy rules can
 * be written portably (`src/server.ts`) or for an explicitly protected host
 * location (`/srv/kontrol/workspaces/project/src/server.ts`). Callers that
 * perform filesystem actions must populate this from the canonical resolved
 * path, never directly from user input.
 */
export interface PolicyPath {
  relativePath: string;
  absolutePath: string;
}

export type PolicyInputPath = string | PolicyPath;

export interface PolicyRule {
  type: "tool" | "path";
  pattern: string;
  mode: PolicyMode;
  /** Original env var name (only used in tests / diagnostics). */
  raw?: string;
}

export interface ToolApprovalRequest {
  id: string;
  principalId: string;
  workspaceId: string;
  workSessionId?: string;
  runId?: string;
  agentId?: string;
  approvalKey?: string;
  mcpSessionId?: string;
  mcpRequestId?: string;
  waiterKey?: string;
  /**
   * Identity of the CURRENTLY ATTACHED live waiter. When this matches an
   * active MCP request, the durable approval row is "live". When it becomes
   * undefined (caller disconnected), a fresh invocation with the same durable
   * operation fingerprint may reattach; transient MCP session/request IDs are
   * retained only as live-waiter metadata.
   */
  liveWaiterId?: string;
  origin?: "direct_mcp" | "work_session";
  conversationId?: string;
  orphanedAt?: string;
  reattachDeadline?: string;
  options?: ApprovalOption[];
  tool: string;
  path?: string;
  command?: string;
  requestedAt: string;
  expiresAt?: string;
}

/** State of a live waiter attached to a durable approval row. */
export type LiveWaiterState = "live" | "dead";

/**
 * Content a retrying caller must re-present to resume an operation by its
 * opaque approval id. Every field is compared against the durable approval
 * row, so a valid id presented with different content never adopts the
 * original operation's identity — the token binds to the operation, not to
 * whoever happens to know it. `tool` and `path` arrive already normalized
 * (canonical policy tool name, policy path label) because the canonical
 * maps live on the enforcement side of the import boundary.
 */
export interface OperationResumeContent {
  principalId: string;
  workspaceId: string;
  workSessionId?: string;
  tool: string;
  approvalKey: string;
  path?: string;
  command?: string;
}

export interface PolicyDecision {
  mode: PolicyMode;
  approvalKey?: string;
  source: PolicySource;
  matchedPattern?: string;
}

export interface ScopeContext {
  workspaceId: string;
  workSessionId?: string;
}

export interface GrantRecord {
  id: string;
  principalId: string;
  scope: ApprovalScope;
  scopeId: string;
  approvalKey: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  reviewerId?: string;
}

/** Pluggable durable grant store (backed by SQLite in production). */
export interface GrantStore {
  insert(grant: GrantRecord): void;
  revokeForScope(scope: ApprovalScope, scopeId: string): void;
  /** All currently-effective (non-revoked, non-expired) grants. */
  listEffective(): GrantRecord[];
}

export interface PolicyEngine {
  evaluate(tool: string, path: PolicyInputPath | undefined, workspaceId: string): PolicyDecision;
  isApproved(principalId: string, key: string, ctx: ScopeContext): boolean;
  recordApproval(
    principalId: string,
    key: string,
    scope: ApprovalScope,
    ctx: ScopeContext,
    reviewerId?: string,
  ): void;
  getPendingApprovals(workspaceId?: string): ToolApprovalRequest[];
  /** Legacy matcher: coalesces by (principal, approvalKey, ctx). Kept for
   *  the rare ACP path that needs to detect an existing card from a
   *  different caller. The MCP enforcer uses findPendingByKey instead. */
  findPending(
    principalId: string,
    approvalKey: string,
    ctx: ScopeContext,
  ): ToolApprovalRequest | undefined;
  /** P0.4 dedup key: reconnecting transports reuse the durable operation
   *  fingerprint stored in waiterKey; transient MCP session/request IDs are
   *  live-waiter metadata, not durable operation identity. */
  findPendingByKey(rowKey: string): ToolApprovalRequest | undefined;
  clearPending(approvalId: string): void;
  resolvePending(
    approvalId: string,
    status: "approved" | "denied" | "expired" | "cancelled",
    reason?: string,
    resolution?: { scope?: ApprovalScope; optionId?: string },
  ): void;
  addPending(request: ToolApprovalRequest): void;
  /** Mark the live waiter for a durable approval row as detached. The
   *  durable card remains available for a future live invocation with the
   *  same row key to reattach to. */
  detachLiveWaiter(approvalId: string, liveWaiterId: string): void;
  /** Register a fresh live waiter for an existing durable approval row.
   *  Called when a reconnecting invocation with the same row key reuses
   *  the row created by a previous live invocation that has since gone. */
  reattachLiveWaiter(approvalId: string, liveWaiterId: string): void;
  /** Extend a direct MCP operation's short reconnect grace period. */
  touchPending(approvalId: string): void;
  /** Resolve the current liveness state for a live waiter. Used by the
   *  enforcer to decide whether a resolved approval should wake the
   *  in-flight invocation or be ignored because the caller is gone. */
  getLiveWaiterState(approvalId: string, liveWaiterId: string): LiveWaiterState | undefined;
  /** Count live waiters attached to a durable approval row. Used by
   *  diagnostics to distinguish "durable cards" from "live waiters". */
  countLiveWaiters(approvalId: string): number;
  /** Consume a resolved one-shot operation approval exactly once. */
  consumeApprovedOperation(waiterKey: string): boolean;
  /** Recover the durable waiterKey of an explicit resume operation. The
   *  caller must present content that exactly matches the durable row; a
   *  mismatching token+content pair never adopts the original identity. */
  resumeOperation(approvalId: string, content: OperationResumeContent): string | undefined;
  /** Revoke all durable and in-memory grants for an exact scope. */
  revokeScope(scope: ApprovalScope, scopeId: string): void;
  /** List effective durable grants for reviewer diagnostics/tools. */
  listGrants(scope?: ApprovalScope, scopeId?: string): GrantRecord[];
}

export interface PolicyConfig {
  defaultMode: PolicyMode;
  toolRules: Record<string, PolicyMode>;
  pathRules: Array<{ pattern: string; mode: PolicyMode }>;
}

/**
 * Secure-by-default mutation boundary (stable-beta threat model).
 *
 * Authentication protects against arbitrary strangers, but the authenticated
 * caller is an LLM consuming potentially adversarial project content, so a
 * zero-policy environment must not silently hand out arbitrary shell or file
 * mutation authority. Read-only inspection stays frictionless; mutating
 * operations require an explicit approval decision unless the operator has
 * explicitly configured policy (any KONTROL_POLICY_MODE / KONTROL_POLICY_TOOL_*
 * setting takes precedence over this baseline).
 */
const SECURE_BASELINE_TOOL_RULES: Record<string, PolicyMode> = {
  bash: "ask",
  write: "ask",
  edit: "ask",
  apply_patch: "ask",
};

const CANONICAL_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "grep",
  "glob",
  "ls",
  "bash",
  "apply_patch",
]);

/**
 * Single canonical tool-normalization map for POLICY purposes. Every surface
 * that evaluates policy (MCP, ACP bridge, process sessions) must funnel its
 * tool name through `canonicalTool` so aliases cannot bypass a bash rule:
 *   - kontrol-shell / exec_command are shell execution -> "bash"
 *   - mutating write_stdin (nonempty input) is handled by callers passing
 *     "bash" explicitly; poll-only write_stdin stays read-only.
 */
export const CANONICAL_TOOL_ALIASES: Record<string, string> = {
  "kontrol-shell": "bash",
  "kontrol-read": "read",
  "kontrol-write": "write",
  "kontrol-edit": "edit",
  "kontrol-grep": "grep",
  "kontrol-glob": "glob",
  exec_command: "bash",
};

export function parseMode(value: string | undefined): PolicyMode | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (v === "allow" || v === "deny" || v === "ask") return v;
  return undefined;
}

export function loadPolicyConfig(env: NodeJS.ProcessEnv): PolicyConfig {
  const toolRules: Record<string, PolicyMode> = {};
  const pathRules: Array<{ pattern: string; mode: PolicyMode }> = [];

  // Structured path rules: KONTROL_POLICY_PATH_RULES='[{"pattern":"/etc/ssh/**","mode":"deny"}]'
  const pathRulesJson = env.KONTROL_POLICY_PATH_RULES;
  if (pathRulesJson) {
    try {
      const parsed = JSON.parse(pathRulesJson) as Array<{ pattern?: string; mode?: string }>;
      for (const entry of parsed) {
        const pattern = entry.pattern;
        const mode = parseMode(entry.mode);
        if (!pattern || !mode) {
          throw new Error(
            `KONTROL_POLICY_PATH_RULES: each entry needs a "pattern" and a valid "mode" (allow|deny|ask)`,
          );
        }
        pathRules.push({ pattern, mode });
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`KONTROL_POLICY_PATH_RULES is not valid JSON: ${error.message}`);
      }
      throw error;
    }
  }

  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (key.startsWith("KONTROL_POLICY_TOOL_")) {
      const tool = key.replace("KONTROL_POLICY_TOOL_", "").toLowerCase();
      const mode = parseMode(value);
      if (mode) toolRules[tool] = mode;
    }
    // NOTE: per-rule env vars like KONTROL_POLICY_PATH_<glob>=... are no
    // longer supported (they are not valid shell assignment syntax). Use
    // KONTROL_POLICY_PATH_RULES instead. Unknown KONTROL_POLICY_PATH_*
    // keys are intentionally ignored.
  }

  // Secure baseline: mutating tools gate behind `ask` unless the operator has
  // explicitly configured policy for them (explicit per-tool rules win, and an
  // explicit global KONTROL_POLICY_MODE is an operator decision that overrides
  // the baseline entirely).
  const explicitGlobalMode = parseMode(env.KONTROL_POLICY_MODE);
  if (!explicitGlobalMode) {
    for (const [tool, mode] of Object.entries(SECURE_BASELINE_TOOL_RULES)) {
      if (!toolRules[tool]) toolRules[tool] = mode;
    }
  }

  // Default mode must be parsed strictly. Silently ignoring a malformed
  // security configuration is the wrong failure mode — a typo like "asks"
  // must not fall through to a permissive default.
  const defaultMode = parseMode(env.KONTROL_POLICY_MODE ?? "allow");
  if (!defaultMode) {
    throw new Error(
      `KONTROL_POLICY_MODE must be one of allow|deny|ask (got "${env.KONTROL_POLICY_MODE}")`,
    );
  }

  return { defaultMode, toolRules, pathRules };
}

/**
 * Whether any effective policy rule can produce an `ask` outcome and
 * therefore an interactive human approval. Direct approvals exist
 * independently from ACP: an ask-capable deployment without a reviewer
 * credential can generate approval cards that no surface is authorized to
 * resolve — a deadlocked configuration. Callers gate startup on this so the
 * failure surfaces as a concrete configuration error, never as a runtime
 * approval nobody can decide.
 */
export function policyCanAsk(config: PolicyConfig): boolean {
  if (config.defaultMode === "ask") return true;
  if (Object.values(config.toolRules).some((mode) => mode === "ask")) return true;
  return config.pathRules.some((rule) => rule.mode === "ask");
}

/**
 * Minimal glob matcher supporting `*` (any chars except `/`), `**` (any chars
 * including `/`), and `?` (single char). Dev-space subsets Node's built-in
 * minimatch behavior without adding a dependency.
 */
function globMatch(path: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<<GLOBSTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
    .replace(/<<<GLOBSTAR>>>/g, ".*");

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(path);
}

function canonicalTool(tool: string): string {
  return CANONICAL_TOOL_ALIASES[tool] ?? tool;
}

export function createPolicyEngine(
  config: PolicyConfig,
  grantStore?: GrantStore,
  approvalRequests?: ApprovalRequestManager,
  options: { directReattachGraceMs?: number } = {},
): PolicyEngine {
  // (principalId|scope|scopeId|approvalKey) -> true
  const sessionApprovals = new Map<string, boolean>();
  const pendingApprovals = new Map<string, ToolApprovalRequest>();
  // approvalId -> set of currently attached LIVE waiter ids. A durable row
  // may outlive its live waiter; this map is the source of truth for
  // "is anyone actually waiting right now?" — used by diagnostics and the
  // enforcer to detect a caller_gone outcome.
  const liveWaitersByApproval = new Map<string, Set<string>>();
  const inMemoryOneShotApprovals = new Set<string>();

  // Seed memory cache from durable grants so restarts keep effective approvals.
  if (grantStore) {
    for (const g of grantStore.listEffective()) {
      sessionApprovals.set(`${g.principalId}|${g.scope}|${g.scopeId}|${g.approvalKey}`, true);
    }
  }

  function scopeIdFor(scope: ApprovalScope, ctx: ScopeContext): string | undefined {
    if (scope === "workspace") return ctx.workspaceId;
    if (scope === "work_session") return ctx.workSessionId ?? ctx.workspaceId;
    return undefined;
  }

  function evaluate(
    tool: string,
    path: PolicyInputPath | undefined,
    _workspaceId: string,
  ): PolicyDecision {
    const canon = canonicalTool(tool);

    // Path rules first. A path can be matched in either its workspace-relative
    // or canonical absolute form. Resolve the most-specific matching rule
    // rather than trusting configuration order; ties retain declaration order
    // for deterministic operator control.
    if (path) {
      const candidates = pathCandidates(path);
      let best: { index: number; specificity: number; pattern: string; mode: PolicyMode } | undefined;
      for (const [index, rule] of config.pathRules.entries()) {
        if (!candidates.some((candidate) => globMatch(candidate, rule.pattern))) continue;
        const specificity = pathRuleSpecificity(rule.pattern);
        if (!best || specificity > best.specificity) {
          best = { index, specificity, pattern: rule.pattern, mode: rule.mode };
        }
      }
      if (best) {
        return {
          mode: best.mode,
          approvalKey: `path:${best.pattern}`,
          source: "path",
          matchedPattern: best.pattern,
        };
      }
    }

    // Tool rules.
    const toolMode = config.toolRules[canon];
    if (toolMode) {
      return {
        mode: toolMode,
        approvalKey: `tool:${canon}`,
        source: "tool",
        matchedPattern: canon,
      };
    }

    return {
      mode: config.defaultMode,
      approvalKey: `default:${canon}`,
      source: "default",
      matchedPattern: undefined,
    };
  }

  function isApproved(principalId: string, key: string, ctx: ScopeContext): boolean {
    const wsId = ctx.workspaceId;
    const wsKey = `${principalId}|workspace|${wsId}|${key}`;
    if (sessionApprovals.get(wsKey) || grantStore?.listEffective().some((grant) =>
      grant.principalId === principalId && grant.scope === "workspace" && grant.scopeId === wsId && grant.approvalKey === key)) return true;
    if (ctx.workSessionId) {
      const wsKey2 = `${principalId}|work_session|${ctx.workSessionId}|${key}`;
      if (sessionApprovals.get(wsKey2) || grantStore?.listEffective().some((grant) =>
        grant.principalId === principalId && grant.scope === "work_session" && grant.scopeId === ctx.workSessionId && grant.approvalKey === key)) return true;
    }
    return false;
  }

  function findPending(
    principalId: string,
    key: string,
    ctx: ScopeContext,
  ): ToolApprovalRequest | undefined {
    const matches = (request: ToolApprovalRequest) => request.principalId === principalId
      && request.workspaceId === ctx.workspaceId
      && request.workSessionId === ctx.workSessionId
      && request.approvalKey === key;
    return Array.from(pendingApprovals.values()).find(matches)
      ?? (approvalRequests
        ? approvalRequests.listPending(ctx.workspaceId)
          .filter((request) => request.kind === "tool")
          .map((request) => ({
            id: request.approvalId,
            principalId: request.principalId ?? "",
            workspaceId: request.workspaceSessionId,
            workSessionId: request.workSessionId,
            runId: request.runId,
            agentId: request.agentId,
            approvalKey: request.approvalKey,
            mcpSessionId: request.mcpSessionId,
            mcpRequestId: request.mcpRequestId,
            waiterKey: request.waiterKey,
            liveWaiterId: undefined,
            origin: request.origin,
            conversationId: request.conversationId,
            orphanedAt: request.orphanedAt,
            reattachDeadline: request.reattachDeadline,
            options: request.options,
            tool: request.tool ?? "",
            path: request.path,
            command: request.command,
            requestedAt: request.createdAt,
            expiresAt: request.expiresAt,
          }))
          .find(matches)
        : undefined);
  }

  /**
   * P0.4 dedup by row key: the durable approval row is keyed by the full
   * MCP-identity + principal + approvalKey. Two invocations with the same
   * row key are the SAME live call retrying; different row keys always
   * create independent rows. Returns the row currently in memory, or
   * looks it up in the durable approval store when one is configured.
   */
  function findPendingByKey(rowKey: string): ToolApprovalRequest | undefined {
    return Array.from(pendingApprovals.values()).find((request) => request.waiterKey === rowKey)
      ?? (approvalRequests
        ? approvalRequests.listPending().filter((request) => request.kind === "tool" && request.waiterKey === rowKey)
          .map((request) => ({
            id: request.approvalId,
            principalId: request.principalId ?? "",
            workspaceId: request.workspaceSessionId,
            workSessionId: request.workSessionId,
            runId: request.runId,
            agentId: request.agentId,
            approvalKey: request.approvalKey,
            mcpSessionId: request.mcpSessionId,
            mcpRequestId: request.mcpRequestId,
            waiterKey: request.waiterKey,
            liveWaiterId: undefined,
            origin: request.origin,
            conversationId: request.conversationId,
            orphanedAt: request.orphanedAt,
            reattachDeadline: request.reattachDeadline,
            options: request.options,
            tool: request.tool ?? "",
            path: request.path,
            command: request.command,
            requestedAt: request.createdAt,
            expiresAt: request.expiresAt,
          }))[0]
        : undefined);
  }

  function detachLiveWaiter(approvalId: string, liveWaiterId: string): void {
    const set = liveWaitersByApproval.get(approvalId);
    if (!set) return;
    set.delete(liveWaiterId);
    if (set.size === 0) liveWaitersByApproval.delete(approvalId);
    approvalRequests?.detachLiveWaiter(approvalId, liveWaiterId);
  }

  function reattachLiveWaiter(approvalId: string, liveWaiterId: string): void {
    let set = liveWaitersByApproval.get(approvalId);
    if (!set) {
      set = new Set();
      liveWaitersByApproval.set(approvalId, set);
    }
    set.add(liveWaiterId);
    approvalRequests?.reattachLiveWaiter(approvalId, liveWaiterId);
  }

  function touchPending(approvalId: string): void {
    // A matching direct retry is evidence the operation is still owned by a
    // live host, so refresh its bounded reattachment window. This is a
    // liveness touch, not an orphan event: the row keeps pending_human_approval
    // semantics and its human approval TTL is unchanged.
    const pending = pendingApprovals.get(approvalId);
    if (pending && !pending.workSessionId && pending.origin !== "work_session") {
      const now = new Date().toISOString();
      pending.reattachDeadline = new Date(Date.parse(now) + (options.directReattachGraceMs ?? DEFAULT_DIRECT_APPROVAL_REATTACH_GRACE_MS)).toISOString();
    }
    approvalRequests?.touchDirectApproval(approvalId);
  }

  function getLiveWaiterState(approvalId: string, liveWaiterId: string): LiveWaiterState | undefined {
    const set = liveWaitersByApproval.get(approvalId);
    if (!set) return undefined;
    return set.has(liveWaiterId) ? "live" : "dead";
  }

  function countLiveWaiters(approvalId: string): number {
    return liveWaitersByApproval.get(approvalId)?.size ?? 0;
  }

  function recordApproval(
    principalId: string,
    key: string,
    scope: ApprovalScope,
    ctx: ScopeContext,
    reviewerId?: string,
  ): void {
    if (scope === "once") return; // no caching, each call needs approval
    const scopeId = scopeIdFor(scope, ctx);
    // A work-session grant without a work session would be durable under the
    // workspace ID but never readable as a work-session grant. Do not offer or
    // persist a grant with that ambiguous lifetime.
    if (!scopeId || (scope === "work_session" && !ctx.workSessionId)) return;
    sessionApprovals.set(`${principalId}|${scope}|${scopeId}|${key}`, true);

    if (grantStore && !grantStore.listEffective().some((grant) =>
      grant.principalId === principalId
      && grant.scope === scope
      && grant.scopeId === scopeId
      && grant.approvalKey === key)) {
      const now = new Date().toISOString();
      grantStore.insert({
        id: `grant_${randomUUID()}`,
        principalId,
        scope,
        scopeId,
        approvalKey: key,
        createdAt: now,
        reviewerId,
      });
    }
  }

  function getPendingApprovals(workspaceId?: string): ToolApprovalRequest[] {
    if (approvalRequests) {
      return approvalRequests
        .listPending(workspaceId)
        .filter((request) => request.kind === "tool")
        .map((request) => ({
          id: request.approvalId,
          principalId: request.principalId ?? "",
          workspaceId: request.workspaceSessionId,
          workSessionId: request.workSessionId,
          runId: request.runId,
          agentId: request.agentId,
          approvalKey: request.approvalKey,
          mcpSessionId: request.mcpSessionId,
          mcpRequestId: request.mcpRequestId,
          waiterKey: request.waiterKey,
          liveWaiterId: request.liveWaiterId,
          origin: request.origin,
          conversationId: request.conversationId,
          orphanedAt: request.orphanedAt,
          reattachDeadline: request.reattachDeadline,
          tool: request.tool ?? "",
          path: request.path,
          command: request.command,
          options: request.options,
          requestedAt: request.createdAt,
          expiresAt: request.expiresAt,
        }));
    }
    const all = Array.from(pendingApprovals.values());
    return workspaceId ? all.filter((r) => r.workspaceId === workspaceId) : all;
  }

  function clearPending(approvalId: string): void {
    pendingApprovals.delete(approvalId);
    liveWaitersByApproval.delete(approvalId);
  }

  function resolvePending(
    approvalId: string,
    status: "approved" | "denied" | "expired" | "cancelled",
    reason?: string,
    resolution: { scope?: ApprovalScope; optionId?: string } = {},
  ): void {
    const pending = pendingApprovals.get(approvalId);
    const durable = approvalRequests?.get(approvalId);
    const waiterKey = pending?.waiterKey ?? durable?.waiterKey;
    if (status === "approved" && resolution.scope === "once" && waiterKey && !approvalRequests) {
      inMemoryOneShotApprovals.add(waiterKey);
    }
    pendingApprovals.delete(approvalId);
    // Remove the operation from the pending lookup, but retain the attached
    // live-waiter set until each waiter observes the decision and detaches in
    // the enforcer's finally block. Otherwise getLiveWaiterState() would
    // misclassify a healthy blocked worker as caller_gone immediately after a
    // reviewer resolves its approval.
    if (approvalRequests) approvalRequests.resolve(approvalId, {
      status,
      reason,
      optionId: resolution.optionId,
      effect: resolution.optionId
        ? status === "approved" ? "approve" : status === "denied" ? "deny" : undefined
        : undefined,
      scope: resolution.scope,
    });
  }

  function consumeApprovedOperation(waiterKey: string): boolean {
    if (approvalRequests?.consumeApprovedOperation(waiterKey)) return true;
    if (!approvalRequests && inMemoryOneShotApprovals.has(waiterKey)) {
      inMemoryOneShotApprovals.delete(waiterKey);
      return true;
    }
    return false;
  }

  /**
   * Explicit operation-resume identity: the retrying caller echoes the
   * approval id from its approval_required card plus the operation content.
   * Every content field must match the durable row exactly; otherwise the
   * resume is rejected and the retry fingerprints as a fresh operation.
   * The row's own waiterKey is the authoritative identity — this function
   * only recovers it, it never grants anything.
   */
  function resumeOperation(approvalId: string, content: OperationResumeContent): string | undefined {
    const durable = approvalRequests?.get(approvalId)
      ?? Array.from(pendingApprovals.values()).find((request) => request.id === approvalId);
    if (!durable) return undefined;
    const durableWorkspaceId = "workspaceSessionId" in durable ? durable.workspaceSessionId : durable.workspaceId;
    if (durable.principalId !== content.principalId) return undefined;
    if (durableWorkspaceId !== content.workspaceId) return undefined;
    if ((durable.workSessionId ?? undefined) !== (content.workSessionId ?? undefined)) return undefined;
    if ((durable.tool ?? "") !== content.tool) return undefined;
    if (durable.approvalKey !== content.approvalKey) return undefined;
    if ((durable.path ?? undefined) !== (content.path ?? undefined)) return undefined;
    if ((durable.command ?? undefined) !== (content.command ?? undefined)) return undefined;
    return durable.waiterKey ?? undefined;
  }

  function addPending(request: ToolApprovalRequest): void {
    pendingApprovals.set(request.id, request);
    if (request.liveWaiterId) {
      let set = liveWaitersByApproval.get(request.id);
      if (!set) {
        set = new Set();
        liveWaitersByApproval.set(request.id, set);
      }
      set.add(request.liveWaiterId);
    }
    if (approvalRequests) {
      approvalRequests.create({
        approvalId: request.id,
        kind: "tool",
        workspaceSessionId: request.workspaceId,
        workSessionId: request.workSessionId,
        runId: request.runId,
        agentId: request.agentId,
        approvalKey: request.approvalKey,
        mcpSessionId: request.mcpSessionId,
        mcpRequestId: request.mcpRequestId,
        waiterKey: request.waiterKey,
        liveWaiterId: request.liveWaiterId,
        principalId: request.principalId,
        origin: request.origin,
        conversationId: request.conversationId,
        orphanedAt: request.orphanedAt,
        reattachDeadline: request.reattachDeadline,
        title: `Approve ${request.tool}`,
        tool: request.tool,
        path: request.path,
        command: request.command,
        // P1.10: server-created options are authoritative. They travel in
        // the durable row so a rehydrated client (via list_pending_approvals)
        // never has to invent scopes. Approve Session only appears when
        // there is an actual work session to attach it to.
        options: request.options ?? [
          { id: "approve", label: "Approve Once", effect: "approve", scope: "once" },
          ...(request.workSessionId ? [{ id: "approve_session", label: "Approve Session", effect: "approve" as const, scope: "work_session" as const }] : []),
          { id: "approve_workspace", label: "Approve Workspace", effect: "approve" as const, scope: "workspace" as const },
          { id: "deny", label: "Deny", effect: "deny" },
        ],
        expiresAt: request.expiresAt,
      });
    }
  }

  function revokeScope(scope: ApprovalScope, scopeId: string): void {
    for (const key of sessionApprovals.keys()) {
      if (key.split("|", 3)[1] === scope && key.split("|", 3)[2] === scopeId) {
        sessionApprovals.delete(key);
      }
    }
    grantStore?.revokeForScope(scope, scopeId);
  }

  function listGrants(scope?: ApprovalScope, scopeId?: string): GrantRecord[] {
    const grants = grantStore?.listEffective() ?? [];
    return grants.filter((grant) => (!scope || grant.scope === scope) && (!scopeId || grant.scopeId === scopeId));
  }

  return {
    evaluate,
    isApproved,
    recordApproval,
    getPendingApprovals,
    findPending,
    findPendingByKey,
    detachLiveWaiter,
    reattachLiveWaiter,
    touchPending,
    getLiveWaiterState,
    countLiveWaiters,
    consumeApprovedOperation,
    resumeOperation,
    clearPending,
    resolvePending,
    addPending,
    revokeScope,
    listGrants,
  };
}

function pathCandidates(path: PolicyInputPath): string[] {
  if (typeof path === "string") return [normalizePolicyPath(path)];
  return [normalizePolicyPath(path.relativePath), normalizePolicyPath(path.absolutePath)];
}

function normalizePolicyPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function pathRuleSpecificity(pattern: string): number {
  // Literal characters carry more specificity than wildcard characters. This
  // makes `src/private/**` win over `src/**`, independent of declaration order.
  return pattern.replace(/[?*]/g, "").length;
}
