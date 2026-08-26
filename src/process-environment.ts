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
} = {}): Record<string, string> {
  const source = options.source ?? process.env;
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || isControlPlaneEnvironmentKey(key)) continue;
    if (ORDINARY_ENVIRONMENT_KEYS.has(key) || options.allowUserEnvironment === true) {
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
