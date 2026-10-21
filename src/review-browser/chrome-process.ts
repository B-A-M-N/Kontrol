import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, readlink, unlink } from "node:fs/promises";
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
  version: Record<string, unknown>;
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

function chromeBinary(explicit?: string): string {
  if (explicit) return explicit;
  const candidates = process.platform === "linux"
    ? ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
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
  if (!endpoint) return undefined;
  const pid = await chromePidForProfile(profileDirectory);
  const lockPresent = await lstat(join(profileDirectory, "SingletonLock")).then(() => true).catch(() => false);
  if (lockPresent && !pid && process.platform === "linux") throw new Error("Chromium profile lock exists but its owner cannot be verified; refusing to launch or attach.");
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

export async function launchOrReconnectChrome(options: ChromeProcessOptions): Promise<OwnedChrome> {
  const profileDirectory = resolve(options.profileDirectory);
  if (activeProfileLocks.has(profileDirectory)) throw new Error("Another browser controller in this process owns the selected reviewer profile.");
  await assertPrivateProfile(profileDirectory);
  const lockPath = join(profileDirectory, "kontrol-controller.lock");
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  let lockHandle;
  try { lockHandle = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let ownerPid: number | undefined;
    try { ownerPid = Number((JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown }).pid); } catch { /* stale malformed lock reconciled below */ }
    if (ownerPid && ownerPid !== process.pid) {
      try { process.kill(ownerPid, 0); throw new Error("Another Kontrol browser controller owns this profile."); }
      catch (probeError) {
        if (probeError instanceof Error && probeError.message === "Another Kontrol browser controller owns this profile.") throw probeError;
      }
    }
    await unlink(lockPath).catch(() => undefined);
    lockHandle = await open(lockPath, "wx", 0o600);
  }
  activeProfileLocks.add(profileDirectory);
  await lockHandle.writeFile(JSON.stringify({ pid: process.pid, generation: options.generation, acquiredAt: new Date().toISOString() }));
  await lockHandle.close();
  let child: ChildProcess | undefined;
  let cdp: CdpClient | undefined;
  let stopped = false;
  const releaseLock = async () => { await unlink(lockPath).catch(() => undefined); activeProfileLocks.delete(profileDirectory); };
  try {
    const existing = await verifyExisting(profileDirectory);
    if (existing) {
      cdp = existing.cdp;
      return createHandle(existing.pid, existing.version, true);
    }
    const executable = chromeBinary(options.chromePath);
    const args = [
      `--user-data-dir=${profileDirectory}`,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
    ];
    if (options.mode === "headless") args.push("--headless=new");
    args.push("about:blank");
    child = spawn(executable, args, { stdio: "ignore", env: chromeEnvironment(options.environment ?? process.env), windowsHide: false });
    const endpoint = await waitForEndpoint(profileDirectory, child, options.startupTimeoutMs ?? 30_000);
    cdp = await new CdpClient(endpoint, 5_000).connect();
    const version = await cdp.send<Record<string, unknown>>("Browser.getVersion");
    if (typeof version.product !== "string" || !/Chrome|Chromium/i.test(version.product)) throw new Error("The launched browser did not identify itself as Chromium.");
    return createHandle(child.pid, version, false);
  } catch (error) {
    await cdp?.close().catch(() => undefined);
    if (child?.pid && child.exitCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child, 2_000);
    }
    await releaseLock();
    throw error;
  }

  function createHandle(browserPid: number | undefined, version: Record<string, unknown>, reused: boolean): OwnedChrome {
    const activeCdp = cdp!;
    return {
      profileDirectory,
      generation: options.generation,
      browserPid,
      version,
      cdp: activeCdp,
      reused,
      async detach() {
        if (stopped) return;
        stopped = true;
        await activeCdp.close().catch(() => undefined);
        await releaseLock();
      },
      async close() {
        if (stopped) return;
        stopped = true;
        let closedByBrowser = false;
        try { await activeCdp.send("Browser.close", {}, undefined, 5_000); closedByBrowser = true; } catch { /* the process exit observation below decides recovery */ }
        await activeCdp.close().catch(() => undefined);
        if (child) {
          const exited = await waitForExit(child, 8_000);
          if (!exited) {
            const pidMatches = await chromePidForProfile(profileDirectory).catch(() => undefined);
            if (pidMatches === child.pid) { child.kill("SIGTERM"); await waitForExit(child, 2_000); }
          }
        } else if (reused && browserPid) {
          const pidMatches = await chromePidForProfile(profileDirectory).catch(() => undefined);
          if (pidMatches === browserPid && !closedByBrowser) throw new Error("Could not safely stop the reconnected Chromium process.");
        }
        await releaseLock();
      },
    };
  }
}
