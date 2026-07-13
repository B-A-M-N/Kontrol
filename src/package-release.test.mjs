import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";

const root = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), "kontrol-package-"));

try {
  execFileSync("npm", ["pack", "--pack-destination", tmp], {
    cwd: root,
    env: { ...process.env, npm_config_cache: join(tmp, "npm-cache") },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const packedFilename = readdirSync(tmp).find((name) => name.endsWith(".tgz"));
  assert.ok(packedFilename, "npm pack did not create a tarball");

  const tarball = join(tmp, packedFilename);
  extractTgz(tarball, tmp);
  const pkg = join(tmp, "package");
  const rootNodeModules = join(root, "node_modules");
  if (existsSync(rootNodeModules)) {
    symlinkSync(rootNodeModules, join(pkg, "node_modules"), "dir");
  }

  const shippedScripts = [
    "scripts/acp-crush-adapter.mjs",
    "scripts/acp-hermes-native-adapter.mjs",
    "scripts/acp-stdio-duplex-adapter.mjs",
    "scripts/mcp-stdio-bridge.mjs",
  ];

  for (const script of shippedScripts) {
    const source = await readFile(join(pkg, script), "utf8");
    assert.equal(
      source.includes("../src/"),
      false,
      `${script} imports from ../src, which is not shipped`,
    );
    execFileSync("node", [script, "--validate-imports"], {
      cwd: pkg,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  console.log("package-release.test.mjs: shipped adapter imports validated");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

function extractTgz(tarball, destination) {
  const buffer = gunzipSync(readFileSyncBuffer(tarball));
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    offset += 512;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (!name) break;
    const sizeOctal = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = sizeOctal ? Number.parseInt(sizeOctal, 8) : 0;
    const type = header[156];
    const outputPath = join(destination, name);
    if (type === 53) {
      mkdirSync(outputPath, { recursive: true });
    } else if (type === 48 || type === 0) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, buffer.subarray(offset, offset + size));
    }
    offset += Math.ceil(size / 512) * 512;
  }
}

function readFileSyncBuffer(path) {
  return readFileSync(path);
}
