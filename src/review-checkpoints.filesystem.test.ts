import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewCheckpointManager } from "./review-checkpoints.js";

const root = mkdtempSync(join(tmpdir(), "kontrol-review-fs-"));
const storeRoot = mkdtempSync(join(tmpdir(), "kontrol-review-fs-store-"));
const outside = mkdtempSync(join(tmpdir(), "kontrol-review-fs-outside-"));
writeFileSync(join(outside, "secret.txt"), "must not be captured through the link\n");
mkdirSync(join(root, "nested"));
writeFileSync(join(root, "tracked.txt"), "before\n");
symlinkSync(join(outside, "secret.txt"), join(root, "external-link"));

const manager = createReviewCheckpointManager({ snapshotStoreRoot: storeRoot });
const workspaceId = "plain-workspace";
const info = await manager.getSnapshotInfo({ workspaceId, root });
assert.deepEqual(info, { kind: "filesystem", available: true, diagnostic: undefined });
const baseline = await manager.reviewChanges({ workspaceId, root, since: "workspace_open", markReviewed: false });
assert.equal(baseline.snapshotKind, "filesystem");
assert.match(baseline.snapshotRef, /^fs:sha256:[a-f0-9]{64}$/);

writeFileSync(join(root, "tracked.txt"), "after\nline two\n");
writeFileSync(join(root, "added.txt"), "new\n");
writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
writeFileSync(join(root, "large.txt"), "x".repeat(200_000));

const sessionDiff = await manager.reviewChangesAgainstSnapshot({ workspaceId, root, baseline: baseline.snapshot });
assert.deepEqual(sessionDiff.files.map((file) => file.path), ["added.txt", "binary.bin", "large.txt", "tracked.txt"]);
assert.ok(sessionDiff.files.every((file) => file.type === "new" || file.type === "change"));
assert.match(sessionDiff.patch, /Binary files a\/binary\.bin and b\/binary\.bin differ/);
assert.match(sessionDiff.patch, /filesystem diff truncated|old file truncated|new file truncated/);
assert.ok(sessionDiff.summary.files >= 4);

const sessionBaseline = await manager.reviewChanges({ workspaceId, root, since: "work_session", workSessionId: "session-a", markReviewed: false });
await manager.commitReviewedSnapshot({ workspaceId, root, workSessionId: "session-a", snapshot: sessionBaseline.snapshot });
assert.equal(await manager.assertSnapshotMatches({ workspaceId, root, expected: sessionBaseline.snapshot }), true);
writeFileSync(join(root, "tracked.txt"), "later\n");
assert.equal(await manager.assertSnapshotMatches({ workspaceId, root, expected: sessionBaseline.snapshot }), false);

await manager.commitReviewedSnapshot({ workspaceId, root, workSessionId: "session-a", snapshot: await manager.reviewChanges({ workspaceId, root, since: "work_session", workSessionId: "session-a", markReviewed: false }).then((result) => result.snapshot) });
await import("node:fs/promises").then(({ rm }) => rm(join(root, "added.txt")));
const deletion = await manager.reviewChanges({ workspaceId, root, since: "work_session", workSessionId: "session-a", markReviewed: false });
assert.equal(deletion.files.find((file) => file.path === "added.txt")?.type, "deleted");

const materialized = mkdtempSync(join(tmpdir(), "kontrol-review-fs-materialized-"));
await manager.materializeSnapshot({ workspaceId, root, snapshot: sessionDiff.snapshot, destination: materialized });
assert.equal(await readFile(join(materialized, "tracked.txt"), "utf8"), "after\nline two\n");
assert.equal((await stat(join(materialized, "external-link"))).isFile(), true);

console.log("review-checkpoints.filesystem: all assertions passed");
