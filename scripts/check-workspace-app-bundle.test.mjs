import assert from "node:assert/strict";
import { validateWorkspaceAppBundleSizes, WORKSPACE_APP_BUNDLE_LIMITS } from "./check-workspace-app-bundle.mjs";

const withinLimits = {
  workspaceAppRawBytes: WORKSPACE_APP_BUNDLE_LIMITS.workspaceAppRawBytes,
  workspaceAppGzipBytes: WORKSPACE_APP_BUNDLE_LIMITS.workspaceAppGzipBytes,
  smokeRawBytes: WORKSPACE_APP_BUNDLE_LIMITS.smokeRawBytes,
  smokeGzipBytes: WORKSPACE_APP_BUNDLE_LIMITS.smokeGzipBytes,
};
assert.equal(validateWorkspaceAppBundleSizes(withinLimits).passed, true, "exact size limits are accepted");
assert.equal(validateWorkspaceAppBundleSizes({ ...withinLimits, workspaceAppRawBytes: 8_000_001 }).passed, false);
assert.equal(validateWorkspaceAppBundleSizes({ ...withinLimits, smokeGzipBytes: 100_001 }).passed, false);
assert.equal(validateWorkspaceAppBundleSizes({ ...withinLimits, workspaceAppRawBytes: 0 }).passed, false);
console.log("check-workspace-app-bundle.test.mjs: size gate assertions passed");
