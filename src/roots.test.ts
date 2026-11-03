import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertAllowedPath,
  expandHomePath,
  isPathInsideRoot,
  resolveAllowedPath,
  resolveAllowedPathCanonical,
} from "./roots.js";

const home = homedir();

assert.equal(expandHomePath("~"), home);
assert.equal(expandHomePath("~/personal/kontrol"), resolve(home, "personal", "kontrol"));
assert.equal(expandHomePath("~user/project"), "~user/project");
assert.equal(expandHomePath("$HOME/project"), "$HOME/project");

assert.equal(
  assertAllowedPath("~/personal/kontrol", [join(home, "personal")]),
  resolve(home, "personal", "kontrol"),
);

assert.equal(
  assertAllowedPath("~/personal/kontrol", ["~/personal"]),
  resolve(home, "personal", "kontrol"),
);

assert.equal(
  resolveAllowedPath("~/file.txt", "/workspace", ["/workspace"]),
  resolve("/workspace", "~/file.txt"),
);

assert.equal(isPathInsideRoot("/workspace/..cache", "/workspace"), true, "a child named ..cache is inside the root");
assert.equal(isPathInsideRoot("/workspace/..", "/workspace"), false, "an exact parent component escapes");
assert.equal(isPathInsideRoot("/workspace/sub/..foo", "/workspace"), true, "a nested child named ..foo is inside");
assert.equal(isPathInsideRoot("/outside/file", "/workspace"), false, "unrelated absolute path escapes");

if (process.platform === "win32") {
  assert.throws(
    () => assertAllowedPath("C:\\Users\\Administrator", ["G:\\Projects\\Dev\\Github\\kontrol"]),
    /Path is outside allowed roots/,
  );
}

// Canonical resolver: symlink containment plus ancestor-walk writes.
{
  const root = mkdtempSync(join(tmpdir(), "roots-ws-"));
  const outside = mkdtempSync(join(tmpdir(), "roots-out-"));
  writeFileSync(join(outside, "secret.txt"), "secret");
  mkdirSync(join(root, "sub"));
  symlinkSync(join(outside, "secret.txt"), join(root, "linked.txt"));
  symlinkSync(outside, join(root, "linked-dir"));
  symlinkSync(join(root, "sub"), join(root, "back-inside"));

  await assert.rejects(
    resolveAllowedPathCanonical("linked.txt", root, [root]),
    /Symlink path components are not permitted/,
    "symlink file component escaping the root is rejected",
  );
  await assert.rejects(
    resolveAllowedPathCanonical("linked-dir/secret.txt", root, [root]),
    /Symlink path components are not permitted/,
    "symlink directory component escaping the root is rejected",
  );
  await assert.rejects(
    resolveAllowedPathCanonical("back-inside/file.txt", root, [root]),
    /Symlink path components are not permitted/,
    "symlinks pointing back inside the root are still rejected",
  );
  await assert.rejects(
    resolveAllowedPathCanonical("../outside.txt", root, [root]),
    /outside allowed roots|Cannot resolve a writable path/,
    "parent-directory escape is rejected",
  );

  const fresh = await resolveAllowedPathCanonical("sub/new-file.txt", root, [root]);
  assert.equal(fresh, resolve(root, "sub", "new-file.txt"), "new nested file resolves under the root");
  const direct = await resolveAllowedPathCanonical("sub", root, [root]);
  assert.equal(direct, resolve(root, "sub"), "existing directory canonicalizes inside the root");
}
