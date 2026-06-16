import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const releasesDir = join(repoRoot, "releases");
const currentLink = join(releasesDir, "current");

function run(command, args) {
  execFileSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
}

function getGitShortSha() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return "nogit";
  }
}

function getReleaseId() {
  if (process.env.DEVSPACE_RELEASE_ID) return process.env.DEVSPACE_RELEASE_ID;

  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

  return `${timestamp}-${getGitShortSha()}`;
}

const releaseId = getReleaseId();
const releaseDir = join(releasesDir, releaseId);
const releaseDistDir = join(releaseDir, "dist");
const tmpLink = join(releasesDir, ".current-tmp");

if (existsSync(releaseDir)) {
  throw new Error(`Release already exists: ${releaseDir}`);
}

run("npm", ["run", "build"]);

mkdirSync(releasesDir, { recursive: true });
mkdirSync(releaseDir, { recursive: true });
cpSync(join(repoRoot, "dist"), releaseDistDir, { recursive: true });
writeFileSync(
  join(releaseDir, "release.json"),
  JSON.stringify(
    {
      id: releaseId,
      createdAt: new Date().toISOString(),
      gitCommit: getGitShortSha(),
    },
    null,
    2,
  ) + "\n",
);

rmSync(tmpLink, { force: true, recursive: true });
try {
  symlinkSync(releaseId, tmpLink, "dir");
  renameSync(tmpLink, currentLink);
} catch (error) {
  rmSync(tmpLink, { force: true, recursive: true });
  rmSync(currentLink, { force: true, recursive: true });
  cpSync(releaseDir, currentLink, { recursive: true });
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`Could not update releases/current as a symlink; copied release instead. ${reason}`);
}

console.log(`Created release ${releaseId}`);
console.log(`Run it with: npm run release:start`);
console.log(`Current release points to: ${basename(releaseId)}`);
