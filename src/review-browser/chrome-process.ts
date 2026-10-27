import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readlink, realpath, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CdpClient } from "./cdp-client.js";
import type { ReviewerBrowserMode } from "./profile-store.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const activeProfileLocks = new Set<string>();

export interface OwnedChrome {
  profileDirectory: string;
  generation: number;
  browserPid?: number;
  processStartIdentity?: string;
  bootIdentity?: string;
  version: Record<string, unknown>;
  launchDiagnostics: { product: string; remoteDebuggingEnabled: boolean; stderr: string };
  cdp: CdpClient;
  reused: boolean;
  detach(): Promise<void>;
  close(): Promise<void>;
}

export interface ChromeProcessOptions {
  profileDirectory: string;
  generation: number;
  mode: ReviewerBrowserMode;
  chromePath?: string;
  startupTimeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
}

export type ChromeLaunchPurpose = "manual_authentication" | "controlled_review";

export function chromeArguments(profileDirectory: string, purpose: ChromeLaunchPurpose, mode: ReviewerBrowserMode = "headed"): string[] {
  const common = [`--user-data-dir=${profileDirectory}`, "--no-first-run", "--no-default-browser-check"];
  if (purpose === "manual_authentication") return [...common, "https://chatgpt.com/"];
  return [
    ...common,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    ...(mode === "headless" ? ["--headless=new"] : []),
    "about:blank",
  ];
}

function chromeBinary(explicit?: string, purpose: ChromeLaunchPurpose = "controlled_review"): string {
  if (explicit) return explicit;
  const candidates = process.platform === "linux"
    ? purpose === "manual_authentication"
      ? ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"]
    : process.platform === "darwin"
      ? purpose === "manual_authentication"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
      : ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Chromium was not found; set the explicit KONTROL_REVIEW_BROWSER_CHROME_PATH.");
  return found;
}

function chromeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY", "TMPDIR", "TEMP", "TMP"]) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function captureChromeStderr(child: ChildProcess): () => string {
  let buffer = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    buffer = (buffer + chunk).slice(-8192);
  });
  return () => buffer
    .replace(/\bBearer\s+[^\s"'`]+/gi, "Bearer [redacted]")
    .replace(/\b(cookie|token|password|secret|authorization)(\s*[=:]\s*)[^\s,;"'`]+/gi, "$1$2[redacted]")
    .replace(/--user-data-dir=\S+/gi, "--user-data-dir=[private]")
    .replace(/ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/devtools\/browser\/[A-Za-z0-9_-]+/gi, "ws://127.0.0.1:[port]/devtools/browser/[redacted]")
    .replace(/\/(?:home|Users|tmp|var|private)\/[^\s:'"`]+/g, "[local-path]")
    .slice(-2048);
}

export function isOfficialChromeInstallPath(platform: NodeJS.Platform, path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (platform === "linux") return /^\/(?:opt\/google\/chrome|usr\/lib\/google-chrome)\//i.test(normalized);
  if (platform === "darwin") return /\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome$/i.test(normalized);
  if (platform === "win32") return /^[A-Za-z]:\/Program Files(?: \(x86\))?\/Google\/Chrome\/Application\/chrome\.exe$/i.test(normalized);
  return false;
}

async function verifyOfficialChrome(executable: string, environment: NodeJS.ProcessEnv): Promise<string> {
  const binary = await realpath(executable).catch(() => resolve(executable));
  if (!isOfficialChromeInstallPath(process.platform, binary)) {
    throw new Error("Manual authentication requires the official Google Chrome installation path; the selected executable is not in a verified location.");
  }
  const child = spawn(binary, ["--version"], { stdio: ["ignore", "pipe", "pipe"], env: chromeEnvironment(environment), windowsHide: true });
  let output = "";
  const append = (chunk: string) => { output = (output + chunk).slice(-1024); };
  child.stdout?.setEncoding("utf8").on("data", append);
  child.stderr?.setEncoding("utf8").on("data", append);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Official Chrome binary verification timed out.")); }, 5_000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("Could not verify the configured official Chrome binary.")); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolvePromise({ code, signal }); });
  });
  const version = output.trim().replace(/\s+/g, " ").slice(0, 160);
  if (result.code !== 0 || !/^Google Chrome\s+[\w. -]+$/i.test(version)) {
    throw new Error("Manual authentication requires the official Google Chrome binary; the selected executable did not identify as Google Chrome.");
  }
  return version;
}

async function assertPrivateProfile(profileDirectory: string): Promise<void> {
  const absolute = resolve(profileDirectory);
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Chromium profile must be a real private directory.");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Chromium profile belongs to another local user.");
  await chmod(absolute, 0o700);
}

async function processCommandLine(pid: number): Promise<string | undefined> {
  try { return await readFile(`/proc/${pid}/cmdline`, "utf8"); } catch { return undefined; }
}

async function chromePidForProfile(profileDirectory: string): Promise<number | undefined> {
  const lock = join(profileDirectory, "SingletonLock");
  let value: string;
  try { value = await readlink(lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    const stat = await lstat(lock).catch(() => undefined);
    if (stat && !stat.isSymbolicLink()) throw new Error("Chromium SingletonLock is not a symlink; refusing ambiguous profile ownership.");
    return undefined;
  }
  const match = /-(\d+)$/.exec(value);
  if (!match) throw new Error("Chromium SingletonLock has an invalid owner identity.");
  const pid = Number(match[1]);
  const commandLine = await processCommandLine(pid);
  if (!commandLine) return undefined;
  if (!commandLine.includes(`--user-data-dir=${profileDirectory}`) && !commandLine.includes(profileDirectory)) {
    throw new Error("The Chromium profile lock belongs to a process whose command line does not match the selected profile.");
  }
  return pid;
}

async function readDebugEndpoint(profileDirectory: string): Promise<string | undefined> {
  const path = join(profileDirectory, "DevToolsActivePort");
  let stat;
  try { stat = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("DevToolsActivePort must be a regular non-symlink file.");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("DevToolsActivePort belongs to another local user.");
  const contents = await readFile(path, "utf8");
  const [portText, websocketPath] = contents.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(websocketPath ?? "")) {
    throw new Error("DevToolsActivePort has an invalid endpoint.");
  }
  const endpoint = new URL(`ws://127.0.0.1:${port}${websocketPath}`);
  if (endpoint.protocol !== "ws:" || !LOOPBACK.has(endpoint.hostname)) throw new Error("Chromium's CDP endpoint is not loopback-only.");
  return endpoint.toString();
}

async function verifyExisting(profileDirectory: string): Promise<{ cdp: CdpClient; version: Record<string, unknown>; pid?: number } | undefined> {
  const endpoint = await readDebugEndpoint(profileDirectory);
  const pid = await chromePidForProfile(profileDirectory);
  const lockPresent = await lstat(join(profileDirectory, "SingletonLock")).then(() => true).catch(() => false);
  if (lockPresent && !pid && process.platform === "linux") throw new Error("Chromium profile lock exists but its owner cannot be verified; refusing to launch or attach.");
  if (!endpoint) {
    if (pid) throw new Error("The selected reviewer profile is open in ordinary Chrome without CDP; close it before starting controlled review.");
    return undefined;
  }
  if (!lockPresent && process.platform === "linux") return undefined;
  const cdp = await new CdpClient(endpoint, 5_000).connect().catch(() => undefined);
  if (!cdp) {
    if (lockPresent) throw new Error("Chromium owns the profile but its CDP endpoint is unavailable.");
    return undefined;
  }
  try {
    const version = await cdp.send<Record<string, unknown>>("Browser.getVersion");
    if (typeof version.product !== "string" || !/Chrome|Chromium/i.test(version.product)) throw new Error("CDP endpoint is not a verified Chromium browser.");
    return { cdp, version, ...(pid ? { pid } : {}) };
  } catch (error) { await cdp.close(); throw error; }
}

export interface ChromeProfileOwnerObservation {
  status: "empty" | "owned" | "unknown";
  pid?: number;
  processStartIdentity?: string;
  bootIdentity?: string;
  remoteDebuggingEnabled?: boolean;
}

/** Inspect the browser's own profile lock after a controller crash. This is
 * distinct from the Kontrol ownership lock: it identifies any surviving
 * Chrome process that still owns the private profile. */
export async function inspectChromeProfileOwner(profileDirectory: string): Promise<ChromeProfileOwnerObservation> {
  const absolute = resolve(profileDirectory);
  await assertPrivateProfile(absolute);
  let singletonPresent = false;
  try { await lstat(join(absolute, "SingletonLock")); singletonPresent = true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { status: "unknown" };
  }
  let endpoint: string | undefined;
  try { endpoint = await readDebugEndpoint(absolute); }
  catch { return { status: "unknown" }; }
  let pid: number | undefined;
  try { pid = await chromePidForProfile(absolute); }
  catch { return { status: "unknown" }; }
  if (pid) {
    const [start, boot] = await Promise.all([processStartIdentity(pid), bootIdentity()]);
    return {
      status: "owned", pid,
      ...(start ? { processStartIdentity: start } : {}),
      ...(boot ? { bootIdentity: boot } : {}),
      remoteDebuggingEnabled: Boolean(endpoint),
    };
  }
  if (singletonPresent || endpoint) return { status: "unknown" };
  return { status: "empty", remoteDebuggingEnabled: false };
}

async function waitForEndpoint(profileDirectory: string, child: ChildProcess, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Chromium exited before CDP startup (code ${child.exitCode ?? child.signalCode}).`);
    const endpoint = await readDebugEndpoint(profileDirectory);
    if (endpoint) return endpoint;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Chromium did not publish DevToolsActivePort before the startup deadline.");
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => { child.off("exit", onExit); resolvePromise(false); }, timeoutMs);
    const onExit = () => { clearTimeout(timer); resolvePromise(true); };
    child.once("exit", onExit);
  });
}

async function waitForOwnedProcessExit(input: { pid: number; processStartIdentity?: string; bootIdentity?: string }, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await inspectOwnedProcess(input);
    if (state === "dead" || state === "different") return true;
    if (state === "unknown") return false;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return false;
}

type PidState = "alive" | "dead" | "unknown";

function probePid(pid: number): PidState {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
}

async function processStartIdentity(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    // /proc/<pid>/stat field 22 (starttime); the remainder starts at field 3.
    return stat.slice(close + 1).trim().split(/\s+/)[19];
  } catch { return undefined; }
}

async function bootIdentity(): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try { return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(); }
  catch { return undefined; }
}

interface ProfileLockRecord {
  pid: number;
  generation: number;
  lockId: string;
  processStartIdentity?: string;
  bootIdentity?: string;
  acquiredAt: string;
}

export type OwnedProcessState = "same" | "dead" | "different" | "unknown";

export async function inspectOwnedProcess(input: { pid: number; processStartIdentity?: string; bootIdentity?: string }): Promise<OwnedProcessState> {
  const pidState = probePid(input.pid);
  if (pidState === "dead") return "dead";
  const [start, boot] = await Promise.all([processStartIdentity(input.pid), bootIdentity()]);
  if (input.bootIdentity && boot && input.bootIdentity !== boot) return "different";
  if (input.processStartIdentity && start && input.processStartIdentity !== start) return "different";
  if (pidState === "unknown" || !input.processStartIdentity || !start) return "unknown";
  return "same";
}

async function lockOwnerIsStale(record: ProfileLockRecord): Promise<boolean> {
  const state = probePid(record.pid);
  if (state === "dead") return true;
  if (state === "unknown") return false;
  const [start, boot] = await Promise.all([processStartIdentity(record.pid), bootIdentity()]);
  if (record.bootIdentity && boot && record.bootIdentity !== boot) return true;
  if (record.processStartIdentity && start && record.processStartIdentity !== start) return true;
  return false;
}

export async function acquireReviewerProfileLock(profileDirectory: string, generation: number): Promise<() => Promise<void>> {
  if (activeProfileLocks.has(profileDirectory)) throw new Error("Another browser controller in this process owns the selected reviewer profile.");
  await assertPrivateProfile(profileDirectory);
  const lockPath = join(profileDirectory, "kontrol-controller.lock");
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  const lockId = randomUUID();
  const [startIdentity, bootId] = await Promise.all([processStartIdentity(process.pid), bootIdentity()]);
  const record: ProfileLockRecord = {
    pid: process.pid,
    generation,
    lockId,
    ...(startIdentity ? { processStartIdentity: startIdentity } : {}),
    ...(bootId ? { bootIdentity: bootId } : {}),
    acquiredAt: new Date().toISOString(),
  };
  let lockHandle;
  try { lockHandle = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let raw: string;
    let prior: ProfileLockRecord;
    try {
      raw = await readFile(lockPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ProfileLockRecord>;
      if (!Number.isSafeInteger(parsed.pid) || (parsed.pid ?? 0) <= 0 || !Number.isSafeInteger(parsed.generation)
        || typeof parsed.lockId !== "string" || !parsed.lockId) throw new Error("invalid lock record");
      prior = parsed as ProfileLockRecord;
    } catch {
      throw new Error("Reviewer browser profile lock is unreadable or ambiguous; refusing to reclaim it.");
    }
    if (!await lockOwnerIsStale(prior)) throw new Error("Another reviewer browser controller owns this profile, or its ownership cannot be verified.");
    // Rename is the compare-and-swap: among concurrent reclaimers only one can
    // move this exact lock entry. A contender then creates the replacement with wx.
    const quarantine = `${lockPath}.reclaim-${randomUUID()}`;
    try { await rename(lockPath, quarantine); }
    catch (renameError) {
      if ((renameError as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Reviewer browser profile lock changed during stale-owner recovery; retry acquisition.");
      throw renameError;
    }
    try {
      if (await readFile(quarantine, "utf8") !== raw) {
        await rename(quarantine, lockPath).catch(() => undefined);
        throw new Error("Reviewer browser profile lock changed during stale-owner recovery; refusing to reclaim it.");
      }
      await unlink(quarantine);
    } catch (reclaimError) {
      // Do not overwrite a successor lock if one appeared while validating.
      if ((reclaimError as NodeJS.ErrnoException).code !== "ENOENT") {
        await open(lockPath, "wx", 0o600).then(async (handle) => { await handle.writeFile(raw); await handle.close(); }).catch(() => undefined);
      }
      throw reclaimError;
    }
    try { lockHandle = await open(lockPath, "wx", 0o600); }
    catch (createError) {
      if ((createError as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another reviewer browser controller acquired the profile during stale-owner recovery.");
      throw createError;
    }
  }
  activeProfileLocks.add(profileDirectory);
  await lockHandle.writeFile(JSON.stringify(record));
  await lockHandle.close();
  return async () => {
    try {
      const current = JSON.parse(await readFile(lockPath, "utf8")) as Partial<ProfileLockRecord>;
      if (current.lockId === lockId) await unlink(lockPath);
    } catch { /* a successor or external recovery owns the path now */ }
    activeProfileLocks.delete(profileDirectory);
  };
}

export interface ManualChromeAuthentication {
  readonly browserPid?: number;
  readonly browserProduct: string;
  readonly processStartIdentity?: string;
  readonly bootIdentity?: string;
  launchDiagnostic(): string;
  hasExited(): boolean;
  releaseAfterExit(): Promise<void>;
  close(): Promise<boolean>;
}

export async function launchManualAuthenticationChrome(options: Pick<ChromeProcessOptions, "profileDirectory" | "generation" | "chromePath" | "startupTimeoutMs" | "environment">): Promise<ManualChromeAuthentication> {
  const profileDirectory = resolve(options.profileDirectory);
  const releaseLock = await acquireReviewerProfileLock(profileDirectory, options.generation);
  let child: ChildProcess | undefined;
  try {
    const existingOwner = await chromePidForProfile(profileDirectory);
    const hasProfileLock = await lstat(join(profileDirectory, "SingletonLock")).then(() => true).catch(() => false);
    const hasDebugEndpoint = Boolean(await readDebugEndpoint(profileDirectory));
    if (existingOwner || hasProfileLock || hasDebugEndpoint) throw new Error("The selected reviewer profile is already open or has unresolved browser ownership; close Chrome and reconcile the profile before beginning manual authentication.");
    const executable = chromeBinary(options.chromePath, "manual_authentication");
    const environment = options.environment ?? process.env;
    const browserProduct = await verifyOfficialChrome(executable, environment);
    child = spawn(executable, chromeArguments(profileDirectory, "manual_authentication"), {
      stdio: ["ignore", "ignore", "pipe"], env: chromeEnvironment(environment), windowsHide: false,
    });
    const launchDiagnostic = captureChromeStderr(child);
    const deadline = Date.now() + (options.startupTimeoutMs ?? 30_000);
    let owned = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Official Chrome exited before manual authentication opened.");
      if (await chromePidForProfile(profileDirectory).catch(() => undefined)) { owned = true; break; }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    if (!owned) throw new Error("Official Chrome did not establish ownership of the reviewer profile before the startup deadline.");
    const startIdentity = child.pid ? await processStartIdentity(child.pid) : undefined;
    const bootId = await bootIdentity();
    let released = false;
    const release = async () => {
      if (released) return;
      if (child!.exitCode === null && child!.signalCode === null) throw new Error("Close the manual Chrome window before completing the authentication handoff.");
      const owner = await chromePidForProfile(profileDirectory).catch(() => undefined);
      if (owner) throw new Error("The reviewer profile is still open in another Chrome process; close every window before handoff.");
      released = true;
      await releaseLock();
    };
    return {
      ...(child.pid ? { browserPid: child.pid } : {}),
      browserProduct,
      ...(startIdentity ? { processStartIdentity: startIdentity } : {}),
      ...(bootId ? { bootIdentity: bootId } : {}),
      launchDiagnostic,
      hasExited: () => child!.exitCode !== null || child!.signalCode !== null,
      releaseAfterExit: release,
      async close() {
        if (child!.exitCode === null && child!.signalCode === null) child!.kill("SIGTERM");
        const exited = await waitForExit(child!, 8_000);
        if (!exited) return false;
        await release();
        return true;
      },
    };
  } catch (error) {
    if (child?.pid && child.exitCode === null) { child.kill("SIGTERM"); await waitForExit(child, 2_000); }
    await releaseLock();
    throw error;
  }
}

export async function launchOrReconnectChrome(options: ChromeProcessOptions): Promise<OwnedChrome> {
  const profileDirectory = resolve(options.profileDirectory);
  const releaseLock = await acquireReviewerProfileLock(profileDirectory, options.generation);
  let child: ChildProcess | undefined;
  let cdp: CdpClient | undefined;
  let launchDiagnostic = () => "";
  let stopped = false;
  try {
    const existing = await verifyExisting(profileDirectory);
    if (existing) {
      cdp = existing.cdp;
      const [startIdentity, bootId] = existing.pid
        ? await Promise.all([processStartIdentity(existing.pid), bootIdentity()])
        : [undefined, undefined];
      return createHandle(existing.pid, existing.version, true, "", startIdentity, bootId);
    }
    const executable = chromeBinary(options.chromePath);
    child = spawn(executable, chromeArguments(profileDirectory, "controlled_review", options.mode), { stdio: ["ignore", "ignore", "pipe"], env: chromeEnvironment(options.environment ?? process.env), windowsHide: false });
    launchDiagnostic = captureChromeStderr(child);
    const endpoint = await waitForEndpoint(profileDirectory, child, options.startupTimeoutMs ?? 30_000);
    cdp = await new CdpClient(endpoint, 5_000).connect();
    const version = await cdp.send<Record<string, unknown>>("Browser.getVersion");
    if (typeof version.product !== "string" || !/Chrome|Chromium/i.test(version.product)) throw new Error("The launched browser did not identify itself as Chromium.");
    const [startIdentity, bootId] = child.pid
      ? await Promise.all([processStartIdentity(child.pid), bootIdentity()])
      : [undefined, undefined];
    return createHandle(child.pid, version, false, launchDiagnostic(), startIdentity, bootId);
  } catch (error) {
    await cdp?.close().catch(() => undefined);
    if (child?.pid && child.exitCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child, 2_000);
    }
    await releaseLock();
    throw error;
  }

  function createHandle(browserPid: number | undefined, version: Record<string, unknown>, reused: boolean, diagnostic: string, startIdentity?: string, bootId?: string): OwnedChrome {
    const activeCdp = cdp!;
    return {
      profileDirectory,
      generation: options.generation,
      browserPid,
      processStartIdentity: startIdentity,
      bootIdentity: bootId,
      version,
      launchDiagnostics: { product: String(version.product ?? "unknown"), remoteDebuggingEnabled: true, stderr: diagnostic },
      cdp: activeCdp,
      reused,
      async detach() {
        if (stopped) return;
        await activeCdp.close().catch(() => undefined);
        await releaseLock();
        stopped = true;
      },
      async close() {
        if (stopped) return;
        try { await activeCdp.send("Browser.close", {}, undefined, 5_000); } catch { /* the process exit observation below decides recovery */ }
        await activeCdp.close().catch(() => undefined);
        if (child) {
          const exited = await waitForExit(child, 8_000);
          if (!exited) {
            const pidMatches = await chromePidForProfile(profileDirectory).catch(() => undefined);
            if (pidMatches !== child.pid) throw new Error("Could not prove ownership of the Chrome process during shutdown; profile lock remains held.");
            child.kill("SIGTERM");
            if (!await waitForExit(child, 2_000)) throw new Error("Chrome did not exit after shutdown; profile lock remains held.");
          }
        } else if (reused && browserPid) {
          if (!await waitForOwnedProcessExit({ pid: browserPid, processStartIdentity: startIdentity, bootIdentity: bootId }, 8_000)) {
            const pidMatches = await chromePidForProfile(profileDirectory).catch(() => undefined);
            const currentIdentity = await inspectOwnedProcess({ pid: browserPid, processStartIdentity: startIdentity, bootIdentity: bootId });
            if (pidMatches !== browserPid || currentIdentity !== "same") throw new Error("Could not prove ownership of the reconnected Chrome process; profile lock remains held.");
            try { process.kill(browserPid, "SIGTERM"); }
            catch { throw new Error("Could not stop the reconnected Chrome process; profile lock remains held."); }
            if (!await waitForOwnedProcessExit({ pid: browserPid, processStartIdentity: startIdentity, bootIdentity: bootId }, 2_000)) {
              throw new Error("Reconnected Chrome did not exit after shutdown; profile lock remains held.");
            }
          }
        }
        if (await chromePidForProfile(profileDirectory)) {
          throw new Error("Chrome still owns the reviewer profile after shutdown; the profile lock remains held.");
        }
        await releaseLock();
        stopped = true;
      },
    };
  }
}
