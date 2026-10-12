import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSnapshotTool } from "./pi-tools.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-read-snapshot-"));
try {
  const path = join(root, "report.txt");
  const original = Buffer.from("first\nsecond\nthird\n", "utf8");
  await writeFile(path, original);

  const response = await readFileSnapshotTool({ path, offset: 2, limit: 1 }, { cwd: root, root });
  assert.equal(response.isError, undefined);
  assert.equal(response.contentSha256, createHash("sha256").update(original).digest("hex"));
  assert.match(response.content.map((part) => part.type === "text" ? part.text : "").join("\n"), /second/);

  // Replacing the path after read completion cannot change the version paired
  // with the already-rendered bytes.
  await writeFile(path, "replacement\n");
  assert.notEqual(await readFile(path), original);
  assert.equal(response.contentSha256, createHash("sha256").update(original).digest("hex"));
  console.log("pi-tools-read-snapshot.test.ts: all assertions passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
