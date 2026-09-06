export const APPROVAL_CENTER_PREFIX = "__approval_center__:";
// P0.4: the approval center is workspace-scoped. One global pseudo-session
// would let workspace A's direct approvals render under workspace B after a
// reconnect re-tagged the shared view's workspaceSessionId.
export function approvalCenterId(workspaceId: string | null | undefined): string {
  return `${APPROVAL_CENTER_PREFIX}${workspaceId ?? ""}`;
}
export function isApprovalCenterId(workSessionId: string | null | undefined): boolean {
  return typeof workSessionId === "string" && workSessionId.startsWith(APPROVAL_CENTER_PREFIX);
}
