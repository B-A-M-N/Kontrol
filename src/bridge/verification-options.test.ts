import assert from "node:assert/strict";
import { missionVerificationOptionsFromConfig } from "./verification-options.js";
import { loadConfig } from "../config.js";

// Sandbox-enabled and disabled configurations map to identical verification
// options at both entry points; this prevents future drift between the
// manual reviewer path and the supervised ACP path.
const enabled = missionVerificationOptionsFromConfig(loadConfig({
  KONTROL_OAUTH_OWNER_TOKEN: "test-owner-token",
  KONTROL_ALLOWED_ROOTS: "/tmp",
  KONTROL_VERIFY_SANDBOX: "1",
  KONTROL_CHILD_ENV_ALLOWLIST: "FOO",
  KONTROL_VERIFY_TOOLCHAIN_PATHS: "/toolchain",
  KONTROL_BWRAP: "/custom/bwrap",
  KONTROL_VERIFY_MAX_INFLIGHT: "5",
}));
assert.deepEqual(enabled, {
  sandbox: true,
  childEnvironmentAllowlist: ["FOO"],
  verifyToolchainPaths: ["/toolchain"],
  sandboxExecutablePath: "/custom/bwrap",
  maxInflight: 5,
});
const disabled = missionVerificationOptionsFromConfig(loadConfig({ KONTROL_OAUTH_OWNER_TOKEN: "test-owner-token", KONTROL_ALLOWED_ROOTS: "/tmp" }));
assert.deepEqual(disabled, {
  sandbox: false,
  childEnvironmentAllowlist: [],
  verifyToolchainPaths: [],
  sandboxExecutablePath: undefined,
  maxInflight: 3,
});
console.log("verification-options.test.ts: all assertions passed");
