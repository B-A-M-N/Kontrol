/**
 * Work-session control plane
 *
 * P1 god-object decomposition: the former 1,466-line SqliteWorkSessionManager
 * now lives in src/work-sessions/ as domain stores over one shared
 * DatabaseHandle (session CRUD, workspace leases, review submissions/feedback,
 * tool-event telemetry, read-model queries, runtime-state reconciliation)
 * behind the WorkSessionManager façade. This module re-exports the public
 * surface so existing consumers keep their import paths.
 */
export type {
  CompletionPolicy,
  RuntimeReconciliationPage,
  SubmissionVerdict,
  ToolEvent,
  WorkSession,
  WorkSessionFeedback,
  WorkSessionLifecycle,
  WorkSessionRuntimeState,
  WorkSessionStatus,
  WorkSessionSubmission,
  WorkspaceLease,
  WorkspaceLeaseResult,
  WorkspaceSessionSurfaceCursor,
  WorkspaceSessionSurfaceEntry,
} from "./work-sessions/types.js";
export {
  createWorkSessionManager,
  type WorkSessionManager,
  type WorkSessionManagerOptions,
} from "./work-sessions/index.js";
export { classifyLifecycle } from "./work-sessions/internal.js";
