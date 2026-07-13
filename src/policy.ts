/**
 * PolicyEngine — tool + filesystem approval policy for Dev Desktop.
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
 *   - `workspace`    : cached for the workspace until it closes
 */

export type PolicyMode = "allow" | "deny" | "ask";
export type PolicySource = "path" | "tool" | "default";
export type ApprovalScope = "once" | "work_session" | "workspace";

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
  tool: string;
  path?: string;
  command?: string;
  requestedAt: string;
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
  evaluate(tool: string, path: string | undefined, workspaceId: string): PolicyDecision;
  isApproved(principalId: string, key: string, ctx: ScopeContext): boolean;
  recordApproval(
    principalId: string,
    key: string,
    scope: ApprovalScope,
    ctx: ScopeContext,
    reviewerId?: string,
  ): void;
  getPendingApprovals(workspaceId?: string): ToolApprovalRequest[];
  clearPending(approvalId: string): void;
  addPending(request: ToolApprovalRequest): void;
}

export interface PolicyConfig {
  defaultMode: PolicyMode;
  toolRules: Record<string, PolicyMode>;
  pathRules: Array<{ pattern: string; mode: PolicyMode }>;
}

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

export function parseMode(value: string | undefined): PolicyMode | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (v === "allow" || v === "deny" || v === "ask") return v;
  return undefined;
}

export function loadPolicyConfig(env: NodeJS.ProcessEnv): PolicyConfig {
  const toolRules: Record<string, PolicyMode> = {};
  const pathRules: Array<{ pattern: string; mode: PolicyMode }> = [];

  // Structured path rules: DEVDESKTOP_POLICY_PATH_RULES='[{"pattern":"/etc/ssh/**","mode":"deny"}]'
  const pathRulesJson = env.DEVDESKTOP_POLICY_PATH_RULES;
  if (pathRulesJson) {
    try {
      const parsed = JSON.parse(pathRulesJson) as Array<{ pattern?: string; mode?: string }>;
      for (const entry of parsed) {
        const pattern = entry.pattern;
        const mode = parseMode(entry.mode);
        if (!pattern || !mode) {
          throw new Error(
            `DEVDESKTOP_POLICY_PATH_RULES: each entry needs a "pattern" and a valid "mode" (allow|deny|ask)`,
          );
        }
        pathRules.push({ pattern, mode });
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`DEVDESKTOP_POLICY_PATH_RULES is not valid JSON: ${error.message}`);
      }
      throw error;
    }
  }

  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (key.startsWith("DEVDESKTOP_POLICY_TOOL_")) {
      const tool = key.replace("DEVDESKTOP_POLICY_TOOL_", "").toLowerCase();
      const mode = parseMode(value);
      if (mode) toolRules[tool] = mode;
    }
    // NOTE: per-rule env vars like DEVDESKTOP_POLICY_PATH_<glob>=... are no
    // longer supported (they are not valid shell assignment syntax). Use
    // DEVDESKTOP_POLICY_PATH_RULES instead. Unknown DEVDESKTOP_POLICY_PATH_*
    // keys are intentionally ignored.
  }

  // Default mode must be parsed strictly. Silently ignoring a malformed
  // security configuration is the wrong failure mode — a typo like "asks"
  // must not fall through to a permissive default.
  const defaultMode = parseMode(env.DEVDESKTOP_POLICY_MODE ?? "allow");
  if (!defaultMode) {
    throw new Error(
      `DEVDESKTOP_POLICY_MODE must be one of allow|deny|ask (got "${env.DEVDESKTOP_POLICY_MODE}")`,
    );
  }

  return { defaultMode, toolRules, pathRules };
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
  return CANONICAL_TOOLS.has(tool) ? tool : tool;
}

export function createPolicyEngine(config: PolicyConfig, grantStore?: GrantStore): PolicyEngine {
  // (principalId|scope|scopeId|approvalKey) -> true
  const sessionApprovals = new Map<string, boolean>();
  const pendingApprovals = new Map<string, ToolApprovalRequest>();

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
    path: string | undefined,
    _workspaceId: string,
  ): PolicyDecision {
    const canon = canonicalTool(tool);

    // Path rules first (most specific).
    if (path) {
      for (const rule of config.pathRules) {
        if (globMatch(path, rule.pattern)) {
          return {
            mode: rule.mode,
            approvalKey: `path:${rule.pattern}`,
            source: "path",
            matchedPattern: rule.pattern,
          };
        }
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
    if (sessionApprovals.get(wsKey)) return true;
    if (ctx.workSessionId) {
      const wsKey2 = `${principalId}|work_session|${ctx.workSessionId}|${key}`;
      if (sessionApprovals.get(wsKey2)) return true;
    }
    return false;
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
    if (!scopeId) return;
    sessionApprovals.set(`${principalId}|${scope}|${scopeId}|${key}`, true);

    if (grantStore) {
      const now = new Date().toISOString();
      grantStore.insert({
        id: `grant_${principalId}_${scope}_${scopeId}_${key}`,
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
    const all = Array.from(pendingApprovals.values());
    return workspaceId ? all.filter((r) => r.workspaceId === workspaceId) : all;
  }

  function clearPending(approvalId: string): void {
    pendingApprovals.delete(approvalId);
  }

  function addPending(request: ToolApprovalRequest): void {
    pendingApprovals.set(request.id, request);
  }

  return {
    evaluate,
    isApproved,
    recordApproval,
    getPendingApprovals,
    clearPending,
    addPending,
  };
}
