// Release-gate verification: publication must be coupled to the FINAL beta
// qualification of the exact candidate being published. This script is the
// single source of that check for the release workflow (and can be run
// locally before dispatching it).
//
// Verifies, in order, failing loudly at the first mismatch:
//   1. beta-qualification.json exists, is stage=combined, qualified=true.
//   2. The receipt's candidate buildId equals the requested buildId.
//   3. The receipt's candidate sourceGitSha equals the checkout HEAD.
//   4. releases/<buildId>/ exists, carries build-meta.json whose buildId and
//      gitSha both match, and passes validate-release.mjs.
//   5. The working tree is clean (publication happens from the exact commit
//      the candidate was built from — no staging-area surprises).
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fail = (message) => {
  console.error(`[release-verify] REFUSED: ${message}`);
  process.exit(1);
};

const requestedBuildId = process.env.KONTROL_RELEASE_BUILD_ID;
if (!requestedBuildId || !/^[a-f0-9]{8,64}$/.test(requestedBuildId)) {
  fail(`KONTROL_RELEASE_BUILD_ID must be the candidate buildId (got: ${requestedBuildId ?? "unset"})`);
}

const receiptPath = process.env.KONTROL_BETA_RECEIPT
  ? resolve(root, process.env.KONTROL_BETA_RECEIPT)
  : join(root, "beta-qualification.json");
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

const receiptBuildId = receipt.candidate?.buildId;
if (receiptBuildId !== requestedBuildId) {
  fail(`qualification receipt names candidate ${receiptBuildId ?? "none"}, not the requested ${requestedBuildId}. Publish the candidate the soak actually ran against.`);
}

const head = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
})();
if (!head) fail("not a git checkout; refusing to publish without source provenance");
const receiptSha = receipt.candidate?.sourceGitSha;
if (receiptSha && receiptSha !== head) {
  fail(`qualification candidate was built from ${String(receiptSha).slice(0, 12)} but this checkout is at ${head.slice(0, 12)}. Dispatch the release from the exact qualified commit.`);
}

const candidatePath = receipt.candidate?.artifactPath
  ? resolve(root, receipt.candidate.artifactPath)
  : join(root, "releases", requestedBuildId);
if (!existsSync(join(candidatePath, "build-meta.json"))) {
  fail(`qualified candidate artifact is missing at ${candidatePath}. The soak-qualified candidate must still be present to publish it.`);
}
const metadata = JSON.parse(readFileSync(join(candidatePath, "build-meta.json"), "utf8"));
if (metadata.buildId !== requestedBuildId) {
  fail(`candidate artifact buildId ${metadata.buildId ?? "missing"} does not match the requested ${requestedBuildId}`);
}
if (metadata.gitSha && metadata.gitSha !== head) {
  fail(`candidate artifact was built from ${String(metadata.gitSha).slice(0, 12)}, not this checkout (${head.slice(0, 12)})`);
}
execFileSync(process.execPath, [join(root, "scripts", "validate-release.mjs"), candidatePath], {
  cwd: root,
  stdio: "inherit",
});

const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
if (dirty) {
  fail(`working tree is not clean (${dirty.split("\n").length} changed paths). Publication must run from the exact qualified commit.`);
}

console.log(`[release-verify] OK: ${receiptBuildId} from ${head.slice(0, 12)} is qualified (${receiptPath}); artifact=${candidatePath}`);
