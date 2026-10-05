import assert from "node:assert/strict";
import { buildChildEnvironment } from "./process-environment.js";

const env = buildChildEnvironment({
  source: {
    PATH: "/bin",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    SystemDrive: "C:",
    SystemRoot: "C:\\Windows",
    windir: "C:\\Windows",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    PROJECT_FLAG: "visible only when opted in",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    KONTROL_ACP_WORKER_SECRET: "must not cross",
    HTTP_PROXY: "http://proxy.test",
  },
  additionalKeys: ["PROJECT_FLAG", "SSH_AUTH_SOCK", "HTTP_PROXY"],
});

assert.equal(env.PROJECT_FLAG, "visible only when opted in");
assert.equal(env.ComSpec, "C:\\Windows\\System32\\cmd.exe");
assert.equal(env.SystemDrive, "C:");
assert.equal(env.SystemRoot, "C:\\Windows");
assert.equal(env.windir, "C:\\Windows");
assert.equal(env.PATHEXT, ".COM;.EXE;.BAT;.CMD");
assert.equal(env.SSH_AUTH_SOCK, "/tmp/agent.sock");
assert.equal(env.HTTP_PROXY, "http://proxy.test");
assert.equal(env.KONTROL_ACP_WORKER_SECRET, undefined);

console.log("process-environment.test.ts: all assertions passed");
