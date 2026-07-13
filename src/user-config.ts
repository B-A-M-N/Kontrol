import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";

export interface DevDesktopUserConfig {
  host?: string;
  port?: number;
  allowedRoots?: string[];
  publicBaseUrl?: string | null;
  allowedHosts?: string[];
  stateDir?: string;
  worktreeRoot?: string;
  agentDir?: string;
  acpKnownAgents?: Array<{ name: string; url: string; description?: string }>;
}

export interface DevDesktopAuthConfig {
  ownerToken?: string;
}

export interface DevDesktopFiles {
  dir: string;
  configPath: string;
  authPath: string;
  configExists: boolean;
  authExists: boolean;
  config: DevDesktopUserConfig;
  auth: DevDesktopAuthConfig;
}

export function devdesktopConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(expandHomePath(env.DEVDESKTOP_CONFIG_DIR ?? join(homedir(), ".devdesktop")));
}

export function devdesktopConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(devdesktopConfigDir(env), "config.json");
}

export function devdesktopAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(devdesktopConfigDir(env), "auth.json");
}

export function loadDevDesktopFiles(env: NodeJS.ProcessEnv = process.env): DevDesktopFiles {
  const dir = devdesktopConfigDir(env);
  const configPath = join(dir, "config.json");
  const authPath = join(dir, "auth.json");
  const configExists = existsSync(configPath);
  const authExists = existsSync(authPath);

  return {
    dir,
    configPath,
    authPath,
    configExists,
    authExists,
    config: configExists ? readJsonFile<DevDesktopUserConfig>(configPath) : {},
    auth: authExists ? readJsonFile<DevDesktopAuthConfig>(authPath) : {},
  };
}

export function writeDevDesktopConfig(
  config: DevDesktopUserConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = devdesktopConfigPath(env);
  mkdirSync(devdesktopConfigDir(env), { recursive: true });
  writeJsonFile(filePath, config, 0o600);
  return filePath;
}

export function writeDevDesktopAuth(
  auth: DevDesktopAuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = devdesktopAuthPath(env);
  mkdirSync(devdesktopConfigDir(env), { recursive: true });
  writeJsonFile(filePath, auth, 0o600);
  return filePath;
}

export function generateOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}

function readJsonFile<T>(filePath: string): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${filePath}: ${reason}`);
  }
}

function writeJsonFile(filePath: string, value: unknown, mode: number): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { mode });
}
