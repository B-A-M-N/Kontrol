import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_FORMAT_VERSION = 4;
const DEFAULT_GRACE_MS = 30 * 24 * 60 * 60 * 1_000;

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function hashTree(directory, hash, relativeDirectory = "") {
  for (const entry of readdirSync(directory).sort()) {
    const absolute = join(directory, entry);
    const relative = join(relativeDirectory, entry);
    if (relative === "build-meta.json") continue;
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) throw new Error(`release contains a symlink and cannot be verified: ${absolute}`);
    if (info.isDirectory()) hashTree(absolute, hash, relative);
    else if (info.isFile()) hash.update(relative).update(readFileSync(absolute));
    else throw new Error(`release contains an unsupported filesystem entry: ${absolute}`);
  }
}

export function verifyReleaseArtifact(path) {
  const artifactPath = resolve(path);
  try {
    const info = lstatSync(artifactPath);
    if (!info.isDirectory()) return { ok: false, reason: "not a directory" };
    const metadata = readJson(join(artifactPath, "build-meta.json"));
    if (!metadata || typeof metadata.buildId !== "string" || typeof metadata.contentSha256 !== "string"
      || !/^[a-f0-9]{16,64}$/.test(metadata.contentSha256) || !existsSync(join(artifactPath, "cli.js"))) {
      return { ok: false, reason: "missing or invalid build metadata/cli" };
    }
    const hash = createHash("sha256").update(`kontrol-release-format:${RELEASE_FORMAT_VERSION}\n`);
    hashTree(artifactPath, hash);
    const actual = hash.digest("hex").slice(0, 16);
    if (actual !== metadata.contentSha256) return { ok: false, reason: `content hash mismatch (${actual})` };
    return { ok: true, buildId: metadata.buildId, contentSha256: actual, artifactPath };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function collectArtifactReferences(value, retained, prefix = "record") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectArtifactReferences(entry, retained, `${prefix}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && /artifact(path)?/i.test(key)) retained.set(resolve(entry), `${prefix}.${key}`);
    else if (entry && typeof entry === "object") collectArtifactReferences(entry, retained, `${prefix}.${key}`);
  }
}

function readProtectedReferences(stateDir) {
  const retained = new Map();
  let referenceUnknown = false;
  for (const name of ["generation.json", "service.json"]) {
    const path = join(stateDir, name);
    if (!existsSync(path)) continue;
    const record = readJson(path);
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      referenceUnknown = true;
      continue;
    }
    collectArtifactReferences(record, retained, name);
  }
  let journalUnknown = false;
  try {
    for (const name of readdirSync(stateDir)) {
      if (!/^deployment\..+\.json$/.test(name)) continue;
      const journal = readJson(join(stateDir, name));
      if (!journal) { journalUnknown = true; continue; }
      const stage = journal.stage ?? journal.status;
      if (stage !== "commit" && stage !== "committed" && stage !== "failed" && stage !== "rolled_back") {
        collectArtifactReferences(journal, retained, name);
      }
    }
  } catch {
    journalUnknown = true;
  }
  return { retained, journalUnknown, referenceUnknown };
}

function assertOwnedDeploymentLock(stateDir, token) {
  if (typeof token !== "string" || token.length < 8) {
    throw new Error("release cleanup apply requires the deployment-lock token owned by this process");
  }
  const record = readJson(join(stateDir, "deployment.lock"));
  if (!record || record.token !== token || record.pid !== process.pid
    || typeof record.processStartToken !== "string") {
    throw new Error("release cleanup requires a live deployment lock owned by this process");
  }
  let live = false;
  try { process.kill(process.pid, 0); live = true; } catch { /* not live */ }
  if (!live) throw new Error("release cleanup deployment-lock owner is no longer live");
  if (!record.processStartToken.startsWith("started:")) {
    try {
      const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      const startToken = `proc:${fields[19]}`;
      if (record.processStartToken !== startToken) throw new Error("release cleanup deployment lock belongs to a stale process generation");
    } catch (error) {
      if (error instanceof Error && error.message.includes("stale process generation")) throw error;
      throw new Error("release cleanup cannot verify deployment-lock process identity");
    }
  }
}

function withinRoot(root, path) {
  const absolute = resolve(path);
  return absolute === root || absolute.startsWith(`${root}${sep}`);
}

/** Build a conservative dry-run manifest. Unverified artifacts are retained. */
export function planReleaseRetention(options) {
  const releasesRoot = resolve(options.releasesRoot);
  const stateDir = resolve(options.stateDir);
  const now = options.now ?? Date.now();
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error("graceMs must be a nonnegative finite number");
  const { retained, journalUnknown, referenceUnknown } = readProtectedReferences(stateDir);
  const entries = readdirSync(releasesRoot, { withFileTypes: true });
  const releases = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = resolve(releasesRoot, entry.name);
    if (!withinRoot(releasesRoot, path) || lstatSync(path).isSymbolicLink()) continue;
    const verification = verifyReleaseArtifact(path);
    const referencedBy = [...retained.entries()].filter(([reference]) => resolve(reference) === path).map(([, reason]) => reason);
    const ageMs = Math.max(0, now - statSync(path).mtimeMs);
    const reasons = [];
    if (referenceUnknown) reasons.push("active deployment reference state is unreadable");
    if (journalUnknown) reasons.push("deployment journal state is unreadable");
    if (referencedBy.length) reasons.push(...referencedBy);
    if (!verification.ok) reasons.push(`artifact unverified: ${verification.reason}`);
    if (ageMs < graceMs) reasons.push("within retention grace period");
    releases.push({
      path,
      buildId: verification.buildId ?? entry.name,
      verified: verification.ok,
      ageMs,
      action: reasons.length ? "retain" : "delete",
      reasons,
    });
  }
  return {
    releasesRoot,
    stateDir,
    generatedAt: new Date(now).toISOString(),
    graceMs,
    dryRun: true,
    retained: releases.filter((entry) => entry.action === "retain"),
    deletable: releases.filter((entry) => entry.action === "delete"),
  };
}

/** Revalidate each candidate before deletion; dry-run is the default. */
export function executeReleaseRetentionPlan(plan, options = {}) {
  const apply = options.apply === true;
  if (!apply) return { dryRun: true, deleted: [], manifest: plan };
  assertOwnedDeploymentLock(plan.stateDir, options.deploymentLockToken);
  const deleted = [];
  const refreshed = planReleaseRetention({
    releasesRoot: plan.releasesRoot,
    stateDir: plan.stateDir,
    now: Date.now(),
    graceMs: plan.graceMs,
  });
  const currentlyDeletable = new Map(refreshed.deletable.map((entry) => [resolve(entry.path), entry]));
  for (const candidate of plan.deletable ?? []) {
    assertOwnedDeploymentLock(plan.stateDir, options.deploymentLockToken);
    const root = resolve(plan.releasesRoot);
    const path = resolve(candidate.path);
    if (!withinRoot(root, path) || path === root) throw new Error(`refusing release cleanup outside the releases root: ${path}`);
    const current = currentlyDeletable.get(path);
    if (!current || current.buildId !== candidate.buildId) {
      throw new Error(`release changed after retention planning; refusing deletion: ${path}`);
    }
    rmSync(path, { recursive: true, force: false });
    deleted.push(path);
  }
  return { dryRun: false, deleted, manifest: plan };
}

/**
 * Check real free space against the operation size and observed state. The
 * reserve scales with existing state/release footprint, so large databases do
 * not receive a misleading fixed 100 MB allowance.
 */
export function assertDiskHeadroom(options) {
  const path = resolve(options.path);
  const requiredBytes = options.requiredBytes;
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) throw new Error("requiredBytes must be a nonnegative safe integer");
  const stateBytes = options.stateDir ? directoryBytes(resolve(options.stateDir)) : 0;
  const releasesBytes = options.releasesRoot ? directoryBytes(resolve(options.releasesRoot)) : 0;
  const footprint = stateBytes + releasesBytes;
  const reserveBytes = Math.max(options.minimumReserveBytes ?? 512 * 1024 * 1024, Math.ceil(footprint * (options.reserveFraction ?? 0.05)));
  const fs = statfsSync(path);
  const availableBytes = fs.bavail * fs.bsize;
  const neededBytes = requiredBytes + reserveBytes;
  if (availableBytes < neededBytes) {
    throw new Error(`Insufficient disk headroom at ${path}: need ${neededBytes} bytes (${requiredBytes} operation + ${reserveBytes} reserve), have ${availableBytes}.`);
  }
  return { path, availableBytes, requiredBytes, reserveBytes, neededBytes, footprintBytes: footprint };
}

export function directoryBytes(path) {
  if (!existsSync(path)) return 0;
  const rootInfo = lstatSync(path);
  if (rootInfo.isSymbolicLink()) return 0;
  if (rootInfo.isFile()) return rootInfo.size;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += directoryBytes(child);
    else if (entry.isFile()) total += statSync(child).size;
  }
  return total;
}

export { DEFAULT_GRACE_MS };

function cliValue(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function runCli() {
  const releasesRoot = cliValue("--releases-root");
  const stateDir = cliValue("--state-dir");
  if (!releasesRoot || !stateDir) {
    throw new Error("Usage: node scripts/lib/release-retention.mjs --releases-root PATH --state-dir PATH [--grace-days N] [--apply --deployment-lock-token TOKEN]");
  }
  const graceDays = Number(cliValue("--grace-days") ?? 30);
  if (!Number.isFinite(graceDays) || graceDays < 0) throw new Error("--grace-days must be a nonnegative number");
  const plan = planReleaseRetention({ releasesRoot, stateDir, graceMs: graceDays * 24 * 60 * 60 * 1_000 });
  const result = executeReleaseRetentionPlan(plan, {
    apply: process.argv.includes("--apply"),
    deploymentLockToken: cliValue("--deployment-lock-token"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runCli(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
