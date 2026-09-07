/** Canonical server/client representation of a review submission. */
export interface ReviewFile {
  path: string;
  previousPath?: string;
  type?: string;
  operation?: string;
  additions: number;
  removals: number;
}

/** P1 (audit): checkpoint-coverage record as surfaced to clients. Present and
 * nonempty exactly when this submission's diff cannot represent every
 * structured mutation the work session made. */
export interface ReviewCoverageDTO {
  backend: "git" | "filesystem";
  uncoveredPaths: string[];
  reasons: string[];
}

export interface ReviewSubmissionDTO {
  [key: string]: unknown;
  submissionId: string;
  sessionId: string;
  submissionNumber: number;
  reviewEpoch: number;
  status: string;
  diffSha256?: string;
  snapshotKind?: "git" | "filesystem";
  snapshotRef?: string;
  patch: string;
  files: ReviewFile[];
  fileCount: number;
  additions: number;
  removals: number;
  message?: string;
  createdAt?: string;
  /** P1 (audit): present ONLY when the submission's coverage is incomplete. */
  coverage?: ReviewCoverageDTO;
}
