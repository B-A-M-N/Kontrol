/**
 * Supervised mission creation, inspection, verification, continuation and approval tools
 *
 * Extracted verbatim from the original acp-bridge.ts god module (P0 refactor):
 * this capability module owns one semantic slice of the reviewer/worker
 * control-plane API and receives the same typed BridgeConfig context.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeConfig } from "./context.js";
import { selectHealthyAgent } from "../acp-gateway.js";
import { verifyMissionSubmission } from "../mission-verifier.js";
import { registerMutationAppTool } from "./app-tool.js";
import { criterionUpdateSchema, dispatchAgentTask, findingSchema, findingUpdateSchema, missionCriterionSchema, supervisorPacket, workOrderSchema } from "./context.js";
import { acquireCheckoutModifyLease, forbidden, isReviewer, renderMissionPrompt, workspaceAppModelAndAppMeta } from "./shared.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod/v4";

export function registerMissionTools(server: McpServer, config: BridgeConfig): void {
  registerMutationAppTool(
    server,
    "begin_supervised_work",
    {
      title: "Begin supervised work",
      description: "Start bounded supervised delegation only when the reviewer explicitly needs a worker. Preflight a currently dispatchable registered agent before creating any mission, lease, or work-session state; ordinary review and diagnosis stay in the direct workspace. The reviewer/WebUI remains the completion authority.",
      inputSchema: {
        workspaceSessionId: z.string(),
        objective: z.string().trim().min(1),
        desiredOutcome: z.string().optional(),
        constraints: z.array(z.unknown()).optional(),
        nonGoals: z.array(z.string()).optional(),
        acceptanceCriteria: z.array(missionCriterionSchema).optional(),
        supervisorInstructions: z.string().optional(),
        maxCorrectionRounds: z.number().int().min(1).max(50).optional().describe("Backstop ceiling on auto-extended correction rounds when new blocking findings appear (default 5). Progress raises the effective ceiling; convergence ends the loop earlier."),
        maxWallTimeMinutes: z.number().int().min(1).max(10_080).optional().describe("Wall-clock safety budget for autonomous supervision; defaults to 24 hours."),
        finalVerification: z.array(z.string()).optional().describe("Mission-level integration commands that must pass against the final submitted snapshot."),
        reviewCoverage: z.array(z.string()).optional().describe("Review lenses (e.g. architecture, security, correctness) the reviewer must explicitly cover before completion. Approval blocks while any lens lacks coverage evidence."),
        autonomyMode: z.enum(["manual", "verify_only", "correction_auto", "full"]).optional(),
        approvalMode: z.enum(["human_required", "policy_auto", "fully_automatic"]).optional(),
        workOrder: workOrderSchema.optional(),
        agentName: z.string().optional(),
        clientMutationId: z.string().min(1).max(200).optional(),
      },
      outputSchema: { workSessionId: z.string(), runId: z.string(), status: z.string(), packet: z.unknown() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ workspaceSessionId, objective, desiredOutcome, constraints, nonGoals, acceptanceCriteria, supervisorInstructions, maxCorrectionRounds, maxWallTimeMinutes, finalVerification, reviewCoverage, autonomyMode, approvalMode, workOrder, agentName }: any) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "begin_supervised_work");
      if (!config.missionLedger) return { content: [{ type: "text" as const, text: "Mission ledger unavailable." }], isError: true };
      const requiredCount = (acceptanceCriteria ?? []).filter((c: any) => (c.priority ?? "required") === "required").length;
      if (requiredCount === 0) {
        return { content: [{ type: "text" as const, text: "Supervised missions require at least one required acceptance criterion." }], isError: true };
      }
      const workspace = config.workspaces.getWorkspace(workspaceSessionId);
      const selectedAgentName = agentName ?? "cli-coding-agent";
      const preflight = await selectHealthyAgent(config.agentRegistry.listAlive(), {
        name: selectedAgentName,
        role: "agent",
        adapterSecret: config.adapterSecret,
      });
      if (!preflight.agent) {
        return {
          content: [{ type: "text" as const, text: `No healthy dispatchable ACP agent named ${selectedAgentName}; no mission, work session, or workspace lease was created. Continue in the direct workspace or retry after a healthy agent is available.` }],
          isError: true,
        };
      }
      let baselineCommit: string | undefined;
      let baselineKind: "git" | "filesystem" | undefined;
      let baselineRef: string | undefined;
      try {
        const baseline = await config.reviewCheckpoints.reviewChanges({ workspaceId: workspaceSessionId, root: workspace.root, since: "workspace_open", markReviewed: false });
        baselineCommit = baseline.snapshotCommit;
        baselineKind = baseline.snapshotKind;
        baselineRef = baseline.snapshotRef;
      } catch {
        baselineCommit = undefined;
      }
      const created = config.workSessions.create({
        workspaceSessionId,
        submittedBy: "webui",
        title: objective.slice(0, 80),
        completionPolicy: "webui_approval_required",
      });
      const leaseError = await acquireCheckoutModifyLease(config, workspaceSessionId, created.id);
      if (leaseError) {
        config.workSessions.updateStatus(created.id, "cancelled");
        return leaseError;
      }
      let mission: ReturnType<typeof config.missionLedger.createMission> | undefined;
      let supervisorRun: ReturnType<NonNullable<typeof config.supervisorRuns>["create"]> | undefined;
      try {
        mission = config.missionLedger.createMission({
          workSessionId: created.id,
          workspaceSessionId,
          objective,
          desiredOutcome,
          constraints,
          nonGoals,
          acceptanceCriteria,
          supervisorInstructions,
          maxCorrectionRounds,
          finalVerification,
          reviewCoverage,
          baselineKind,
          baselineRef,
          baselineCommit,
        });
        // Mission correction rounds are an evidence/convergence policy. They
        // are deliberately not copied into the supervisor's emergency cycle
        // guard; one cycle can include verification and a correction dispatch.
        supervisorRun = config.supervisorRuns?.create({ missionId: mission.id, workSessionId: created.id, workspaceSessionId, autonomyMode, approvalMode, maxWallTimeMs: maxWallTimeMinutes ? maxWallTimeMinutes * 60_000 : undefined });
        config.missionLedger.createWorkOrder(mission.id, created.id, workOrder ?? { objectiveForThisTurn: objective });
        const prompt = renderMissionPrompt(config, created.id, objective);
        const dispatch = await dispatchAgentTask(config, {
          task: prompt,
          workspaceSessionId,
          workSessionId: created.id,
          agentName,
          appendSessionInstructions: true,
        });
        if (dispatch.result.status === "failed") {
          throw new Error(dispatch.result.error ?? "ACP worker dispatch failed");
        }
        if (supervisorRun) config.supervisorRuns?.transition({ id: supervisorRun.id, expectedStatus: "created", expectedRevision: supervisorRun.revision, nextStatus: "worker_active" });
        return {
          content: [{ type: "text" as const, text: `Supervised work started in ${created.id}; worker status=${dispatch.result.status}.` }],
          structuredContent: {
            workSessionId: created.id,
            runId: dispatch.result.runId,
            status: dispatch.result.status,
            packet: await supervisorPacket(config, created.id),
          },
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // Dispatch failure is a durable failed mission, not a half-created
        // supervisor with a checkout fence left behind. Keep the mission and
        // work order for diagnosis, then release every ownership record.
        config.workSessions.updateStatus(created.id, "failed");
        config.workSessions.releaseWorkspaceLeasesForSession(created.id);
        if (supervisorRun) {
          const current = config.supervisorRuns?.getByWorkSession(created.id);
          if (current && !["failed", "cancelled", "completed"].includes(current.status)) {
            config.supervisorRuns?.transition({ id: current.id, expectedStatus: current.status, expectedRevision: current.revision, nextStatus: "failed", lastError: reason });
          }
        }
        config.eventStore.appendEvent({
          type: "agent.run.failed",
          sessionId: created.id,
          payload: { reason, missionId: mission?.id, phase: "supervised_dispatch" },
        });
        return {
          content: [{ type: "text" as const, text: `Supervised work failed before dispatch: ${reason}` }],
          structuredContent: { workSessionId: created.id, runId: "", status: "failed", packet: await supervisorPacket(config, created.id) },
          isError: true,
        };
      }
    },
  );

  registerAppTool(
    server,
    "inspect_supervised_work",
    {
      title: "Inspect supervised work",
      description: "Return a bounded model-visible mission packet. summary returns unresolved criteria, blocking findings, the current work order, latest evidence, progress, and the latest report; current adds recent tool activity; full explicitly loads complete mission history and cumulative diff metadata.",
      inputSchema: { workSessionId: z.string(), detail: z.enum(["summary", "current", "full"]).optional().describe("Defaults to summary. Use current for recent tool activity or full for complete history and cumulative diff metadata.") },
      outputSchema: { packet: z.unknown() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: true },
    },
    async ({ workSessionId, detail }) => {
      if (!config.workSessions.get(workSessionId)) return { content: [{ type: "text" as const, text: "Session not found." }], isError: true };
      const packet = await supervisorPacket(config, workSessionId, detail ?? "summary");
      return { content: [{ type: "text" as const, text: "Supervisor review packet ready." }], structuredContent: { packet } };
    },
  );

  registerMutationAppTool(
    server,
    "run_mission_verification",
    {
      title: "Run mission verification",
      description: "Run declared criterion verification commands only when the current workspace matches the submitted snapshot, then record server-generated evidence.",
      inputSchema: { workSessionId: z.string(), criterionIds: z.array(z.string()).optional(), verificationScope: z.enum(["focused", "affected", "full"]).optional().describe("focused runs selected criteria, affected runs criteria whose declared areas intersect the submitted diff, and full runs all eligible criteria."), verificationPhase: z.enum(["progressive", "final"]).optional().describe("progressive runs normal correction checks; final explicitly unlocks finalOnly criteria and final integration checks."), clientMutationId: z.string().min(1).max(200).optional(), },
      outputSchema: { packet: z.unknown(), results: z.array(z.unknown()) },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ workSessionId, criterionIds, verificationScope, verificationPhase }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "run_mission_verification");
      if (!config.missionLedger) return { content: [{ type: "text" as const, text: "Mission ledger unavailable." }], isError: true };
      let results;
      const currentSubmission = config.workSessions.get(workSessionId)?.latestSubmission;
      try { results = await verifyMissionSubmission({ workSessionId, missionLedger: config.missionLedger, workSessions: config.workSessions, workspaces: config.workspaces, reviewCheckpoints: config.reviewCheckpoints, criterionIds, verificationScope, verificationPhase, submissionId: currentSubmission?.id, reviewEpoch: currentSubmission?.reviewEpoch }); }
      catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }; }
      return { content: [{ type: "text" as const, text: `Recorded ${results.length} verification result(s).` }], structuredContent: { results, packet: await supervisorPacket(config, workSessionId) } };
    },
  );

  registerMutationAppTool(
    server,
    "continue_supervised_work",
    {
      title: "Continue supervised work",
      description: "Persist supervisor findings/criterion updates, create a bounded work order, request changes, and return the next supervisor packet.",
      inputSchema: {
        workSessionId: z.string(),
        comments: z.string().trim().min(1),
        findings: z.array(findingSchema).optional(),
        criterionUpdates: z.array(criterionUpdateSchema.omit({ status: true }).extend({ status: z.enum(["unverified", "partially_verified", "failed"]) })).optional(),
        findingUpdates: z.array(findingUpdateSchema).optional(),
        evidence: z.array(z.object({
          criterionId: z.string().optional(),
          submissionId: z.string().optional(),
          snapshotKind: z.enum(["git", "filesystem"]).optional(),
          snapshotRef: z.string().optional(),
          snapshotCommit: z.string().optional(),
          command: z.string().optional(),
          status: z.enum(["passed", "failed", "inconclusive"]),
          details: z.unknown().optional(),
        })).optional(),
        workOrder: workOrderSchema,
        clientMutationId: z.string().min(1).max(200).optional(),
      },
      outputSchema: { status: z.string(), continuationId: z.string().optional(), extension: z.unknown().optional(), packet: z.unknown() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ workSessionId, comments, findings, criterionUpdates, findingUpdates, evidence, workOrder }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "continue_supervised_work");
      if (!config.missionLedger) return { content: [{ type: "text" as const, text: "Mission ledger unavailable." }], isError: true };
      const mission = config.missionLedger.getMissionByWorkSession(workSessionId);
      if (!mission) return { content: [{ type: "text" as const, text: "No mission contract for this work session." }], isError: true };
      const session = config.workSessions.get(workSessionId);
      const latest = session?.latestSubmission;
      if (!latest?.id) return { content: [{ type: "text" as const, text: "No pending submission to continue from." }], isError: true };
      const createdFindings = findings?.length ? config.missionLedger.addFindings(mission.id, findings) : [];
      if (criterionUpdates?.length) config.missionLedger.updateCriterionStatus(mission.id, criterionUpdates);
      if (findingUpdates?.length) config.missionLedger.updateFindingStatus(mission.id, findingUpdates);
      if (evidence?.length) {
        config.missionLedger.recordReviewerEvidence(mission.id, evidence.map((entry: { submissionId?: string; snapshotKind?: "git" | "filesystem"; snapshotRef?: string; snapshotCommit?: string; criterionId?: string; command?: string; status: "passed" | "failed" | "inconclusive"; details?: unknown }) => ({
          ...entry,
          submissionId: entry.submissionId ?? latest.id,
          snapshotKind: entry.snapshotKind ?? latest.snapshotKind,
          snapshotRef: entry.snapshotRef ?? latest.snapshotRef ?? latest.snapshotCommit,
          snapshotCommit: entry.snapshotRef ?? entry.snapshotCommit ?? latest.snapshotRef ?? latest.snapshotCommit,
        })));
      }

      // P2 #34/#35: persist which review lenses this pass covered and any
      // explicit uncertainty so completion can end on coverage, not a timer.
      if ((workOrder.reviewCoverage?.length || workOrder.uncertainty?.length) && (latest.snapshotRef ?? latest.snapshotCommit)) {
        config.missionLedger.recordReviewCoverage(mission.id, {
          submissionId: latest.id,
          snapshotKind: latest.snapshotKind,
          snapshotRef: latest.snapshotRef ?? latest.snapshotCommit,
          snapshotCommit: latest.snapshotRef ?? latest.snapshotCommit!,
          reviewCoverage: workOrder.reviewCoverage,
          uncertainty: workOrder.uncertainty,
        });
      }
      // Anti-runaway guard: only extend the correction loop when this round is
      // making progress. A round that surfaced new blocking in-scope findings
      // extends (bounded by a progress-aware ceiling); a non-converging runaway
      // is stopped and handed back to a human rather than auto-looping forever.
      const resolvedFindingIds = (findingUpdates ?? [])
        .filter((u: { status: string }) => u.status === "verified_resolved" || u.status === "waived")
        .map((u: { id: string }) => u.id);
      const extension = config.missionLedger.evaluateLoopExtension(workSessionId, {
        newFindingIds: createdFindings.map((f) => f.id),
        resolvedFindingIds,
      });
      if (extension.ceilingHit) {
        // The findings are already persisted (auditable), but we refuse to
        // auto-dispatch another correction turn. A human decides: ship what
        // exists, waive, or explicitly force another round.
        return {
          content: [{ type: "text" as const, text: `Correction loop not extended: ${extension.reason}` }],
          structuredContent: {
            status: "ceiling_reached",
            extension,
            packet: await supervisorPacket(config, workSessionId),
          },
        };
      }

      config.missionLedger.createWorkOrder(mission.id, workSessionId, workOrder);
      const result = await config.reviewWorkflow.provideFeedback({
        sessionId: workSessionId,
        submissionId: latest.id,
        diffSha256: latest.diffSha256,
        reviewEpoch: latest.reviewEpoch,
        verdict: "changes_requested",
        comments,
        requiredActions: workOrder.requiredActions,
        reviewerId: "webui",
      });
      return {
        content: [{ type: "text" as const, text: `Changes requested for ${workSessionId}; continuation queued.` }],
        structuredContent: {
          status: "running",
          continuationId: result.continuationId,
          packet: await supervisorPacket(config, workSessionId),
        },
      };
    },
  );

  registerMutationAppTool(
    server,
    "approve_supervised_work",
    {
      title: "Approve supervised work",
      description: "Approve only if the durable mission predicate allows it. Criteria/finding/evidence updates are persisted before evaluating approval.",
      inputSchema: {
        workSessionId: z.string(),
        criterionUpdates: z.array(criterionUpdateSchema.omit({ status: true }).extend({ status: z.enum(["unverified", "partially_verified", "failed"]) })).optional(),
        findingUpdates: z.array(findingUpdateSchema).optional(),
        evidence: z.array(z.object({
          criterionId: z.string().optional(),
          submissionId: z.string().optional(),
          snapshotKind: z.enum(["git", "filesystem"]).optional(),
          snapshotRef: z.string().optional(),
          snapshotCommit: z.string().optional(),
          command: z.string().optional(),
          status: z.enum(["passed", "failed", "inconclusive"]),
          details: z.unknown().optional(),
        })).optional(),
        comments: z.string().optional(),
        reviewCoverage: z.array(z.string()).optional().describe("Review lenses covered by this approval pass; recorded before the gate evaluates coverage."),
        uncertainty: z.array(z.unknown()).optional().describe("Explicit residual-uncertainty entries recorded with the completion report."),
        clientMutationId: z.string().min(1).max(200).optional(),
      },
      outputSchema: { status: z.string(), approved: z.boolean(), reasons: z.array(z.string()), packet: z.unknown() },
      _meta: workspaceAppModelAndAppMeta(),
      annotations: { readOnlyHint: false },
    },
    config,
    async ({ workSessionId, criterionUpdates, findingUpdates, evidence, comments, reviewCoverage, uncertainty }) => {
      if (!isReviewer(config.principalRole)) return forbidden(config.principalRole, "approve_supervised_work");
      if (!config.missionLedger) return { content: [{ type: "text" as const, text: "Mission ledger unavailable." }], isError: true };
      const mission = config.missionLedger.getMissionByWorkSession(workSessionId);
      if (!mission) return { content: [{ type: "text" as const, text: "No mission contract for this work session." }], isError: true };
      const session = config.workSessions.get(workSessionId);
      const latest = session?.latestSubmission;
      if (!latest?.id) return { content: [{ type: "text" as const, text: "No pending submission to approve." }], isError: true };
      if (criterionUpdates?.length) config.missionLedger.updateCriterionStatus(mission.id, criterionUpdates);
      if (findingUpdates?.length) config.missionLedger.updateFindingStatus(mission.id, findingUpdates);
      if (evidence?.length) {
        config.missionLedger.recordReviewerEvidence(mission.id, evidence.map((entry: { submissionId?: string; snapshotKind?: "git" | "filesystem"; snapshotRef?: string; snapshotCommit?: string; criterionId?: string; command?: string; status: "passed" | "failed" | "inconclusive"; details?: unknown }) => ({
          ...entry,
          submissionId: entry.submissionId ?? latest.id,
          snapshotKind: entry.snapshotKind ?? latest.snapshotKind,
          snapshotRef: entry.snapshotRef ?? latest.snapshotRef ?? latest.snapshotCommit,
          snapshotCommit: entry.snapshotRef ?? entry.snapshotCommit ?? latest.snapshotRef ?? latest.snapshotCommit,
        })));
      }
      // P2 #34/#35: coverage/uncertainty recorded on the approval attempt so
      // the gate sees exactly which lenses this reviewer visited.
      if ((reviewCoverage?.length || uncertainty?.length) && (latest.snapshotRef ?? latest.snapshotCommit)) {
        config.missionLedger.recordReviewCoverage(mission.id, {
          submissionId: latest.id,
          snapshotKind: latest.snapshotKind,
          snapshotRef: latest.snapshotRef ?? latest.snapshotCommit,
          snapshotCommit: latest.snapshotRef ?? latest.snapshotCommit!,
          reviewCoverage,
          uncertainty,
        });
      }
      const approval = config.missionLedger.canApprove(workSessionId, { submissionId: latest.id, snapshotKind: latest.snapshotKind, snapshotRef: latest.snapshotRef ?? latest.snapshotCommit, snapshotCommit: latest.snapshotRef ?? latest.snapshotCommit, reviewEpoch: latest.reviewEpoch });
      if (!approval.allowed) {
        return {
          content: [{ type: "text" as const, text: `Approval blocked: ${approval.reasons.join("; ")}` }],
          structuredContent: { status: "blocked", approved: false, reasons: approval.reasons, packet: await supervisorPacket(config, workSessionId) },
          isError: true,
        };
      }
      await config.reviewWorkflow.provideFeedback({
        sessionId: workSessionId,
        submissionId: latest.id,
        diffSha256: latest.diffSha256,
        reviewEpoch: latest.reviewEpoch,
        verdict: "approve",
        comments,
        reviewerId: "webui",
          completionReportSha256: config.missionLedger.getCompletionReportHash(workSessionId, { submissionId: latest.id, snapshotKind: latest.snapshotKind, snapshotRef: latest.snapshotRef ?? latest.snapshotCommit, snapshotCommit: latest.snapshotRef ?? latest.snapshotCommit, reviewEpoch: latest.reviewEpoch }),
      });
      const supervisor = config.supervisorRuns?.getByWorkSession(workSessionId);
      if (supervisor) config.supervisorRuns?.transition({ id: supervisor.id, expectedStatus: supervisor.status, expectedRevision: supervisor.revision, nextStatus: "completed" });
      return {
        content: [{ type: "text" as const, text: `Approved ${workSessionId}.` }],
        structuredContent: { status: "approved", approved: true, reasons: [], packet: await supervisorPacket(config, workSessionId) },
      };
    },
  );
}
