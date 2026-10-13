import { createHmac, timingSafeEqual } from "node:crypto";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const READ_ONLY_EXECUTION_ISSUER = "kontrol";
export const READ_ONLY_EXECUTION_OPERATIONS = Object.freeze([
  "workspace.read",
  "workspace.search",
  "execution.report",
]);
export const READ_ONLY_EXECUTION_MAX_TTL_MS = 24 * 60 * 60 * 1000;

const GRANT_VERSION = 1;
const GRANT_FIELDS = Object.freeze([
  "version",
  "issuer",
  "workSessionId",
  "workspaceSessionId",
  "workspaceRoot",
  "agentId",
  "runId",
  "attemptNumber",
  "dispatchIdempotencyKey",
  "networkPolicy",
  "operations",
  "issuedAt",
  "expiresAt",
]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function grantPayload(grant) {
  return Object.fromEntries(GRANT_FIELDS.map((field) => [field, grant[field]]));
}

function signatureFor(payload, secret) {
  return createHmac("sha256", secret).update(stableJson(payload)).digest("hex");
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** Create the Kontrol-issued, attempt-bound capability used for read-only ACP launches. */
export function createReadOnlyExecutionGrant(input, secret, now = Date.now()) {
  if (!nonempty(secret)) throw new Error("read_only_grant_issuer_unavailable");
  const ttlMs = Math.max(1, Math.min(Number(input.ttlMs) || 60 * 60 * 1000, READ_ONLY_EXECUTION_MAX_TTL_MS));
  const payload = {
    version: GRANT_VERSION,
    issuer: READ_ONLY_EXECUTION_ISSUER,
    workSessionId: input.workSessionId,
    workspaceSessionId: input.workspaceSessionId,
    workspaceRoot: input.workspaceRoot,
    agentId: input.agentId,
    runId: input.runId,
    attemptNumber: input.attemptNumber,
    dispatchIdempotencyKey: input.dispatchIdempotencyKey,
    networkPolicy: input.networkPolicy ?? "disabled",
    operations: [...READ_ONLY_EXECUTION_OPERATIONS],
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
  if (
    !nonempty(payload.workSessionId)
    || !nonempty(payload.workspaceSessionId)
    || !isAbsolute(payload.workspaceRoot)
    || !nonempty(payload.agentId)
    || !nonempty(payload.runId)
    || !Number.isSafeInteger(payload.attemptNumber)
    || payload.attemptNumber < 1
    || !nonempty(payload.dispatchIdempotencyKey)
    || !["disabled", "host"].includes(payload.networkPolicy)
  ) throw new Error("read_only_grant_claims_invalid");
  return { ...payload, signature: signatureFor(payload, secret) };
}

/** Verify signature, lifetime, exact read-only operations, and caller-supplied attempt identity. */
export function verifyReadOnlyExecutionGrant(grant, secret, expected, now = Date.now()) {
  if (!grant || typeof grant !== "object" || !nonempty(secret) || typeof grant.signature !== "string") return false;
  if (GRANT_FIELDS.some((field) => !(field in grant))) return false;
  if (Object.keys(grant).some((field) => field !== "signature" && !GRANT_FIELDS.includes(field))) return false;
  if (grant.version !== GRANT_VERSION || grant.issuer !== READ_ONLY_EXECUTION_ISSUER) return false;
  if (!Array.isArray(grant.operations) || stableJson(grant.operations) !== stableJson(READ_ONLY_EXECUTION_OPERATIONS)) return false;
  if (!Number.isSafeInteger(grant.issuedAt) || !Number.isSafeInteger(grant.expiresAt)) return false;
  if (grant.issuedAt > now + 30_000 || grant.expiresAt <= now || grant.expiresAt <= grant.issuedAt) return false;
  if (grant.expiresAt - grant.issuedAt > READ_ONLY_EXECUTION_MAX_TTL_MS) return false;
  const payload = grantPayload(grant);
  const expectedSignature = Buffer.from(signatureFor(payload, secret), "hex");
  const actualSignature = Buffer.from(grant.signature, "hex");
  if (expectedSignature.length !== actualSignature.length || !timingSafeEqual(expectedSignature, actualSignature)) return false;
  for (const [key, value] of Object.entries(expected ?? {})) {
    if (grant[key] !== value) return false;
  }
  let canonicalRoot;
  try { canonicalRoot = realpathSync(expected?.workspaceRoot ?? grant.workspaceRoot); } catch { return false; }
  return grant.workspaceRoot === canonicalRoot;
}

/** Validate the signed authority attached to one scheduled read-only dispatch. */
export function validateReadOnlyDispatchRequest(body, canonicalWorkspaceRoot, secret, adapterAgentId) {
  const policy = body?.scheduled_execution_policy;
  const grant = body?.read_only_execution_grant;
  const declaresReadOnly = policy?.executionMode === "read_only_audit"
    || policy?.workspaceAccess === "read_only"
    || grant !== undefined;
  if (!declaresReadOnly) return { readOnly: false };
  if (
    policy?.executionMode !== "read_only_audit"
    || policy?.workspaceAccess !== "read_only"
    || policy?.mutate !== false
    || !body?.session_id
    || !body?.workspace_session_id
    || !body?.agent_id
    || !(body?.parent_run_id || body?.run_id)
    || !Number.isSafeInteger(body?.attempt_number)
    || body.attempt_number < 1
    || !body?.dispatch_idempotency_key
    || !nonempty(adapterAgentId)
    || body.agent_id !== adapterAgentId
  ) return { readOnly: true, valid: false, code: "read_only_grant_invalid" };
  const valid = verifyReadOnlyExecutionGrant(grant, secret, {
    workSessionId: body.session_id,
    workspaceSessionId: body.workspace_session_id,
    workspaceRoot: canonicalWorkspaceRoot,
    agentId: body.agent_id,
    runId: body.parent_run_id || body.run_id,
    attemptNumber: body.attempt_number,
    dispatchIdempotencyKey: body.dispatch_idempotency_key,
  });
  return valid
    ? { readOnly: true, valid: true, grant }
    : { readOnly: true, valid: false, code: "read_only_grant_invalid" };
}

export class ReadOnlySandboxUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReadOnlySandboxUnavailableError";
    this.code = "sandbox_unavailable";
  }
}

export function findBubblewrap(configuredPath = process.env.KONTROL_BWRAP) {
  if (process.platform !== "linux") throw new ReadOnlySandboxUnavailableError("Read-only ACP confinement is supported only on Linux.");
  const candidates = configuredPath ? [configuredPath] : ["/usr/bin/bwrap", "/bin/bwrap"];
  const path = candidates.find((candidate) => {
    if (typeof candidate !== "string" || !existsSync(candidate)) return false;
    try { accessSync(candidate, constants.X_OK); return statSync(candidate).isFile(); } catch { return false; }
  });
  if (!path) throw new ReadOnlySandboxUnavailableError("Bubblewrap is unavailable; refusing an unsandboxed read-only ACP run.");
  return path;
}

export function probeBubblewrap(configuredPath = process.env.KONTROL_BWRAP) {
  const bubblewrapPath = findBubblewrap(configuredPath);
  const probe = spawnSync(bubblewrapPath, [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--ro-bind-try", "/usr", "/usr",
    "--proc", "/proc",
    "--dev", "/dev",
    "--", "/usr/bin/true",
  ], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] });
  if (probe.error || probe.status !== 0) {
    const detail = probe.error?.message ?? probe.stderr?.trim() ?? `exit ${probe.status}`;
    throw new ReadOnlySandboxUnavailableError(`Bubblewrap confinement probe failed: ${detail}`);
  }
  return bubblewrapPath;
}

function parseToolchainPaths(raw, sourceRoot) {
  if (!raw) return [];
  const paths = (Array.isArray(raw) ? raw : raw.split(delimiter))
    .map((part) => String(part).trim()).filter(Boolean).map((part) => resolve(part));
  const unique = [...new Set(paths)];
  for (const path of unique) {
    if (path === "/" || path === sourceRoot || path.startsWith(`${sourceRoot}/`) || !existsSync(path) || !statSync(path).isDirectory()) {
      throw new ReadOnlySandboxUnavailableError(`Invalid read-only toolchain path: ${path}`);
    }
  }
  return unique;
}

function addMountTree(path, args, createdDirectories) {
  const normalized = resolve(path);
  const segments = normalized.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments.slice(0, -1)) {
    current += `/${segment}`;
    if (!createdDirectories.has(current)) {
      args.push("--dir", current);
      createdDirectories.add(current);
    }
  }
}

/** Build a fail-closed Linux execution boundary: workspace/toolchain read-only, private scratch, no network. */
export function buildReadOnlySandboxCommand({
  workspaceRoot,
  executable,
  executableTarget,
  args: commandArgs = [],
  env = {},
  toolchainPaths = process.env.KONTROL_VERIFY_TOOLCHAIN_PATHS ?? process.env.KONTROL_READ_ONLY_TOOLCHAIN_PATHS,
  bindMounts = [],
  bindFiles = [],
  networkPolicy = "disabled",
  bubblewrapPath = process.env.KONTROL_BWRAP,
}) {
  const bwrap = findBubblewrap(bubblewrapPath);
  let sourceRoot;
  let executablePath;
  try {
    sourceRoot = realpathSync(workspaceRoot);
    executablePath = realpathSync(executable);
  } catch (error) {
    throw new ReadOnlySandboxUnavailableError(`Required read-only execution path is unavailable: ${error.message}`);
  }
  const runtimePaths = parseToolchainPaths(toolchainPaths, sourceRoot);
  if (!["disabled", "host"].includes(networkPolicy)) {
    throw new ReadOnlySandboxUnavailableError(`Invalid read-only network policy: ${networkPolicy}`);
  }
  const sandboxExecutable = executableTarget ?? `/opt/kontrol/bin/${basename(executablePath)}`;
  if (!isAbsolute(sandboxExecutable) || sandboxExecutable === "/" || sandboxExecutable === "/workspace" || sandboxExecutable.startsWith("/workspace/") || sandboxExecutable === "/tmp" || sandboxExecutable.startsWith("/tmp/")) {
    throw new ReadOnlySandboxUnavailableError("Read-only executable target must be an absolute path outside the workspace and scratch directory.");
  }
  const sandboxEnv = {
    HOME: "/tmp/home",
    TMPDIR: "/tmp",
    TMP: "/tmp",
    TEMP: "/tmp",
    XDG_CONFIG_HOME: "/tmp/home/.config",
    XDG_CACHE_HOME: "/tmp/home/.cache",
    XDG_DATA_HOME: "/tmp/home/.local/share",
    PATH: "/opt/kontrol/bin:/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    TERM: "dumb",
    ...env,
  };
  const result = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    ...(networkPolicy === "host" ? ["--share-net"] : []),
    "--clearenv",
    "--dir", "/usr",
    "--dir", "/bin",
    "--dir", "/lib",
    "--dir", "/lib64",
    "--dir", "/etc",
    "--dir", "/etc/ssl",
    "--dir", "/etc/ssl/certs",
    "--dir", "/etc/ca-certificates",
    "--ro-bind-try", "/usr", "/usr",
    "--ro-bind-try", "/bin", "/bin",
    "--ro-bind-try", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind-try", "/usr/local", "/usr/local",
    "--ro-bind-try", "/etc/ssl/certs", "/etc/ssl/certs",
    "--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates",
    "--ro-bind-try", "/etc/nsswitch.conf", "/etc/nsswitch.conf",
    "--ro-bind-try", "/etc/passwd", "/etc/passwd",
    "--ro-bind-try", "/etc/group", "/etc/group",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--dir", "/tmp/home",
    "--dir", "/tmp/home/.config",
    "--dir", "/tmp/home/.cache",
    "--dir", "/tmp/home/.local",
    "--dir", "/tmp/home/.local/share",
    "--dir", "/workspace",
    "--ro-bind", sourceRoot, "/workspace",
    "--dir", "/opt",
    "--dir", "/opt/kontrol",
    "--dir", "/opt/kontrol/bin",
  ];
  const createdDirectories = new Set([
    "/", "/tmp", "/tmp/home", "/tmp/home/.config", "/tmp/home/.cache",
    "/tmp/home/.local", "/tmp/home/.local/share", "/workspace", "/opt",
    "/opt/kontrol", "/opt/kontrol/bin", "/usr", "/usr/bin", "/usr/local",
    "/usr/local/bin", "/bin", "/lib", "/lib64", "/etc",
  ]);
  // Mount only the selected executable. Binding its whole parent directory
  // could expose adjacent credentials when an agent is installed under HOME.
  const executableVisibleByToolchain = runtimePaths.some((path) => executablePath === path || executablePath.startsWith(`${path}/`));
  if (!executableVisibleByToolchain || sandboxExecutable !== executablePath) {
    addMountTree(sandboxExecutable, result, createdDirectories);
    result.push("--ro-bind", executablePath, sandboxExecutable);
  }
  for (const path of runtimePaths) {
    const target = path;
    addMountTree(target, result, createdDirectories);
    if (target === "/" || target === "/workspace" || target.startsWith("/workspace/") || target === "/tmp" || target.startsWith("/tmp/")) {
      throw new ReadOnlySandboxUnavailableError(`Read-only runtime bind target is reserved: ${target}`);
    }
    result.push("--dir", target);
    createdDirectories.add(target);
    result.push("--ro-bind", path, target);
  }
  for (const mount of bindMounts) {
    let source;
    try { source = realpathSync(mount.source); } catch (error) {
      throw new ReadOnlySandboxUnavailableError(`Read-only runtime bind source is unavailable: ${error.message}`);
    }
    const target = resolve(mount.target);
    if (!target.startsWith("/")) throw new ReadOnlySandboxUnavailableError("Read-only runtime bind target must be absolute.");
    if (!statSync(source).isDirectory()) throw new ReadOnlySandboxUnavailableError(`Read-only runtime bind source must be a directory: ${source}`);
    addMountTree(target, result, createdDirectories);
    result.push("--dir", target);
    createdDirectories.add(target);
    result.push("--ro-bind", source, target);
  }
  for (const mount of bindFiles) {
    let source;
    try { source = realpathSync(mount.source); } catch (error) {
      throw new ReadOnlySandboxUnavailableError(`Read-only runtime file is unavailable: ${error.message}`);
    }
    const target = resolve(mount.target);
    if (!isAbsolute(mount.target) || target === "/" || target === "/workspace" || target.startsWith("/workspace/") || target === "/tmp" || target.startsWith("/tmp/")) {
      throw new ReadOnlySandboxUnavailableError("Read-only runtime file target must be absolute and outside the workspace and scratch directory.");
    }
    if (!statSync(source).isFile()) throw new ReadOnlySandboxUnavailableError(`Read-only runtime bind source must be a file: ${source}`);
    addMountTree(target, result, createdDirectories);
    result.push("--ro-bind", source, target);
  }
  result.push("--chdir", "/workspace");
  for (const [key, value] of Object.entries(sandboxEnv)) {
    if (typeof value === "string" && value.length > 0) result.push("--setenv", key, value);
  }
  result.push(sandboxExecutable, ...commandArgs);
  return { command: bwrap, args: result, env: {} };
}

/** Exercise the complete mount policy with a harmless command before accepting a worker dispatch. */
export function probeReadOnlyExecutionSandbox({ workspaceRoot, toolchainPaths, bindMounts, bindFiles, networkPolicy = "disabled", bubblewrapPath } = {}) {
  const launch = buildReadOnlySandboxCommand({
    workspaceRoot,
    executable: "/usr/bin/true",
    args: [],
    env: {},
    toolchainPaths,
    bindMounts,
    bindFiles,
    networkPolicy,
    bubblewrapPath,
  });
  const probe = spawnSync(launch.command, launch.args, {
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (probe.error || probe.status !== 0) {
    const detail = probe.error?.message ?? probe.stderr?.trim() ?? `exit ${probe.status}`;
    throw new ReadOnlySandboxUnavailableError(`Read-only execution sandbox probe failed: ${detail}`);
  }
  return true;
}

/** Build the child environment from explicit ordinary names and explicit provider credentials. */
export function readOnlyWorkerEnvironment(source = process.env) {
  const allowedNames = new Set([
    ...(source.KONTROL_CHILD_ENV_ALLOWLIST ?? "").split(","),
    ...(source.KONTROL_READ_ONLY_AGENT_ENV_ALLOWLIST ?? "").split(","),
  ].map((name) => name.trim()).filter(Boolean));
  const blocked = /(?:KONTROL|ACP|OAUTH|REVIEWER|DIAGNOSTIC|TUNNEL|PASSWORD|COOKIE|SSH|AWS|GITHUB|PRIVATE_KEY|CREDENTIAL|SECRET|TOKEN|SESSION)/i;
  const result = {};
  for (const name of allowedNames) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || blocked.test(name)) {
      throw new ReadOnlySandboxUnavailableError(`Unsafe read-only child environment name: ${name}`);
    }
    if (typeof source[name] === "string") result[name] = source[name];
  }
  return result;
}

export function resolveExecutablePath(executable, pathValue = process.env.PATH ?? "") {
  if (isAbsolute(executable)) {
    try {
      const resolved = realpathSync(executable);
      accessSync(resolved, constants.X_OK);
      return statSync(resolved).isFile() ? resolved : undefined;
    } catch { return undefined; }
  }
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, executable);
    try {
      const resolved = realpathSync(candidate);
      accessSync(resolved, constants.X_OK);
      if (statSync(resolved).isFile()) return resolved;
    } catch { /* try next PATH component */ }
  }
  return undefined;
}
