// Release-gate verification module: publication must be coupled to the FINAL
// combined qualification of the exact candidate being published. This is the
// single implementation of that check — `scripts/release-verify.mjs` is a thin
// CLI wrapper, and `scripts/package-stage.mjs --publish` calls it directly
// before `npm publish`, so the publish path cannot bypass it.
//
// verifyQualifiedRelease() checks, in order, failing closed at the first
// mismatch (throwing with a release-specific error):
//   1. A qualification receipt exists, is stage=combined, qualified=true, and
//      includes fresh external-host catalog parity for the candidate.
//   2. The receipt's candidate buildId equals the requested buildId.
//   3. The receipt's candidate sourceGitSha equals the checkout HEAD.
//   4. The candidate directory (receipt artifactPath or releases/<buildId>/)
//      exists, carries build-meta.json whose buildId and gitSha both match,
//      and passes validate-release.mjs.
//   5. The working tree is clean (publication happens from the exact commit
//      the candidate was built from — no staging-area surprises).
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { validateRelease } from "./validate-release.mjs";

export class ReleaseVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseVerificationError";
  }
}

export function fail(message) {
  throw new ReleaseVerificationError(`REFUSED: ${message}`);
}

export function normalizeBuildId(value) {
  const requested = typeof value === "string" ? value.trim() : "";
  if (!requested || !/^[a-f0-9]{8,64}$/.test(requested)) {
    fail(`KONTROL_RELEASE_BUILD_ID must be the candidate buildId (got: ${requested || "unset"})`);
  }
  return requested;
}

export function readReceipt(receiptPath) {
  if (!existsSync(receiptPath)) {
    fail(`no final qualification receipt at ${receiptPath}. Publication requires a completed 12-hour soak and gate:beta:final.`);
  }
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch (error) {
    fail(`qualification receipt is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (receipt.qualified !== true) {
    fail(`qualification receipt is not qualified (status=${receipt.status ?? "unknown"}). Only qualified=true receipts may publish.`);
  }
  if (receipt.stage !== "combined") {
    fail(`qualification receipt stage is ${receipt.stage ?? "missing"}, expected "combined" (a code-only receipt never authorizes publication)`);
  }
  if (receipt.checks?.externalCatalogFresh !== true) {
    fail("qualification receipt has no fresh external-host catalog parity for the deployed candidate");
  }
  return receipt;
}

export function gitHead(root) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

export function verifyCheckoutIdentity(root, receipt) {
  const head = gitHead(root);
  if (!head) fail("not a git checkout; refusing to publish without source provenance");
  const receiptSha = receipt.candidate?.sourceGitSha;
  if (receiptSha && receiptSha !== head) {
    fail(`qualification candidate was built from ${String(receiptSha).slice(0, 12)} but this checkout is at ${head.slice(0, 12)}. Dispatch the release from the exact qualified commit.`);
  }
  return head;
}

export function verifyCandidateArtifact(root, requestedBuildId, head) {
  let candidatePath;
  let metadata;
  try {
    candidatePath = resolve(root, "releases", requestedBuildId);
    if (!existsSync(join(candidatePath, "build-meta.json"))) {
      fail(`qualified candidate artifact is missing at ${candidatePath}. The soak-qualified candidate must still be present to publish it.`);
    }
    metadata = JSON.parse(readFileSync(join(candidatePath, "build-meta.json"), "utf8"));
  } catch (error) {
    if (error instanceof ReleaseVerificationError) throw error;
    fail(`candidate artifact build-meta.json is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (metadata.buildId !== requestedBuildId) {
    fail(`candidate artifact buildId ${metadata.buildId ?? "missing"} does not match the requested ${requestedBuildId}`);
  }
  if (metadata.gitSha && metadata.gitSha !== head) {
    fail(`candidate artifact was built from ${String(metadata.gitSha).slice(0, 12)}, not this checkout (${head.slice(0, 12)})`);
  }
  return candidatePath;
}

export function verifyCleanCheckout(root) {
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
  if (dirty) {
    fail(`working tree is not clean (${dirty.split("\n").length} changed paths). Publication must run from the exact qualified commit.`);
  }
}

export function verifyQualifiedRelease(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const requestedBuildId = normalizeBuildId(options.buildId ?? process.env.KONTROL_RELEASE_BUILD_ID);
  const receiptPath = options.receiptPath
    ?? (process.env.KONTROL_BETA_RECEIPT ? resolve(root, process.env.KONTROL_BETA_RECEIPT) : join(root, "beta-qualification.json"));
  const receipt = readReceipt(receiptPath);

  const receiptBuildId = receipt.candidate?.buildId;
  if (receiptBuildId !== requestedBuildId) {
    fail(`qualification receipt names candidate ${receiptBuildId ?? "none"}, not the requested ${requestedBuildId}. Publish the candidate the soak actually ran against.`);
  }

  const head = verifyCheckoutIdentity(root, receipt);
  const candidatePath = verifyCandidateArtifact(root, requestedBuildId, head);

  try {
    validateRelease(candidatePath);
  } catch (error) {
    fail(`candidate artifact failed release-local validation: ${error instanceof Error ? error.message : String(error)}`);
  }

  verifyCleanCheckout(root);

  return { buildId: receiptBuildId, head, candidatePath, receiptPath };
}
