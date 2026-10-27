import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertAllowedPath, assertNoSymlinkComponentsSync, expandHomePath, isPathInsideRoot, resolveAllowedPath } from "./roots.js";

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

if (process.platform !== "win32") {
  const fixture = mkdtempSync(join(tmpdir(), "kontrol-root-alias-"));
  try {
    const physicalParent = join(fixture, "physical");
    const workspace = join(physicalParent, "workspace");
    const aliasParent = join(fixture, "alias");
    mkdirSync(workspace, { recursive: true });
    symlinkSync(physicalParent, aliasParent, "dir");
    const aliasedWorkspace = join(aliasParent, "workspace");
    assertNoSymlinkComponentsSync(join(aliasedWorkspace, "new-file.txt"), aliasedWorkspace);

    const outside = join(fixture, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(workspace, "escape"), "dir");
    assert.throws(
      () => assertNoSymlinkComponentsSync(join(aliasedWorkspace, "escape", "new-file.txt"), aliasedWorkspace),
      /Symlink path components are not permitted/,
      "trusted workspace roots may have an OS path alias, but child symlinks remain denied",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}
