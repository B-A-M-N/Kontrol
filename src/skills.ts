import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  loadSkills,
  type Skill,
  type LoadSkillsResult,
} from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "./config.js";
import { expandHomePath, isPathInsideRoot } from "./roots.js";

export interface LoadedSkills {
  skills: Skill[];
  diagnostics: LoadSkillsResult["diagnostics"];
}

export interface SkillReadResolution {
  absolutePath: string;
  skill: Skill;
  isSkillFile: boolean;
}

export interface SkillConfig {
  skillsEnabled: boolean;
  agentDir: string;
  skillPaths?: string[];
}

export function effectiveSkillPaths(config: SkillConfig, cwd: string): {
  projectLocal: string[];
  global: string[];
} {
  const projectLocal = uniqueExistingPaths([
    resolve(cwd, ".agents", "skills"),
  ]);
  const projectLocalSet = new Set(projectLocal);

  const global = uniqueExistingPaths([
    join(homedir(), ".agents", "skills"),
    join(config.agentDir, "skills"),
    ...(config.skillPaths ?? []).map((path) => resolveSkillPath(path, cwd)),
  ]).filter((path) => !projectLocalSet.has(path));

  return { projectLocal, global };
}

function uniqueExistingPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    if (seen.has(path) || !existsSync(path)) return false;
    seen.add(path);
    return true;
  });
}

function resolveSkillPath(path: string, cwd: string): string {
  return resolve(cwd, expandHomePath(path));
}

/**
 * P1 #10: Load only project-local skills (from workspace `.agents/skills`).
 * Global skills are loaded lazily via `search_skills` to reduce model context.
 */
export function loadProjectLocalSkills(config: ServerConfig, cwd: string): LoadedSkills {
  if (!config.skillsEnabled) return { skills: [], diagnostics: [] };

  const { projectLocal } = effectiveSkillPaths(config, cwd);

  return loadSkills({
    cwd,
    agentDir: config.agentDir,
    skillPaths: projectLocal,
    includeDefaults: false,
  });
}

/**
 * P1 #10: Load a compact index of all skills (project + global) for discovery.
 * Returns only name, description, and path — no file content.
 */
export function loadSkillIndex(
  config: SkillConfig,
  cwd: string,
): Array<{
  name: string;
  description: string;
  path: string;
  source: "project-local" | "global";
}> {
  if (!config.skillsEnabled) return [];

  const { projectLocal, global } = effectiveSkillPaths(config, cwd);
  const seen = new Set<string>();
  const index: Array<{ name: string; description: string; path: string; source: "project-local" | "global" }> = [];

  for (const source of ["project-local", "global"] as const) {
    const paths = source === "project-local" ? projectLocal : global;
    if (paths.length === 0) continue;

    try {
      const result = loadSkills({
        cwd,
        agentDir: config.agentDir,
        skillPaths: paths,
        includeDefaults: false,
      });

      for (const skill of result.skills) {
        const resolved = resolve(skill.filePath);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        index.push({
          name: skill.name,
          description: skill.description,
          path: formatPathForPrompt(skill.filePath),
          source,
        });
      }
    } catch {
      /* ignore */
    }
  }

  return index;
}

export function loadWorkspaceSkills(config: ServerConfig, cwd: string): LoadedSkills {
  if (!config.skillsEnabled) return { skills: [], diagnostics: [] };

  const { projectLocal, global } = effectiveSkillPaths(config, cwd);
  const allPaths = [...projectLocal, ...global];

  return loadSkills({
    cwd,
    agentDir: config.agentDir,
    skillPaths: allPaths,
    includeDefaults: false,
  });
}

export function resolveSkillReadPath(
  skills: Skill[],
  activatedSkillDirs: Set<string>,
  inputPath: string,
): SkillReadResolution | undefined {
  const absolutePath = resolve(expandHomePath(inputPath));

  for (const skill of skills) {
    const skillFilePath = resolve(skill.filePath);
    if (absolutePath === skillFilePath) {
      return { absolutePath, skill, isSkillFile: true };
    }
  }

  for (const skill of skills) {
    const baseDir = resolve(skill.baseDir);
    if (!activatedSkillDirs.has(baseDir)) continue;
    if (!isPathInsideRoot(absolutePath, baseDir)) continue;

    return { absolutePath, skill, isSkillFile: false };
  }

  return undefined;
}

export function markSkillActivated(
  activatedSkillDirs: Set<string>,
  skill: Skill,
): void {
  activatedSkillDirs.add(resolve(skill.baseDir));
}

export function formatPathForPrompt(path: string): string {
  const home = resolve(homedir());
  const resolvedPath = resolve(path);

  if (resolvedPath === home) return "~";
  if (resolvedPath.startsWith(`${home}${sep}`)) {
    return `~/${resolvedPath.slice(home.length + 1).split(sep).join("/")}`;
  }

  return resolvedPath.split(sep).join("/");
}
