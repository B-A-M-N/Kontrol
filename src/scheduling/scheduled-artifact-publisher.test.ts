import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { publishScheduledArtifact } from "./scheduled-artifact-publisher.js";
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

rmSync(workspaceRoot, { recursive: true, force: true });
console.log("scheduled-artifact-publisher: all scenarios passed");
