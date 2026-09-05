/**
 * Workspace tool surface: createMcpServer and its private helpers
 *
 * Extracted verbatim from server.ts (P0 god-module decomposition). This
 * capability module owns the MCP server construction: the workspace app
 * resources, the open_workspace/read/write/edit/apply_patch/show_changes/
 * grep/glob/ls/bash tools, the codex process tools, policy gating helpers,
 * and the tool-call logging/card envelope. HTTP transport admission and
 * session lifecycle remain in server.ts.
 */
import { performance } from "node:perf_hooks";
import { readFileSync, statSync } from "node:fs";
import { join, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { ServerConfig, WidgetMode } from "../config.js";
import type { createWorkSessionManager } from "../work-sessions.js";
import { logEvent, commandPreview, requestIp } from "../logger.js";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  runShellTool,
  writeFileTool,
} from "../pi-tools.js";
import { applyPatch, parsePatch } from "../apply-patch.js";
import type { ProcessSnapshot } from "../process-sessions.js";
import type { PolicyConfig, PolicyEngine } from "../policy.js";
import type { PolicyEnforcer, PolicyInvocation, PolicyWaitContext, PolicyWaitOutcome } from "../policy-enforcement.js";
import type { ProcessSessionManager } from "../process-sessions.js";
import { authorizeWorkSessionAction } from "../work-session-action-guard.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { WorkSessionManager } from "../work-sessions.js";
import { formatAgentsPath, type WorkspaceRegistry } from "../workspaces.js";
import type { createReviewCheckpointManager } from "../review-checkpoints.js";
import { getGitEligibility } from "../git.js";
import { formatPathForPrompt } from "../skills.js";
import type { AgentRegistryManager } from "../acp-registry.js";
import type { EventStore } from "../event-log.js";
import type { ContinuationManager } from "../continuation.js";
import type { DispatchOutbox } from "../dispatch-outbox.js";
import type { createApprovalRequestManager } from "../approval-requests.js";
import type { createMissionLedger } from "../mission-ledger.js";
import type { createAgentMessageManager } from "../agent-messages.js";
import type { createSupervisorRuns } from "../supervisor-runs.js";
import type { MutationReceiptStore } from "../mutation-receipts.js";
import {
  DEVDESKTOP_WORKSPACE_APP_URI,
  LEGACY_WORKSPACE_APP_URI,
  OPENAI_WORKSPACE_APP_URI,
  WORKSPACE_APP_BUILD_ID,
  WORKSPACE_APP_HTML,
  WORKSPACE_APP_URI,
  workspaceAppResourceMeta,
  workspaceAppToolMeta,
} from "../workspace-app-resource.js";
import type { ReviewWorkflowService } from "../review-workflow.js";
import type { LiveWaiterRegistry } from "../bridge/shared.js";
import type { DatabaseHandle } from "../db/client.js";
import { installCachedToolList } from "../mcp-tool-list-cache.js";
import { isPathInsideRoot } from "../roots.js";
import { registerPolicyTools } from "../policy-tools.js";
import { registerBridgeTools } from "../acp-bridge.js";

/** P1 #26: single source of runtime version identity — the package manifest. */
let cachedPackageVersion: string | undefined;
export function readPackageVersion(): string {
  if (cachedPackageVersion) return cachedPackageVersion;
  try {
    const buildMeta = JSON.parse(readFileSync(new URL("../build-meta.json", import.meta.url), "utf8")) as { version?: string };
    cachedPackageVersion = typeof buildMeta.version === "string" && buildMeta.version ? buildMeta.version : "0.0.0";
  } catch {
    try {
      const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version?: string };
      cachedPackageVersion = typeof manifest.version === "string" && manifest.version ? manifest.version : "0.0.0";
    } catch {
      cachedPackageVersion = "0.0.0";
    }
  }
  return cachedPackageVersion;
}

/**
 * P1 #25: audit-event writes are best-effort (they must never fail user
 * work), but silent degradation is unacceptable. Track a counter per scope,
 * warn rate-limited, and expose the counters under authenticated
 * diagnostics so persistent failures surface.
 */
const degradedAuditCounters = new Map<string, { count: number; lastWarnedAt: number; lastError?: string }>();
const DEGRADED_AUDIT_WARN_INTERVAL_MS = 60_000;

function recordDegradedAudit(scope: string, error: unknown): void {
  const entry = degradedAuditCounters.get(scope) ?? { count: 0, lastWarnedAt: 0 };
  entry.count += 1;
  entry.lastError = error instanceof Error ? error.message : String(error);
  const now = Date.now();
  if (now - entry.lastWarnedAt >= DEGRADED_AUDIT_WARN_INTERVAL_MS) {
    entry.lastWarnedAt = now;
    console.warn(`[kontrol] degraded audit telemetry (${scope}): ${entry.count} write failure(s); last error: ${entry.lastError}`);
  }
  degradedAuditCounters.set(scope, entry);
}

export function degradedAuditSnapshot(): Record<string, { count: number; lastError?: string }> {
  const snapshot: Record<string, { count: number; lastError?: string }> = {};
  for (const [scope, entry] of degradedAuditCounters) {
    snapshot[scope] = { count: entry.count, lastError: entry.lastError };
  }
  return snapshot;
}

export type Transport = StreamableHTTPServerTransport;

export interface McpRequestContext {
  signal: AbortSignal;
  mcpSessionId?: string;
  mcpRequestId?: string;
  conversationId?: string;
  approvalCorrelationId?: string;
  onPolicyWaitStart?: (context: PolicyWaitContext) => void | Promise<void>;
  onPolicyWaitEnd?: (context: PolicyWaitContext & { outcome: PolicyWaitOutcome }) => void | Promise<void>;
}

export const mcpRequestContext = new AsyncLocalStorage<McpRequestContext>();

function currentMcpRequestSignal(): AbortSignal | undefined {
  return mcpRequestContext.getStore()?.signal;
}

function currentMcpRequestContext(): McpRequestContext | undefined {
  return mcpRequestContext.getStore();
}

const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const EDIT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface DiffStats {
  additions: number;
  removals: number;
}

type ToolWidgetKind =
  | "workspace"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "directory"
  | "shell"
  | "show_changes";

interface ToolDefinitionMeta extends Record<string, unknown> {
  ui: {
    resourceUri: string;
    visibility: ["model"];
  };
}

type EmptyToolDefinitionMeta = Record<string, unknown> & {
  "ui/resourceUri"?: string;
};

interface ToolWidgetDescriptorMeta {
  _meta: ToolDefinitionMeta | EmptyToolDefinitionMeta;
}

function shouldAttachWidget(mode: WidgetMode, kind: ToolWidgetKind): boolean {
  switch (mode) {
    case "off":
      return false;
    case "changes":
      return kind === "workspace" || kind === "show_changes";
    case "full":
      return true;
  }
}

/**
 * A tool whose effective policy can produce an `ask` outcome may return a
 * blocked result that carries an interactive approval card. Those results must
 * reach the Workspace App even in `changes` mode: a card the host cannot
 * render because the tool descriptor never advertised the app is a
 * dead-end approval. `off` stays off — an operator who disabled widgets has
 * no interactive surface to attach one to.
 */
function toolCanRequireInteractiveApproval(policy: PolicyConfig, kind: ToolWidgetKind): boolean {
  const canonicalToolsByKind: Partial<Record<ToolWidgetKind, string[]>> = {
    // exec_command and a mutating write_stdin are gated under the canonical
    // "bash" policy key (P0 #1), so the shell widget follows bash's rule.
    shell: ["bash"],
    read: ["read"],
    write: ["write"],
    edit: ["edit", "apply_patch"],
    search: ["grep", "glob"],
    directory: ["ls"],
  };
  const tools = canonicalToolsByKind[kind];
  if (!tools) return false;
  if (tools.some((tool) => (policy.toolRules[tool] ?? policy.defaultMode) === "ask")) return true;
  // Path rules can place a read/ls (and any path-scoped tool) in ask; the
  // pattern cannot be resolved per-descriptor, so any path rule with mode
  // "ask" makes every path-scoped tool potentially interactive.
  return policy.pathRules.some((rule) => rule.mode === "ask");
}

function toolWidgetDescriptorMeta(
  config: ServerConfig,
  kind: ToolWidgetKind,
): ToolWidgetDescriptorMeta {
  if (config.widgets === "changes" && toolCanRequireInteractiveApproval(config.policy, kind)) {
    return {
      _meta: workspaceAppToolMeta(["model"]) as unknown as ToolDefinitionMeta,
    };
  }
  if (!shouldAttachWidget(config.widgets, kind)) return { _meta: {} };

  return {
    _meta: workspaceAppToolMeta(["model"]) as unknown as ToolDefinitionMeta,
  };
}

const toolNames = {
  openWorkspace: "open_workspace",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  shell: "bash",
} as const;

const serverInstructionCache = new Map<string, string>();

// P1 #42: SDK internal-hook usage is isolated in mcp-tool-list-cache.ts.
const toolListDescriptorCache = new Map<string, Promise<unknown>>();
let toolListDescriptorCacheActive = false;

interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
  success: boolean;
  durationMs: number;
  error?: string;
}

function serverInstructions(config: ServerConfig): string {
  const showChangesInstruction =
    config.widgets === "changes"
      ? " If you successfully create, edit, overwrite, delete, move, or apply patches to files in a turn, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual change; do not skip it because individual file-change tools already returned diffs."
      : "";

  if (config.toolMode === "codex") {
    return `Use Kontrol as a local coding workspace. Call ${toolNames.openWorkspace} once per project folder or worktree and reuse its workspaceId. Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for direct structured inspection; use apply_patch for modifications, exec_command for tests/builds/other commands, and write_stdin to poll running processes. Review, diagnosis, architecture, and code-edit requests go directly through the workspace first. Delegate only when the reviewer explicitly asks for bounded worker assistance: call discover_agents, dispatch only a currently dispatchable healthy role=agent peer, and if optional assistance is unavailable continue directly without trying an alternate ACP route. The WebUI reviewer remains the approval authority. Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.${showChangesInstruction}`;
  }

  const inspection = `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. `;

  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories. `
    : "";

  const agentsMd = `Follow instructions returned by ${toolNames.openWorkspace}. Kontrol loads additional AGENTS.md/CLAUDE.md files lazily from the ancestors of each requested path and returns newly applicable instructions with that tool call. `;

  return `Use Kontrol as a local coding workspace. Call ${toolNames.openWorkspace} once per project folder or worktree to obtain a workspaceId. Reuse that same workspaceId for all later file, search, edit, write, show-changes, and shell tools in that folder; do not call ${toolNames.openWorkspace} again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. ${agentsMd}${skills}${inspection}Review, diagnosis, architecture, and code-edit requests go directly through the workspace first. Delegate only when the reviewer explicitly asks for bounded worker assistance: call discover_agents before optional dispatch, select only a currently dispatchable healthy role=agent peer, and if optional assistance is unavailable continue directly without trying an alternate ACP route. The WebUI reviewer remains the approval authority. Prefer ${toolNames.edit} for targeted modifications, ${toolNames.write} only for new files or complete rewrites, and ${toolNames.shell} for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not create or modify files with ${toolNames.shell}; avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or any command whose purpose is to write project files.${showChangesInstruction}`;
}

function cachedServerInstructions(config: ServerConfig): string {
  const key = `${config.toolMode}|${config.widgets}|${config.skillsEnabled ? "skills" : "no-skills"}`;
  const cached = serverInstructionCache.get(key);
  if (cached) return cached;
  const instructions = serverInstructions(config);
  serverInstructionCache.set(key, instructions);
  return instructions;
}
function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    status: z.string().optional(),
    approvalId: z.string().optional(),
    retryable: z.boolean().optional(),
    ...extra,
  };
}

/**
 * Explicit opaque operation-resume identity (audit P1). A caller whose tool
 * call returned approval_required retries with the SAME arguments plus this
 * field set to the approvalId it was shown. The server verifies the echoed
 * operation content against the durable approval row before honoring the
 * original human decision, so a reconnect that lost its conversation
 * correlation can still consume "Approve Once" instead of prompting again.
 */
const approvalResumeIdSchema = z
  .string()
  .optional()
  .describe(
    "Opaque resume token: the approvalId returned in a prior approval_required result. Retry the identical tool call with this field set to consume the human's original decision.",
  );

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

const reviewFileOutputSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  additions: z.number(),
  removals: z.number(),
});

const reviewSummaryOutputSchema = z.object({
  files: z.number(),
  additions: z.number(),
  removals: z.number(),
});

export function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

export function constantTimeStringEqual(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;

  const { command, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    commandPreview: config.logging.shellCommands && command ? commandPreview(command) : undefined,
  });
}

function contentText(content: ToolContent[]): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

function toolErrorPreview(content: ToolContent[]): string | undefined {
  const text = contentText(content).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function logFailedToolResponse(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  content: ToolContent[],
  startedAt: number,
): void {
  logToolCall(config, {
    ...fields,
    success: false,
    durationMs: Math.round(performance.now() - startedAt),
    error: toolErrorPreview(content),
  });
}

function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

function textSummary(content: ToolContent[]): {
  lines: number;
  characters: number;
} {
  const text = contentText(content);
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n").length
    : content.split("\n").length;
}

/**
 * P0.2: a policy-blocked result must remain renderable by the Workspace App.
 * The MCP `_meta.tool`/`_meta.card` envelope is the only contract the app can
 * use (see toolNameFromMeta()/isToolResultCard() in workspace-app.tsx), and it
 * is attached even when isError is true because the UI renders both blocked
 * and approval-pending cards from the same payload.
 */
function policyFailureResponse(
  result: { allowed: boolean; approvalRequired?: boolean; approvalId?: string },
  deniedMessage: string,
  context: {
    tool: "exec_command" | "write_stdin" | "read" | "write" | "edit" | "apply_patch" | "grep" | "glob" | "ls" | "bash";
    workspaceId: string;
    path?: string;
    command?: string;
  },
): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  _meta: { tool: string; card: Record<string, unknown> };
  structuredContent?: Record<string, unknown>;
} {
  if (result.approvalRequired && result.approvalId) {
    const message = `Approval required. Approve ${result.approvalId} in the Kontrol review UI, then retry this exact tool call with approvalResumeId set to ${result.approvalId}. The retry consumes the human decision without prompting again.`;
    const card: Record<string, unknown> = {
      tool: context.tool,
      workspaceId: context.workspaceId,
      status: "approval_required",
      approvalId: result.approvalId,
      resumeArgument: "approvalResumeId",
      retryable: true,
      summary: {
        status: "approval_required",
        approvalId: result.approvalId,
        command: context.command,
      },
      payload: { content: [{ type: "text", text: message }] },
    };
    if (context.path !== undefined) card.path = context.path;
    if (context.command !== undefined) card.command = context.command;
    return {
      content: [{ type: "text", text: message }],
      isError: false,
      _meta: { tool: context.tool, card },
      structuredContent: {
        result: message,
        status: "approval_required",
        approvalId: result.approvalId,
        retryable: true,
        ...(context.tool === "apply_patch" ? { additions: 0, removals: 0, files: [] } : {}),
      },
    };
  }
  const card: Record<string, unknown> = {
    tool: context.tool,
    workspaceId: context.workspaceId,
    status: "policy_denied",
    summary: { status: "policy_denied", command: context.command },
    payload: { content: [{ type: "text", text: deniedMessage }] },
  };
  if (context.path !== undefined) card.path = context.path;
  if (context.command !== undefined) card.command = context.command;
  return {
    content: [{ type: "text", text: deniedMessage }],
    isError: true,
    _meta: { tool: context.tool, card },
    structuredContent: { result: deniedMessage },
  };
}

/**
 * Policy enforcement for tool calls.
 * Returns the policy outcome. Direct MCP calls return approval_required
 * immediately; controlled ACP invocations may retain blocking semantics.
 *
 * Uses the shared enforcer so MCP and ACP share one code path, and records
 * approvals under the CANONICAL policy key (never a reconstructed key).
 */
async function enforceToolPolicy(
  workSessions: ReturnType<typeof createWorkSessionManager> | undefined,
  enforcer: PolicyEnforcer,
  workspaceId: string,
  workSessionId: string | undefined,
  runId: string | undefined,
  tool: string,
  path: PolicyInvocation["path"],
  command: string | undefined,
  paths?: PolicyInvocation["paths"],
  approvalResumeId?: string,
): Promise<{ allowed: boolean; approvalRequired?: boolean; approvalId?: string }> {
  if (workSessions && workSessionId) {
    const sessionDecision = authorizeWorkSessionAction(workSessions, {
      workSessionId,
      tool,
      path: typeof path === "string" ? path : path?.relativePath,
      command,
    });
    if (!sessionDecision.allowed) return { allowed: false };
  }
  const result = await enforcer.enforce({
    principalId: workSessionId ?? workspaceId,
    principalRole: workSessionId ? "worker" : "client",
    workspaceId,
    workSessionId,
    runId,
    tool,
    path,
    paths,
    command,
    signal: currentMcpRequestSignal(),
    mcpSessionId: currentMcpRequestContext()?.mcpSessionId,
    mcpRequestId: currentMcpRequestContext()?.mcpRequestId,
    onPolicyWaitStart: currentMcpRequestContext()?.onPolicyWaitStart,
    onPolicyWaitEnd: currentMcpRequestContext()?.onPolicyWaitEnd,
    // A direct MCP operation has no durable worker lifecycle to hold open, so
    // return approval_required immediately. Calls bound to a work session are
    // controlled worker operations and retain ACP-style blocking semantics.
    blockingApproval: Boolean(workSessionId),
    conversationId: currentMcpRequestContext()?.conversationId,
    approvalCorrelationId: currentMcpRequestContext()?.approvalCorrelationId,
    // Explicit opaque operation-resume identity: when a retrying caller
    // echoes the approvalId from its approval_required card, verified
    // content adopts the original durable operation instead of prompting
    // again under a new reconnect fingerprint.
    approvalResumeId,
  });
  return result;
}

/**
 * Build the only path representation that may enter policy evaluation from an
 * MCP filesystem action. The lexical user path is retained only as the
 * relative display form; the absolute form has already passed workspace
 * resolution and symlink checks.
 */
function canonicalPolicyPath(
  workspaceRoot: string,
  inputPath: string | undefined,
  resolvedPath?: string,
): NonNullable<PolicyInvocation["path"]> {
  const absolutePath = resolve(resolvedPath ?? workspaceRoot, resolvedPath ? "." : (inputPath ?? "."));
  const relativePath = isPathInsideRoot(absolutePath, workspaceRoot)
    ? (relative(workspaceRoot, absolutePath).split(sep).join("/") || ".")
    : (inputPath ?? absolutePath).replaceAll("\\", "/");
  return { relativePath, absolutePath };
}

function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}

function newFilePatch(path: string, content: string): string {
  const lines =
    content.length === 0
      ? []
      : content.endsWith("\n")
        ? content.slice(0, -1).split("\n")
        : content.split("\n");
  const hunkLength = lines.length;
  const hunkRange = hunkLength === 0 ? "+0,0" : `+1,${hunkLength}`;
  const body = lines.map((line) => `+${line}`).join("\n");

  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 ${hunkRange} @@`,
    body,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId}.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return snapshot.output ? `${snapshot.output.replace(/\n$/, "")}\n${status}` : status;
}

function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    sessionId: z.string().optional(),
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    wallTimeMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
  });
}

function processToolResponse(
  tool: "exec_command" | "write_stdin",
  workspaceId: string,
  snapshot: ProcessSnapshot,
  summary: Record<string, unknown>,
) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  const outputSummary = textSummary(snapshot.output ? [textBlock(snapshot.output)] : []);
  return {
    content,
    _meta: {
      tool,
      card: {
        workspaceId,
        summary: { ...summary, ...outputSummary },
        payload: { content },
      },
    },
    structuredContent: {
      result,
      sessionId: snapshot.sessionId,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      wallTimeMs: snapshot.wallTimeMs,
      outputTruncated: snapshot.outputTruncated,
    },
  };
}

/**
 * P0 #6: a dispatched worker is cryptographically bound to exactly one signed
 * work session, which lives inside exactly one workspace. It must never operate
 * on a different workspace — cross-workspace worker access defeats the
 * correlation/credential contract. Enforced only when the connection is a
 * verified worker with a bound session; ordinary clients and reviewers are
 * unrestricted here (their tools are role-gated separately).
 */
function assertWorkerWorkspaceBinding(
  connectionContext: ConnectionContext | undefined,
  workSessions: WorkSessionManager | undefined,
  workspaceId: string,
): { content: Array<{ type: "text"; text: string }>; isError: true } | null {
  if (connectionContext?.authenticatedRole === "worker" && connectionContext.workSessionId && workSessions) {
    const session = workSessions.get(connectionContext.workSessionId);
    const allowed = session?.workspaceSessionId;
    if (allowed && workspaceId !== allowed) {
      return {
        content: [{ type: "text" as const, text: "Forbidden: worker is bound to a different workspace than the requested one." }],
        isError: true,
      };
    }
  }
  return null;
}

function registerCodexProcessTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
  workSessions?: ReturnType<typeof createWorkSessionManager>,
  policyEnforcer?: import("../policy-enforcement.js").PolicyEnforcer,
  policyEngine?: PolicyEngine,
  connectionContext?: ConnectionContext,
  prepareForMutation?: (workspaceId: string) => Promise<void>,
): void {
  registerAppTool(
    server,
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run a command inside an open workspace. Returns its result when it exits during the yield window, otherwise returns a sessionId for write_stdin. Use this for file inspection, tests, builds, package scripts, and long-running processes. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        cmd: z.string().min(1).describe("Shell command to execute."),
        approvalResumeId: approvalResumeIdSchema,
        tty: z
          .boolean()
          .optional()
          .describe("Allocate a pseudo-terminal for interactive commands. Defaults to false."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Initial PTY width. Defaults to 80."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Initial PTY height. Defaults to 24."),
        workingDirectory: z
          .string()
          .optional()
          .describe("Working directory relative to the workspace root. Defaults to the workspace root."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("Milliseconds to wait before returning a running session. Defaults to 10000."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, cmd, approvalResumeId, tty, columns, rows, workingDirectory, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      await prepareForMutation?.(workspaceId);
      const workspace = workspaces.getWorkspace(workspaceId);
      const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
      if (bindingErr) return bindingErr;
      const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
      const policyPath = canonicalPolicyPath(workspace.root, workingDirectory, cwd);

      // Policy enforcement (P0 #3): Codex exec_command is a run_commands action
      // and must be gated exactly like the ordinary `bash` tool.
      if (policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          workspaceId,
          connectionContext?.workSessionId,
          connectionContext?.runId,
          // P0 #1: canonical policy name — exec_command is gated as "bash".
          "bash",
          policyPath,
          cmd,
          undefined,
          approvalResumeId,
        );
        if (!approved.allowed) {
          return policyFailureResponse(approved, `Tool "exec_command" denied by policy. Command: ${cmd}`, {
            tool: "exec_command",
            workspaceId,
            path: typeof policyPath === "string" ? policyPath : policyPath?.relativePath,
            command: cmd,
          });
        }
      }

      const snapshot = await processSessions.start({
        workspaceId,
        ownerId: processSessionOwnerId(connectionContext),
        workSessionId: connectionContext?.workSessionId,
        command: cmd,
        cwd,
        tty,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });

      logToolCall(config, {
        tool: "exec_command",
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: cmd,
        commandLength: cmd.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse("exec_command", workspaceId, snapshot, {
        command: cmd,
        workingDirectory: workingDirectory ?? ".",
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );

  registerAppTool(
    server,
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Poll or write characters to a process returned by exec_command. Omit chars or pass an empty string to poll. Pass \\u0003 to send Ctrl-C.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        sessionId: z.string().describe("Opaque process session identifier returned by exec_command."),
        chars: z.string().optional().describe("Characters to write. Omit or pass an empty string to poll."),
        approvalResumeId: approvalResumeIdSchema,
        columns: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this width."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this height."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("Milliseconds to wait for process output or completion. Defaults to 10000."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, sessionId, chars, approvalResumeId, columns, rows, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      const hasInput = Boolean(chars && chars.length > 0);
      // Writing input to a process can mutate the workspace via that process;
      // gate it behind the baseline like exec_command. Outline-free poll stays fast.
      if (hasInput) await prepareForMutation?.(workspaceId);
      workspaces.getWorkspace(workspaceId);
      const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
      if (bindingErr) return bindingErr;

      // Policy enforcement (P0 #3): writing NONEMPTY input to a process is a
      // run_commands action and must be gated. A poll-only write_stdin (no
      // chars / empty string) cannot alter process state, so it stays a
      // read/wait operation and is not gated.
      if (hasInput && policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          workspaceId,
          connectionContext?.workSessionId,
          connectionContext?.runId,
          // P0 #1: a mutating write_stdin is a run_commands action. Pass the
          // CANONICAL policy name ("bash") so it is gated by exactly the same
          // rule as exec_command and the bash tool — never an alias.
          "bash",
          undefined,
          chars,
          undefined,
          approvalResumeId,
        );
        if (!approved.allowed) {
          return policyFailureResponse(approved, `Tool "write_stdin" denied by policy: cannot send input to a gated process.`, {
            tool: "write_stdin",
            workspaceId,
            command: chars,
          });
        }
      }

      const snapshot = await processSessions.write({
        workspaceId,
        sessionId,
        ownerId: processSessionOwnerId(connectionContext),
        workSessionId: connectionContext?.workSessionId,
        chars,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });

      logToolCall(config, {
        tool: "write_stdin",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse("write_stdin", workspaceId, snapshot, {
        sessionId,
        charactersWritten: chars?.length ?? 0,
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );
}

/**
 * Work-session attribution envelope bound to a single MCP connection. Tool
 * activity is attributed to the work session named here, NOT to the workspace's
 * mutable "currently active" session. This prevents concurrent CRUSH processes
 * sharing a workspace from overwriting each other's attribution.
 */
export interface ConnectionContext {
  /**
   * The role authenticated for this connection. A successfully-verified signed
   * worker token yields "worker"; otherwise the connection is treated as a
   * reviewer/client. AUTHORIZATION MUST derive from this field — never from the
   * unsigned attribution headers (P0 #3). The unsigned headers below are for
   * logging/attribution only and grant no privileges.
   */
  authenticatedRole?: "worker" | "reviewer" | "client";
  authSource?: "oauth" | "reviewer_token" | "worker_token" | "tunnel_reviewer" | "anonymous";
  /** Authenticated principal for durable client mutation identities. */
  authenticatedPrincipalId?: string;
  workspaceSessionId?: string;
  workSessionId?: string;
  runId?: string;
  continuationId?: string;
  /** Checkout lease nonce issued for the bound worker work session. */
  workspaceLeaseNonce?: string;
  /** Transport identity, never shared across MCP sessions. */
  mcpSessionId?: string;
  /** Human-readable diagnostic label for this isolated transport. */
  mcpSessionLabel?: string;
  /** Optional upstream conversation correlation; not an authorization key. */
  conversationId?: string;
  /** Stable trusted identity used only for reconnecting one approval operation. */
  approvalCorrelationId?: string;
}

/**
 * Direct process sessions normally belong to the transport that opened them,
 * but a trusted reconnect identity or durable work session can outlive one
 * MCP transport. Generic clientInfo fallback remains deliberately ephemeral.
 */
function processSessionOwnerId(context?: ConnectionContext): string | undefined {
  if (context?.workSessionId) return `work-session:${context.workSessionId}`;
  if (context?.approvalCorrelationId) return `logical-client:${context.approvalCorrelationId}`;
  return context?.mcpSessionId;
}

export function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  workSessions?: ReturnType<typeof createWorkSessionManager>,
  agentRegistry?: import("../acp-registry.js").AgentRegistryManager,
  eventStore?: import("../event-log.js").EventStore,
  continuationManager?: import("../continuation.js").ContinuationManager,
  dispatchOutbox?: import("../dispatch-outbox.js").DispatchOutbox,
  policyEngine?: PolicyEngine,
  policyEnforcer?: import("../policy-enforcement.js").PolicyEnforcer,
  approvalRequests?: ReturnType<typeof createApprovalRequestManager>,
  missionLedger?: ReturnType<typeof createMissionLedger>,
  connectionContext?: ConnectionContext,
  reviewWorkflow?: ReviewWorkflowService,
  liveWaiters?: LiveWaiterRegistry,
  agentMessages?: ReturnType<typeof createAgentMessageManager>,
  supervisorRuns?: ReturnType<typeof createSupervisorRuns>,
  onSupervisorResume?: (workSessionId: string) => void,
  db?: DatabaseHandle,
  mutationReceipts?: MutationReceiptStore,
  onWorkspaceAppResource?: (uri: string) => void,
  onPhaseTiming?: (phase: string, durationMs: number) => void,
): McpServer {
  const serverConstructionStartedAt = performance.now();
  const server = new McpServer(
    {
      name: "kontrol",
      title: "Kontrol",
      // P1 #26: runtime version derives from the package manifest so the MCP
      // surface can never advertise an independent hardcoded version.
      version: readPackageVersion(),
      description:
        "Secure local coding workspace for MCP clients. Provides workspace-scoped file, search, edit, write, and shell tools.",
    },
    {
      instructions: cachedServerInstructions(config),
    },
  );
  onPhaseTiming?.("mcp.server_construction", performance.now() - serverConstructionStartedAt);
  const toolRegistrationStartedAt = performance.now();
  const mutationPrincipalId = connectionContext?.authenticatedPrincipalId
    || `${connectionContext?.authSource ?? "anonymous"}:${connectionContext?.authenticatedRole ?? "client"}`;

  function trackToolEvent(
    workspaceId: string,
    tool: string,
    input: Record<string, unknown>,
    result: { content: ToolContent[]; isError?: boolean },
    startedAt: number,
  ): void {
    if (!workSessions || !config.acpEnabled || !eventStore) return;
    try {
      // Attribution is part of the execution envelope: prefer the work session
      // bound to THIS MCP connection, falling back to the workspace's "currently
      // active" session only for non-delegated (direct) tool calls.
      const workSessionId =
        connectionContext?.workSessionId ?? workspaces.getWorkspace(workspaceId).currentWorkSessionId;
      if (!workSessionId) return;

      const session = workSessions.get(workSessionId);
      if (!session) {
        throw new Error("Bound work session does not exist");
      }
      if (session.workspaceSessionId !== workspaceId) {
        throw new Error("Work session does not belong to this workspace");
      }

      workSessions.logToolEvent({
        workSessionId,
        workspaceSessionId: workspaceId,
        tool,
        inputJson: JSON.stringify(input),
        outputSummary: contentText(result.content).slice(0, 2000),
        path: typeof input.path === "string" ? input.path : undefined,
        success: !result.isError,
        elapsedMs: Math.round(performance.now() - startedAt),
      });

      // Append to the durable event log so subscribers (WebUI watcher) react
      // without polling. The projection (work_session_tool_events) is for
      // query/history; the event log is what drives the UI.
      eventStore.appendEvent({
        type: result.isError ? "agent.tool.failed" : "agent.tool.completed",
        sessionId: workSessionId,
        payload: {
          runId: connectionContext?.runId,
          mcpSessionId: connectionContext?.mcpSessionId,
          mcpSessionLabel: connectionContext?.mcpSessionLabel,
          conversationId: connectionContext?.conversationId,
          tool,
          path: typeof input.path === "string" ? input.path : undefined,
          input,
          outputSummary: contentText(result.content).slice(0, 2000),
          success: !result.isError,
          elapsedMs: Math.round(performance.now() - startedAt),
        },
      });
    } catch (error) {
      // P1 #25: session tracking is non-critical and must never fail the
      // user's tool call, but persistent audit degradation must be visible.
      recordDegradedAudit("work_session_tool_event", error);
    }
  }

  // P0 #3: Centralized mutation preflight. Every mutation-capable tool (write,
  // edit, apply_patch, exec_command/bash, write_stdin) awaits the workspace's
  // initial filesystem baseline through this single choke point, so a mutation
  // can never race the background baseline capture and escape the review
  // boundary. Reads may proceed immediately.
  async function prepareForMutation(workspaceId: string): Promise<void> {
    if (!config.widgets || config.widgets === "off") return;
    const workspace = workspaces.getWorkspace(workspaceId);
    try {
      await reviewCheckpoints.awaitWorkspaceReady({ workspaceId, root: workspace.root });
    } catch (error) {
      // A permanently-ineligible workspace (no git, capture failure) must not
      // silently block mutations; log and let the mutation proceed, since there
      // is no baseline to race. Real readiness errors surface at open_workspace.
      logEvent(config.logging, "warn", "checkpoint_ready_barrier_failed", {
        workspaceId,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  registerAppResource(
    server,
    "Kontrol Workspace App",
    WORKSPACE_APP_URI,
    {
      description: "Interactive Kontrol workspace and review interface.",
      _meta: workspaceAppResourceMeta(),
    },
    async () => {
      onWorkspaceAppResource?.(WORKSPACE_APP_URI);
      logEvent(config.logging, "info", "workspace_app_resource_served", {
        uri: WORKSPACE_APP_URI,
        buildId: WORKSPACE_APP_BUILD_ID,
        mimeType: RESOURCE_MIME_TYPE,
        bytes: Buffer.byteLength(WORKSPACE_APP_HTML, "utf8"),
      });
      return { contents: [{ uri: WORKSPACE_APP_URI, mimeType: RESOURCE_MIME_TYPE, text: WORKSPACE_APP_HTML, _meta: workspaceAppResourceMeta() }] };
    },
  );
  // Existing ChatGPT cards already cache the original URI under OpenAI's
  // output-template key. Serve its legacy representation so Retry can repair
  // those cards; new MCP Apps use the content-hashed standards URI above.
  server.registerResource(
    "Kontrol Workspace App (legacy)",
    LEGACY_WORKSPACE_APP_URI,
    { mimeType: "text/html+skybridge", description: "Legacy ChatGPT template." },
    async () => {
      onWorkspaceAppResource?.(LEGACY_WORKSPACE_APP_URI);
      logEvent(config.logging, "info", "workspace_app_resource_served", {
        uri: LEGACY_WORKSPACE_APP_URI,
        buildId: WORKSPACE_APP_BUILD_ID,
        mimeType: "text/html+skybridge",
        bytes: Buffer.byteLength(WORKSPACE_APP_HTML, "utf8"),
      });
      return { contents: [{ uri: LEGACY_WORKSPACE_APP_URI, mimeType: "text/html+skybridge", text: WORKSPACE_APP_HTML }] };
    },
  );
  server.registerResource(
    "Kontrol Workspace App (OpenAI compatibility)",
    OPENAI_WORKSPACE_APP_URI,
    { mimeType: "text/html+skybridge", description: "OpenAI compatibility template." },
    async () => {
      onWorkspaceAppResource?.(OPENAI_WORKSPACE_APP_URI);
      logEvent(config.logging, "info", "workspace_app_resource_served", {
        uri: OPENAI_WORKSPACE_APP_URI,
        buildId: WORKSPACE_APP_BUILD_ID,
        mimeType: "text/html+skybridge",
        bytes: Buffer.byteLength(WORKSPACE_APP_HTML, "utf8"),
      });
      return { contents: [{ uri: OPENAI_WORKSPACE_APP_URI, mimeType: "text/html+skybridge", text: WORKSPACE_APP_HTML }] };
    },
  );
  server.registerResource(
    "Kontrol Workspace App (DevDesktop migration)",
    DEVDESKTOP_WORKSPACE_APP_URI,
    { mimeType: "text/html+skybridge", description: "Compatibility template for cached DevDesktop cards." },
    async () => {
      onWorkspaceAppResource?.(DEVDESKTOP_WORKSPACE_APP_URI);
      logEvent(config.logging, "info", "workspace_app_resource_served", {
        uri: DEVDESKTOP_WORKSPACE_APP_URI,
        buildId: WORKSPACE_APP_BUILD_ID,
        mimeType: "text/html+skybridge",
        bytes: Buffer.byteLength(WORKSPACE_APP_HTML, "utf8"),
      });
      return { contents: [{ uri: DEVDESKTOP_WORKSPACE_APP_URI, mimeType: "text/html+skybridge", text: WORKSPACE_APP_HTML }] };
    },
  );

  registerAppTool(
    server,
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Open a local project directory as a coding workspace. Call this once per project folder or worktree before reading, editing, searching, writing, showing changes, or running commands. Reuse the returned workspaceId for later calls in the same folder; do not call open_workspace again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. By default this opens the actual checkout; set mode=\"worktree\" when the user asks for an isolated or parallel coding session. Ordinary non-Git directories are valid checkout workspaces and use filesystem change tracking; only managed worktrees require Git. Review and code-edit work stays direct in the workspace; optional ACP delegation follows discover_agents and healthy-agent checks. Returns the workspace capabilities and project instructions.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path, or a leading-tilde home path such as ~/project, to a local project directory inside an allowed root.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Defaults to checkout. Use checkout to work in the actual directory. Use worktree to create an isolated managed Git worktree for parallel work.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
      },
      outputSchema: {
        workspaceId: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        sourceRoot: z.string().optional(),
        workspaceKind: z.enum(["checkout", "worktree"]),
        versionControl: z.enum(["git", "none", "unknown"]),
        checkpointBackend: z.enum(["git", "filesystem", "unavailable"]),
        capabilities: z.object({
          read: z.boolean(),
          search: z.boolean(),
          edit: z.boolean(),
          changeTracking: z.boolean(),
          managedWorktree: z.boolean(),
        }),
        worktree: z
          .object({
            path: z.string(),
            baseRef: z.string(),
            baseSha: z.string(),
            dirtySource: z.boolean(),
            detached: z.boolean(),
            managed: z.boolean(),
          })
          .optional(),
        agentsFiles: z.array(workspaceAgentsFileOutputSchema),
        availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema),
        skills: z.array(workspaceSkillOutputSchema),
        skillDiagnostics: z.array(z.unknown()),
        instruction: z.string(),
      },
      ...toolWidgetDescriptorMeta(config, "workspace"),
      // checkout opening initializes workspace/checkpoint state, and
      // mode="worktree" creates a managed Git worktree. This combined
      // operation therefore has a real side effect even when the default
      // checkout path only reads project files.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ path, mode, baseRef }) => {
      const startedAt = performance.now();
      const { workspace, agentsFiles, availableAgentsFiles } = await workspaces.openWorkspace({ path, mode, baseRef });
      const gitEligibility = await getGitEligibility(workspace.root);
      const workspaceKind = workspace.mode;
      const versionControl = gitEligibility.ok ? "git" : "none";
      const checkpointBackend = gitEligibility.ok ? "git" : "filesystem";
      if (config.widgets === "changes") {
        void reviewCheckpoints.initializeWorkspace({
          workspaceId: workspace.id,
          root: workspace.root,
        });
      }
      const visibleSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: formatPathForPrompt(skill.filePath),
        }));
      const loadedAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const availableAgentsFileOutputs = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const instruction = config.skillsEnabled
        ? "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Nested instructions are loaded automatically when later tools enter their directory. Review, diagnosis, architecture, and code-edit requests go directly through this workspace first. Delegate only when the reviewer explicitly asks for bounded assistance: call discover_agents, use only a currently dispatchable healthy role=agent peer, and if optional assistance is unavailable continue directly without an alternate ACP route. The WebUI reviewer remains the approval authority. When a task matches an available skill in skills, read its path before proceeding. For skills not listed here, use the search_skills tool to discover global skills by keyword."
        : "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Nested instructions are loaded automatically when later tools enter their directory. Review, diagnosis, architecture, and code-edit requests go directly through this workspace first. Delegate only when the reviewer explicitly asks for bounded assistance: call discover_agents, use only a currently dispatchable healthy role=agent peer, and if optional assistance is unavailable continue directly without an alternate ACP route. The WebUI reviewer remains the approval authority.";
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            `Opened workspace ${workspace.id}`,
            `Root: ${workspace.root}`,
            `Mode: ${workspace.mode}`,
            `Version control: ${versionControl}; checkpoint backend: ${checkpointBackend}`,
            loadedAgentsFiles.length > 0
              ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
              : undefined,
            availableAgentsFileOutputs.length > 0
              ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
              : undefined,
            visibleSkills.length > 0
              ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
              : undefined,
            instruction,
          ].filter(Boolean).join("\n"),
        },
      ];
      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: resultContent,
        _meta: {
          tool: "open_workspace",
          card: {
            workspaceId: workspace.id,
            root: workspace.root,
            path: workspace.root,
            summary: {
              agentsFiles: loadedAgentsFiles.length,
              availableAgentsFiles: availableAgentsFileOutputs.length,
              skills: visibleSkills.length,
              skillDiagnostics: workspace.skillDiagnostics.length,
            },
          },
        },
        structuredContent: {
          workspaceId: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          workspaceKind,
          versionControl,
          checkpointBackend,
          capabilities: {
            read: true,
            search: true,
            edit: true,
            changeTracking: true,
            managedWorktree: workspace.mode === "worktree",
          },
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          agentsFiles: loadedAgentsFiles,
          availableAgentsFiles: availableAgentsFileOutputs,
          skills: visibleSkills,
          skillDiagnostics: workspace.skillDiagnostics,
          instruction,
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.read,
    {
      title: "Read file",
      description:
        [
          "Read a file inside an open workspace. Use this for file inspection instead of shell commands like cat or sed. Call open_workspace first and pass workspaceId.",
          "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
          config.skillsEnabled
            ? "If available skills were returned and a task matches one, read that skill's path before proceeding. Skill paths may be outside the workspace; only advertised SKILL.md files and files under already-loaded skill directories are readable."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path to read, relative to the workspace root. May also be an advertised skill path from open_workspace skills."
              : "File path to read, relative to the workspace root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
        approvalResumeId: approvalResumeIdSchema,
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      {
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
      }
      const readPath = workspaces.resolveReadPath(workspace, input.path);
      if (policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          workspaceId,
          connectionContext?.workSessionId,
          connectionContext?.runId,
          toolNames.read,
          canonicalPolicyPath(workspace.root, input.path, readPath.absolutePath),
          undefined,
        );
        if (!approved.allowed) {
          return policyFailureResponse(approved, `Tool "${toolNames.read}" denied by policy. Path: ${input.path}`, {
            tool: toolNames.read,
            workspaceId,
            path: input.path,
          });
        }
      }
      const newlyApplicable = readPath.skillRead
        ? []
        : await workspaces.loadApplicableInstructions(workspace, input.path);
      const response = await readFileTool(
        { ...input, path: readPath.absolutePath },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: readPath.readRoots,
        },
      );

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }
      workspaces.markReadPathLoaded(workspace, readPath);

      const instructionNotice = newlyApplicable.length > 0
        ? textBlock(`Newly applicable instructions loaded: ${newlyApplicable.map((file) => formatAgentsPath(file.path, workspace.root)).join(", ")}`)
        : undefined;
      const responseContent = instructionNotice ? [instructionNotice, ...response.content] : response.content;
      const responseForOutput = instructionNotice ? { ...response, content: responseContent } : response;
      const summary = {
        ...textSummary(responseContent),
        offset: input.offset ?? 1,
        limited: input.limit !== undefined,
      };
      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      trackToolEvent(workspaceId, toolNames.read, input, responseForOutput, startedAt);

      return {
        ...responseForOutput,
        _meta: {
          tool: toolNames.read,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: { content: responseContent },
          },
        },
        structuredContent: {
          result: contentText(responseContent),
        },
      };
    },
  );

  if (config.toolMode !== "codex") {
  registerAppTool(
    server,
    toolNames.write,
    {
      title: "Write file",
      description:
        `Create or completely overwrite a file inside an open workspace. Prefer ${toolNames.edit} for targeted changes to existing files. Call open_workspace first and pass workspaceId.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
        approvalResumeId: approvalResumeIdSchema,
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "write"),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      await prepareForMutation(workspaceId);
      const workspace = workspaces.getWorkspace(workspaceId);
      const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
      if (bindingErr) return bindingErr;
      const resolvedPath = workspaces.resolvePath(workspace, input.path);
      const policyPath = canonicalPolicyPath(workspace.root, input.path, resolvedPath);

      // Policy enforcement for file writes
      if (policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          workspaceId,
          connectionContext?.workSessionId,
          connectionContext?.runId,
          toolNames.write,
          policyPath,
          undefined,
        );
        if (!approved.allowed) {
          return policyFailureResponse(approved, `Tool "${toolNames.write}" denied by policy. Path: ${input.path}`, {
            tool: toolNames.write,
            workspaceId,
            path: input.path,
          });
        }
      }

      await workspaces.loadApplicableInstructions(workspace, input.path);
      const response = await writeFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.write,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const patch = newFilePatch(input.path, input.content);
      const stats = countDiffStats(patch);
      const summary = {
        ...stats,
        lines: contentLineCount(input.content),
        characters: input.content.length,
      };
      logToolCall(config, {
        tool: toolNames.write,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      trackToolEvent(workspaceId, toolNames.write, input, response, startedAt);

      return {
        ...response,
        _meta: {
          tool: toolNames.write,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              content: response.content,
              patch,
            },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.edit,
    {
      title: "Edit file",
      description:
        `Edit one file inside an open workspace by replacing exact text blocks. Prefer this over ${toolNames.write} for targeted changes. Each oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit and keep oldText as small as possible while still unique. Call open_workspace first and pass workspaceId.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
        approvalResumeId: approvalResumeIdSchema,
      },
      ...toolWidgetDescriptorMeta(config, "edit"),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      await prepareForMutation(workspaceId);
      const workspace = workspaces.getWorkspace(workspaceId);
      const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
      if (bindingErr) return bindingErr;
      const resolvedPath = workspaces.resolvePath(workspace, input.path);
      const policyPath = canonicalPolicyPath(workspace.root, input.path, resolvedPath);

      // Policy enforcement for file edits
      if (policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          workspaceId,
          connectionContext?.workSessionId,
          connectionContext?.runId,
          toolNames.edit,
          policyPath,
          undefined,
        );
        if (!approved.allowed) {
          return policyFailureResponse(approved, `Tool "${toolNames.edit}" denied by policy. Path: ${input.path}`, {
            tool: toolNames.edit,
            workspaceId,
            path: input.path,
          });
        }
      }

      await workspaces.loadApplicableInstructions(workspace, input.path);
      const response = await editFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.edit,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const stats = countDiffStats(
        response.details?.patch ?? response.details?.diff,
      );
      const summary = {
        ...stats,
        editCount: input.edits.length,
      };
      const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
      const editContent = [textBlock(editResultText)];
      logToolCall(config, {
        tool: toolNames.edit,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      trackToolEvent(workspaceId, toolNames.edit, { ...input, path: input.path }, response, startedAt);

      return {
        content: editContent,
        _meta: {
          tool: toolNames.edit,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              diff: response.details?.diff,
              patch: response.details?.patch,
            },
          },
        },
        structuredContent: {
          status: "applied",
          result: contentText(editContent),
        },
      };
    },
  );
  }

  if (config.toolMode === "codex") {
    registerAppTool(
      server,
      "apply_patch",
      {
        title: "Apply patch",
        description:
          "Apply one Codex-style patch inside an open workspace. Supports adding, overwriting, updating, deleting, and moving files. Use this for all file modifications. Paths must be relative to the workspace. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          patch: z
            .string()
            .describe("Patch text enclosed by *** Begin Patch and *** End Patch markers."),
          approvalResumeId: approvalResumeIdSchema,
        },
        outputSchema: resultOutputSchema({
          additions: z.number(),
          removals: z.number(),
          files: z.array(
            z.object({
              path: z.string(),
              previousPath: z.string().optional(),
              operation: z.enum(["add", "update", "delete", "move"]),
            }),
          ),
        }),
        ...toolWidgetDescriptorMeta(config, "edit"),
        annotations: EDIT_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, patch, approvalResumeId }) => {
        const startedAt = performance.now();
        await prepareForMutation(workspaceId);
        const workspace = workspaces.getWorkspace(workspaceId);
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
        const actions = parsePatch(patch) as Array<{ path: string; moveTo?: string }>;
        const affectedPaths = actions.flatMap((action) => [action.path, action.moveTo].filter((path): path is string => Boolean(path)));
        const policyPaths = affectedPaths.map((path) => canonicalPolicyPath(
          workspace.root,
          path,
          workspaces.resolvePath(workspace, path),
        ));

        // Policy enforcement (P0 #3): Codex apply_patch is an edit_files action
        // and must be gated exactly like the ordinary `write`/`edit` tools.
        if (policyEnforcer && policyEngine) {
          const approved = await enforceToolPolicy(
            workSessions,
            policyEnforcer,
            workspaceId,
            connectionContext?.workSessionId,
            connectionContext?.runId,
            "apply_patch",
            undefined,
            undefined,
            policyPaths,
            approvalResumeId,
          );
          if (!approved.allowed) {
            return policyFailureResponse(approved, `Tool "apply_patch" denied by policy.`, {
              tool: "apply_patch",
              workspaceId,
              path: affectedPaths[0],
            });
          }
        }

        // Load instructions for every path named by the patch before any file
        // is changed. parsePatch is validation-only; applyPatch revalidates all
        // confined destinations immediately before staging/rename.
        for (const action of actions) {
          await workspaces.loadApplicableInstructions(workspace, action.path);
          if (action.moveTo) await workspaces.loadApplicableInstructions(workspace, action.moveTo);
        }
        const applied = await applyPatch(workspace.root, patch);
        const paths = applied.files.map((file) => file.path).join(", ");
        const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
        const content = [textBlock(result)];
        const displayPath = applied.files.length === 1
          ? applied.files[0]?.path
          : `${applied.files.length} files`;

        logToolCall(config, {
          tool: "apply_patch",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        trackToolEvent(workspaceId, "apply_patch", { patch: patch.slice(0, 500) }, { content, isError: false }, startedAt);

        return {
          content,
          _meta: {
            tool: "apply_patch",
            card: {
              workspaceId,
              path: displayPath,
              summary: {
                files: applied.files.length,
                additions: applied.additions,
                removals: applied.removals,
              },
              payload: { patch: applied.patch },
            },
          },
          structuredContent: {
            result,
            additions: applied.additions,
            removals: applied.removals,
            files: applied.files,
          },
        };
      },
    );
  }

  if (config.widgets === "changes") {
    registerAppTool(
      server,
      "show_changes",
      {
        title: "Show changes",
        description:
          "Show aggregate changes for an open workspace using its available checkpoint backend. Git is optional: ordinary directories use content-addressed filesystem snapshots. After the final successful edit, write, or apply_patch call in the current turn, call this exactly once before the final response so the user can inspect the combined change set.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          since: z
            .enum(["last_shown", "workspace_open"])
            .optional()
            .describe("Defaults to last_shown, which is correct for normal end-of-turn review. Use workspace_open only when the user asks to review all changes since opening the workspace."),
          markReviewed: z
            .boolean()
            .optional()
            .describe("Defaults to true. When true, advances the last shown checkpoint to the current workspace state."),
        },
        outputSchema: resultOutputSchema({
          snapshotKind: z.enum(["git", "filesystem"]).optional(),
          snapshotRef: z.string().optional(),
        }),
        ...toolWidgetDescriptorMeta(config, "show_changes"),
        // The default markReviewed=true advances the workspace checkpoint.
        // Keep the existing end-of-turn acknowledgement behavior, but do not
        // advertise this state-changing operation as read-only to MCP hosts.
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      async ({ workspaceId, since, markReviewed }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
      {
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
      }
        const review = await reviewCheckpoints.reviewChanges({
          workspaceId,
          root: workspace.root,
          since: since ?? "last_shown",
          markReviewed: markReviewed ?? true,
        });

        const content = [textBlock(review.result)];
        logToolCall(config, {
          tool: "show_changes",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        trackToolEvent(workspaceId, "show_changes", { since, markReviewed }, { content, isError: false }, startedAt);

        return {
          content,
          _meta: {
            tool: "show_changes",
            card: {
              workspaceId,
              summary: review.summary,
              files: review.files,
              payload: {
                patch: review.patch,
              },
            },
          },
          structuredContent: {
            result: contentText(content),
            snapshotKind: review.snapshotKind,
            snapshotRef: review.snapshotRef,
          },
        };
      },
    );
  }

  // Structured read-only discovery is part of the public surface in every
  // tool mode. Codex mode adds process-oriented tools but does not hide these
  // stable inspection primitives.
  {
    registerAppTool(
      server,
      toolNames.grep,
      {
        title: "Grep",
        description:
          "Search file contents inside an open workspace. Use this before broad reads when looking for symbols, text, or usage sites. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          pattern: z.string().describe("Search pattern."),
          approvalResumeId: approvalResumeIdSchema,
          path: z
            .string()
            .optional()
            .describe(
              "Optional path or glob scope relative to the workspace root.",
            ),
          include: z.string().optional().describe("Optional include glob."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
      {
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
      }
        const policyPath = input.path
          ? canonicalPolicyPath(workspace.root, input.path, workspaces.resolvePath(workspace, input.path))
          : undefined;
        if (policyEnforcer && policyEngine) {
          const approved = await enforceToolPolicy(
            workSessions,
            policyEnforcer,
            workspaceId,
            connectionContext?.workSessionId,
            connectionContext?.runId,
            toolNames.grep,
            policyPath,
            undefined,
          );
          if (!approved.allowed) {
            return policyFailureResponse(approved, `Tool "${toolNames.grep}" denied by policy.`, {
              tool: toolNames.grep,
              workspaceId,
              path: input.path,
            });
          }
        }
        if (input.path) await workspaces.loadApplicableInstructions(workspace, input.path);
        const response = await grepFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.grep,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.grep,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.grep,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.glob,
      {
        title: "Glob",
        description:
          "Find files by glob pattern inside an open workspace. Use this to discover filenames or narrow file sets before reading. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          pattern: z.string().describe("File glob pattern."),
          approvalResumeId: approvalResumeIdSchema,
          path: z
            .string()
            .optional()
            .describe("Optional path scope relative to the workspace root."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
      {
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
      }
        const policyPath = input.path
          ? canonicalPolicyPath(workspace.root, input.path, workspaces.resolvePath(workspace, input.path))
          : undefined;
        if (policyEnforcer && policyEngine) {
          const approved = await enforceToolPolicy(
            workSessions,
            policyEnforcer,
            workspaceId,
            connectionContext?.workSessionId,
            connectionContext?.runId,
            toolNames.glob,
            policyPath,
            undefined,
          );
          if (!approved.allowed) {
            return policyFailureResponse(approved, `Tool "${toolNames.glob}" denied by policy.`, {
              tool: toolNames.glob,
              workspaceId,
              path: input.path,
            });
          }
        }
        if (input.path) await workspaces.loadApplicableInstructions(workspace, input.path);
        const response = await findFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.glob,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.glob,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.glob,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.ls,
      {
        title: "Ls",
        description:
          "List a directory inside an open workspace. Use this for directory inspection before reading files. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          path: z
            .string()
            .describe(
              "Directory path to list, relative to the workspace root.",
            ),
          approvalResumeId: approvalResumeIdSchema,
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "directory"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
      {
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
      }
        const resolvedPath = workspaces.resolvePath(workspace, input.path);
        const policyPath = canonicalPolicyPath(workspace.root, input.path, resolvedPath);
        if (policyEnforcer && policyEngine) {
          const approved = await enforceToolPolicy(
            workSessions,
            policyEnforcer,
            workspaceId,
            connectionContext?.workSessionId,
            connectionContext?.runId,
            toolNames.ls,
            policyPath,
            undefined,
          );
          if (!approved.allowed) {
            return policyFailureResponse(approved, `Tool "${toolNames.ls}" denied by policy. Path: ${input.path}`, {
              tool: toolNames.ls,
              workspaceId,
              path: input.path,
            });
          }
        }
        await workspaces.loadApplicableInstructions(workspace, input.path);
        const response = await listDirectoryTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.ls,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = textSummary(response.content);
        logToolCall(config, {
          tool: toolNames.ls,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.ls,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );
  }

  if (config.toolMode !== "codex") {
  registerAppTool(
    server,
    toolNames.shell,
    {
      title: "Bash",
      description: `Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for repository inspection; do not use shell parsing to replace those structured read-only tools. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        command: z
          .string()
          .describe(
            `Shell command to run. Must not create or modify project files; use ${toolNames.edit} or ${toolNames.write} for file changes.`,
          ),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Optional working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout in seconds. Defaults to 30, max 300."),
        approvalResumeId: approvalResumeIdSchema,
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, workingDirectory, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
      if (bindingErr) return bindingErr;
      const cwd = workspaces.resolveWorkingDirectory(
        workspace,
        workingDirectory,
      );
      const policyPath = canonicalPolicyPath(workspace.root, workingDirectory, cwd);

      // Policy enforcement: block until human approval if required
      if (policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          workspaceId,
          connectionContext?.workSessionId,
          connectionContext?.runId,
          toolNames.shell,
          policyPath,
          input.command,
          undefined,
          input.approvalResumeId,
        );
        if (!approved.allowed) {
          return policyFailureResponse(approved, `Tool "${toolNames.shell}" denied by policy. Command: ${input.command}`, {
            tool: toolNames.shell,
            workspaceId,
            path: typeof policyPath === "string" ? policyPath : policyPath?.relativePath,
            command: input.command,
          });
        }
      }

      if (workingDirectory) await workspaces.loadApplicableInstructions(workspace, workingDirectory);
      const response = await runShellTool(input, {
        cwd,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.shell,
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: input.command,
          commandLength: input.command.length,
        }, response.content, startedAt);
        return response;
      }

      const summary = {
        command: input.command,
        workingDirectory: workingDirectory ?? ".",
        ...textSummary(response.content),
      };
      logToolCall(config, {
        tool: toolNames.shell,
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: input.command,
        commandLength: input.command.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      trackToolEvent(workspaceId, toolNames.shell, input, response, startedAt);

      return {
        ...response,
        _meta: {
          tool: toolNames.shell,
          card: {
            workspaceId,
            path: workingDirectory,
            summary,
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );
  }

  if (config.toolMode === "codex") {
    registerCodexProcessTools(server, config, workspaces, processSessions, workSessions, policyEnforcer, policyEngine, connectionContext, prepareForMutation);
  }

  // Policy approval tools — available whenever policy engine is configured.
  // The MCP /mcp surface is reached by the WebUI (reviewer) and ordinary
  // clients, NOT by the worker (the worker reaches Kontrol through the
  // stdio bridge, which hides these tools). Mark the caller as a reviewer so
  // provide_policy_approval is permitted here.
  if (policyEngine && eventStore) {
    registerPolicyTools(server, {
      eventStore,
      policyEngine,
      approvalRequests,
      principalRole: connectionContext?.authenticatedRole ?? "client",
      principalId: mutationPrincipalId,
      mutationReceipts,
    });
  }

  if (workSessions && config.acpEnabled && eventStore && reviewWorkflow && liveWaiters) {
    const bridgeConfig: Parameters<typeof registerBridgeTools>[1] = {
      db,
      workspaces,
      workSessions,
      reviewCheckpoints,
      agentRegistry: agentRegistry!,
      eventStore,
      continuationManager: continuationManager!,
      dispatchOutbox,
      reviewWorkflow,
      missionLedger,
      supervisorRuns,
      onSupervisorResume,
      agentMessages,
      approvalRequests,
      knownAgents: config.acpKnownAgents,
      adapterSecret: config.acpAdapterSecret,
      // P1 #10: pass server config to bridge so search_skills has access to skill paths.
      serverConfig: config,
      // Role is derived from the AUTHENTICATED envelope only. A connection is a
      // WORKER solely when a signed worker token verified (see
      // connectionContext.authenticatedRole); an ordinary MCP client is
      // "client". Reviewer authority requires the separate reviewer credential.
      // This lets the SAME bridge tool set enforce
      // reviewer-only vs worker-only server-side without registering the tools
      // twice — and crucially, a caller cannot gain worker rights by sending an
      // unsigned X-Kontrol-Work-Session header (P0 #3).
      principalRole: connectionContext?.authenticatedRole ?? "client",
      principalId: mutationPrincipalId,
      mutationReceipts,
      connectionContinuationId: connectionContext?.continuationId,
      connectionWorkSessionId: connectionContext?.workSessionId,
      connectionWorkspaceLeaseNonce: connectionContext?.workspaceLeaseNonce,
      liveWaiters,
      onPhaseTiming,
    };
    registerBridgeTools(server, bridgeConfig);
  }

  toolListDescriptorCacheActive = installCachedToolList(
    server,
    `${config.toolMode}|${config.widgets}|${config.skillsEnabled ? "skills" : "no-skills"}|${config.acpEnabled ? "acp" : "no-acp"}|${policyEngine ? "policy" : "no-policy"}`,
    toolListDescriptorCache,
    ListToolsRequestSchema,
  );
  if (!toolListDescriptorCacheActive) {
    console.warn("[kontrol] tools/list descriptor cache unavailable (SDK internals changed); serving uncached");
  }
  onPhaseTiming?.("mcp.tool_registration", performance.now() - toolRegistrationStartedAt);

  return server;
}
