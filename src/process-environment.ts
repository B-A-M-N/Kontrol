/**
 * Environment passed to processes whose command or working tree is
 * project-controlled.  The server environment is a privileged boundary and
 * must never be inherited wholesale by those processes.
 */

const ORDINARY_ENVIRONMENT_KEYS = new Set([
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
]);

/**
 * Return true for credential/control-plane namespaces even if a future caller
 * accidentally adds a broad key to the ordinary allowlist.
 */
export function isControlPlaneEnvironmentKey(key: string): boolean {
  return /(?:KONTROL|ACP|OAUTH|REVIEWER|DIAGNOSTIC|TUNNEL|SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_KEY|COOKIE|SESSION)/i.test(key);
}

export function buildChildEnvironment(options: {
  sandbox?: boolean;
  allowUserEnvironment?: boolean;
  source?: NodeJS.ProcessEnv;
  additionalKeys?: Iterable<string>;
} = {}): Record<string, string> {
  const source = options.source ?? process.env;
  const result: Record<string, string> = {};
  const additionalKeys = new Set(options.additionalKeys ?? []);

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || isControlPlaneEnvironmentKey(key)) continue;
    if (ORDINARY_ENVIRONMENT_KEYS.has(key) || additionalKeys.has(key) || options.allowUserEnvironment === true) {
      result[key] = value;
    }
  }

  result.NO_COLOR = "1";
  result.TERM = "dumb";
  result.PAGER = "cat";
  result.GIT_PAGER = "cat";
  result.GH_PAGER = "cat";
  result.CODEX_CI = "1";
  result.CI = "1";
  result.LANG ??= "C.UTF-8";
  result.LC_ALL ??= "C.UTF-8";

  // A sandbox must not expose the host home directory as a writable location.
  if (options.sandbox) {
    result.HOME = "/tmp";
    result.TMPDIR = "/tmp";
    result.TMP = "/tmp";
    result.TEMP = "/tmp";
  }

  return result;
}

export const ordinaryEnvironmentKeys = [...ORDINARY_ENVIRONMENT_KEYS];

/**
 * P1.10: named builders for the trusted-tooling spawn sites that previously
 * used wholesale process-env spreads. Each caller declares its purpose, and the
 * builder applies an explicit allowlist so launcher authority
 * (KONTROL_DEPLOYMENT_ID, runtime/deployment lock tokens, launch generation,
 * reviewer/tunnel credentials) cannot ride into unrelated children even when
 * the parent process legitimately holds it.
 */

// Keys trusted build/dev tooling may need beyond the ordinary set: package
// manager identity, node module resolution, and proxy configuration.
const TOOL_ENVIRONMENT_KEYS = new Set([
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

export function buildToolEnvironment(options: {
  source?: NodeJS.ProcessEnv;
  additionalKeys?: Iterable<string>;
} = {}): Record<string, string> {
  return buildChildEnvironment({ ...options, additionalKeys: [...TOOL_ENVIRONMENT_KEYS, ...(options.additionalKeys ?? [])] });
}

// Test harnesses get the tool set plus the explicit test hooks the suites
// set; launcher authority stays excluded. Suites that intentionally inject
// KONTROL_* values pass them as additionalKeys.
export function testHarnessEnvironment(options: {
  source?: NodeJS.ProcessEnv;
  additionalKeys?: Iterable<string>;
} = {}): Record<string, string> {
  return buildToolEnvironment(options);
}

// Release probes talk to a running deployment over HTTP; they need no
// launcher authority in the child environment at all, only the tool set.
export function releaseProbeEnvironment(options: {
  source?: NodeJS.ProcessEnv;
  additionalKeys?: Iterable<string>;
} = {}): Record<string, string> {
  return buildToolEnvironment(options);
}

// Workspace command execution: the audited surface used by the MCP shell
// tooling. Same allowlist contract as buildChildEnvironment's callers.
export function workspaceCommandEnvironment(options: {
  source?: NodeJS.ProcessEnv;
  additionalKeys?: Iterable<string>;
} = {}): Record<string, string> {
  return buildChildEnvironment(options);
}
