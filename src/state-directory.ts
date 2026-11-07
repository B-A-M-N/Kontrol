import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type StateProfile = "development" | "qualification" | "production";

export interface StateDirectoryResolution {
  readonly stateDir: string;
  readonly profile: StateProfile;
  readonly projectRoot: string;
  readonly launcherContext: string;
}

export interface StateOwnershipContext {
  profile: StateProfile;
  projectRoot?: string;
  launcherContext?: string;
}

const LAUNCHERS_BY_PROFILE: Readonly<Record<StateProfile, ReadonlySet<string>>> = {
  development: new Set(["dev-watch", "serve"]),
  qualification: new Set(["qualification", "release-smoke"]),
  production: new Set(["systemd"]),
};

interface StateOwnershipRecord {
  formatVersion: 1;
  stateId: string;
  profile: StateProfile;
  projectRoot?: string;
  permittedLauncherContext: "development" | "qualification" | "systemd";
  createdAt: string;
}

export function projectRootForModule(moduleUrl: string): string {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const candidate = basename(moduleDirectory) === "src" ? dirname(moduleDirectory) : moduleDirectory;
  return canonicalPath(candidate);
}

export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(canonicalPath(parent), basename(absolute));
  }
}

function assertProfileLauncher(profile: StateProfile, launcherContext: string): void {
  if (!LAUNCHERS_BY_PROFILE[profile].has(launcherContext)) {
    const expected = [...LAUNCHERS_BY_PROFILE[profile]].join(" or ");
    throw new Error(`${profile[0]?.toUpperCase()}${profile.slice(1)} Kontrol state requires launcher ${expected}; received ${launcherContext || "<empty>"}.`);
  }
}

export function canonicalProductionDirectory(env: NodeJS.ProcessEnv): string {
  return canonicalPath(join(dataHome(env), "kontrol"));
}

function dataHome(env: NodeJS.ProcessEnv): string {
  return resolve(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"));
}

export function resolveStateDirectory(options: {
  env: NodeJS.ProcessEnv;
  projectRoot: string;
  configuredStateDir?: string;
  defaultProfile?: StateProfile;
}): StateDirectoryResolution {
  const { env, configuredStateDir } = options;
  const projectRoot = canonicalPath(options.projectRoot);
  if (env.KONTROL_SOURCE_ROOT?.trim()) {
    const suppliedRoot = canonicalPath(env.KONTROL_SOURCE_ROOT.trim());
    if (suppliedRoot !== projectRoot) {
      throw new Error(`KONTROL_SOURCE_ROOT does not match the selected source checkout: ${suppliedRoot} (expected ${projectRoot}).`);
    }
  }
  const requestedProfile = env.KONTROL_STATE_PROFILE;
  const launcherContext = env.KONTROL_LAUNCHER?.trim() || (options.defaultProfile === "qualification" ? "qualification" : options.defaultProfile === "production" ? "systemd" : "serve");
  const inferredProfile: StateProfile = launcherContext === "systemd" ? "production" : launcherContext === "qualification" || launcherContext === "release-smoke" ? "qualification" : options.defaultProfile ?? "development";
  const profile = requestedProfile ?? inferredProfile;
  if (profile !== "development" && profile !== "qualification" && profile !== "production") {
    throw new Error(`Invalid KONTROL_STATE_PROFILE: ${profile}. Expected development, qualification, or production.`);
  }
  assertProfileLauncher(profile, launcherContext);

  const legacyProductionDir = canonicalProductionDirectory(env);
  const explicitDirectory = env.KONTROL_STATE_DIR?.trim() || configuredStateDir?.trim();
  if (explicitDirectory) {
    const stateDir = canonicalPath(explicitDirectory.replace(/^~(?=$|[/\\])/, homedir()));
    if (profile !== "production" && stateDir === legacyProductionDir) {
      throw new Error("The legacy production state directory cannot be selected by a non-production launcher.");
    }
    return Object.freeze({ stateDir, profile, projectRoot, launcherContext });
  }

  if (profile === "production") {
    return Object.freeze({ stateDir: legacyProductionDir, profile, projectRoot, launcherContext });
  }
  const projectId = createHash("sha256").update(projectRoot).digest("hex").slice(0, 24);
  return Object.freeze({
    stateDir: join(legacyProductionDir, profile, projectId),
    profile,
    projectRoot,
    launcherContext,
  });
}

function expectedLauncherContext(profile: StateProfile): StateOwnershipRecord["permittedLauncherContext"] {
  return profile === "production" ? "systemd" : profile;
}

/**
 * Verify or establish the state-directory ownership fence before any writable
 * SQLite open. Production data is accepted only from the systemd lifecycle;
 * development and qualification state are bound to their explicit profile
 * and (for development) canonical checkout path.
 */
export function claimStateDirectory(stateDir: string, context: StateOwnershipContext): StateOwnershipRecord {
  const launcher = context.launcherContext ?? (context.profile === "qualification" ? "qualification" : context.profile === "production" ? "systemd" : "serve");
  assertProfileLauncher(context.profile, launcher);
  const absoluteStateDir = canonicalPath(stateDir);
  const legacyProductionDir = canonicalProductionDirectory(process.env);
  if (context.profile !== "production" && absoluteStateDir === legacyProductionDir) {
    throw new Error("A non-production Kontrol process cannot open the legacy production state directory.");
  }

  const ownerPath = join(absoluteStateDir, "state-owner.json");
  const permittedLauncherContext = expectedLauncherContext(context.profile);
  const requestedProjectRoot = context.projectRoot ? canonicalPath(context.projectRoot) : undefined;
  // All authority and path checks happen before mkdir, so a mismatched caller
  // cannot create artifacts at a location owned by another profile.
  mkdirSync(absoluteStateDir, { recursive: true, mode: 0o700 });
  if (existsSync(ownerPath)) {
    let record: StateOwnershipRecord;
    try {
      record = JSON.parse(readFileSync(ownerPath, "utf8")) as StateOwnershipRecord;
    } catch {
      throw new Error(`Kontrol state ownership record is unreadable: ${ownerPath}`);
    }
    const validRecord = record && record.formatVersion === 1
      && typeof record.stateId === "string" && /^[0-9a-f-]{36}$/i.test(record.stateId)
      && (record.profile === "development" || record.profile === "qualification" || record.profile === "production")
      && (record.permittedLauncherContext === "development" || record.permittedLauncherContext === "qualification" || record.permittedLauncherContext === "systemd")
      && typeof record.createdAt === "string" && Number.isFinite(Date.parse(record.createdAt))
      && (record.projectRoot === undefined || typeof record.projectRoot === "string");
    if (!validRecord) {
      throw new Error(`Kontrol state ownership record is invalid: ${ownerPath}`);
    }
    if (record.profile !== context.profile || record.permittedLauncherContext !== permittedLauncherContext) {
      throw new Error(`Kontrol state profile mismatch at ${absoluteStateDir}: recorded ${record.profile}, requested ${context.profile}.`);
    }
    if (context.profile !== "production" && (!record.projectRoot || !requestedProjectRoot)) {
      throw new Error(`Kontrol state ownership record lacks a verified checkout identity: ${ownerPath}. Use the explicit legacy-state adoption procedure before opening this database.`);
    }
    if (context.profile !== "production" && record.projectRoot !== requestedProjectRoot) {
      throw new Error(`Kontrol development state belongs to a different checkout: ${record.projectRoot}`);
    }
    return record;
  }

  const databasePath = join(absoluteStateDir, "kontrol.sqlite");
  if (existsSync(databasePath) && statSync(databasePath).isFile()) {
    throw new Error(`Kontrol database has no state ownership record: ${databasePath}. Refusing implicit adoption; use the explicit legacy-state adoption procedure.`);
  }

  const record: StateOwnershipRecord = {
    formatVersion: 1,
    stateId: randomUUID(),
    profile: context.profile,
    ...(context.profile !== "production" && requestedProjectRoot ? { projectRoot: requestedProjectRoot } : {}),
    permittedLauncherContext,
    createdAt: new Date().toISOString(),
  };
  const tempPath = `${ownerPath}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    // Hard-link publication is atomic and refuses to replace a competing
    // opener's owner record, unlike rename on POSIX systems.
    linkSync(tempPath, ownerPath);
    unlinkSync(tempPath);
  } catch (error) {
    if (existsSync(ownerPath)) {
      unlinkSync(tempPath);
      return claimStateDirectory(absoluteStateDir, context);
    }
    try { unlinkSync(tempPath); } catch { /* preserve original error */ }
    throw error;
  }
  return record;
}
