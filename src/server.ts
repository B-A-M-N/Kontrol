import { execSync } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { applyPatch, parsePatch } from "./apply-patch.js";
import { loadConfig, type ServerConfig, type WidgetMode } from "./config.js";
import {
  logEvent,
  requestIp,
  requestPath,
  commandPreview,
  sessionIdPrefix,
} from "./logger.js";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  runShellTool,
  writeFileTool,
} from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { ProcessSessionManager, type ProcessSnapshot } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { formatPathForPrompt } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import { createWorkSessionManager, type WorkSessionManager } from "./work-sessions.js";
import { createAgentRegistryManager } from "./acp-registry.js";
import { createAcpServer } from "./acp-server.js";
import { registerBridgeTools, createContinuationDispatcher, type ContinuationDispatcher, type LiveWaiterRegistry, type BridgeConfig } from "./acp-bridge.js";
import { createEventStore } from "./event-log.js";
import { createContinuationManager } from "./continuation.js";
import { createDispatchOutbox } from "./dispatch-outbox.js";
import { createSupervisorRuns } from "./supervisor-runs.js";
import { createSupervisorRuntime } from "./supervisor-runtime.js";
import { verifyMissionSubmission } from "./mission-verifier.js";
import { evaluateSupervisorMission } from "./supervisor-evaluator.js";
import { createReviewWorkflowService, type ReviewWorkflowService } from "./review-workflow.js";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { createPolicyEngine, type PolicyConfig, type PolicyEngine, type ApprovalScope } from "./policy.js";
import { createSqliteGrantStore } from "./policy-grants.js";
import { registerPolicyTools } from "./policy-tools.js";
import { createPolicyEnforcer, type PolicyInvocation, type PolicyEnforcer, ACP_TOOL_POLICY_NAMES, type PrincipalRole } from "./policy-enforcement.js";
import { authorizeWorkSessionAction } from "./work-session-action-guard.js";
import { verifyWorkerToken, type WorkerTokenClaims } from "./acp-worker-token.mjs";
import { createApprovalRequestManager } from "./approval-requests.js";
import { createMissionLedger } from "./mission-ledger.js";
import { createAgentMessageManager } from "./agent-messages.js";
import { DEVDESKTOP_WORKSPACE_APP_URI, LEGACY_WORKSPACE_APP_URI, OPENAI_WORKSPACE_APP_URI, WORKSPACE_APP_BUILD_ID, WORKSPACE_APP_HTML, WORKSPACE_APP_URI, isWorkspaceAppUri, workspaceAppResourceMeta, workspaceAppToolMeta } from "./workspace-app-resource.js";
import { createRuntimeIdentity, readBuildIdentity, readRuntimeIdentity, removeRuntimeIdentity } from "./runtime-identity.js";
import { mcpSessionIdleReason, mcpSessionIdleTtl } from "./mcp-session-policy.js";

type Transport = StreamableHTTPServerTransport;
interface McpSessionState {
  sessionId: string;
  sessionLabel: string;
  logicalClientId: string;
  conversationId?: string;
  createdAt: number;
  lastActivityAt: number;
  inFlightRequests: number;
  requestCount: number;
  notificationCount: number;
  toolCallCount: number;
  resourceReadCount: number;
  activeLongPollCount: number;
  closing: boolean;
  closed: boolean;
  endRecorded: boolean;
  durableWorkerSession: boolean;
  lastRpcMethod?: string;
  lastToolName?: string;
}

type McpSessionWindowKind = "created" | "closed" | "expired" | "tool";

interface McpSessionClientMetrics {
  sessionsCreated: number;
  currentSessions: number;
  sessionsClosed: number;
  sessionsExpired: number;
  zeroToolSessions: number;
  singleToolSessions: number;
  multiToolSessions: number;
  totalToolCalls: number;
  totalLifetimeMs: number;
  oldestIdleMs: number;
}

interface McpSessionMetrics {
  created: number;
  evicted: number;
  closed: number;
  expired: number;
  inFlight: number;
  clients: Map<string, McpSessionClientMetrics>;
  windowEvents: Array<{ at: number; kind: McpSessionWindowKind }>;
  completedToolCounts: number[];
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

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  dispatcher?: ContinuationDispatcher;
  close(): void;
  drain(): Promise<void>;
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface DiffStats {
  additions: number;
  removals: number;
}

function logicalClientId(req: Request): string {
  if (req.auth?.clientId) return `oauth:${req.auth.clientId}`;
  const supplied = req.header("x-kontrol-client-instance")?.trim();
  if (supplied) return `instance:${supplied.slice(0, 200)}`;
  const clientInfo = (req.body as { params?: { clientInfo?: { name?: unknown; version?: unknown } } } | undefined)
    ?.params?.clientInfo;
  const name = typeof clientInfo?.name === "string" ? clientInfo.name : "unknown";
  const version = typeof clientInfo?.version === "string" ? clientInfo.version : "unknown";
  return `mcp:${name.slice(0, 100)}@${version.slice(0, 100)}`;
}

// MCP does not standardize a conversation identifier. If a trusted
// deployment forwards one, retain it for diagnostics/labeling only. Never use
// this value to pool transports or grant access; the MCP session ID remains the
// isolation boundary.
function conversationId(req: Request): string | undefined {
  const value = req.header("x-kontrol-conversation-id")?.trim()
    || req.header("x-openai-conversation-id")?.trim();
  return value ? value.slice(0, 200) : undefined;
}

function mcpSessionLabel(logicalClientIdValue: string, sessionId: string, conversationIdValue?: string): string {
  const owner = conversationIdValue ? `conversation:${conversationIdValue}` : logicalClientIdValue;
  return `${owner}/mcp:${sessionIdPrefix(sessionId)}`;
}

interface McpAdmissionWaiter {
  key: string;
  resolve: (release: (() => void) | null) => void;
  timer: NodeJS.Timeout;
}

/**
 * Bounded request admission for the MCP HTTP hop. Session caps protect the
 * transport map; this queue protects the process from an unbounded number of
 * expensive tool calls and long polls running at once.
 */
export class McpAdmission {
  private active = 0;
  private readonly activeByKey = new Map<string, number>();
  private readonly queue: McpAdmissionWaiter[] = [];
  private closed = false;

  constructor(
    private readonly maxInflight: number,
    private readonly maxInflightPerKey: number,
    private readonly maxQueue: number,
  ) {
    if (!Number.isInteger(maxInflight) || maxInflight < 1) throw new Error("maxInflight must be positive");
    if (!Number.isInteger(maxInflightPerKey) || maxInflightPerKey < 1) throw new Error("maxInflightPerKey must be positive");
    if (!Number.isInteger(maxQueue) || maxQueue < 0) throw new Error("maxQueue must be non-negative");
  }

  getStats(): { active: number; queued: number; maxInflight: number; maxInflightPerKey: number; maxQueue: number } {
    return {
      active: this.active,
      queued: this.queue.length,
      maxInflight: this.maxInflight,
      maxInflightPerKey: this.maxInflightPerKey,
      maxQueue: this.maxQueue,
    };
  }

  acquire(key: string, waitDeadlineMs: number): Promise<(() => void) | null> {
    if (this.closed) return Promise.resolve(null);
    if (this.canAdmit(key)) return Promise.resolve(this.grant(key));
    if (this.queue.length >= this.maxQueue) return Promise.resolve(null);

    return new Promise((resolve) => {
      const waiter: McpAdmissionWaiter = {
        key,
        resolve,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          resolve(null);
        }, Math.max(1, waitDeadlineMs)),
      };
      this.queue.push(waiter);
    });
  }

  close(): void {
    this.closed = true;
    while (this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
  }

  private canAdmit(key: string): boolean {
    return this.active < this.maxInflight && (this.activeByKey.get(key) ?? 0) < this.maxInflightPerKey;
  }

  private grant(key: string): () => void {
    this.active++;
    this.activeByKey.set(key, (this.activeByKey.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      const count = (this.activeByKey.get(key) ?? 1) - 1;
      if (count > 0) this.activeByKey.set(key, count);
      else this.activeByKey.delete(key);
      this.drain();
    };
  }

  private drain(): void {
    if (this.closed) return;
    for (let i = 0; i < this.queue.length; i++) {
      const waiter = this.queue[i];
      if (!this.canAdmit(waiter.key)) continue;
      this.queue.splice(i, 1);
      i--;
      clearTimeout(waiter.timer);
      waiter.resolve(this.grant(waiter.key));
    }
  }
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

function toolWidgetDescriptorMeta(
  config: ServerConfig,
  kind: ToolWidgetKind,
): ToolWidgetDescriptorMeta {
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
    return `Use Kontrol as a local coding workspace. Call ${toolNames.openWorkspace} once per project folder or worktree and reuse its workspaceId. Use ${toolNames.read} for direct file reads, apply_patch for all file modifications, exec_command for inspection, tests, builds, and other commands, and write_stdin to poll or interact with running processes. Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.${showChangesInstruction}`;
  }

  const inspection = config.toolMode !== "full"
    ? `In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use ${toolNames.shell} with command-line tools such as grep, rg, find, ls, and tree for search and directory inspection. `
    : `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. `;

  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories. `
    : "";

  const agentsMd = `Follow instructions returned by ${toolNames.openWorkspace}. Kontrol loads additional AGENTS.md/CLAUDE.md files lazily from the ancestors of each requested path and returns newly applicable instructions with that tool call. `;

  return `Use Kontrol as a local coding workspace. Call ${toolNames.openWorkspace} once per project folder or worktree to obtain a workspaceId. Reuse that same workspaceId for all later file, search, edit, write, show-changes, and shell tools in that folder; do not call ${toolNames.openWorkspace} again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. ${agentsMd}${skills}${inspection}Prefer ${toolNames.edit} for targeted modifications, ${toolNames.write} only for new files or complete rewrites, and ${toolNames.shell} for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not create or modify files with ${toolNames.shell}; avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or any command whose purpose is to write project files.${showChangesInstruction}`;
}
function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    ...extra,
  };
}

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

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

function constantTimeStringEqual(actual: string | undefined, expected: string | undefined): boolean {
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
 * Policy enforcement for tool calls.
 * Returns true if the call should proceed, false if denied.
 * For "ask" mode, blocks until human approval is provided before returning.
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
  path: string | undefined,
  command: string | undefined,
): Promise<boolean> {
  if (workSessions && workSessionId) {
    const sessionDecision = authorizeWorkSessionAction(workSessions, {
      workSessionId,
      tool,
      path,
      command,
    });
    if (!sessionDecision.allowed) return false;
  }
  const { allowed } = await enforcer.enforce({
    principalId: workSessionId ?? workspaceId,
    principalRole: workSessionId ? "worker" : "client",
    workspaceId,
    workSessionId,
    runId,
    tool,
    path,
    command,
  });
  return allowed;
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


function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
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
    sessionId: z.number().optional(),
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
  policyEnforcer?: import("./policy-enforcement.js").PolicyEnforcer,
  policyEngine?: PolicyEngine,
  connectionContext?: ConnectionContext,
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
    async ({ workspaceId, cmd, tty, columns, rows, workingDirectory, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();

      // Policy enforcement (P0 #3): Codex exec_command is a run_commands action
      // and must be gated exactly like the ordinary `bash` tool.
      if (policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          workspaceId,
          connectionContext?.workSessionId,
          connectionContext?.runId,
          "exec_command",
          workingDirectory,
          cmd,
        );
        if (!approved) {
          return {
            content: [{ type: "text" as const, text: `Tool "exec_command" denied by policy. Command: ${cmd}` }],
            isError: true,
          };
        }
      }

      const workspace = workspaces.getWorkspace(workspaceId);
      {
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
      }
      const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
      const snapshot = await processSessions.start({
        workspaceId,
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
        sessionId: z.number().describe("Process session identifier returned by exec_command."),
        chars: z.string().optional().describe("Characters to write. Omit or pass an empty string to poll."),
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
    async ({ workspaceId, sessionId, chars, columns, rows, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();

      // Policy enforcement (P0 #3): writing NONEMPTY input to a process is a
      // run_commands action and must be gated. A poll-only write_stdin (no
      // chars / empty string) cannot alter process state, so it stays a
      // read/wait operation and is not gated.
      const hasInput = Boolean(chars && chars.length > 0);
      if (hasInput && policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          workspaceId,
          connectionContext?.workSessionId,
          connectionContext?.runId,
          "exec_command",
          undefined,
          chars,
        );
        if (!approved) {
          return {
            content: [{ type: "text" as const, text: `Tool "write_stdin" denied by policy: cannot send input to a gated process.` }],
            isError: true,
          };
        }
      }

      workspaces.getWorkspace(workspaceId);
      const snapshot = await processSessions.write({
        workspaceId,
        sessionId,
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
interface ConnectionContext {
  /**
   * The role authenticated for this connection. A successfully-verified signed
   * worker token yields "worker"; otherwise the connection is treated as a
   * reviewer/client. AUTHORIZATION MUST derive from this field — never from the
   * unsigned attribution headers (P0 #3). The unsigned headers below are for
   * logging/attribution only and grant no privileges.
   */
  authenticatedRole?: "worker" | "reviewer" | "client";
  workspaceSessionId?: string;
  workSessionId?: string;
  runId?: string;
  continuationId?: string;
  /** Transport identity, never shared across MCP sessions. */
  mcpSessionId?: string;
  /** Human-readable diagnostic label for this isolated transport. */
  mcpSessionLabel?: string;
  /** Optional upstream conversation correlation; not an authorization key. */
  conversationId?: string;
}

function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  workSessions?: ReturnType<typeof createWorkSessionManager>,
  agentRegistry?: import("./acp-registry.js").AgentRegistryManager,
  eventStore?: import("./event-log.js").EventStore,
  continuationManager?: import("./continuation.js").ContinuationManager,
  dispatchOutbox?: import("./dispatch-outbox.js").DispatchOutbox,
  policyEngine?: PolicyEngine,
  policyEnforcer?: import("./policy-enforcement.js").PolicyEnforcer,
  approvalRequests?: ReturnType<typeof createApprovalRequestManager>,
  missionLedger?: ReturnType<typeof createMissionLedger>,
  connectionContext?: ConnectionContext,
  reviewWorkflow?: ReviewWorkflowService,
  liveWaiters?: LiveWaiterRegistry,
  agentMessages?: ReturnType<typeof createAgentMessageManager>,
  supervisorRuns?: ReturnType<typeof createSupervisorRuns>,
  onSupervisorResume?: (workSessionId: string) => void,
  db?: DatabaseHandle,
): McpServer {
  const server = new McpServer(
    {
      name: "kontrol",
      title: "Kontrol",
      version: "0.1.0",
      description:
        "Secure local coding workspace for MCP clients. Provides workspace-scoped file, search, edit, write, and shell tools.",
    },
    {
      instructions: serverInstructions(config),
    },
  );

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
    } catch {
      // Session tracking is non-critical
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
        "Open a local project directory as a coding workspace. Call this once per project folder or worktree before reading, editing, searching, writing, showing changes, or running commands. Reuse the returned workspaceId for later calls in the same folder; do not call open_workspace again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. By default this opens the actual checkout; set mode=\"worktree\" when the user asks for an isolated or parallel coding session. Returns a workspaceId, loaded root project instructions, and nested instruction file paths the model should read before working in those directories.",
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
      annotations: { readOnlyHint: true },
    },
    async ({ path, mode, baseRef }) => {
      const startedAt = performance.now();
      const { workspace, agentsFiles, availableAgentsFiles } = await workspaces.openWorkspace({ path, mode, baseRef });
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
        ? "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Nested instructions are loaded automatically when later tools enter their directory. When a task matches an available skill in skills, read its path before proceeding. For skills not listed here, use the search_skills tool to discover global skills by keyword."
        : "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Nested instructions are loaded automatically when later tools enter their directory.";
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            `Opened workspace ${workspace.id}`,
            `Root: ${workspace.root}`,
            `Mode: ${workspace.mode}`,
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
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "write"),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();

      // Policy enforcement for file writes
      if (policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          workspaceId,
          connectionContext?.workSessionId,
          connectionContext?.runId,
          toolNames.write,
          input.path,
          undefined,
        );
        if (!approved) {
          return {
            content: [{ type: "text" as const, text: `Tool "${toolNames.write}" denied by policy. Path: ${input.path}` }],
            isError: true,
          };
        }
      }

      const workspace = workspaces.getWorkspace(workspaceId);
      {
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
      }
      await workspaces.loadApplicableInstructions(workspace, input.path);
      workspaces.resolvePath(workspace, input.path);
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
      },
      outputSchema: resultOutputSchema({
        status: z.literal("applied"),
      }),
      ...toolWidgetDescriptorMeta(config, "edit"),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();

      // Policy enforcement for file edits
      if (policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          workspaceId,
          connectionContext?.workSessionId,
          connectionContext?.runId,
          toolNames.edit,
          input.path,
          undefined,
        );
        if (!approved) {
          return {
            content: [{ type: "text" as const, text: `Tool "${toolNames.edit}" denied by policy. Path: ${input.path}` }],
            isError: true,
          };
        }
      }

      const workspace = workspaces.getWorkspace(workspaceId);
      {
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
      }
      await workspaces.loadApplicableInstructions(workspace, input.path);
      workspaces.resolvePath(workspace, input.path);
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
      async ({ workspaceId, patch }) => {
        const startedAt = performance.now();

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
          );
          if (!approved) {
            return {
              content: [{ type: "text" as const, text: `Tool "apply_patch" denied by policy.` }],
              isError: true,
            };
          }
        }

        const workspace = workspaces.getWorkspace(workspaceId);
      {
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
      }
        // Load instructions for every path named by the patch before any file
        // is changed. parsePatch is validation-only; applyPatch revalidates all
        // confined destinations immediately before staging/rename.
        for (const action of parsePatch(patch) as Array<{ path: string; moveTo?: string }>) {
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
          "Show aggregate file changes for an open workspace. After the final successful edit, write, or apply_patch call in the current turn, call this exactly once for that workspace before your final response so the user can inspect the combined diff for the turn. Do not call it after every individual change, and do not skip it because prior file-change tools already displayed per-tool diffs.",
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
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "show_changes"),
        annotations: { readOnlyHint: true },
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
          },
        };
      },
    );
  }

  if (config.toolMode === "full") {
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
        await workspaces.loadApplicableInstructions(workspace, input.path);
        workspaces.resolvePath(workspace, input.path);
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
      description: config.toolMode !== "full"
        ? `Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, search, file discovery, and directory inspection. In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use command-line tools such as grep, rg, find, ls, and tree for those read-only inspection actions. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read} for direct file reads. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication.`
        : `Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication.`,
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
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, workingDirectory, ...input }) => {
      const startedAt = performance.now();

      // Policy enforcement: block until human approval if required
      if (policyEnforcer && policyEngine) {
        const approved = await enforceToolPolicy(
          workSessions,
          policyEnforcer,
          workspaceId,
          connectionContext?.workSessionId,
          connectionContext?.runId,
          toolNames.shell,
          workingDirectory,
          input.command,
        );
        if (!approved) {
          return {
            content: [{ type: "text" as const, text: `Tool "${toolNames.shell}" denied by policy. Command: ${input.command}` }],
            isError: true,
          };
        }
      }

      const workspace = workspaces.getWorkspace(workspaceId);
      {
        const bindingErr = assertWorkerWorkspaceBinding(connectionContext, workSessions, workspaceId);
        if (bindingErr) return bindingErr;
      }
      if (workingDirectory) await workspaces.loadApplicableInstructions(workspace, workingDirectory);
      const cwd = workspaces.resolveWorkingDirectory(
        workspace,
        workingDirectory,
      );
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
    registerCodexProcessTools(server, config, workspaces, processSessions, workSessions, policyEnforcer, policyEngine, connectionContext);
  }

  // Policy approval tools — available whenever policy engine is configured.
  // The MCP /mcp surface is reached by the WebUI (reviewer) and ordinary
  // clients, NOT by the worker (the worker reaches Kontrol through the
  // stdio bridge, which hides these tools). Mark the caller as a reviewer so
  // provide_policy_approval is permitted here.
  if (policyEngine && eventStore) {
    registerPolicyTools(server, { eventStore, policyEngine, approvalRequests, principalRole: connectionContext?.authenticatedRole ?? "client" });
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
      knownAgents: config.acpKnownAgents,
      sharedSecret: config.acpSharedSecret,
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
      connectionContinuationId: connectionContext?.continuationId,
      connectionWorkSessionId: connectionContext?.workSessionId,
      liveWaiters,
    };
    registerBridgeTools(server, bridgeConfig);
  }

  return server;
}

export function createServer(config = loadConfig()): RunningServer {
  if (config.acpEnabled && !config.acpSharedSecret) {
    throw new Error(
      "KONTROL_ACP_SHARED_SECRET is required when KONTROL_ACP_ENABLED=true (the default). " +
        "Set it to a long random value, e.g. `openssl rand -hex 32`. The ACP surface (/acp) is authenticated with this secret.",
    );
  }

  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const buildMeta = readBuildIdentity(join(dirname(fileURLToPath(import.meta.url)), "build-meta.json"));
  const transports = new Map<string, Transport>();
  const mcpSessions = new Map<string, McpSessionState>();
  let shuttingDown = false;
  const mcpAdmission = new McpAdmission(
    config.mcpMaxInflight,
    config.mcpMaxInflightPerSession,
    config.mcpMaxQueue,
  );
  const mcpSessionMetrics: McpSessionMetrics = {
    created: 0,
    evicted: 0,
    closed: 0,
    expired: 0,
    inFlight: 0,
    clients: new Map(),
    windowEvents: [],
    completedToolCounts: [],
  };

  function clientMcpMetrics(logicalClientId: string): McpSessionClientMetrics {
    let metrics = mcpSessionMetrics.clients.get(logicalClientId);
    if (!metrics) {
      metrics = {
        sessionsCreated: 0,
        currentSessions: 0,
        sessionsClosed: 0,
        sessionsExpired: 0,
        zeroToolSessions: 0,
        singleToolSessions: 0,
        multiToolSessions: 0,
        totalToolCalls: 0,
        totalLifetimeMs: 0,
        oldestIdleMs: 0,
      };
      mcpSessionMetrics.clients.set(logicalClientId, metrics);
    }
    return metrics;
  }

  function recordMcpWindowEvent(kind: McpSessionWindowKind, at = Date.now()): void {
    mcpSessionMetrics.windowEvents.push({ at, kind });
    const cutoff = at - 15 * 60_000;
    while (mcpSessionMetrics.windowEvents.length > 0 && mcpSessionMetrics.windowEvents[0].at < cutoff) {
      mcpSessionMetrics.windowEvents.shift();
    }
  }

  function sessionWindowMetrics(windowMs: number, now = Date.now()) {
    const cutoff = now - windowMs;
    const events = mcpSessionMetrics.windowEvents.filter((event) => event.at >= cutoff);
    const sessionsCreated = events.filter((event) => event.kind === "created").length;
    const toolCalls = events.filter((event) => event.kind === "tool").length;
    return {
      sessionsCreated,
      sessionsClosed: events.filter((event) => event.kind === "closed").length,
      sessionsExpired: events.filter((event) => event.kind === "expired").length,
      toolCalls,
      sessionsPerToolCall: sessionsCreated / Math.max(toolCalls, 1),
    };
  }

  function recordMcpSessionEnd(state: McpSessionState, reason: string, now = Date.now()): void {
    if (state.endRecorded) return;
    state.endRecorded = true;
    state.closed = true;
    const metrics = clientMcpMetrics(state.logicalClientId);
    metrics.currentSessions = Math.max(0, metrics.currentSessions - 1);
    metrics.totalLifetimeMs += Math.max(0, now - state.createdAt);
    metrics.totalToolCalls += state.toolCallCount;
    metrics.oldestIdleMs = 0;
    if (state.toolCallCount === 0) metrics.zeroToolSessions++;
    else if (state.toolCallCount === 1) metrics.singleToolSessions++;
    else metrics.multiToolSessions++;
    mcpSessionMetrics.completedToolCounts.push(state.toolCallCount);
    if (mcpSessionMetrics.completedToolCounts.length > 10_000) mcpSessionMetrics.completedToolCounts.shift();
    if (reason === "expired") {
      mcpSessionMetrics.expired++;
      metrics.sessionsExpired++;
      recordMcpWindowEvent("expired", now);
    } else {
      mcpSessionMetrics.closed++;
      metrics.sessionsClosed++;
      recordMcpWindowEvent("closed", now);
    }
  }

  function recordMcpSessionCreated(logicalClientId: string, at = Date.now()): void {
    const metrics = clientMcpMetrics(logicalClientId);
    metrics.sessionsCreated++;
    metrics.currentSessions++;
    mcpSessionMetrics.created++;
    recordMcpWindowEvent("created", at);
  }

  function completedToolPercentile(percentile: number): number {
    if (mcpSessionMetrics.completedToolCounts.length === 0) return 0;
    const sorted = [...mcpSessionMetrics.completedToolCounts].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)] ?? 0;
  }

  function mcpSessionReuseMetrics() {
    const now = Date.now();
    const completed = mcpSessionMetrics.closed + mcpSessionMetrics.expired;
    const perClient = [...mcpSessionMetrics.clients.entries()].map(([client, metrics]) => {
      let currentZeroToolSessions = 0;
      let currentSingleToolSessions = 0;
      let currentMultiToolSessions = 0;
      let oldestIdleMs = 0;
      for (const state of mcpSessions.values()) {
        if (state.logicalClientId !== client) continue;
        if (state.toolCallCount === 0) currentZeroToolSessions++;
        else if (state.toolCallCount === 1) currentSingleToolSessions++;
        else currentMultiToolSessions++;
        oldestIdleMs = Math.max(oldestIdleMs, now - state.lastActivityAt);
      }
      return {
        client,
        sessionsCreated: metrics.sessionsCreated,
        currentSessions: metrics.currentSessions,
        sessionsClosed: metrics.sessionsClosed,
        sessionsExpired: metrics.sessionsExpired,
        singleToolSessions: metrics.singleToolSessions,
        multiToolSessions: metrics.multiToolSessions,
        unusedSessions: metrics.zeroToolSessions,
        currentZeroToolSessions,
        currentSingleToolSessions,
        currentMultiToolSessions,
        averageToolCallsPerSession: metrics.sessionsCreated > 0 ? metrics.totalToolCalls / metrics.sessionsCreated : 0,
        averageLifetimeMs: completed > 0 ? metrics.totalLifetimeMs / completed : 0,
        oldestIdleMs,
      };
    });
    const clientTotals = [...mcpSessionMetrics.clients.values()].reduce((totals, metrics) => ({
      zeroToolSessions: totals.zeroToolSessions + metrics.zeroToolSessions,
      singleToolSessions: totals.singleToolSessions + metrics.singleToolSessions,
      multiToolSessions: totals.multiToolSessions + metrics.multiToolSessions,
    }), { zeroToolSessions: 0, singleToolSessions: 0, multiToolSessions: 0 });
    return {
      sessionsCreated: mcpSessionMetrics.created,
      sessionsClosed: mcpSessionMetrics.closed,
      sessionsExpired: mcpSessionMetrics.expired,
      zeroToolSessions: clientTotals.zeroToolSessions,
      singleToolSessions: clientTotals.singleToolSessions,
      multiToolSessions: clientTotals.multiToolSessions,
      toolCallsPerSessionMean: completed > 0 ? mcpSessionMetrics.completedToolCounts.reduce((sum, count) => sum + count, 0) / completed : 0,
      toolCallsPerSessionP50: completedToolPercentile(0.5),
      toolCallsPerSessionP95: completedToolPercentile(0.95),
      windows: {
        last1m: sessionWindowMetrics(60_000, now),
        last5m: sessionWindowMetrics(5 * 60_000, now),
        last15m: sessionWindowMetrics(15 * 60_000, now),
      },
      perClient,
    };
  }

  // P1 #33: Memory pressure tracking for adaptive caps
  const mcpSessionBaseRss = process.memoryUsage().rss;
  let mcpSessionPeakRss = mcpSessionBaseRss;
  let mcpSessionCountAtPeak = 0;
  let mcpSessionBytesPerSessionEstimate = 5_700_000;

  function estimateMcpSessionMemoryCost() {
    return {
      bytesPerSession: mcpSessionBytesPerSessionEstimate,
      peakRss: mcpSessionPeakRss,
      peakCount: mcpSessionCountAtPeak,
    };
  }

  function trackMcpSessionMemory() {
    const current = process.memoryUsage();
    if (mcpSessions.size > mcpSessionCountAtPeak) {
      mcpSessionPeakRss = current.rss;
      mcpSessionCountAtPeak = mcpSessions.size;
      const delta = Math.max(0, current.rss - mcpSessionBaseRss);
      mcpSessionBytesPerSessionEstimate = Math.max(1_000_000, Math.round(delta / mcpSessions.size));
    }
  }

  function getMemoryPressureState() {
    trackMcpSessionMemory();
    const totalRss = process.memoryUsage().rss;
    const rssLimit = 2_000_000_000; // 2 GB threshold for "high" pressure
    if (totalRss > rssLimit * 0.8) {
      return { level: "high" as const, effectiveHardCap: Math.min(config.mcpSessionHardCap, 100), effectiveSoftCap: Math.min(config.mcpSessionSoftCap, 75) };
    }
    if (totalRss > rssLimit * 0.5) {
      return { level: "moderate" as const, effectiveHardCap: Math.min(config.mcpSessionHardCap, 150), effectiveSoftCap: Math.min(config.mcpSessionSoftCap, 100) };
    }
    return { level: "low" as const, effectiveHardCap: config.mcpSessionHardCap, effectiveSoftCap: config.mcpSessionSoftCap };
  }

  const reapIdleMcpSessions = (forceClientId?: string) => {
    const pressure = getMemoryPressureState();
    const now = Date.now();
    // Phase 1: evict sessions with active requests (never evict in-flight)
    // Phase 2: evict provisional one-tool sessions after their model-turn
    // grace window. One completed tool is not treated as immediate completion.
    // Phase 3: evict reusable sessions past their normal TTL.
    // Phase 4: if still over soft cap, LRU evict idle sessions
    const toEvict: string[] = [];
    const evictionReasons = new Map<string, string>();
    const queueEviction = (id: string, reason: string) => {
      if (evictionReasons.has(id)) return;
      toEvict.push(id);
      evictionReasons.set(id, reason);
    };
    const clientCounts = new Map<string, number>();

    for (const [id, state] of mcpSessions) {
      const idle = now - state.lastActivityAt;
      const ttl = mcpSessionIdleTtl(state, config);

      if (state.inFlightRequests > 0 || state.activeLongPollCount > 0 || state.closing || state.closed) continue;

      if (idle >= ttl) {
        queueEviction(id, mcpSessionIdleReason(state));
      } else {
        clientCounts.set(state.logicalClientId, (clientCounts.get(state.logicalClientId) ?? 0) + 1);
      }
    }

    // Admission at the per-client cap must not become a 503 wall when the
    // client has accumulated idle, non-worker one-tool transports. Reclaim
    // the oldest safe provisional sessions first, even if their ordinary TTL
    // has not elapsed yet. Active requests, long polls, and worker-bound
    // transports remain protected.
    if (forceClientId) {
      const currentClientCount = [...mcpSessions.values()].filter((state) => state.logicalClientId === forceClientId).length;
      const alreadyQueued = [...evictionReasons.keys()].filter((id) => mcpSessions.get(id)?.logicalClientId === forceClientId).length;
      const needed = Math.max(0, currentClientCount - config.mcpSessionMaxPerClient + 1 - alreadyQueued);
      if (needed > 0) {
        const candidates = [...mcpSessions.values()]
          .filter((state) => (
            state.logicalClientId === forceClientId
            && state.toolCallCount <= 1
            && !state.durableWorkerSession
            && state.inFlightRequests === 0
            && state.activeLongPollCount === 0
            && !state.closing
            && !state.closed
            && !evictionReasons.has(state.sessionId)
          ))
          .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
        for (const state of candidates.slice(0, needed)) {
          queueEviction(state.sessionId, "per_client_limit");
        }
      }
    }

    // Per-client limit: evict oldest idle sessions beyond limit
    for (const [id, state] of mcpSessions) {
      if (toEvict.includes(id)) continue;
      if (state.inFlightRequests > 0 || state.activeLongPollCount > 0 || state.closing || state.closed) continue;
      const count = clientCounts.get(state.logicalClientId) ?? 0;
      if (count > config.mcpSessionMaxPerClient) {
        queueEviction(id, "per_client_limit");
        clientCounts.set(state.logicalClientId, count - 1);
      }
    }

    // Adaptive soft cap: evict true LRU idle sessions before the hard cap.
    const softExcess = mcpSessions.size - toEvict.length - pressure.effectiveSoftCap;
    if (softExcess > 0) {
      const candidates: Array<{ id: string; lastActivityAt: number }> = [];
      for (const [id, state] of mcpSessions) {
        if (toEvict.includes(id)) continue;
        if (state.inFlightRequests > 0 || state.activeLongPollCount > 0 || state.closing || state.closed) continue;
        candidates.push({ id, lastActivityAt: state.lastActivityAt });
      }
      candidates.sort((a, b) => a.lastActivityAt - b.lastActivityAt);
      for (let i = 0; i < Math.min(softExcess, candidates.length); i++) {
        queueEviction(candidates[i].id, "soft_cap_lru");
      }
    }

    for (const id of toEvict) {
      const transport = transports.get(id);
      const state = mcpSessions.get(id);
      if (state) {
        state.closing = true;
        recordMcpSessionEnd(state, "expired", now);
      }
      mcpSessions.delete(id);
      transports.delete(id);
      mcpSessionMetrics.evicted++;
      void transport?.close().catch(() => {});
      logEvent(config.logging, "info", "mcp_session_expired", {
        sessionIdPrefix: sessionIdPrefix(id),
        logicalClientId: state?.logicalClientId,
        ageMs: now - (state?.createdAt ?? now),
        idleMs: now - (state?.lastActivityAt ?? now),
        requestCount: state?.requestCount ?? 0,
        notificationCount: state?.notificationCount ?? 0,
        toolCallCount: state?.toolCallCount ?? 0,
        resourceReadCount: state?.resourceReadCount ?? 0,
        lastRpcMethod: state?.lastRpcMethod,
        lastToolName: state?.lastToolName,
        reason: evictionReasons.get(id) ?? "bounded",
        sessionLabel: state?.sessionLabel,
        conversationId: state?.conversationId,
      });
    }
  };
  const mcpSessionReaper = setInterval(reapIdleMcpSessions, config.mcpSessionReaperIntervalMs);
  mcpSessionReaper.unref?.();
  const mcpMemorySampler = setInterval(trackMcpSessionMemory, 30_000);
  mcpMemorySampler.unref?.();

  // P1 #23: Periodic maintenance loop — event compaction, stale approval
  // reconciliation, and DB checkpoint. Runs every 5 minutes.
  const MAINTENANCE_INTERVAL_MS = 5 * 60_000;
  const maintenanceTimer = setInterval(() => {
    try {
      workSessions.reconcileRuntimeStates();
      // Compact telemetry for terminal sessions
      const terminalStatuses = new Set(["approved", "rejected", "cancelled", "failed", "failed_protocol"]);
      for (const session of workSessions.listAllWorkSessions(undefined, 200)) {
        if (terminalStatuses.has(session.status)) {
          try { eventStore.compactSessionEvents(session.id, { retentionDays: 7 }); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }, MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref?.();
  const oauthEnabled = config.authMode === "oauth";
  let oauthProvider: SingleUserOAuthProvider | null = null;
  let bearerAuth:
    | ((req: Request, res: Response, next: (error?: unknown) => void) => void)
    | undefined;
  let resourceServerUrl: URL | undefined;
  if (oauthEnabled) {
    const mcpUrl = new URL("/mcp", config.publicBaseUrl);
    resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
    oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
    bearerAuth = requireBearerAuth({
      verifier: oauthProvider,
      requiredScopes: [config.oauth.scopes[0] ?? "kontrol"],
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
    });
  }
  // ONE shared DB handle for every manager + the review workflow service, so the
  // workflow can commit state + event log in a SINGLE transaction (P1 #15).
  const db: DatabaseHandle = openDatabase(config.stateDir);
  const workspaceStore = createWorkspaceStore(db);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const processSessions = new ProcessSessionManager();
  const workSessions = createWorkSessionManager(db);
  const agentRegistry = createAgentRegistryManager(db);
  // Seed the well-known topology: the WebUI is the ACP reviewer;
  // the CLI coding agent registers itself as the ACP *agent* at runtime.
  agentRegistry.ensure({
    name: "webui",
    url: "ui://kontrol/workspace-app.html",
    description: "Kontrol review WebUI — the ACP client that submits work to the coding agent and signs off (Nelson Wiggum Loop).",
    role: "reviewer",
    tags: ["webui", "reviewer"],
    ttlSeconds: 60 * 60 * 24 * 365,
  });
  const eventStore = createEventStore(db);
  const continuationManager = createContinuationManager(db);
  const dispatchOutbox = createDispatchOutbox(db);
  const supervisorRuns = createSupervisorRuns(db);
  const approvalRequests = createApprovalRequestManager(db);
  const missionLedger = createMissionLedger(db);
  const agentMessages = createAgentMessageManager(db);
  const startupRecovery = {
    at: new Date().toISOString(),
    expiredApprovals: 0,
    cancelledApprovals: 0,
    supersededContinuations: 0,
    releasedSupervisorLeases: 0,
    reconciledWorkSessions: 0,
    markedStaleWorkSessions: 0,
  };
  const databaseIntegrity = {
    ok: false,
    checkedAt: undefined as string | undefined,
    detail: "integrity check pending",
  };
  const refreshDatabaseIntegrity = () => {
    try {
      const result = db.sqlite.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
      databaseIntegrity.ok = result?.quick_check === "ok";
      databaseIntegrity.detail = String(result?.quick_check ?? "quick_check returned no result");
      databaseIntegrity.checkedAt = new Date().toISOString();
    } catch (error) {
      databaseIntegrity.ok = false;
      databaseIntegrity.detail = error instanceof Error ? error.message : String(error);
      databaseIntegrity.checkedAt = new Date().toISOString();
    }
  };
  // Integrity scans are valuable, but must not run synchronously on every
  // readiness request. Run once at startup and refresh in the background.
  refreshDatabaseIntegrity();
  const databaseIntegrityTimer = setInterval(refreshDatabaseIntegrity, 5 * 60_000);
  databaseIntegrityTimer.unref?.();
  const terminalWorkSessionStatuses = new Set(["approved", "rejected", "cancelled", "failed", "failed_protocol"]);
  // Durable rows survive a process restart; live transports and in-memory
  // worker maps do not. Reconcile only objects whose durable references make
  // their liveness unambiguous, and record each repair in the session event
  // log so recovery is inspectable rather than silently mutating state.
  for (const approval of approvalRequests.listPending()) {
    const session = approval.workSessionId ? workSessions.get(approval.workSessionId) : undefined;
    const expired = Boolean(approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now());
    const orphaned = Boolean(approval.workSessionId && (!session || terminalWorkSessionStatuses.has(session.status)));
    if (!expired && !orphaned) continue;
    const status = expired ? "expired" : "cancelled";
    approvalRequests.resolve(approval.approvalId, { status, reason: expired ? "startup_reconciliation: approval expired" : "startup_reconciliation: referenced work session is terminal or missing", reviewerId: "kontrol-startup" });
    if (status === "expired") startupRecovery.expiredApprovals++;
    else startupRecovery.cancelledApprovals++;
    if (session) {
      eventStore.appendEvent({
        type: "recovery.approval.reconciled",
        sessionId: session.id,
        payload: { approvalId: approval.approvalId, status, reason: "startup_reconciliation" },
      }, { publish: false });
    }
  }
  const continuationRows = db.sqlite.prepare(`
    select c.id, c.session_id as sessionId, c.status, ws.status as workSessionStatus
    from continuations c
    left join work_sessions ws on ws.id = c.session_id
    where c.status in ('pending', 'claimed')
  `).all() as Array<{ id: string; sessionId: string; status: string; workSessionStatus?: string | null }>;
  for (const continuation of continuationRows) {
    if (continuation.workSessionStatus && !terminalWorkSessionStatuses.has(continuation.workSessionStatus)) continue;
    if (!continuationManager.supersede(continuation.id, "startup_reconciliation: referenced work session is terminal or missing")) continue;
    startupRecovery.supersededContinuations++;
    if (continuation.workSessionStatus) {
      eventStore.appendEvent({
        type: "recovery.continuation.superseded",
        sessionId: continuation.sessionId,
        payload: { continuationId: continuation.id, reason: "startup_reconciliation" },
      }, { publish: false });
    }
  }
  const runtimeReconciliation = workSessions.reconcileRuntimeStates();
  startupRecovery.reconciledWorkSessions = runtimeReconciliation.reconciled;
  startupRecovery.markedStaleWorkSessions = runtimeReconciliation.markedStale;
  startupRecovery.releasedSupervisorLeases = supervisorRuns.releaseExpiredClaims();
  const reviewWorkflow = createReviewWorkflowService({
    workSessions,
    eventStore,
    continuationManager,
    agentRegistry,
    db,
    workspaces,
    reviewCheckpoints,
    missionLedger,
    dispatchOutbox,
  });
  // Shared live-waiter registry: the singleton dispatcher and every MCP client
  // consult the SAME instance, so a parked agent suppresses duplicate dispatch
  // regardless of which client connection owns the worker.
  const liveWaitersMap = new Map<string, Set<string>>();
  const liveWaiters: LiveWaiterRegistry = {
    add(id: string) {
      const waiterId = `waiter_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const set = liveWaitersMap.get(id) ?? new Set<string>();
      set.add(waiterId);
      liveWaitersMap.set(id, set);
      return waiterId;
    },
    remove(id: string, waiterId?: string) {
      const set = liveWaitersMap.get(id);
      if (!set) return false;
      if (waiterId) set.delete(waiterId);
      else set.clear();
      const empty = set.size === 0;
      if (empty) liveWaitersMap.delete(id);
      return empty;
    },
    has(id: string) { return (liveWaitersMap.get(id)?.size ?? 0) > 0; },
  };
  const grantStore = createSqliteGrantStore(db);
  const policyEngine = createPolicyEngine(config.policy, grantStore);
  const policyEnforcer = createPolicyEnforcer(policyEngine, eventStore);

  if (config.logging.trustProxy) {
    app.set("trust proxy", true);
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        rpcMethod: typeof req.body?.method === "string" ? req.body.method : undefined,
        resourceUri: req.body?.method === "resources/read" && typeof req.body?.params?.uri === "string"
          ? req.body.params.uri
          : undefined,
        ...requestLogFields(req, config),
      });
    });

    next();
  });

  if (oauthProvider) {
    app.use(
      mcpAuthRouter({
        provider: oauthProvider,
        issuerUrl: new URL(config.publicBaseUrl),
        baseUrl: new URL(config.publicBaseUrl),
        resourceServerUrl,
        scopesSupported: config.oauth.scopes,
        resourceName: "Kontrol",
      }),
    );
  } else if (config.authMode === "tunnel") {
    // Tunnel mode has no OAuth gate on /mcp, but the OpenAI tunnel-client
    // probes these discovery paths during readiness. Serve static metadata so
    // discovery succeeds and the tunnel reports ready; we do NOT actually
    // authenticate on /mcp (access is the loopback + tunnel boundary).
    const mcpResource = new URL("/mcp", config.publicBaseUrl).href;
    const metadata = {
      resource: mcpResource,
      authorization_servers: [],
      bearer_methods_supported: ["header"],
      scopes_supported: config.oauth.scopes,
      resource_documentation: "https://github.com/B-A-M-N/Kontrol",
    };
    const discovery = (_req: Request, res: Response) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.json(metadata);
    };
    app.get("/.well-known/oauth-protected-resource", discovery);
    app.get("/.well-known/oauth-protected-resource/mcp", discovery);
    app.get("/.well-known/oauth-authorization-server", (_req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.status(404).json({ error: { code: "not_found", message: "OAuth disabled in tunnel mode" } });
    });
  }

  app.options("/mcp-app-assets/{*asset}", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );

  app.get("/healthz", (_req, res) => {
    const runtime = readRuntimeIdentity(config.stateDir);
    const sessionWindow = sessionWindowMetrics(60_000);
    res.json({
      ok: true,
      name: "kontrol",
      build: buildMeta,
      runtime: runtime ? {
        instanceId: runtime.instanceId,
        pid: runtime.pid,
        buildId: runtime.buildId,
        buildSha: runtime.buildSha,
        buildDirty: runtime.buildDirty,
        startedAt: runtime.startedAt,
      } : undefined,
      uptimeMs: Math.round(performance.now()),
      mcpSessions: mcpSessions.size,
      mcpSessionReuse: {
        sessionsCreatedLastMinute: sessionWindow.sessionsCreated,
        sessionsClosedLastMinute: sessionWindow.sessionsClosed,
        sessionsExpiredLastMinute: sessionWindow.sessionsExpired,
        toolCallsLastMinute: sessionWindow.toolCalls,
        sessionsPerToolCall: sessionWindow.sessionsPerToolCall,
      },
      activeWorkSessions: workSessions?.countActiveWorkSessions?.() ?? workSessions?.listActiveWorkSessions?.()?.length ?? 0,
      pendingReviews: workSessions?.countPendingReviews?.() ?? workSessions?.listPendingReviews?.()?.length ?? 0,
    });
  });

  function readinessChecks(req: Request, includeAgents: boolean): Record<string, { ok: boolean; detail?: string; agents?: unknown[] }> {
    const checks: Record<string, { ok: boolean; detail?: string; agents?: unknown[] }> = {};
    const runtime = readRuntimeIdentity(config.stateDir);
    let schemaVersion = 0;
    try {
      const databaseProbe = db.sqlite.prepare("select 1 as ok").get() as { ok?: number } | undefined;
      checks.database = { ok: databaseProbe?.ok === 1, detail: databaseProbe?.ok === 1 ? "select 1 ok" : "database probe failed" };
      const schema = db.sqlite.prepare("select max(version) as v from kontrol_schema_migrations").get() as { v?: number } | undefined;
      schemaVersion = Number(schema?.v ?? 0);
      checks.schema = { ok: schemaVersion > 0, detail: `version=${schemaVersion}` };
    } catch (error) {
      checks.database = { ok: false, detail: error instanceof Error ? error.message : String(error) };
      checks.schema = { ok: false, detail: "schema query failed" };
    }
    const integrityAgeMs = databaseIntegrity.checkedAt ? Date.now() - Date.parse(databaseIntegrity.checkedAt) : Number.POSITIVE_INFINITY;
    checks.databaseIntegrity = {
      ok: databaseIntegrity.ok && integrityAgeMs <= 10 * 60_000,
      detail: `${databaseIntegrity.detail}; ageMs=${Number.isFinite(integrityAgeMs) ? integrityAgeMs : "unknown"}`,
    };
    checks.mcpHandler = { ok: true, detail: `HTTP handler is serving ${includeAgents ? "/readyz" : "/core-readyz"}` };
    checks.workspaceRegistry = { ok: Boolean(workspaces && workspaceStore), detail: "workspace registry initialized" };
    checks.reviewSubsystem = { ok: Boolean(reviewWorkflow && workSessions && eventStore), detail: "review managers initialized" };
    checks.acpBridge = { ok: !config.acpEnabled || Boolean(dispatcher), detail: config.acpEnabled ? "dispatcher initialized" : "ACP disabled" };
    checks.build = {
      ok: Boolean(buildMeta.buildId) && Boolean(runtime) && runtime?.buildId === buildMeta.buildId,
      detail: `expected=${buildMeta.buildId ?? "missing"} live=${runtime?.buildId ?? "missing"}`,
    };

    if (!includeAgents) {
      checks.agents = { ok: true, detail: "agent checks deferred to strict /readyz" };
      return checks;
    }

    const rawAgents = typeof req.query.agents === "string" ? req.query.agents : "";
    const requiredAgents = rawAgents
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf("=");
        return separator >= 0
          ? { name: entry.slice(0, separator), url: entry.slice(separator + 1) }
          : { name: entry, url: undefined };
      });
    let configuredAgents = requiredAgents.length > 0 ? requiredAgents : config.acpKnownAgents;
    const aliveAgents = agentRegistry.listAlive();
    // In ACP mode an empty configured list is not "no requirements". It means
    // the generation has not registered an operational coding agent yet. The
    // WebUI is seeded separately and is not sufficient for worker readiness.
    const dynamicAgentRequirement = config.acpEnabled && configuredAgents.length === 0;
    if (dynamicAgentRequirement) {
      configuredAgents = aliveAgents
        .filter((agent) => agent.role === "agent" && agent.name !== "webui")
        .map((agent) => ({ name: agent.name, url: agent.url }));
    }
    const agentResults = configuredAgents.map((required) => {
      const found = aliveAgents.find((agent) => agent.name === required.name);
      const urlMatches = !required.url || found?.url === required.url;
      return {
        name: required.name,
        expectedUrl: required.url,
        registeredUrl: found?.url,
        alive: Boolean(found?.alive),
        healthy: Boolean(found?.alive) && urlMatches,
      };
    });
    checks.agents = {
      ok: dynamicAgentRequirement ? agentResults.length > 0 && agentResults.every((agent) => agent.healthy) : agentResults.every((agent) => agent.healthy),
      detail: dynamicAgentRequirement
        ? (agentResults.length > 0 ? "registered worker agents checked" : "no live worker agents registered")
        : (configuredAgents.length > 0 ? "required agents checked" : "ACP disabled; no agents required"),
      agents: agentResults,
    };
    return checks;
  }

  function sendReadiness(res: Response, checks: Record<string, { ok: boolean; detail?: string; agents?: unknown[] }>): void {
    const ready = Object.values(checks).every((check) => check.ok);
    const schemaVersion = Number(checks.schema?.detail?.match(/version=(\d+)/)?.[1] ?? 0);
    res.status(ready ? 200 : 503).json({
      ok: ready,
      ready,
      name: "kontrol",
      schemaVersion,
      build: buildMeta,
      checks,
    });
  }

  // Core readiness is used while KONTROL is starting before adapters register.
  app.get("/core-readyz", (_req, res) => sendReadiness(res, readinessChecks(_req, false)));
  // Strict readiness is the operational contract used by the tunnel and the
  // persistent supervisor. It must fail when a required worker disappears.
  app.get("/readyz", (req, res) => sendReadiness(res, readinessChecks(req, true)));

  // P2: Warn about low reuse using a rolling rate, not only a raw creation
  // count. A client creating one session per tool call is operationally
  // different from a healthy reusable session that happens to be busy.
  let dbSizeBytes = 0;
  const mcpSessionChurnTimer = setInterval(() => {
    const window = sessionWindowMetrics(60_000);
    if (window.sessionsCreated > 10 || (window.toolCalls > 0 && window.sessionsPerToolCall >= 0.75)) {
      logEvent(config.logging, "warn", "mcp_session_reuse_low", {
        ...window,
        logicalClients: mcpSessionMetrics.clients.size,
      });
    }
  }, 60_000);
  mcpSessionChurnTimer.unref?.();

  // P1 #23 / P1 #50: Protect /diagnostics — loopback-only AND require an
  // explicit admin credential. Disabled diagnostics are not an accidental
  // unauthenticated information endpoint.
  app.get("/diagnostics", (req, res) => {
    const ip = requestIp(req, config.logging.trustProxy) || "";
    if (ip && !ip.startsWith("127.") && !ip.startsWith("::1") && ip !== "::ffff:127.0.0.1") {
      return res.status(403).json({ ok: false, error: "Forbidden: diagnostics is loopback-only" });
    }
    if (!config.diagnosticsSecret) {
      return res.status(404).json({ ok: false, error: "Diagnostics disabled" });
    }
    // Credentials are header-only. Query-string secrets leak through browser
    // history, proxy logs, and referrer metadata.
    const provided = req.header("x-kontrol-diagnostics") || "";
    const expected = config.diagnosticsSecret;
    const a = Buffer.from(String(provided));
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return res.status(403).json({ ok: false, error: "Forbidden: valid X-Kontrol-Diagnostics credential required" });
    }
    try {
      const sqlite = (db as unknown as { sqlite?: { prepare?: (sql: string) => { get?: () => unknown } } }).sqlite;
      let dbSizeBytes = 0;
      let walSizeBytes = 0;
      let eventLogCount = 0;
      let outputDeltaCount = 0;
      let thoughtDeltaCount = 0;
      let schemaVersion = 1;
      if (sqlite && sqlite.prepare) {
        try {
          // P1 #47: Use filesystem stat for accurate DB + WAL size
          const dbPath = join(config.stateDir, "kontrol.sqlite");
          try {
            const st = statSync(dbPath);
            dbSizeBytes = st.size;
          } catch { /* ignore */ }
          try {
            const st = statSync(`${dbPath}-wal`);
            walSizeBytes = st.size;
          } catch { /* ignore */ }
        } catch { /* ignore */ }
        try {
          const r = sqlite.prepare("select count(*) as c from event_log").get?.();
          eventLogCount = typeof r === "object" && r !== null && "c" in r ? (r as { c: number }).c : 0;
          const od = sqlite.prepare("select count(*) as c from event_log where type = 'agent.run.output_delta'").get?.();
          outputDeltaCount = typeof od === "object" && od !== null && "c" in od ? (od as { c: number }).c : 0;
          const td = sqlite.prepare("select count(*) as c from event_log where type = 'agent.run.thought_delta'").get?.();
          thoughtDeltaCount = typeof td === "object" && td !== null && "c" in td ? (td as { c: number }).c : 0;
        } catch { /* ignore */ }
        // P1 #48: Query actual schema version
        try {
          const sv = sqlite.prepare("select max(version) as v from kontrol_schema_migrations").get?.();
          schemaVersion = typeof sv === "object" && sv !== null && "v" in sv ? (sv as { v: number }).v : 1;
        } catch { schemaVersion = 1; }
      }

      // P1 #49: Use cheap count APIs instead of expensive hydration
      const activeWorkSessions = workSessions.countActiveWorkSessions();
      const pendingReviews = workSessions.countPendingReviews();
      const activeAcps = agentRegistry?.listAlive?.()?.length ?? 0;
      const totalMcpSessions = mcpSessions?.size ?? 0;

      // P0 #2: Comprehensive session/heap metrics
      const memUsage = process.memoryUsage();
      const supervisorStatus = (() => {
        try {
          return JSON.parse(readFileSync(join(config.stateDir, "supervisor-status.json"), "utf8")) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })();
      const mcpMetrics = {
        created: mcpSessionMetrics.created,
        evicted: mcpSessionMetrics.evicted,
        current: totalMcpSessions,
        inFlight: [...mcpSessions.values()].reduce((sum, s) => sum + s.inFlightRequests, 0),
        admission: mcpAdmission.getStats(),
        memoryPressure: getMemoryPressureState(),
        memoryEstimate: estimateMcpSessionMemoryCost(),
        reuse: mcpSessionReuseMetrics(),
        policy: {
          unusedSessionIdleMs: config.mcpUnusedSessionIdleMs,
          ephemeralSessionIdleMs: config.mcpEphemeralSessionIdleMs,
          reusableSessionIdleMs: config.mcpReusableSessionIdleMs,
          sessionReaperIntervalMs: config.mcpSessionReaperIntervalMs,
          sessionMaxPerClient: config.mcpSessionMaxPerClient,
          sessionSoftCap: config.mcpSessionSoftCap,
          sessionHardCap: config.mcpSessionHardCap,
        },
        // Each entry is a separate transport/context. The aggregate logical
        // client label is deliberately not used as an ownership key.
        sessions: [...mcpSessions.values()]
          .sort((a, b) => a.lastActivityAt - b.lastActivityAt)
          .map((state) => ({
            sessionIdPrefix: sessionIdPrefix(state.sessionId),
            sessionLabel: state.sessionLabel,
            logicalClientId: state.logicalClientId,
            conversationId: state.conversationId,
            createdAt: new Date(state.createdAt).toISOString(),
            ageMs: Date.now() - state.createdAt,
            idleMs: Date.now() - state.lastActivityAt,
            requestCount: state.requestCount,
            notificationCount: state.notificationCount,
            toolCallCount: state.toolCallCount,
            resourceReadCount: state.resourceReadCount,
            activeLongPollCount: state.activeLongPollCount,
            inFlightRequests: state.inFlightRequests,
            durableWorkerSession: state.durableWorkerSession,
            lastRpcMethod: state.lastRpcMethod,
            lastToolName: state.lastToolName,
          })),
        perClient: Object.entries([...mcpSessions.values()].reduce((acc, s) => {
          acc[s.logicalClientId] = (acc[s.logicalClientId] || 0) + 1;
          return acc;
        }, {} as Record<string, number>)).map(([client, count]) => ({ client, count })),
      };

      // P1 #51: Report embedded build metadata (immutable artifact identity)
      // rather than the working tree state.
      let buildMeta: Record<string, unknown> | undefined;
      try {
        const metaPath = join(dirname(fileURLToPath(import.meta.url)), "build-meta.json");
        buildMeta = JSON.parse(readFileSync(metaPath, "utf8"));
      } catch { /* ignore */ }

      res.json({
        ok: true,
        name: "kontrol",
        build: buildMeta ?? process.env.KONTROL_BUILD_ID ?? "dev",
        buildMeta,
        schema: schemaVersion,
        dbSizeBytes,
        walSizeBytes,
        eventLogCount,
        outputDeltaCount,
        thoughtDeltaCount,
        activeWorkSessions,
        pendingReviews,
        activeAcps,
        totalMcpSessions,
        mcpSessionMetrics: mcpMetrics,
        startupRecovery,
        databaseIntegrity,
        supervisor: supervisorStatus,
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        rss: memUsage.rss,
        external: memUsage.external,
        uptimeMs: Math.round(performance.now()),
        memoryUsage: memUsage,
        pid: process.pid,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  if (config.acpEnabled) {
    app.use("/acp", createAcpServer(
      workspaces,
      workSessions,
      agentRegistry,
      config.acpSharedSecret,
      eventStore,
      continuationManager,
      reviewCheckpoints,
      reviewWorkflow,
      policyEnforcer,
      approvalRequests,
      config.acpAgentSecret,
      config.acpReviewerSecret,
    ));
  }

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);
    let admissionRelease: (() => void) | undefined;
    let sessionLongPoll = false;

    if (shuttingDown) {
      return res.status(503).json({
        jsonrpc: "2.0",
        id: (req.body as { id?: unknown } | undefined)?.id ?? null,
        error: { code: -32000, message: "KONTROL is draining; retry after restart." },
      });
    }

    if (bearerAuth) {
      await new Promise<void>((resolve, reject) => {
        bearerAuth(req, res, (error?: unknown) => {
          if (error) reject(error);
          else resolve();
        });
      });
      if (res.headersSent) return;

      if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl! })) {
        logEvent(config.logging, "warn", "auth_denied", {
          requestId,
          method: req.method,
          path: requestPath(req),
          reason: "invalid_oauth_resource",
          ...requestLogFields(req, config),
        });
        sendJsonRpcError(res, 401, -32001, "Unauthorized");
        return;
      }
    } else if (config.authMode === "tunnel") {
      // Tunnel mode is intentionally unauthenticated at the local MCP hop.
      // The OpenAI Secure MCP Tunnel owns the external trust boundary. In
      // particular, never let a stale KONTROL_TUNNEL_TOKEN or Authorization
      // header turn this mode back into a second, unsynchronized auth gate.
    }

    // tunnel-client performs liveness and compatibility probes with an empty
    // POST and a sessionless GET before/after initialize. These are not MCP
    // tool requests and must not be reported as application 400s.
    const emptyTunnelProbe = config.authMode === "tunnel" && !sessionId && (
      req.method === "GET" ||
      (req.method === "POST" && (!req.body || Object.keys(req.body).length === 0))
    );
    if (emptyTunnelProbe) {
      logEvent(config.logging, "debug", "mcp_probe_request", {
        requestId,
        method: req.method,
        reason: "sessionless_tunnel_probe",
      });
      res.status(req.method === "GET" ? 200 : 202).end();
      return;
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
      sessionIdPresent: Boolean(sessionId),
      sessionIdPrefix: sessionIdPrefix(sessionId),
      isInitialize: initializeRequest,
    });

    try {
      let transport: Transport | undefined;

      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
        const state = mcpSessions.get(sessionId);
        if (config.authMode === "oauth" && state && state.logicalClientId !== logicalClientId(req)) {
          logEvent(config.logging, "warn", "mcp_session_client_mismatch", {
            requestId,
            sessionIdPrefix: sessionIdPrefix(sessionId),
            expectedClientId: state.logicalClientId,
            actualClientId: logicalClientId(req),
          });
          sendJsonRpcError(res, 403, -32001, "MCP session belongs to another client");
          return;
        }
        const requestedConversationId = conversationId(req);
        if (state?.conversationId && requestedConversationId && state.conversationId !== requestedConversationId) {
          logEvent(config.logging, "warn", "mcp_session_conversation_mismatch", {
            requestId,
            sessionIdPrefix: sessionIdPrefix(sessionId),
            sessionLabel: state.sessionLabel,
            expectedConversationId: state.conversationId,
            actualConversationId: requestedConversationId,
          });
          sendJsonRpcError(res, 403, -32001, "MCP session belongs to another conversation");
          return;
        }
        if (state) {
          state.lastActivityAt = Date.now();
          state.inFlightRequests++;
          state.requestCount++;
          const rpcMethod = (req.body as { method?: string })?.method;
          state.lastRpcMethod = rpcMethod;
          if (rpcMethod?.startsWith("notifications/")) {
            state.notificationCount++;
          }
          if (rpcMethod === "resources/read") {
            state.resourceReadCount++;
          }
          if (rpcMethod === "tools/call") {
            state.toolCallCount++;
            recordMcpWindowEvent("tool");
            const toolName = (req.body as { params?: { name?: string } })?.params?.name;
            state.lastToolName = toolName;
            if (toolName === "await_review_feedback" || toolName === "await_work_session_events") {
              state.activeLongPollCount++;
              sessionLongPoll = true;
            }
          }
        }
      } else if (initializeRequest) {
        // P1 #31: Admission pressure control — enforce caps at session creation
        const clientId = logicalClientId(req);
        const pressure = getMemoryPressureState();
        if (mcpSessions.size >= pressure.effectiveSoftCap) {
          reapIdleMcpSessions();
        }
        if (mcpSessions.size >= pressure.effectiveHardCap) {
          // Try idle eviction first to make room
          reapIdleMcpSessions();
          if (mcpSessions.size >= pressure.effectiveHardCap) {
            logEvent(config.logging, "warn", "mcp_session_rejected", {
              requestId,
              reason: "global_hard_cap_reached",
              current: mcpSessions.size,
              hardCap: pressure.effectiveHardCap,
              pressure: pressure.level,
            });
            return res.status(503).json({
              jsonrpc: "2.0",
              id: (req.body as { id?: unknown })?.id ?? null,
              error: { code: -32000, message: "Server at capacity. Try again later." },
            });
          }
        }
        // Per-client limit at admission
        let clientSessionCount = [...mcpSessions.values()].filter((s) => s.logicalClientId === clientId).length;
        if (clientSessionCount >= config.mcpSessionMaxPerClient) {
          reapIdleMcpSessions(clientId);
          clientSessionCount = [...mcpSessions.values()].filter((s) => s.logicalClientId === clientId).length;
        }
        if (clientSessionCount >= config.mcpSessionMaxPerClient) {
          logEvent(config.logging, "warn", "mcp_session_rejected", {
            requestId,
            reason: "per_client_limit_reached",
            clientId,
            current: clientSessionCount,
            maxPerClient: config.mcpSessionMaxPerClient,
          });
          return res.status(503).json({
            jsonrpc: "2.0",
            id: (req.body as { id?: unknown })?.id ?? null,
            error: { code: -32000, message: "Too many sessions for this client. Close some and retry." },
          });
        }
        const sessionInitializedAt = performance.now();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) {
              transports.set(newSessionId, transport);
              const requestConversationId = conversationId(req);
              mcpSessions.set(newSessionId, {
                sessionId: newSessionId,
                sessionLabel: mcpSessionLabel(clientId, newSessionId, requestConversationId),
                logicalClientId: clientId,
                conversationId: requestConversationId,
                createdAt: Date.now(),
                lastActivityAt: Date.now(),
                inFlightRequests: 0,
                requestCount: 1,
                notificationCount: 0,
                toolCallCount: 0,
                resourceReadCount: 0,
                activeLongPollCount: 0,
                closing: false,
                closed: false,
                endRecorded: false,
                durableWorkerSession: false,
                lastRpcMethod: "initialize",
              });
              recordMcpSessionCreated(clientId);
            }
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              sessionLabel: mcpSessions.get(newSessionId)?.sessionLabel,
              conversationId: mcpSessions.get(newSessionId)?.conversationId,
              logicalClientId: clientId,
              ...requestLogFields(req, config),
            });
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) {
            transports.delete(closedSessionId);
            const state = mcpSessions.get(closedSessionId);
            if (state) {
              recordMcpSessionEnd(state, state.closing ? "server_shutdown" : "client_closed");
            }
            mcpSessions.delete(closedSessionId);
            logEvent(config.logging, "info", "mcp_session_closed", {
              sessionIdPrefix: sessionIdPrefix(closedSessionId),
              logicalClientId: state?.logicalClientId,
              sessionLabel: state?.sessionLabel,
              conversationId: state?.conversationId,
              ageMs: state ? Date.now() - state.createdAt : undefined,
              idleMs: state ? Date.now() - state.lastActivityAt : undefined,
              requestCount: state?.requestCount,
              notificationCount: state?.notificationCount,
              toolCallCount: state?.toolCallCount,
              resourceReadCount: state?.resourceReadCount,
              lastRpcMethod: state?.lastRpcMethod,
              lastToolName: state?.lastToolName,
              closeReason: state?.closing ? "server_shutdown" : "client_closed",
            });
          }
        };

        // Extract the work-session attribution envelope. Role is derived from a
        // SIGNED worker token (X-Kontrol-Worker-Token) when present, NOT from
        // the plain attribution headers. The token is HMAC-signed by the adapter
        // and binds this connection to exactly one work session + the "worker"
        // role. A caller that omits/forges the token is treated as a
        // reviewer/client and cannot acquire worker rights (P0 #3: role is no
        // longer client-controlled).
        const workerToken = req.header("x-kontrol-worker-token");
        let verifiedClaims: WorkerTokenClaims | undefined;
        if (workerToken && config.acpAgentSecret) {
          try {
            verifiedClaims = verifyWorkerToken(workerToken, config.acpAgentSecret);
          } catch (err) {
            logEvent(config.logging, "warn", "worker_token_rejected", {
              requestId,
              reason: err instanceof Error ? err.message : String(err),
              ...requestLogFields(req, config),
            });
          }
        }
        const reviewerToken = req.header("x-kontrol-reviewer-token");
        const verifiedReviewer = constantTimeStringEqual(reviewerToken, config.acpReviewerSecret);
        const oauthScopes = Array.isArray(req.auth?.scopes) ? req.auth.scopes : [];
        const verifiedOAuthReviewer = oauthEnabled && oauthScopes.some((scope) =>
          scope === "kontrol" ||
          scope === "kontrol:review" ||
          scope === "kontrol:approve" ||
          scope === "kontrol:mission" ||
          scope === "kontrol:dispatch"
        );

        // A verified worker token authenticates this connection as a worker. It
        // also provides the bound work sessions (workspace/run/continuation) so
        // they cannot be spoofed by the headers below. Unsigned attribution
        // headers are used ONLY when no token is present (a reviewer/client
        // reaching /mcp directly) and never grant worker rights.
        const connectionContext: ConnectionContext = {
          authenticatedRole: verifiedClaims ? "worker" : (verifiedReviewer || verifiedOAuthReviewer) ? "reviewer" : "client",
          workspaceSessionId:
            verifiedClaims?.workspaceSessionId
            || (req.header("x-kontrol-workspace-session") ?? undefined),
          workSessionId:
            verifiedClaims?.workSessionId
            || (req.header("x-kontrol-work-session") ?? undefined),
          runId:
            verifiedClaims?.runId || (req.header("x-kontrol-run") ?? undefined),
          continuationId:
            verifiedClaims?.continuationId
            || (req.header("x-kontrol-continuation") ?? undefined),
          conversationId: conversationId(req),
        };

        const serverCreateStarted = performance.now();
        const server = createMcpServer(
          config,
          workspaces,
          reviewCheckpoints,
          processSessions,
          workSessions,
          agentRegistry,
          eventStore,
          continuationManager,
          dispatchOutbox,
          policyEngine,
          policyEnforcer,
          approvalRequests,
          missionLedger,
          connectionContext,
          reviewWorkflow,
          liveWaiters,
          agentMessages,
          supervisorRuns,
          (workSessionId) => supervisorRuntime?.wake(workSessionId),
          db,
        );
        const serverCreateMs = performance.now() - serverCreateStarted;
        const transportConnectStarted = performance.now();
        await server.connect(transport);
        const state = transport.sessionId ? mcpSessions.get(transport.sessionId) : undefined;
        if (state) {
          state.durableWorkerSession = connectionContext.authenticatedRole === "worker" || Boolean(connectionContext.workSessionId);
          connectionContext.mcpSessionId = state.sessionId;
          connectionContext.mcpSessionLabel = state.sessionLabel;
          connectionContext.conversationId = state.conversationId;
        }
        logEvent(config.logging, "info", "mcp_session_initialized", {
          requestId,
          sessionIdPrefix: sessionIdPrefix(transport.sessionId),
          sessionLabel: state?.sessionLabel,
          conversationId: state?.conversationId,
          serverCreateMs: Math.round(serverCreateMs),
          transportConnectMs: Math.round(performance.now() - transportConnectStarted),
          totalMs: Math.round(performance.now() - sessionInitializedAt),
        });
      } else if (
        (req.body as { method?: unknown; params?: { uri?: unknown } } | undefined)?.method === "resources/read" &&
        isWorkspaceAppUri((req.body as { params?: { uri?: unknown } } | undefined)?.params?.uri)
      ) {
        // The OpenAI tunnel fetches app resources on a separate, sessionless
        // channel after initialization. Resources are read-only and the outer
        // bearer/tunnel authentication above has already succeeded, so serve
        // this one protocol method statelessly rather than rejecting the WebUI
        // template with "No valid MCP session".
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const sessionlessServerCreateStarted = performance.now();
        const server = createMcpServer(
          config,
          workspaces,
          reviewCheckpoints,
          processSessions,
          workSessions,
          agentRegistry,
          eventStore,
          continuationManager,
          dispatchOutbox,
          policyEngine,
          policyEnforcer,
          approvalRequests,
          missionLedger,
          undefined,
          reviewWorkflow,
          liveWaiters,
          agentMessages,
          supervisorRuns,
          (workSessionId) => supervisorRuntime?.wake(workSessionId),
          db,
        );
        const serverCreateMs = performance.now() - sessionlessServerCreateStarted;
        const transportConnectStarted = performance.now();
        await server.connect(transport);
        logEvent(config.logging, "info", "mcp_session_initialized", {
          requestId,
          sessionless: true,
          serverCreateMs: Math.round(serverCreateMs),
          transportConnectMs: Math.round(performance.now() - transportConnectStarted),
          totalMs: Math.round(performance.now() - sessionlessServerCreateStarted),
        });
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      const acquiredAdmission = await mcpAdmission.acquire(
        sessionId ?? logicalClientId(req),
        config.mcpRequestDeadlineMs,
      );
      if (!acquiredAdmission) {
        if (sessionId) {
          const state = mcpSessions.get(sessionId);
          if (state) {
            if (state.inFlightRequests > 0) state.inFlightRequests--;
            state.lastActivityAt = Date.now();
          }
        }
        logEvent(config.logging, "warn", "mcp_request_rejected", {
          requestId,
          reason: "admission_queue_full_or_deadline",
          sessionIdPrefix: sessionIdPrefix(sessionId),
          admission: mcpAdmission.getStats(),
        });
        return res.status(503).json({
          jsonrpc: "2.0",
          id: (req.body as { id?: unknown })?.id ?? null,
          error: { code: -32029, message: "MCP request capacity is temporarily exhausted. Retry later." },
        });
      }
      admissionRelease = acquiredAdmission;

      await transport.handleRequest(req, res, req.body);
      admissionRelease();
      admissionRelease = undefined;
      // Decrement in-flight count after response completes
      if (sessionId) {
        const state = mcpSessions.get(sessionId);
        if (state) {
          if (state.inFlightRequests > 0) state.inFlightRequests--;
          if (sessionLongPoll && state.activeLongPollCount > 0) state.activeLongPollCount--;
          state.lastActivityAt = Date.now();
        }
      }
    } catch (error) {
      admissionRelease?.();
      admissionRelease = undefined;
      // Decrement in-flight count on error too
      if (sessionId) {
        const state = mcpSessions.get(sessionId);
        if (state) {
          if (state.inFlightRequests > 0) state.inFlightRequests--;
          if (sessionLongPoll && state.activeLongPollCount > 0) state.activeLongPollCount--;
          state.lastActivityAt = Date.now();
        }
      }
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  // Singleton continuation dispatcher — owned by the Kontrol process, not by an
  // individual MCP client connection. Shares the SAME liveWaiters instance used
  // by every createMcpServer so a parked agent suppresses duplicate dispatch.
  let dispatcher: ContinuationDispatcher | undefined;
  let supervisorRuntime: ReturnType<typeof createSupervisorRuntime> | undefined;
  if (config.acpEnabled) {
    const bridgeBase: BridgeConfig = {
      workspaces,
      workSessions,
      reviewCheckpoints,
      agentRegistry,
      eventStore,
      continuationManager,
      dispatchOutbox,
      reviewWorkflow,
      missionLedger,
      supervisorRuns,
      onSupervisorResume: (workSessionId) => supervisorRuntime?.wake(workSessionId),
      agentMessages,
      knownAgents: config.acpKnownAgents,
      sharedSecret: config.acpSharedSecret,
      liveWaiters,
    };
    dispatcher = createContinuationDispatcher(bridgeBase);
    dispatcher.start();
    supervisorRuntime = createSupervisorRuntime({
      outbox: dispatchOutbox,
      events: eventStore,
      runs: supervisorRuns,
      onVerify: async (workSessionId, deadlineAt, submission) => {
        await verifyMissionSubmission({
          workSessionId,
          missionLedger,
          workSessions,
          workspaces,
          reviewCheckpoints,
          deadlineAtMs: deadlineAt ? Date.parse(deadlineAt) : undefined,
          submissionId: submission?.id,
          reviewEpoch: submission?.reviewEpoch,
        });
      },
      onEvaluate: async (workSessionId) => {
        const run = supervisorRuns.getByWorkSession(workSessionId);
        const latest = workSessions.get(workSessionId)?.latestSubmission;
        return evaluateSupervisorMission(missionLedger, workSessionId, {
          submissionId: latest?.id,
          snapshotCommit: latest?.snapshotCommit,
          cycleNumber: run?.cycleNumber ?? 0,
          maxCycles: run?.maxCycles ?? 0,
        });
      },
      onCorrect: async (workSessionId, reasons) => {
        const mission = missionLedger.getMissionByWorkSession(workSessionId);
        const session = workSessions.get(workSessionId);
        const latest = session?.latestSubmission;
        if (!mission || !latest?.id || !session) throw new Error("Cannot create a correction without a current mission submission.");
        const packet = missionLedger.getPacket(workSessionId);
        const failedCriteria = packet.criteria.filter((criterion) => criterion.priority === "required" && criterion.status !== "verified");
        const openFindings = packet.findings.filter((finding) => finding.scope !== "out_of_scope" && ["blocker", "high"].includes(finding.severity) && !["verified_resolved", "waived"].includes(finding.status));
        const workOrder = missionLedger.createWorkOrder(mission.id, workSessionId, {
          objectiveForThisTurn: "Resolve the current failed mission verification and resubmit the exact workspace snapshot for review.",
          acceptanceCriterionIds: failedCriteria.map((criterion) => criterion.id),
          requiredFindingIds: openFindings.map((finding) => finding.id),
          requiredActions: reasons,
          prohibitedActions: mission.userLockedFields.map((field) => `Do not alter user-locked mission field: ${field}`),
          requiredVerification: failedCriteria.map((criterion) => criterion.verificationCommand).filter(Boolean),
          expectedDeliverables: ["A corrected submission with verification-ready workspace state."],
        });
        await reviewWorkflow.provideFeedback({
          sessionId: workSessionId,
          submissionId: latest.id,
          diffSha256: latest.diffSha256,
          reviewEpoch: latest.reviewEpoch,
          verdict: "changes_requested",
          comments: `Automatic verification requires correction:\n${reasons.join("\n")}`,
          requiredActions: workOrder.requiredActions,
          reviewerId: "supervisor-runtime",
        });
      },
      currentSubmission: (workSessionId) => {
        const session = workSessions.get(workSessionId);
        if (session?.status !== "awaiting_review") return undefined;
        const submission = session.latestSubmission;
        return submission?.id ? { id: submission.id, snapshotCommit: submission.snapshotCommit, reviewEpoch: submission.reviewEpoch } : undefined;
      },
      currentSessionStatus: (workSessionId) => workSessions.get(workSessionId)?.status,
      currentApproval: (workSessionId) => {
        const latest = workSessions.get(workSessionId)?.latestSubmission;
        return missionLedger.canApprove(workSessionId, latest?.id ? { submissionId: latest.id, snapshotCommit: latest.snapshotCommit, reviewEpoch: latest.reviewEpoch } : {});
      },
      onApprove: async (workSessionId) => {
        const session = workSessions.get(workSessionId);
        const latest = session?.latestSubmission;
        if (!session || !latest?.id) throw new Error("Cannot automatically approve without a current submission.");
        const approval = missionLedger.canApprove(workSessionId, { submissionId: latest.id, snapshotCommit: latest.snapshotCommit, reviewEpoch: latest.reviewEpoch });
        if (!approval.allowed) throw new Error(`Automatic approval blocked: ${approval.reasons.join("; ")}`);
        await reviewWorkflow.provideFeedback({
          sessionId: workSessionId,
          submissionId: latest.id,
          diffSha256: latest.diffSha256,
          reviewEpoch: latest.reviewEpoch,
          verdict: "approve",
          comments: "Automatically approved after current trusted mission verification.",
          reviewerId: "supervisor-runtime",
          completionReportSha256: missionLedger.getCompletionReportHash(workSessionId, { submissionId: latest.id, snapshotCommit: latest.snapshotCommit, reviewEpoch: latest.reviewEpoch }),
        });
      },
    });
    supervisorRuntime.start();
  }

  let closed = false;
  let draining: Promise<void> | undefined;
  const closeTransport = async (transport: Transport): Promise<void> => {
    try {
      await Promise.race([
        Promise.resolve(transport.close()),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    } catch {
      // A transport that rejects during drain is already unusable; continue
      // closing the rest of the generation.
    }
  };
  const finalizeClose = () => {
    if (closed) return;
    closed = true;
    dispatcher?.stop();
    supervisorRuntime?.stop();
    supervisorRuns.close();
    mcpAdmission.close();
    clearInterval(mcpSessionReaper);
    clearInterval(mcpMemorySampler);
    clearInterval(mcpSessionChurnTimer);
    clearInterval(maintenanceTimer);
    clearInterval(databaseIntegrityTimer);
    const shutdownAt = Date.now();
    for (const state of mcpSessions.values()) {
      state.closing = true;
      recordMcpSessionEnd(state, "server_shutdown", shutdownAt);
    }
    for (const transport of transports.values()) void transport.close().catch(() => {});
    transports.clear();
    mcpSessions.clear();
    eventStore.close();
    continuationManager.close();
    dispatchOutbox.close();
    processSessions.shutdown();
    oauthProvider?.close();
    workspaceStore.close?.();
    workSessions?.close?.();
    agentRegistry.close();
    try { db.close(); } catch { /* ignore */ }
  };
  return {
    app,
    config,
    dispatcher,
    close: finalizeClose,
    drain: async () => {
      if (closed) return;
      if (draining) return draining;
      draining = (async () => {
        // Reject new MCP admission first, then close transports so long polls
        // are woken before the Node HTTP server waits for connection closure.
        shuttingDown = true;
        mcpAdmission.close();
        const activeTransports = [...transports.values()];
        for (const state of mcpSessions.values()) state.closing = true;
        await Promise.all(activeTransports.map(closeTransport));
        finalizeClose();
      })();
      return draining;
    },
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close, drain } = createServer();
  const runtimeIdentity = createRuntimeIdentity(
    config.stateDir,
    readBuildIdentity(join(dirname(fileURLToPath(import.meta.url)), "build-meta.json")),
  );
  const httpServer = app.listen(config.port, config.host, () => {
    // P2 / P1 #51: Log build info at startup for dirty-deployment visibility.
    // Prefer the embedded build meta (artifact identity); fall back to git working tree.
    let commit = "unknown";
    let dirty = false;
    let dirtyFileCount = 0;
    try {
      const metaPath = join(dirname(fileURLToPath(import.meta.url)), "build-meta.json");
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      commit = meta.gitSha ?? "unknown";
      dirty = (meta.gitDirty ?? 0) > 0;
      dirtyFileCount = meta.gitDirty ?? 0;
      console.log(`[build] id=${meta.buildId ?? "dev"} version=${meta.version} sha=${commit} dirty=${dirtyFileCount} schema=${meta.schemaHash} built=${meta.buildTimestamp}`);
    } catch {
      try {
        commit = execSync("git rev-parse HEAD 2>/dev/null || echo unknown", { encoding: "utf8" }).trim();
        const status = execSync("git status --porcelain 2>/dev/null", { encoding: "utf8" }).trim();
        if (status) {
          dirty = true;
          dirtyFileCount = status.split("\n").length;
        }
      } catch { /* ignore */ }
    }

    console.log(
      `kontrol listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(
      config.authMode === "tunnel"
        ? "auth: tunnel mode (loopback only; OAuth disabled on /mcp; ChatGPT connects with No Authentication)"
        : "auth: oauth owner-token flow required",
    );
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
    // P2: Build info for dirty-deployment visibility
    console.log(`build commit: ${commit.slice(0, 8)} dirty: ${dirty ? `YES (${dirtyFileCount} files)` : "no"} built: ${new Date().toISOString()}`);
  });
  httpServer.once("error", (error) => {
    removeRuntimeIdentity(config.stateDir, runtimeIdentity.instanceId);
    close();
    console.error(`kontrol failed to listen on ${config.host}:${config.port}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });

  let shutdownStarted = false;
  const shutdown = async () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    try {
      await drain();
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const deadline = setTimeout(() => {
          httpServer.closeAllConnections?.();
          finish();
        }, 5_000);
        httpServer.close(() => {
          clearTimeout(deadline);
          finish();
        });
      });
      close();
      removeRuntimeIdentity(config.stateDir, runtimeIdentity.instanceId);
      process.exit(0);
    } catch (error) {
      console.error(`kontrol graceful shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      close();
      removeRuntimeIdentity(config.stateDir, runtimeIdentity.instanceId);
      process.exit(1);
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
