import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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
  const packedPackageJson = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
  assert.equal(packedPackageJson.name, "@b-a-m-n/kontrol", "package name changed unexpectedly");
  assert.equal(packedPackageJson.main, "dist/server.js", "package main must point at built server output");
  assert.equal(packedPackageJson.bin?.kontrol, "dist/cli.js", "kontrol bin must point at built CLI output");
  assert.ok(existsSync(join(pkg, "dist/server.js")), "packed package is missing dist/server.js");
  assert.ok(existsSync(join(pkg, "dist/cli.js")), "packed package is missing dist/cli.js");
  assert.ok(existsSync(join(pkg, "dist/acp-worker-token.mjs")), "packed package is missing dist/acp-worker-token.mjs");
  assert.equal(
    existsSync(join(pkg, "scripts/kontrol-acp-crush-adapter.service")),
    false,
    "fixed-path systemd units must not ship until service install generation exists",
  );
  assertUserFacingBranding(pkg);

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

function assertUserFacingBranding(pkg) {
  const checkedFiles = listFiles(pkg).filter((file) =>
    [
      ".env.example",
      "README.md",
      "package.json",
      "NOTICE",
      "docs",
    ].some((prefix) => file === prefix || file.startsWith(`${prefix}/`)),
  );

  for (const file of checkedFiles) {
    if (/\.(png|jpg|jpeg|gif|webp|ico)$/i.test(file)) continue;
    const text = readFileSync(join(pkg, file), "utf8");
    const withoutAttribution = removeAllowedAttribution(file, text);

    assert.equal(
      /Dev Desktop|devdesktop|dev desktop/.test(withoutAttribution),
      false,
      `${file} contains old Dev Desktop branding`,
    );
    assert.equal(
      /(^|[^A-Za-z])devspace([^A-Za-z]|$)/i.test(withoutAttribution),
      false,
      `${file} contains old DevSpace branding outside attribution`,
    );
    assert.equal(
      /OpenCollective|GitHub Sponsors|sponsor|funding|donate|buy me a coffee/i.test(text),
      false,
      `${file} contains funding/sponsor copy`,
    );
    assert.equal(
      /github\.com\/bamn\/kontrol/i.test(text),
      false,
      `${file} uses lowercase bamn GitHub owner; use B-A-M-N`,
    );
  }
}

function removeAllowedAttribution(file, text) {
  if (file === "NOTICE") return "";
  if (file !== "README.md") return text;
  return text.replace(/## Attribution[\s\S]*?(?=\n## |\n# |\s*$)/, "");
}

function listFiles(base, dir = "") {
  const out = [];
  for (const entry of readdirSync(join(base, dir))) {
    const rel = dir ? `${dir}/${entry}` : entry;
    const path = join(base, rel);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...listFiles(base, rel));
    else if (stat.isFile()) out.push(rel);
  }
  return out;
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
