import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const adapter = readFileSync("scripts/acp-stdio-duplex-adapter.mjs", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

assert.match(adapter, /dist\/acp-duplex\.js/);
assert.match(adapter, /createAcpDuplex/);
assert.match(adapter, /session\/request_permission|requestPermission/);
assert.match(adapter, /permission\.requested/);
assert.match(adapter, /approvals\/\$\{approvalId\}\/decision/);
assert.match(adapter, /ACP_STDIO_COMMAND/);
assert.match(adapter, /ACP_STDIO_DISPATCH_METHOD/);
assert.match(adapter, /duplex-json-rpc/);
assert.match(adapter, /reverse-permissions/);
assert.ok(adapter.includes("url.match(/^\\/runs\\/([^/]+)\\/cancel$/)"));
assert.match(adapter, /process\.kill\(-run\.child\.pid, "SIGTERM"\)/);

assert.ok(
  pkg.files.includes("scripts/acp-stdio-duplex-adapter.mjs"),
  "stdio duplex adapter is included in the published package",
);
assert.match(pkg.scripts.test, /acp-stdio-duplex-adapter\.mjs/);
assert.match(pkg.scripts.test, /acp-stdio-duplex-adapter\.test\.mjs/);

console.log("acp-stdio-duplex-adapter.test.mjs: all assertions passed");
