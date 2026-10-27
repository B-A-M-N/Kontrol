import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync, renameSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { publishScheduledArtifact, recoverScheduledArtifactPublication } from "./scheduled-artifact-publisher.js";
import type { BoundedFileWriteOutputPolicy } from "./scheduled-job-store.js";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "kontrol-publisher-"));
}
function hash(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
function receipt_ok(r: any, msg: string): void {
  assert.equal(r.outcome, "committed", `${msg}: got ${r.outcome} ${r.reason ?? ""}`);
  assert.equal(r.readBackVerified, true, `${msg}: read-back must verify`);
}

const workspaceRoot = makeRoot();
const job = { jobId: "job-test", workSessionId: "ws-test", workspaceRoot, attemptNumber: 1 };

// 1. Create new file: committed, correct bytes, read-back verified.
{
  const content = Buffer.from("hello world\n");
  const policy: BoundedFileWriteOutputPolicy = { path: "Hello World.txt", operation: "create", overwrite: "deny" };
  const result = await publishScheduledArtifact({ ...job, path: "Hello World.txt", content, output: policy });
  receipt_ok(result, "create new file");
  assert.equal(readFileSync(join(workspaceRoot, "Hello World.txt"), "utf8"), "hello world\n");
  assert.equal(result.sha256, hash(content));
}

// 2. Deny overwrite: conflict, original bytes preserved.
{
  writeFileSync(join(workspaceRoot, "no-overwrite.txt"), "original\n");
  const policy: BoundedFileWriteOutputPolicy = { path: "no-overwrite.txt", operation: "create", overwrite: "deny" };
  const result = await publishScheduledArtifact({ ...job, path: "no-overwrite.txt", content: Buffer.from("replacement\n"), output: policy });
  assert.equal(result.outcome, "conflict");
  assert.equal(readFileSync(join(workspaceRoot, "no-overwrite.txt"), "utf8"), "original\n");
}

// 3. Replace with expected previous hash: committed.
{
  writeFileSync(join(workspaceRoot, "replace.txt"), "old\n");
  const policy: BoundedFileWriteOutputPolicy = { path: "replace.txt", operation: "replace", overwrite: "expected_hash", expectedPreviousSha256: hash("old\n") };
  const result = await publishScheduledArtifact({ ...job, path: "replace.txt", content: Buffer.from("new\n"), output: policy });
  receipt_ok(result, "replace with correct previous hash");
  assert.equal(readFileSync(join(workspaceRoot, "replace.txt"), "utf8"), "new\n");
}

// 4. Replace with wrong previous hash: conflict.
{
  writeFileSync(join(workspaceRoot, "wrong-hash.txt"), "current\n");
  const policy: BoundedFileWriteOutputPolicy = { path: "wrong-hash.txt", operation: "replace", overwrite: "expected_hash", expectedPreviousSha256: hash("stale\n") };
  const result = await publishScheduledArtifact({ ...job, path: "wrong-hash.txt", content: Buffer.from("attempted\n"), output: policy });
  assert.equal(result.outcome, "conflict");
  assert.equal(readFileSync(join(workspaceRoot, "wrong-hash.txt"), "utf8"), "current\n");
}

// 5. Wrong content hash: rejected.
{
  const policy: BoundedFileWriteOutputPolicy = { path: "bad-hash.txt", operation: "create", overwrite: "deny", expectedSha256: hash("expected\n") };
  const result = await publishScheduledArtifact({ ...job, path: "bad-hash.txt", content: Buffer.from("different\n"), output: policy });
  assert.equal(result.outcome, "rejected");
  assert.ok(result.reason?.includes("content_hash_mismatch"));
  assert.ok(!existsSync(join(workspaceRoot, "bad-hash.txt")));
}

// 6. Symlink escape: rejected.
{
  mkdirSync(join(workspaceRoot, "real-dir"), { recursive: true });
  symlinkSync(join(workspaceRoot, "real-dir"), join(workspaceRoot, "escape-link"));
  const policy: BoundedFileWriteOutputPolicy = { path: "escape-link/target.txt", operation: "create", overwrite: "deny" };
  const result = await publishScheduledArtifact({ ...job, path: "escape-link/target.txt", content: Buffer.from("outside\n"), output: policy });
  assert.equal(result.outcome, "rejected");
  assert.ok(result.reason?.includes("symlink_escape"));
  assert.ok(!existsSync(join(workspaceRoot, "real-dir", "target.txt")));
}

// 7. Path escape with ..: rejected.
{
  const policy: BoundedFileWriteOutputPolicy = { path: "../outside.txt", operation: "create", overwrite: "deny" };
  const result = await publishScheduledArtifact({ ...job, path: "../outside.txt", content: Buffer.from("outside\n"), output: policy });
  assert.equal(result.outcome, "rejected");
}

// 8. Publisher independently rejects a request/path policy mismatch.
{
  const policy: BoundedFileWriteOutputPolicy = { path: "authorized.txt", operation: "create", overwrite: "deny" };
  const result = await publishScheduledArtifact({ ...job, path: "unauthorized-sibling.txt", content: Buffer.from("not authorized\n"), output: policy });
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "path_policy_mismatch");
  assert.ok(!existsSync(join(workspaceRoot, "unauthorized-sibling.txt")));
}

// 9. Nested directory creation.
{
  const policy: BoundedFileWriteOutputPolicy = { path: "deep/nested/file.txt", operation: "create", overwrite: "deny" };
  const result = await publishScheduledArtifact({ ...job, path: "deep/nested/file.txt", content: Buffer.from("nested\n"), output: policy });
  receipt_ok(result, "nested create");
  assert.equal(readFileSync(join(workspaceRoot, "deep/nested/file.txt"), "utf8"), "nested\n");
}

// 10. Replace operation without existing file: conflict.
{
  const policy: BoundedFileWriteOutputPolicy = { path: "not-there.txt", operation: "replace", overwrite: "deny" };
  const result = await publishScheduledArtifact({ ...job, path: "not-there.txt", content: Buffer.from("x\n"), output: policy });
  assert.equal(result.outcome, "conflict");
}

// 11. Concurrent create cannot replace a winner, and only one publication commits.
{
  const path = "racing-create.txt";
  const output: BoundedFileWriteOutputPolicy = { path, operation: "create", overwrite: "deny" };
  const candidates = ["first writer\n", "second writer\n"];
  const results = await Promise.all(candidates.map((value) => publishScheduledArtifact({
    ...job,
    path,
    content: Buffer.from(value),
    output,
  })));
  assert.equal(results.filter((result) => result.outcome === "committed").length, 1);
  assert.equal(results.filter((result) => result.outcome === "conflict").length, 1);
  assert.ok(candidates.includes(readFileSync(join(workspaceRoot, path), "utf8")));
}

// 12. A destination appearing after the first check is never overwritten; intent and temp files are resolved.
{
  const path = "create-race-hook.txt";
  const output: BoundedFileWriteOutputPolicy = { path, operation: "create", overwrite: "deny" };
  let intent: Record<string, unknown> | undefined;
  let failure: { outcome: string; reason: string } | undefined;
  const result = await publishScheduledArtifact({
    ...job,
    path,
    content: Buffer.from("authorized bytes\n"),
    output,
    recordPublicationIntent: (value) => {
      intent = value;
      writeFileSync(join(workspaceRoot, path), "external winner\n");
    },
    recordPublicationReceipt: () => undefined,
    recordPublicationFailure: (_receiptId, outcome, reason) => { failure = { outcome, reason }; },
  });
  assert.equal(result.outcome, "conflict");
  assert.equal(readFileSync(join(workspaceRoot, path), "utf8"), "external winner\n");
  assert.equal(failure?.outcome, "conflict");
  assert.equal(readdirSync(workspaceRoot).some((name) => name.includes(".tmp-") || name.endsWith(".proof")), false);
  assert.ok(intent);
  assert.equal(await recoverScheduledArtifactPublication({
    jobId: job.jobId,
    workSessionId: job.workSessionId,
    workspaceRoot,
    attemptId: "attempt-1",
    attemptNumber: 1,
    intent: intent!,
  }), undefined, "matching output bytes without the publisher inode proof cannot recover a receipt");
}

// 13. A parent symlink swap after the directory is anchored cannot redirect publication outside the workspace.
{
  const root = makeRoot();
  const parent = join(root, "parent");
  const heldParent = join(root, "parent-held");
  const outside = makeRoot();
  mkdirSync(parent);
  const path = "parent/anchored.txt";
  const output: BoundedFileWriteOutputPolicy = { path, operation: "create", overwrite: "deny" };
  const result = await publishScheduledArtifact({
    ...job,
    workspaceRoot: root,
    path,
    content: Buffer.from("anchored\n"),
    output,
    recordPublicationIntent: () => {
      renameSync(parent, heldParent);
      symlinkSync(outside, parent);
    },
    recordPublicationReceipt: () => undefined,
    recordPublicationFailure: () => undefined,
  });
  if (process.platform === "linux") {
    receipt_ok(result, "parent symlink swap");
    assert.equal(readFileSync(join(heldParent, "anchored.txt"), "utf8"), "anchored\n");
  } else {
    // Non-Linux development runners do not have the Linux /proc/self/fd
    // directory anchor used by the production publisher. A race must fail
    // closed rather than follow the replacement symlink.
    assert.equal(result.outcome, "rejected", `unsupported platform race must fail closed: ${result.reason ?? ""}`);
    assert.equal(existsSync(join(heldParent, "anchored.txt")), false);
  }
  assert.equal(existsSync(join(outside, "anchored.txt")), false);
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

// 14. A receipt-store failure leaves durable intent and a same-inode proof for restart recovery.
{
  const root = makeRoot();
  const path = "recover-me.txt";
  const output: BoundedFileWriteOutputPolicy = { path, operation: "create", overwrite: "deny" };
  let intent: Record<string, unknown> | undefined;
  const result = await publishScheduledArtifact({
    ...job,
    workspaceRoot: root,
    path,
    content: Buffer.from("recoverable bytes\n"),
    output,
    attemptId: "attempt-recovery",
    attemptNumber: 2,
    runId: "run-recovery",
    dispatchIdempotencyKey: "dispatch-recovery",
    recordPublicationIntent: (value) => { intent = value; },
    recordPublicationReceipt: () => { throw new Error("simulated database write failure"); },
  });
  assert.equal(result.outcome, "rejected");
  assert.ok(existsSync(join(root, path)), "the destination was published before receipt persistence failed");
  assert.ok(intent && intent.state === "pending", "intent remains pending after database failure");
  const recovered = await recoverScheduledArtifactPublication({
    jobId: job.jobId,
    workSessionId: job.workSessionId,
    workspaceRoot: root,
    attemptId: "attempt-recovery",
    attemptNumber: 2,
    intent: intent!,
  });
  assert.equal(recovered?.outcome, "committed");
  assert.equal(recovered?.sha256, hash("recoverable bytes\n"));
  rmSync(root, { recursive: true, force: true });
}

rmSync(workspaceRoot, { recursive: true, force: true });
console.log("scheduled-artifact-publisher: all scenarios passed");
