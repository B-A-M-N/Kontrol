// Release-gate verification CLI. The implementation lives in
// scripts/lib/release-verify.mjs so the publish path (package-stage --publish)
// and this command share one fail-closed check.
//
// Verifies, in order, failing loudly at the first mismatch:
//   1. beta-qualification.json exists, is stage=combined, qualified=true.
//   2. The receipt's candidate buildId equals KONTROL_RELEASE_BUILD_ID.
//   3. The receipt's candidate sourceGitSha equals the checkout HEAD.
//   4. The candidate artifact exists, its build-meta.json buildId and gitSha
//      both match, and it passes validate-release.mjs.
//   5. The working tree is clean (publication happens from the exact commit
//      the candidate was built from — no staging-area surprises).
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { ReleaseVerificationError, verifyQualifiedRelease } from "./lib/release-verify.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

try {
  const { buildId, head, candidatePath, receiptPath } = verifyQualifiedRelease({ root });
  console.log(`[release-verify] OK: ${buildId} from ${head.slice(0, 12)} is qualified (${receiptPath}); artifact=${candidatePath}`);
} catch (error) {
  if (error instanceof ReleaseVerificationError) {
    console.error(`[release-verify] ${error.message}`);
    process.exit(1);
  }
  throw error;
}
