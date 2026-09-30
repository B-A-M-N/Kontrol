import { readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const WORKSPACE_APP_BUNDLE_LIMITS = Object.freeze({
  workspaceAppRawBytes: 8_000_000,
  workspaceAppGzipBytes: 2_000_000,
  smokeRawBytes: 400_000,
  smokeGzipBytes: 100_000,
});

export function validateWorkspaceAppBundleSizes(sizes) {
  const failures = [];
  for (const [key, limit] of Object.entries(WORKSPACE_APP_BUNDLE_LIMITS)) {
    const value = sizes?.[key];
    if (!Number.isSafeInteger(value) || value < 1) failures.push(`${key} must be a positive safe integer`);
    else if (value > limit) failures.push(`${key} ${value} exceeds limit ${limit}`);
  }
  return {
    passed: failures.length === 0,
    failures,
    reductionTargetBytes: WORKSPACE_APP_BUNDLE_LIMITS.workspaceAppRawBytes,
    reductionTargetMet: Number.isSafeInteger(sizes?.workspaceAppRawBytes)
      && sizes.workspaceAppRawBytes <= WORKSPACE_APP_BUNDLE_LIMITS.workspaceAppRawBytes,
  };
}

function measure(path) {
  const text = readFileSync(path);
  const rawBytes = statSync(path).size;
  return { rawBytes, gzipBytes: gzipSync(text, { level: 9 }).byteLength };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDirectory = resolve(process.env.KONTROL_BUILD_OUTPUT_DIR ?? join(root, "dist"));
  const uiDirectory = join(outputDirectory, "ui");
  const app = measure(join(uiDirectory, "workspace-app.html"));
  const smoke = measure(join(uiDirectory, "workspace-app-smoke.html"));
  const sizes = {
    workspaceAppRawBytes: app.rawBytes,
    workspaceAppGzipBytes: app.gzipBytes,
    smokeRawBytes: smoke.rawBytes,
    smokeGzipBytes: smoke.gzipBytes,
  };
  const result = validateWorkspaceAppBundleSizes(sizes);
  console.log(`[workspace-app-bundle] app=${app.rawBytes} bytes (${app.gzipBytes} gzip); target<=${result.reductionTargetBytes} ${result.reductionTargetMet ? "met" : "missed"}`);
  console.log(`[workspace-app-bundle] smoke=${smoke.rawBytes} bytes (${smoke.gzipBytes} gzip)`);
  if (!result.passed) {
    for (const failure of result.failures) console.error(`[workspace-app-bundle] ${failure}`);
    process.exitCode = 1;
  }
}
