import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertAllowedPath, expandHomePath, isPathInsideRoot, resolveAllowedPath } from "./roots.js";

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
