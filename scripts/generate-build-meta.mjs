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

function getSchemaVersion() {
  try {
    const migrationFile = join(root, "src/db/migrations.ts");
    const source = readFileSync(migrationFile, "utf8");
    const versions = [...source.matchAll(/\{\s*version:\s*(\d+)\s*,/g)]
      .map((match) => Number(match[1]))
      .filter((version) => Number.isInteger(version));
    return versions.length > 0 ? Math.max(...versions) : 0;
  } catch {
    return Number(process.env.SCHEMA_VERSION) || 0;
  }
}

const schemaVersion = getSchemaVersion();
const releaseFormatVersion = Number(process.env.KONTROL_RELEASE_FORMAT_VERSION || 1);

const buildMeta = {
  version: getPackageVersion(),
  gitSha: getGitSha(),
  gitDirty: getGitDirty(),
  buildTimestamp: process.env.KONTROL_BUILD_TIMESTAMP || new Date().toISOString(),
  // contentSha256 identifies the executable/UI tree independently of source
  // provenance. Atomic builds use a separate buildId for the exact immutable
  // release, so metadata from a different source snapshot can never be
  // silently reused for identical output bytes.
  contentSha256: process.env.KONTROL_CONTENT_SHA256 || undefined,
  schemaHash: getSchemaHash(),
  // Older schemas are upgraded in place by the migration chain. Future
  // schemas are rejected fail-closed, so these bounds describe what this
  // artifact can actually open rather than promising downgrade support.
  schemaVersion,
  minReadableSchemaVersion: 0,
  maxReadableSchemaVersion: schemaVersion,
  schemaCompatibility: "upgrade-in-place; downgrade-via-versioned-backup",
  releaseFormatVersion,
  nodeVersion: process.version,
};
// build-atomic.mjs supplies the ID after the final candidate bytes are known.
// Keep the fallback for direct tooling/tests, but never emit a preliminary ID
// during an atomic build.
buildMeta.buildId = process.env.KONTROL_BUILD_ID || createHash("sha256")
  .update(JSON.stringify({
    version: buildMeta.version,
    gitSha: buildMeta.gitSha,
    gitDirty: buildMeta.gitDirty,
    schemaHash: buildMeta.schemaHash,
    schemaVersion: buildMeta.schemaVersion,
    minReadableSchemaVersion: buildMeta.minReadableSchemaVersion,
    maxReadableSchemaVersion: buildMeta.maxReadableSchemaVersion,
    schemaCompatibility: buildMeta.schemaCompatibility,
    releaseFormatVersion: buildMeta.releaseFormatVersion,
  }))
  .digest("hex")
  .slice(0, 16);

writeFileSync(join(distDir, "build-meta.json"), JSON.stringify(buildMeta, null, 2));
console.log("[build-identity]", JSON.stringify(buildMeta));
