import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};
const cliSource = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");

assert.match(
  cliSource,
  /KONTROL_AUTH_MODE === "tunnel" && process\.env\.KONTROL_ALLOWED_ROOTS\?\.trim\(\)/,
  "tunnel mode with environment-provided roots must not enter interactive setup",
);
assert.match(cliSource, /case "up":\s+runUp\(args\);/);
assert.match(cliSource, /const launcher = resolve\(process\.cwd\(\), "start-all\.sh"\);/);
assert.match(cliSource, /spawnSync\("bash", \[launcher\], \{ cwd: process\.cwd\(\), stdio: "inherit" \}\)/);
assert.match(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  /fs\.chmodSync\('dist\/cli\.js',0o755\)/,
  "the compiled CLI must remain executable for npm's global bin symlink",
);

for (const flag of ["-v", "--version"]) {
  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", flag], {
    encoding: "utf8",
    env: { ...process.env, KONTROL_CONFIG_DIR: "/tmp/kontrol-cli-version-test" },
  }).trim();

  assert.equal(output, packageJson.version);
}
