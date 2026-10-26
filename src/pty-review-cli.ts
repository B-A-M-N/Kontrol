export type PtyReviewFeedbackStatus = "feedback_ready" | "transferred" | "timeout";

export type PtyReviewToolResult = { ok: true; receipt: Record<string, unknown> }
  | { ok: false; error: string };

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function diagnostic(result: unknown, fallback: string): string {
  const value = objectValue(result);
  const blocks = Array.isArray(value?.content) ? value.content : [];
  const text = blocks.flatMap((block) => {
    const entry = objectValue(block);
    return typeof entry?.text === "string" && entry.text.length > 0 ? [entry.text] : [];
  }).join("\n");
  return text || fallback;
}

export function readPtyReviewSubmission(result: unknown): PtyReviewToolResult {
  const value = objectValue(result);
  const receipt = objectValue(value?.structuredContent);
  if (value?.isError === true || !receipt
    || typeof receipt.submissionId !== "string" || typeof receipt.status !== "string") {
    return { ok: false, error: diagnostic(result, "submit_for_review returned an invalid response") };
  }
  return { ok: true, receipt };
}

export function readPtyReviewFeedback(result: unknown): PtyReviewToolResult & { status?: PtyReviewFeedbackStatus } {
  const value = objectValue(result);
  const receipt = objectValue(value?.structuredContent);
  const status = receipt?.status;
  if (value?.isError === true || !receipt
    || !["feedback_ready", "transferred", "timeout", "error"].includes(String(status))) {
    return { ok: false, error: diagnostic(result, "await_review_feedback returned an invalid response") };
  }
  if (status === "error") {
    return { ok: false, error: typeof receipt.message === "string" ? receipt.message : "await_review_feedback failed" };
  }
  return { ok: true, status: status as PtyReviewFeedbackStatus, receipt };
}
