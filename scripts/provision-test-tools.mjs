#!/usr/bin/env node
// Stage the npm-packaged ripgrep binary where Pi's tool adapter can find it.
// @vscode/ripgrep contains verified binaries for supported OS/architectures
// in its package tarball, so test setup never downloads executables at runtime.
import { copyFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rgPath } from "@vscode/ripgrep";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const executable = process.platform === "win32" ? "rg.exe" : "rg";
const destination = join(root, "node_modules", ".bin", executable);

function checkBinary(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} is missing at ${path}; run npm ci to install the pinned @vscode/ripgrep test dependency`);
  }
  const result = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status ?? "unknown"}`;
    throw new Error(`${label} could not run (${detail}); verify the npm package matches ${process.platform}/${process.arch}`);
  }
  return (result.stdout ?? "").trim().split(/\s+/)[0] ?? "ripgrep";
}

const version = checkBinary(rgPath, "Packaged ripgrep");
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(rgPath, destination);
if (process.platform !== "win32") chmodSync(destination, 0o755);
checkBinary(destination, "Provisioned ripgrep");
console.log(`test tools: provisioned ${version} at ${destination} (${process.platform}/${process.arch})`);
