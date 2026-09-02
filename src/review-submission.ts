/** Canonical server/client representation of a review submission. */
export interface ReviewFile {
  path: string;
  previousPath?: string;
  type?: string;
  operation?: string;
  additions: number;
  removals: number;
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
}
