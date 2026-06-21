import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch, parsePatch } from "./apply-patch.js";

const root = await mkdtemp(join(tmpdir(), "devspace-apply-patch-"));
await writeFile(join(root, "alpha.txt"), "one\ntwo\nthree\n");
await writeFile(join(root, "remove.txt"), "remove me\n");
await writeFile(join(root, "windows.txt"), "first\r\nsecond\r\n");

const result = await applyPatch(
  root,
  `*** Begin Patch
*** Add File: nested/added.txt
+new
+file
*** Update File: alpha.txt
@@
 one
-two
+changed
 three
*** Update File: windows.txt
@@
 first
-second
+updated
*** Delete File: remove.txt
*** End Patch`,
);

assert.deepEqual(result.files, [
  { path: "nested/added.txt", operation: "add" },
  { path: "alpha.txt", operation: "update" },
  { path: "windows.txt", operation: "update" },
  { path: "remove.txt", operation: "delete" },
]);
assert.equal(await readFile(join(root, "nested/added.txt"), "utf8"), "new\nfile\n");
assert.equal(await readFile(join(root, "alpha.txt"), "utf8"), "one\nchanged\nthree\n");
assert.equal(await readFile(join(root, "windows.txt"), "utf8"), "first\r\nupdated\r\n");
await assert.rejects(readFile(join(root, "remove.txt"), "utf8"), /ENOENT/);

const moveResult = await applyPatch(
  root,
  `*** Begin Patch
*** Update File: alpha.txt
*** Move to: moved/alpha.txt
@@
-one
+ONE
 changed
*** End Patch`,
);
assert.deepEqual(moveResult.files, [
  { path: "moved/alpha.txt", previousPath: "alpha.txt", operation: "move" },
]);
assert.equal(await readFile(join(root, "moved/alpha.txt"), "utf8"), "ONE\nchanged\nthree\n");
await assert.rejects(readFile(join(root, "alpha.txt"), "utf8"), /ENOENT/);

await assert.rejects(
  applyPatch(
    root,
    `*** Begin Patch
*** Add File: ../escape.txt
+no
*** End Patch`,
  ),
  /path escapes the workspace/,
);

const outside = await mkdtemp(join(tmpdir(), "devspace-apply-patch-outside-"));
await symlink(outside, join(root, "outside-link"));
await assert.rejects(
  applyPatch(
    root,
    `*** Begin Patch
*** Add File: outside-link/escape.txt
+no
*** End Patch`,
  ),
  /path resolves outside the workspace/,
);

await assert.rejects(
  applyPatch(
    root,
    `*** Begin Patch
*** Update File: moved/alpha.txt
@@
-not present
+replacement
*** End Patch`,
  ),
  /could not find hunk context/,
);
assert.equal(await readFile(join(root, "moved/alpha.txt"), "utf8"), "ONE\nchanged\nthree\n");

assert.throws(() => parsePatch("*** Begin Patch\n*** End Patch"), /contains no file actions/);
assert.throws(() => parsePatch("*** Add File: bad.txt\n+x"), /missing .* marker/);
