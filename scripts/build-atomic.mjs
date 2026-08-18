import { chmodSync, copyFileSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempDist = mkdtempSync(join(root, ".kontrol-build-"));
let backupDist;
const previousDist = join(root, "dist.previous");

function run(command, args) {
  execFileSync(command, args, {
    cwd: root,
    env: { ...process.env, KONTROL_BUILD_OUTPUT_DIR: tempDist },
    stdio: "inherit",
  });
}

try {
  // Every producer writes only to the isolated candidate tree. The live dist/
  // directory is untouched until all source, UI, metadata, and entrypoint
  // checks pass.
  run("npm", ["run", "build:app"]);
  run("npx", ["tsc", "-p", "tsconfig.build.json", "--outDir", tempDist]);

  const workerToken = join(root, "src/acp-worker-token.mjs");
  if (existsSync(workerToken)) copyFileSync(workerToken, join(tempDist, "acp-worker-token.mjs"));
  chmodSync(join(tempDist, "cli.js"), 0o755);
  run(process.execPath, ["scripts/generate-build-meta.mjs"]);

  for (const required of ["cli.js", "server.js", "acp-duplex.js", "build-meta.json", "ui/workspace-app.html"]) {
    if (!existsSync(join(tempDist, required))) throw new Error(`Atomic build candidate is missing ${required}`);
  }

  if (existsSync(join(root, "dist"))) {
    if (existsSync(previousDist)) rmSync(previousDist, { recursive: true, force: true });
    backupDist = mkdtempSync(join(root, ".kontrol-dist-backup-"));
    rmSync(backupDist, { recursive: true, force: true });
    renameSync(join(root, "dist"), backupDist);
  }
  renameSync(tempDist, join(root, "dist"));
  if (backupDist) renameSync(backupDist, previousDist);
  backupDist = undefined;
  console.log(`[build-atomic] promoted candidate to dist/ (previous generation retained at ${previousDist})`);
} catch (error) {
  console.error(`[build-atomic] failed: ${error instanceof Error ? error.message : String(error)}`);
  if (backupDist && !existsSync(join(root, "dist"))) {
    renameSync(backupDist, join(root, "dist"));
    backupDist = undefined;
    console.error("[build-atomic] restored previous dist/");
  }
  process.exitCode = 1;
} finally {
  if (existsSync(tempDist)) rmSync(tempDist, { recursive: true, force: true });
  if (backupDist && existsSync(backupDist)) rmSync(backupDist, { recursive: true, force: true });
}
