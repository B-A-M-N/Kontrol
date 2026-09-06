// P1.10: explicit environment builders for trusted tooling spawns. These
// mirror the allowlist contract of src/process-environment.ts (buildTool-
// Environment / testHarnessEnvironment / releaseProbeEnvironment) for the
// plain-ESM scripts that cannot import TypeScript directly.
//
// Launcher authority — KONTROL_DEPLOYMENT_ID, KONTROL_RUNTIME_LOCK_TOKEN,
// KONTROL_DEPLOYMENT_LOCK_TOKEN, KONTROL_LAUNCH_GENERATION_ID,
// KONTROL_EXPECTED_SCHEMA_VERSION, KONTROL_ARTIFACT_PATH — and every other
// credential/control-plane namespace is dropped unless the caller explicitly
// allowlists it. The wholesale-spread exemptions these replaced were
// audited as acceptable only while launcher authority was ambient; with
// explicit DeploymentContext resolution (P0.3) tooling children no longer
// need any of it.

const ORDINARY_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "TERM",
  "COLORTERM",
  "CI",
  "NO_COLOR",
  "PAGER",
  "GIT_PAGER",
  "GH_PAGER",
  "npm_config_yes",
  "npm_config_audit",
  "npm_config_fund",
  "npm_config_update_notifier",
  "CC",
  "CXX",
  "AR",
  "RANLIB",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "GOPATH",
  "GOROOT",
  "GOCACHE",
  "JAVA_HOME",
  "VIRTUAL_ENV",
  // Tooling: package manager identity, node resolution, proxies, browser
  // test plumbing.
  "NODE_PATH",
  "NODE_OPTIONS",
  "npm_config_registry",
  "npm_config_strict_ssl",
  "npm_config_cache",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "PLAYWRIGHT_BROWSERS_PATH",
  "KONTROL_BROWSER_PATH",
  "KONTROL_BROWSER_NO_SANDBOX",
]);

export function isControlPlaneEnvironmentKey(key) {
  return /(?:KONTROL|ACP|OAUTH|REVIEWER|DIAGNOSTIC|TUNNEL|SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_KEY|COOKIE|SESSION)/i.test(key);
}

/**
 * Build a child environment for a trusted tooling spawn. `extraKeys` allows
 * specific non-default keys (test hooks, explicit KONTROL_* values a suite
 * intentionally injects); control-plane namespaces are still rejected here —
 * pass them via `overrides` to take responsibility for the value.
 */
export function buildToolEnvironment(source = process.env, {
  extraKeys = [],
  overrides = {},
} = {}) {
  const allow = new Set([...ORDINARY_KEYS, ...extraKeys]);
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || isControlPlaneEnvironmentKey(key)) continue;
    if (allow.has(key)) result[key] = value;
  }
  result.NO_COLOR = "1";
  result.TERM = "dumb";
  result.CI = "1";
  result.LANG ??= "C.UTF-8";
  result.LC_ALL ??= "C.UTF-8";
  Object.assign(result, overrides);
  return result;
}

export function testHarnessEnvironment(source = process.env, options = {}) {
  return buildToolEnvironment(source, options);
}

export function releaseProbeEnvironment(source = process.env, options = {}) {
  return buildToolEnvironment(source, options);
}
