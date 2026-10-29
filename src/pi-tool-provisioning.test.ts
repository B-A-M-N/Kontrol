import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { delimiter, dirname } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import "./pi-tool-provisioning.js";

assert.equal(process.env.PI_OFFLINE, "1", "Pi's downloader is disabled after deterministic tool provisioning");
assert.ok(
  (process.env.PATH ?? "").split(delimiter).some((entry) => entry.toLowerCase() === dirname(rgPath).toLowerCase()),
  "the locked platform ripgrep binary is available through PATH before Pi creates its grep tool",
);
const result = spawnSync("rg", ["--version"], { encoding: "utf8", windowsHide: true });
assert.equal(result.error, undefined, result.error?.message);
assert.equal(result.status, 0, result.stderr);
assert.match(result.stdout ?? "", /^ripgrep /);

console.log("pi-tool-provisioning: locked ripgrep is available; runtime downloads are disabled");
