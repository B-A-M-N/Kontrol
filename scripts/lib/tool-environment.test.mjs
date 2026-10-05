import assert from "node:assert/strict";
import { buildToolEnvironment } from "./tool-environment.mjs";

const windowsEnv = buildToolEnvironment({
  Path: "C:\\Windows\\System32;C:\\Program Files\\nodejs",
  ComSpec: "C:\\Windows\\System32\\cmd.exe",
  SystemDrive: "C:",
  SystemRoot: "C:\\Windows",
  windir: "C:\\Windows",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  KONTROL_CHILD_ENV_ALLOWLIST: "must-not-cross",
}, { platform: "win32" });

assert.equal(windowsEnv.Path, "C:\\Windows\\System32;C:\\Program Files\\nodejs");
assert.equal(windowsEnv.ComSpec, "C:\\Windows\\System32\\cmd.exe");
assert.equal(windowsEnv.SystemDrive, "C:");
assert.equal(windowsEnv.SystemRoot, "C:\\Windows");
assert.equal(windowsEnv.windir, "C:\\Windows");
assert.equal(windowsEnv.PATHEXT, ".COM;.EXE;.BAT;.CMD");
assert.equal(windowsEnv.KONTROL_CHILD_ENV_ALLOWLIST, undefined);

const posixEnv = buildToolEnvironment({ PATH: "/usr/bin", Path: "/should/not/pass" }, { platform: "linux" });
assert.equal(posixEnv.PATH, "/usr/bin");
assert.equal(posixEnv.Path, undefined, "POSIX environment variable names remain case-sensitive");

console.log("tool-environment.test.mjs: cross-platform allowlist assertions passed");
