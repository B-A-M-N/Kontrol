import type { MissionLedger } from "./mission-ledger.js";

export type SupervisorDecision = "approval_pending" | "correction_pending" | "awaiting_human";
export function evaluateSupervisorMission(ledger: MissionLedger, workSessionId: string, context: { submissionId?: string; snapshotCommit?: string; cycleNumber: number; maxCycles?: number; emergencyCycleCeiling?: number }) {
  const packet = ledger.getPacket(workSessionId, context);
  const approval = ledger.canApprove(workSessionId, context);
  const failed = packet.criteria.filter((criterion) => criterion.priority === "required" && criterion.status === "failed");
  // Failed command verification is represented as trusted failed evidence; the
  // criterion remains unverified until a later submission passes. Treat a
  // declared command that is still unverified as an actionable correction, not
  // an ambiguous manual-review requirement that should stop unattended work.
  const commandVerificationPending = packet.criteria.filter(
    (criterion) => criterion.priority === "required" && Boolean(criterion.verificationCommand) && criterion.status !== "verified",
  );
  const actionable = packet.findings.filter((finding) => finding.scope !== "out_of_scope" && ["blocker", "high"].includes(finding.severity) && !["verified_resolved", "waived"].includes(finding.status));
  if (approval.allowed) return { decision: "approval_pending" as const, reasons: [] };
  const emergencyCeiling = context.emergencyCycleCeiling ?? context.maxCycles;
  if (emergencyCeiling !== undefined && context.cycleNumber >= emergencyCeiling) {
    return { decision: "awaiting_human" as const, reasons: ["Supervisor emergency cycle ceiling reached.", ...approval.reasons] };
  }
  if (failed.length || commandVerificationPending.length || actionable.length) return { decision: "correction_pending" as const, reasons: approval.reasons };
  return { decision: "awaiting_human" as const, reasons: approval.reasons };
}
