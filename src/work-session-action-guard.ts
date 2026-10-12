import type { WorkSessionManager } from "./work-sessions.js";

/**
 * Action classes map concrete tools onto coarse categories so a reviewer can
 * constrain what a worker may do next via `allowedNextActions`.
 */
export type ActionClass =
  | "read_files"
  | "edit_files"
  | "run_commands"
  | "resubmit"
  | "await_feedback"
  | "cancel";

export const TOOL_TO_ACTION_CLASS: Record<string, ActionClass> = {
  read: "read_files",
  ls: "read_files",
  grep: "read_files",
  glob: "read_files",
  git_status: "read_files",
  git_log: "read_files",
  git_diff: "read_files",
  git_show: "read_files",
  write: "edit_files",
  edit: "edit_files",
  apply_patch: "edit_files",
  "kontrol-read": "read_files",
  "kontrol-grep": "read_files",
  "kontrol-glob": "read_files",
  "kontrol-write": "edit_files",
  "kontrol-edit": "edit_files",
  bash: "run_commands",
  "kontrol-shell": "run_commands",
  exec_command: "run_commands",
  submit_for_review: "resubmit",
  "kontrol-submit-work-to-webui": "resubmit",
  await_review_feedback: "await_feedback",
  check_review_status: "await_feedback",
  get_work_session: "await_feedback",
  get_review_submission: "read_files",
  await_work_session_events: "await_feedback",
  cancel: "cancel",
  cancel_work_session: "cancel",
};

/** Tools/actions that must ALWAYS remain available so a worker cannot deadlock. */
export const ALWAYS_ALLOWED_ACTION_CLASSES: ReadonlySet<ActionClass> = new Set<ActionClass>([
  "await_feedback",
  "cancel",
]);

const TERMINAL_STATUSES = new Set([
  "approved",
  "rejected",
  "cancelled",
  "failed",
  "failed_protocol",
]);

export interface RequiredAction {
  id: string;
  description: string;
  actionClass?: ActionClass;
  verification?: {
    type: "test_command" | "file_changed" | "reviewer_only";
    value?: string;
  };
}

/**
 * Authorize a concrete tool invocation against the latest work-session verdict.
 *
 * When the latest verdict for the session is `changes_requested`, the worker's
 * `allowedNextActions` (action classes) is enforced. A tool whose action class
 * is NOT in the allowed set is rejected — this turns "allowedNextActions" from
 * advisory text into a real gate.
 *
 * `await_feedback` and `cancel` remain available during ordinary review so a
 * worker can observe feedback or exit. During cancellation, those are the only
 * permitted action classes; all work is fenced until shutdown is confirmed.
 *
 * IMPORTANT: this guard reads the *latest* feedback. The authoritative verifier
 * (review workflow) decides whether resubmission is accepted; this guard merely
 * blocks clearly-forbidden tools between verdict and resubmission.
 */
/** Server-owned scheduled execution policy bound to the dispatch attempt. */
export interface ScheduledExecutionPolicy {
  executionMode?: string;
  workspaceAccess?: string;
  mutate?: boolean;
  allowedTools?: string[];
}

/**
 * Read-only audit policy is enforced at the tool-action boundary. An unclassified
 * tool or any edit/command class is denied when a scheduled job requires
 * read-only workspace access; read-only tools remain available.
 */
function scheduledReadOnlyDecision(
  policy: ScheduledExecutionPolicy | undefined,
  input: { tool: string },
): { allowed: boolean; reason?: string } {
  if (!policy || policy.workspaceAccess !== "read_only" || policy.mutate !== false) return { allowed: true };
  const actionClass = TOOL_TO_ACTION_CLASS[input.tool];
  if (actionClass === "read_files") return { allowed: true };
  if (policy.allowedTools?.includes(input.tool)) return { allowed: true };
  return {
    allowed: false,
    reason: `Scheduled read-only audit policy denies tool "${input.tool}".`,
  };
}

export function authorizeWorkSessionAction(
  workSessions: WorkSessionManager | Pick<WorkSessionManager, "get">,
  input: {
    workSessionId: string;
    tool: string;
    path?: string;
    command?: string;
    scheduledExecutionPolicy?: ScheduledExecutionPolicy;
  },
): { allowed: boolean; reason?: string } {
  const session = workSessions.get(input.workSessionId);
  if (!session) return { allowed: false, reason: "unknown work session" };

  const actionClass = TOOL_TO_ACTION_CLASS[input.tool];
  if (session.status === "cancelling") {
    if (actionClass === "await_feedback" || actionClass === "cancel") return { allowed: true };
    return { allowed: false, reason: "Work session is cancelling; worker actions are fenced until shutdown is confirmed." };
  }

  const scheduledPolicyDecision = scheduledReadOnlyDecision(input.scheduledExecutionPolicy, input);
  if (!scheduledPolicyDecision.allowed) return scheduledPolicyDecision;

  if (!actionClass) {
    if (session.completionPolicy === "webui_approval_required") {
      return {
        allowed: false,
        reason: `Tool ${input.tool} has no work-session action classification.`,
      };
    }
    return { allowed: true };
  }

  if (ALWAYS_ALLOWED_ACTION_CLASSES.has(actionClass)) return { allowed: true };

  if (TERMINAL_STATUSES.has(session.status)) {
    return {
      allowed: false,
      reason: `Work session is ${session.status}; worker actions are no longer permitted.`,
    };
  }

  if (session.status === "awaiting_review" || session.status === "in_review" || session.status === "review_in_progress") {
    if (actionClass === "read_files") return { allowed: true };
    return {
      allowed: false,
      reason: `Work session is ${session.status}; worker edits and commands are blocked until reviewer feedback arrives.`,
    };
  }

  if (session.status !== "changes_requested" && session.status !== "resuming") return { allowed: true };

  const latestFeedback = session.latestFeedback;
  if (!latestFeedback) {
    return session.completionPolicy === "webui_approval_required"
      ? { allowed: false, reason: `Work session is ${session.status} but has no reviewer feedback to authorize actions.` }
      : { allowed: true };
  }

  let allowed: string[] = [];
  try {
    allowed = latestFeedback.allowedNextActionsJson
      ? (JSON.parse(latestFeedback.allowedNextActionsJson) as string[])
      : [];
  } catch {
    allowed = [];
  }

  if (allowed.length === 0) {
    // No constraint specified: default allow for non-destructive, but block
    // file edits / commands unless explicitly permitted, to honor the spirit
    // of changes_requested (the worker should be making the requested changes).
    // We allow read/await/cancel always; edits/commands require explicit allow.
    if (actionClass === "edit_files" || actionClass === "run_commands") {
      return {
        allowed: false,
        reason: `Work session is in changes_requested and no allowedNextActions permit "${actionClass}".`,
      };
    }
    return { allowed: true };
  }

  if (!allowed.includes(actionClass)) {
    return {
      allowed: false,
      reason: `Action class "${actionClass}" is not permitted by the reviewer's allowedNextActions: ${allowed.join(", ")}.`,
    };
  }

  return { allowed: true };
}
