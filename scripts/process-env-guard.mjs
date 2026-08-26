// Review P0.1 / P1 #15: static security invariant for control-plane child
// processes.
//
// Production code must NOT spawn processes with wholesale `process.env`
// inheritance (env: process.env or { ...process.env }) — that leaks
// KONTROL_*, ACP, OAuth, tunnel, and reviewer credentials into any child,
// including ones capable of executing project/repository-controlled behavior.
// Spawns must go through buildChildEnvironment() / the explicit allowlist.
//
// Exceptions are audited annotations on the line ABOVE the finding:
//   // kontrol-env-exception: <reason>
// (This file's own comment text mentioning the pattern is skipped below.)
//
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["src", "scripts"];
const EXTS = [".ts", ".mts", ".mjs"];
const SKIP = [/\.test\.(ts|mjs|mts)$/, /node_modules/, /\/dist\//];

const findings = [];
let exceptions = 0;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (EXTS.some((ext) => full.endsWith(ext))) yield full;
  }
}

const ENV_INHERIT = /(^|[^.\w])(?:env:\s*process\.env\s*[,}]|\{\s*\.\.\.process\.env)/;
const SELF_FILE = "process-env-guard.mjs";

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(root, dir))) {
    if (SKIP.some((pattern) => pattern.test(file))) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      // Skip this file's own documentation comments mentioning the pattern.
      if (file.endsWith(SELF_FILE) && lines[i].trimStart().startsWith("//")) continue;
      if (!ENV_INHERIT.test(lines[i])) continue;
      // Exception annotation may sit anywhere in the comment block above the
      // finding; blank lines are transparent, code stops the search.
      let annotated = false;
      for (let j = i - 1; j >= 0; j--) {
        const trimmed = lines[j].trim();
        if (trimmed === "") continue;
        if (lines[j].trimStart().startsWith("//")) {
          if (/kontrol-env-exception:/.test(lines[j])) { annotated = true; break; }
          continue;
        }
        break;
      }
      if (annotated) {
        exceptions++;
        continue;
      }
      findings.push(`${file}:${i + 1}: process.env inherited into child environment — ${lines[i].trim()}`);
    }
  }
}

if (findings.length > 0) {
  console.error(`process-env-guard: ${findings.length} violation(s)`);
  for (const finding of findings) console.error(`  ${finding}`);
  console.error(
    "\nChild processes must receive an explicit scrubbed environment (buildChildEnvironment()).",
    "\nIf a spawn genuinely needs host env inheritance, annotate the line above with:",
    "\n  // kontrol-env-exception: <why this is safe>",
  );
  process.exit(1);
}

console.log(`process-env-guard: clean (${exceptions} audited exception(s))`);
