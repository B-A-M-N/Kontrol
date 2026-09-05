/**
 * ReviewSubmissionStore: submissions, feedback, and the review transitions
 *
 * Extracted verbatim from SqliteWorkSessionManager (P1 god-object
 * decomposition). The submitForReview and submitFeedback transactions keep
 * their original immediate/deferred boundaries — the epoch allocation and the
 * session-state advance stay inside ONE transaction, exactly as before.
 * Shares the caller's DatabaseHandle.
 */
import { randomUUID } from "node:crypto";
import { eq, and, desc, sql } from "drizzle-orm";
import type { DatabaseHandle } from "../db/client.js";
import {
  workSessions,
  workSessionSubmissions,
  workSessionFeedback,
} from "../db/schema.js";
import type {
  SubmissionVerdict,
  WorkSessionFeedback,
  WorkSessionStatus,
  WorkSessionSubmission,
} from "./types.js";
import type { WorkspaceSnapshotKind, ReviewFile } from "../review-checkpoints.js";
import { isTerminalStatus, rowToSubmission, rowToFeedback, sha256 } from "./internal.js";

/** Latest submission for a session (also used by the session store hydration). */
export function getLatestSubmission(db: DatabaseHandle, workSessionId: string): WorkSessionSubmission | undefined {
  const row = db.db
    .select()
    .from(workSessionSubmissions)
    .where(eq(workSessionSubmissions.workSessionId, workSessionId))
    .orderBy(desc(workSessionSubmissions.submissionNumber))
    .limit(1)
    .get();
  return row ? rowToSubmission(row) : undefined;
}

/** Latest feedback for a session (also used by the session store hydration). */
export function getLatestFeedback(db: DatabaseHandle, workSessionId: string): WorkSessionFeedback | undefined {
  const row = db.db
    .select({ feedback: workSessionFeedback })
    .from(workSessionFeedback)
    .innerJoin(workSessionSubmissions, eq(workSessionSubmissions.id, workSessionFeedback.submissionId))
    .where(eq(workSessionFeedback.workSessionId, workSessionId))
    .orderBy(desc(workSessionSubmissions.submissionNumber), desc(workSessionSubmissions.reviewEpoch), desc(workSessionFeedback.id))
    .limit(1)
    .get();
  return row ? rowToFeedback(row.feedback) : undefined;
}

export function createReviewSubmissionStore(db: DatabaseHandle, deps: {
  /** Release this session's workspace leases (lease-store callback). */
  releaseWorkspaceLeasesForSession(workSessionId: string): number;
}) {
  const { releaseWorkspaceLeasesForSession } = deps;

  return {
    submitForReview(input: {
      workSessionId: string;
      diff?: string;
      diffSha256?: string;
      snapshotCommit?: string;
      snapshotKind?: WorkspaceSnapshotKind;
      snapshotRef?: string;
      message?: string;
      summaryJson?: string;
      files?: ReviewFile[];
    }): WorkSessionSubmission {
      const diffSha256 = input.diffSha256 ?? sha256(input.diff ?? "");
      const now = new Date().toISOString();
      const submissionId = `wssub_${randomUUID()}`;

      const createSubmission = db.sqlite.transaction(() => {
        const session = db.sqlite
          .prepare("select review_epoch, status from work_sessions where id = ?")
          .get(input.workSessionId) as { review_epoch: number; status: string } | undefined;
        if (!session) throw new Error(`Work session not found: ${input.workSessionId}`);
        if (!["in_progress", "changes_requested", "resuming"].includes(session.status)) {
          throw new Error(`Work session ${input.workSessionId} is ${session.status}; cannot submit for review.`);
        }

        // Allocate under the same immediate transaction that advances the
        // session epoch. A second writer cannot observe the same max/count and
        // turn a normal concurrency race into a raw unique-index error.
        const latest = db.sqlite
          .prepare("select coalesce(max(submission_number), 0) as submission_number from work_session_submissions where work_session_id = ?")
          .get(input.workSessionId) as { submission_number: number };
        const submissionNumber = Number(latest.submission_number) + 1;
        const reviewEpoch = Number(session.review_epoch) + 1;
        db.sqlite.prepare(`
          insert into work_session_submissions
            (id, work_session_id, submission_number, diff, diff_sha256, files_json, snapshot_commit, snapshot_kind, snapshot_ref, review_epoch, message, summary_json, status, created_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `).run(
          submissionId,
          input.workSessionId,
          submissionNumber,
          input.diff ?? null,
          diffSha256,
          input.files ? JSON.stringify(input.files) : null,
          input.snapshotCommit ?? null,
          input.snapshotKind ?? (input.snapshotCommit ? "git" : null),
          input.snapshotRef ?? input.snapshotCommit ?? null,
          reviewEpoch,
          input.message ?? null,
          input.summaryJson ?? null,
          now,
        );
        const updated = db.sqlite.prepare(`
          update work_sessions
             set status = 'awaiting_review', runtime_state = 'parked', runtime_classified_at = ?, review_epoch = ?, updated_at = ?
           where id = ? and review_epoch = ? and status in ('in_progress', 'changes_requested', 'resuming')
        `).run(now, reviewEpoch, now, input.workSessionId, session.review_epoch);
        if (updated.changes !== 1) throw new Error("submission changed concurrently");
        return { submissionNumber, reviewEpoch };
      }).immediate();

      return {
        id: submissionId,
        workSessionId: input.workSessionId,
        submissionNumber: createSubmission.submissionNumber,
        diff: input.diff,
        diffSha256,
        snapshotKind: input.snapshotKind ?? (input.snapshotCommit ? "git" : undefined),
        snapshotRef: input.snapshotRef ?? input.snapshotCommit,
        snapshotCommit: input.snapshotCommit,
        reviewEpoch: createSubmission.reviewEpoch,
        message: input.message,
        summaryJson: input.summaryJson,
        files: input.files,
        status: "pending",
        createdAt: now,
      };
    },

    submitFeedback(input: {
      workSessionId: string;
      submissionId: string;
      verdict: SubmissionVerdict;
      comments?: string;
      filesJson?: string;
      requiredActions?: string[];
      allowedNextActions?: string[];
      reviewerId?: string;
      completionReportSha256?: string;
    }): WorkSessionFeedback {
      const now = new Date().toISOString();
      const feedback: WorkSessionFeedback = {
        id: `wsfb_${randomUUID()}`,
        workSessionId: input.workSessionId,
        submissionId: input.submissionId,
        verdict: input.verdict,
        comments: input.comments,
        filesJson: input.filesJson,
        requiredActionsJson: input.requiredActions ? JSON.stringify(input.requiredActions) : undefined,
        allowedNextActionsJson: input.allowedNextActions ? JSON.stringify(input.allowedNextActions) : undefined,
        reviewerId: input.reviewerId,
        completionReportSha256: input.completionReportSha256,
        createdAt: now,
      };

      const nextStatus: WorkSessionStatus =
        input.verdict === "approve"
          ? "approved"
          : input.verdict === "reject"
            ? "rejected"
            : "changes_requested";

      db.db.transaction(() => {
        const submission = db.db
          .select({ workSessionId: workSessionSubmissions.workSessionId })
          .from(workSessionSubmissions)
          .where(eq(workSessionSubmissions.id, input.submissionId))
          .get();
        if (!submission) throw new Error(`Submission not found: ${input.submissionId}`);
        if (submission.workSessionId !== input.workSessionId) {
          throw new Error("Submission does not belong to work session");
        }

        db.db
          .insert(workSessionFeedback)
          .values({
            id: feedback.id,
            workSessionId: feedback.workSessionId,
            submissionId: feedback.submissionId,
            verdict: feedback.verdict,
            comments: feedback.comments ?? null,
            filesJson: feedback.filesJson ?? null,
            requiredActionsJson: feedback.requiredActionsJson ?? null,
            allowedNextActionsJson: feedback.allowedNextActionsJson ?? null,
            reviewerId: feedback.reviewerId ?? null,
            completionReportSha256: feedback.completionReportSha256 ?? null,
            createdAt: feedback.createdAt,
          })
          .run();

        db.db
          .update(workSessionSubmissions)
          .set({ status: "reviewed" })
          .where(eq(workSessionSubmissions.id, input.submissionId))
          .run();

        db.db
          .update(workSessions)
          .set({
            status: nextStatus,
            runtimeState: isTerminalStatus(nextStatus) ? "archived" : "detached",
            runtimeClassifiedAt: now,
            updatedAt: now,
          })
          .where(eq(workSessions.id, input.workSessionId))
          .run();
        if (isTerminalStatus(nextStatus)) {
          releaseWorkspaceLeasesForSession(input.workSessionId);
        }
      });

      return feedback;
    },

    getSubmissions(workSessionId: string): WorkSessionSubmission[] {
      const rows = db.db
        .select()
        .from(workSessionSubmissions)
        .where(eq(workSessionSubmissions.workSessionId, workSessionId))
        .orderBy(workSessionSubmissions.submissionNumber)
        .all();
      return rows.map(rowToSubmission);
    },

    getLatestSubmission(workSessionId: string): WorkSessionSubmission | undefined {
      return getLatestSubmission(db, workSessionId);
    },

    getLatestFeedback(workSessionId: string): WorkSessionFeedback | undefined {
      return getLatestFeedback(db, workSessionId);
    },

    countFeedback(workSessionId: string): number {
      const row = db.sqlite
        .prepare("select count(*) as count from work_session_feedback where work_session_id = ?")
        .get(workSessionId) as { count?: number } | undefined;
      return Number(row?.count ?? 0);
    },

    markFeedbackConsumed(workSessionId: string, feedbackId: string): void {
      const now = new Date().toISOString();
      const feedback = db.sqlite.prepare(`
        select f.id, s.review_epoch
          from work_session_feedback f
          inner join work_session_submissions s on s.id = f.submission_id
         where f.id = ? and f.work_session_id = ?
      `).get(feedbackId, workSessionId) as { id: string; review_epoch: number } | undefined;
      if (!feedback) return;
      db.sqlite.prepare(`
        update work_sessions
           set last_consumed_feedback_id = ?,
               last_consumed_review_epoch = ?,
               updated_at = ?
         where id = ?
           and last_consumed_review_epoch < ?
      `).run(feedback.id, feedback.review_epoch, now, workSessionId, feedback.review_epoch);
    },

    getLatestFeedbackAfter(workSessionId: string, afterFeedbackId?: string): WorkSessionFeedback | undefined {
      if (afterFeedbackId) {
        const anchor = db.db
          .select({ feedback: workSessionFeedback, submissionNumber: workSessionSubmissions.submissionNumber })
          .from(workSessionFeedback)
          .innerJoin(workSessionSubmissions, eq(workSessionSubmissions.id, workSessionFeedback.submissionId))
          .where(eq(workSessionFeedback.id, afterFeedbackId))
          .get();
        if (!anchor || anchor.feedback.workSessionId !== workSessionId) {
          // P2 #55: Anchor not found — fall back to latest feedback
          return getLatestFeedback(db, workSessionId);
        }

        const row = db.db
          .select({ feedback: workSessionFeedback })
          .from(workSessionFeedback)
          .innerJoin(workSessionSubmissions, eq(workSessionSubmissions.id, workSessionFeedback.submissionId))
          .where(
            and(
              eq(workSessionFeedback.workSessionId, workSessionId),
              sql`${workSessionSubmissions.submissionNumber} > ${anchor.submissionNumber}`,
            ),
          )
          .orderBy(desc(workSessionSubmissions.submissionNumber), desc(workSessionSubmissions.reviewEpoch), desc(workSessionFeedback.id))
          .limit(1)
          .get();

        return row ? rowToFeedback(row.feedback) : undefined;
      }

      return getLatestFeedback(db, workSessionId);
    },
  };
}

export type ReviewSubmissionStore = ReturnType<typeof createReviewSubmissionStore>;
