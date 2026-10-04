// Worker-side lease deadline shared by the bundled ACP adapters. The lease is
// valid only through a Kontrol acknowledgement; a request being sent is not a
// renewal. Keep a short local margin for clock skew and process shutdown.
export const WORKSPACE_LEASE_SAFETY_MARGIN_MS = 5_000;

export function workspaceLeaseDeadline(expiresAt, now = Date.now()) {
  if (typeof expiresAt !== "string" || expiresAt.length === 0) return Number.NaN;
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) return Number.NaN;
  return expiry - WORKSPACE_LEASE_SAFETY_MARGIN_MS;
}

export function applyWorkspaceLeaseRenewal(run, responseBody, now = Date.now()) {
  const expiresAt = responseBody?.workspace_lease_expires_at;
  const deadline = workspaceLeaseDeadline(expiresAt, now);
  if (!Number.isFinite(deadline) || deadline <= now) return false;
  run.workspaceLeaseExpiresAt = expiresAt;
  run.workspaceLeaseDeadlineAt = deadline;
  return true;
}

export function workspaceLeaseDeadlineReached(run, now = Date.now()) {
  if (!run?.workSessionId) return false;
  return !Number.isFinite(run.workspaceLeaseDeadlineAt) || now >= run.workspaceLeaseDeadlineAt;
}
