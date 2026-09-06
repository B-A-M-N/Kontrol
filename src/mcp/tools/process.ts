/**
 * Codex-mode process tools (exec_command / write_stdin). Extracted verbatim
 * from src/mcp/workspace-server.ts (P1.3).
 */
import * as z from "zod/v4";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "../../config.js";
import type { PolicyEngine } from "../../policy.js";
import type { PolicyEnforcer } from "../../policy-enforcement.js";
import type { ProcessSessionManager } from "../../process-sessions.js";
import type { createWorkSessionManager } from "../../work-sessions.js";
import type { WorkspaceRegistry } from "../../workspaces.js";
import { approvalResumeIdSchema, SHELL_TOOL_ANNOTATIONS } from "../tool-schemas.js";
import { toolWidgetDescriptorMeta } from "../tool-context.js";
import { canonicalPolicyPath, enforceToolPolicy, policyFailureResponse } from "../tool-policy.js";
import { logToolCall } from "../tool-logging.js";
import { runMutationBarrier } from "../mutation-barrier.js";
import {
  assertWorkerWorkspaceBinding,
  processOutputSchema,
  processToolResponse,
} from "../process-tool-response.js";
import { processSessionOwnerId } from "../connection-context.js";
import type { ConnectionContext } from "../connection-context.js";

export function registerCodexProcessTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
  workSessions?: ReturnType<typeof createWorkSessionManager>,
  policyEnforcer?: PolicyEnforcer,
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
      const blocked = await runMutationBarrier(prepareForMutation, workspaceId, "exec_command");
      if (blocked) return blocked;
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
      if (hasInput) {
        const blocked = await runMutationBarrier(prepareForMutation, workspaceId, "write_stdin");
        if (blocked) return blocked;
      }
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
