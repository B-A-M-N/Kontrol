/**
 * DevSpace's host-side handler for agent-initiated ACP calls.
 *
 * This is where the reverse channel of {@link createAcpDuplex} meets DevSpace's
 * durable approval + policy machinery. When an agent calls
 * `session/request_permission` mid-tool, we create a real approval request,
 * surface it in the WebUI (via the `approval.requested` event), and PARK — with
 * no fail-closed timeout — until a human resolves it or the session is
 * cancelled. This mirrors the HTTP `POST /runs/:id/events` permission path so
 * both transports behave identically.
 */

import type { AcpClientHandler, RequestPermissionParams, PermissionOutcome, FsReadParams, FsWriteParams, SessionUpdateParams } from "./acp-duplex.js";
import type { ApprovalRequestManager, ApprovalOption } from "./approval-requests.js";
import type { EventStore } from "./event-log.js";

export interface DuplexHandlerConfig {
  approvalRequests: ApprovalRequestManager;
  eventStore: EventStore;
  workspaceSessionId: string;
  workSessionId?: string;
  runId?: string;
  agentId?: string;
  /** Optional policy-gated file access. Absent → fs/* is refused. */
  fs?: {
    readTextFile(path: string, opts?: { line?: number; limit?: number }): Promise<string>;
    writeTextFile(path: string, content: string): Promise<void>;
  };
  /** Forward a streaming session/update to observers (usually the event log). */
  onSessionUpdate?(params: SessionUpdateParams): void;
}

function toApprovalOptions(options: RequestPermissionParams["options"]): ApprovalOption[] {
  const mapped = options
    .map((o): ApprovalOption | null => {
      if (!o.optionId) return null;
      // Map ACP option kinds to DevSpace approval effects. Anything not clearly
      // an allow is treated as a deny effect so the UI renders it correctly.
      const kind = (o.kind ?? "").toLowerCase();
      const effect: ApprovalOption["effect"] = kind.includes("allow") || kind.includes("accept") ? "approve" : "deny";
      const scope = kind.includes("always") ? "work_session" : "once";
      return { id: o.optionId, label: o.name ?? o.optionId, effect, scope: effect === "approve" ? scope : undefined };
    })
    .filter((o): o is ApprovalOption => o !== null);
  return mapped.length ? mapped : [{ id: "deny", label: "Deny", effect: "deny" }];
}

export function createDevSpaceDuplexHandler(config: DuplexHandlerConfig): AcpClientHandler {
  return {
    requestPermission(params: RequestPermissionParams, signal: AbortSignal): Promise<PermissionOutcome> {
      const eventSessionId = config.workSessionId ?? config.workspaceSessionId;
      const options = toApprovalOptions(params.options);

      // Subscribe BEFORE creating the request so a fast human decision cannot
      // resolve in the create→wait gap (lost-wakeup safe). NO timeout: park
      // until a decision or cancellation.
      const approvalIdRef: { id?: string } = {};
      const resolution = new Promise<{ decision: string; optionId?: string } | null>((resolve) => {
        let onAbort: (() => void) | undefined;
        // Tear down BOTH the event subscription and the abort listener whichever
        // side settles first, so neither leaks onto the long-lived connection
        // signal across many permission requests.
        const cleanup = () => {
          unsubscribe();
          if (onAbort) signal.removeEventListener("abort", onAbort);
        };
        const unsubscribe = config.eventStore.subscribe(eventSessionId, (event) => {
          if (event.type !== "approval.resolved") return;
          const payload = event.payload ?? {};
          if (approvalIdRef.id === undefined || payload.approvalId !== approvalIdRef.id) return;
          cleanup();
          resolve({ decision: String(payload.decision ?? "deny"), optionId: typeof payload.optionId === "string" ? payload.optionId : undefined });
        });

        // Cancellation (session cancelled / stream closed) unblocks as a deny.
        if (signal.aborted) { cleanup(); resolve(null); }
        else {
          onAbort = () => { cleanup(); resolve(null); };
          signal.addEventListener("abort", onAbort);
        }
      });

      const request = config.approvalRequests.create({
        kind: "agent_permission",
        workspaceSessionId: config.workspaceSessionId,
        workSessionId: config.workSessionId,
        runId: config.runId,
        agentId: config.agentId,
        title: describeToolCall(params.toolCall) ?? "Agent permission requested",
        options,
      });
      approvalIdRef.id = request.approvalId;

      config.eventStore.appendEvent({
        type: "approval.requested",
        sessionId: eventSessionId,
        payload: {
          approvalId: request.approvalId,
          kind: request.kind,
          workspaceSessionId: request.workspaceSessionId,
          workSessionId: request.workSessionId,
          runId: request.runId,
          agentId: request.agentId,
          title: request.title,
          options: request.options,
          toolCall: params.toolCall,
        },
      });

      return resolution.then((decided): PermissionOutcome => {
        if (!decided || decided.decision !== "approve") return { outcome: "cancelled" };
        // Choose the resolved option, else the first allow option available.
        const allowIds = new Set(options.filter((o) => o.effect === "approve").map((o) => o.id));
        const chosen = decided.optionId && allowIds.has(decided.optionId)
          ? decided.optionId
          : options.find((o) => o.effect === "approve")?.id;
        return chosen ? { outcome: "selected", optionId: chosen } : { outcome: "cancelled" };
      });
    },

    async readTextFile(params: FsReadParams): Promise<{ content: string }> {
      if (!config.fs) throw new Error("fs/read_text_file is not enabled for this session");
      const content = await config.fs.readTextFile(params.path, { line: params.line, limit: params.limit });
      return { content };
    },

    async writeTextFile(params: FsWriteParams): Promise<void> {
      if (!config.fs) throw new Error("fs/write_text_file is not enabled for this session");
      await config.fs.writeTextFile(params.path, params.content);
    },

    sessionUpdate(params: SessionUpdateParams): void {
      config.onSessionUpdate?.(params);
    },
  };
}

function describeToolCall(toolCall: unknown): string | undefined {
  if (!toolCall || typeof toolCall !== "object") return undefined;
  const obj = toolCall as Record<string, unknown>;
  const title = obj.title ?? obj.name ?? obj.tool ?? obj.kind;
  return typeof title === "string" && title.length > 0 ? `Approve: ${title}` : undefined;
}
