import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFilesTool } from "./pi-tools.js";

const root = await mkdtemp(join(tmpdir(), "kontrol-find-compat-"));
try {
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, "nested", "hello.txt"), "workspace fixture\n");

  const response = await findFilesTool({ pattern: "*.txt" }, { cwd: root, root });
  const output = response.content.map((part) => part.type === "text" ? part.text : "").join("\n");
  assert.equal(response.isError, undefined, output);
  assert.match(output, /nested\/hello\.txt/);
  console.log("pi-tools-find.test.ts: all assertions passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
