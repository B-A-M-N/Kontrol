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

export interface KontrolUserConfig {
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

export interface KontrolAuthConfig {
  ownerToken?: string;
}

export interface KontrolFiles {
  dir: string;
  configPath: string;
  authPath: string;
  configExists: boolean;
  authExists: boolean;
  config: KontrolUserConfig;
  auth: KontrolAuthConfig;
}

export function kontrolConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.KONTROL_CONFIG_DIR) return resolve(expandHomePath(env.KONTROL_CONFIG_DIR));
  return resolve(expandHomePath(join(homedir(), ".kontrol")));
}

export function kontrolConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(kontrolConfigDir(env), "config.json");
}

export function kontrolAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(kontrolConfigDir(env), "auth.json");
}

export function loadKontrolFiles(env: NodeJS.ProcessEnv = process.env): KontrolFiles {
  const dir = kontrolConfigDir(env);
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
    config: configExists ? readJsonFile<KontrolUserConfig>(configPath) : {},
    auth: authExists ? readJsonFile<KontrolAuthConfig>(authPath) : {},
  };
}

export function writeKontrolConfig(
  config: KontrolUserConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = kontrolConfigPath(env);
  mkdirSync(kontrolConfigDir(env), { recursive: true });
  writeJsonFile(filePath, config, 0o600);
  return filePath;
}

export function writeKontrolAuth(
  auth: KontrolAuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = kontrolAuthPath(env);
  mkdirSync(kontrolConfigDir(env), { recursive: true });
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
