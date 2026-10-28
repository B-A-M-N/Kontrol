import { closeSync, constants, fsyncSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export type PtyReviewFeedbackStatus = "feedback_ready" | "transferred" | "timeout";

export type PtyReviewToolResult = { ok: true; receipt: Record<string, unknown> }
  | { ok: false; error: string };

export function readPtyReviewMutationId(args: string[]): { ok: true; clientMutationId?: string } | { ok: false; error: string } {
  const indexes = args.flatMap((argument, index) => argument === "--client-mutation-id" ? [index] : []);
  if (indexes.length === 0) return { ok: true };
  if (indexes.length > 1) return { ok: false, error: "--client-mutation-id may be specified only once." };
  const index = indexes[0]!;
  const clientMutationId = args[index + 1];
  if (!clientMutationId || clientMutationId.startsWith("--") || clientMutationId.length > 200) {
    return { ok: false, error: "--client-mutation-id requires a 1–200 character value." };
  }
  return { ok: true, clientMutationId };
}

function syncDirectory(path: string): void {
  // Windows does not expose a syncable directory descriptor through Node.
  if (process.platform === "win32") return;
  const descriptor = openSync(path, constants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function readPrivateIntent(path: string): string {
  const stats = lstatSync(path);
  // Node's mode bits do not expose Windows ACL permissions; keep the type and
  // symlink checks on every platform, and enforce POSIX privacy where visible.
  const modeIsPrivate = process.platform === "win32" || (stats.mode & 0o077) === 0;
  if (!stats.isFile() || stats.isSymbolicLink() || !modeIsPrivate) {
    throw new Error("PTY review submission intent is not a private regular file.");
  }
  const value = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("PTY review submission intent is malformed; preserve it for safe reconciliation.");
  }
  return value;
}

export function readPtyReviewMutationIntent(path: string): string | undefined {
  try { return readPrivateIntent(path); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Persist the retry key before the first MCP call so a restarted PTY command
 * can replay the same logical submission after losing its response. */
export function getOrCreatePtyReviewMutationId(path: string): string {
  const existing = readPtyReviewMutationIntent(path);
  if (existing) return existing;

  const directory = dirname(path);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const value = randomUUID();
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(descriptor, `${value}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      // A hard link gives atomic create-if-absent semantics without replacing
      // another concurrent PTY command's pending identity.
      linkSync(temporaryPath, path);
      syncDirectory(directory);
      return value;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      return readPrivateIntent(path);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    unlinkSync(temporaryPath);
  }
}

/** Clear only the identity whose authoritative submission receipt was received. */
export function completePtyReviewMutationId(path: string, expected: string): void {
  const current = readPrivateIntent(path);
  if (current !== expected) throw new Error("PTY review submission intent changed before receipt cleanup.");
  unlinkSync(path);
  syncDirectory(dirname(path));
}

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
