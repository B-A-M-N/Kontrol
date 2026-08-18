// P1 #51: Generate immutable build metadata at build time.
// This is run as part of the build pipeline so the running artifact
// can report its true identity (not the current working tree state).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = process.env.KONTROL_BUILD_OUTPUT_DIR
  ? resolve(root, process.env.KONTROL_BUILD_OUTPUT_DIR)
  : join(root, "dist");

function getGitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: root, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return process.env.GIT_SHA || "unknown";
  }
}

function getGitDirty() {
  try {
    const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", cwd: root, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return status ? status.split("\n").length : 0;
  } catch {
    return Number(process.env.GIT_DIRTY) || 0;
  }
}

function getPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return process.env.PACKAGE_VERSION || "0.0.0";
  }
}

function getSchemaHash() {
  try {
    const migrationsDir = join(root, "src/db/migrations");
    const hash = createHash("sha256");
    if (existsSync(migrationsDir)) {
      for (const f of readdirSync(migrationsDir).sort()) {
        const content = readFileSync(join(migrationsDir, f), "utf8");
        hash.update(f).update(content);
      }
    } else {
      const migrationFile = join(root, "src/db/migrations.ts");
      if (existsSync(migrationFile)) hash.update("migrations.ts").update(readFileSync(migrationFile, "utf8"));
    }
    return hash.digest("hex").slice(0, 12);
  } catch {
    return process.env.SCHEMA_HASH || "unknown";
  }
}

const buildMeta = {
  version: getPackageVersion(),
  gitSha: getGitSha(),
  gitDirty: getGitDirty(),
  buildTimestamp: new Date().toISOString(),
  schemaHash: getSchemaHash(),
  nodeVersion: process.version,
};
// The build ID is deterministic for a source/build generation.  Do not use
// the timestamp alone: a launcher must be able to prove that the process it
// reached is the artifact it just built.
buildMeta.buildId = createHash("sha256")
  .update(JSON.stringify({
    version: buildMeta.version,
    gitSha: buildMeta.gitSha,
    gitDirty: buildMeta.gitDirty,
    schemaHash: buildMeta.schemaHash,
  }))
  .digest("hex")
  .slice(0, 16);

writeFileSync(join(distDir, "build-meta.json"), JSON.stringify(buildMeta, null, 2));
console.log("[build-identity]", JSON.stringify(buildMeta));
