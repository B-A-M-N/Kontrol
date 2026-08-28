import {
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
const marker = join(root, ".kontrol-package-dist.json");
const buildResult = join(root, ".kontrol-build-result.json");
const originalDistBackup = join(root, ".kontrol-package-dist-original");

function prepare() {
  let target;
  const distExists = existsSync(dist) || (() => {
    try { return lstatSync(dist).isSymbolicLink(); } catch { return false; }
  })();
  const originalLinkTarget = distExists && lstatSync(dist).isSymbolicLink()
    ? readlinkSync(dist)
    : undefined;
  let originalTarget;
  if (originalLinkTarget !== undefined) {
    // A failed/manual projection may be a broken symlink. It must not make
    // prepack fail before the immutable build-result candidate is considered.
    try { originalTarget = realpathSync(dist); } catch { originalTarget = undefined; }
  }
  const originalDirectory = distExists && originalLinkTarget === undefined && !originalTarget;
  if (originalDirectory && existsSync(originalDistBackup)) {
    throw new Error(`Refusing to overwrite stale package dist backup: ${originalDistBackup}`);
  }
  if (existsSync(buildResult)) {
    const result = JSON.parse(readFileSync(buildResult, "utf8"));
    target = result.artifactPath ? realpathSync(resolve(root, result.artifactPath)) : undefined;
  } else if (existsSync(dist) && lstatSync(dist).isSymbolicLink()) {
    target = realpathSync(dist);
  }
  if (!target) return;
  const releasesRoot = realpathSync(join(root, "releases"));
  if (!target.startsWith(`${releasesRoot}/`)) {
    throw new Error(`Refusing to package unexpected dist target: ${target}`);
  }
  writeFileSync(marker, JSON.stringify({
    target,
    hadDist: distExists,
    originalTarget,
    originalLinkTarget,
    originalBackup: originalDirectory ? originalDistBackup : undefined,
  }));
  if (originalDirectory) renameSync(dist, originalDistBackup);
  else if (distExists) unlinkSync(dist);
  cpSync(target, dist, { recursive: true });
}

function restore() {
  if (!existsSync(marker)) return;
  const { target, hadDist = true, originalTarget, originalLinkTarget, originalBackup } = JSON.parse(readFileSync(marker, "utf8"));
  if (!target || !existsSync(target)) throw new Error(`Cannot restore packaged dist target: ${target ?? "missing"}`);
  rmSync(dist, { recursive: true, force: true });
  if (originalTarget) symlinkSync(originalTarget, dist, "dir");
  else if (originalLinkTarget !== undefined) symlinkSync(originalLinkTarget, dist, "dir");
  else if (originalBackup && existsSync(originalBackup)) renameSync(originalBackup, dist);
  unlinkSync(marker);
}

const mode = process.argv[2];
if (mode === "prepare") prepare();
else if (mode === "restore") restore();
else throw new Error("Usage: package-dist.mjs <prepare|restore>");
