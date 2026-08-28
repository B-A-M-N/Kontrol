import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const sourceExtensions = [".js", ".mjs", ".cjs", ".json"];
const moduleReferencePatterns = [
  /\b(?:from|import|export)\s*(["'])([^"']+)\1/g,
  /\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g,
  /\brequire\s*\(\s*(["'])([^"']+)\1\s*\)/g,
  /\bnew\s+URL\s*\(\s*(["'])([^"']+)\1\s*,\s*import\.meta\.url/g,
];
const forbiddenApplicationImportPrefixes = ["src/", "scripts/", "dist/", "releases/"];

function codeFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        visit(path);
      } else if ([".js", ".mjs", ".cjs"].includes(extname(entry.name))) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files;
}

function isWithin(root, path) {
  const rootWithSeparator = root.endsWith(sep) ? root : `${root}${sep}`;
  return path === root || path.startsWith(rootWithSeparator);
}

function resolveModuleFile(path) {
  const candidates = [path];
  if (!extname(path)) {
    for (const extension of sourceExtensions) candidates.push(`${path}${extension}`);
    for (const extension of sourceExtensions) candidates.push(resolve(path, `index${extension}`));
  }
  return candidates.find((candidate) => existsSync(candidate) && lstatSync(candidate).isFile());
}

function isNodeModulesPath(path) {
  return path.split(sep).includes("node_modules");
}

function resolveAbsoluteModuleSpecifier(specifier) {
  if (isAbsolute(specifier)) return resolve(specifier);
  if (!specifier.startsWith("file:")) return undefined;
  try {
    const url = new URL(specifier);
    if (url.protocol !== "file:") return undefined;
    return resolve(fileURLToPath(url));
  } catch {
    return undefined;
  }
}

export function validateRelease(artifactPath) {
  const root = realpathSync(resolve(artifactPath));
  const required = ["cli.js", "server.js", "acp-duplex.js", "acp-worker-token.mjs", "build-meta.json", "ui/workspace-app.html"];
  const missing = required.filter((entry) => !existsSync(resolve(root, entry)));
  if (missing.length > 0) throw new Error(`release is missing required files: ${missing.join(", ")}`);

  const metadata = JSON.parse(readFileSync(resolve(root, "build-meta.json"), "utf8"));
  if (typeof metadata.buildId !== "string" || metadata.buildId.length === 0) {
    throw new Error("release build-meta.json has no buildId");
  }
  for (const field of ["schemaVersion", "minReadableSchemaVersion", "maxReadableSchemaVersion", "releaseFormatVersion"]) {
    if (!Number.isInteger(metadata[field]) || metadata[field] < 0) {
      throw new Error(`release build-meta.json has invalid ${field}`);
    }
  }
  if (metadata.minReadableSchemaVersion > metadata.schemaVersion || metadata.schemaVersion > metadata.maxReadableSchemaVersion) {
    throw new Error("release build-meta.json has incompatible schema bounds");
  }

  const failures = [];
  for (const file of codeFiles(root)) {
    const source = readFileSync(file, "utf8");
    for (const pattern of moduleReferencePatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source))) {
        const specifier = match[2];
        const bareApplicationImport = forbiddenApplicationImportPrefixes.some((prefix) => specifier === prefix.slice(0, -1) || specifier.startsWith(prefix));
        if (bareApplicationImport) {
          failures.push(`${relative(root, file)} -> ${specifier} (forbidden application import)`);
          continue;
        }
        const absolutePath = resolveAbsoluteModuleSpecifier(specifier);
        if (absolutePath) {
          const resolvedPath = resolveModuleFile(absolutePath);
          if (!resolvedPath) {
            failures.push(`${relative(root, file)} -> ${specifier} (missing absolute/file module)`);
            continue;
          }
          const realResolvedPath = realpathSync(resolvedPath);
          const isPackageMetadata = basename(realResolvedPath) === "package.json";
          if (!isWithin(root, realResolvedPath) && !isNodeModulesPath(realResolvedPath) && !isPackageMetadata) {
            failures.push(`${relative(root, file)} -> ${specifier} (${realResolvedPath} escapes release)`);
          }
          continue;
        }
        if (!specifier.startsWith(".")) continue;
        const resolvedPath = resolveModuleFile(resolve(dirname(file), specifier));
        if (!resolvedPath) {
          failures.push(`${relative(root, file)} -> ${specifier} (missing relative module)`);
          continue;
        }
        const realResolvedPath = realpathSync(resolvedPath);
        const isPackageMetadata = basename(realResolvedPath) === "package.json";
        if (!isWithin(root, realResolvedPath) && !isNodeModulesPath(realResolvedPath) && !isPackageMetadata) {
          failures.push(`${relative(root, file)} -> ${specifier} (${realResolvedPath} escapes release)`);
        }
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`release-local module validation failed:\n${failures.join("\n")}`);
  }
  return { artifactPath: root, buildId: metadata.buildId };
}

async function main() {
  const artifactPath = process.argv[2];
  if (!artifactPath) throw new Error("Usage: validate-release.mjs ARTIFACT_PATH");
  const result = validateRelease(artifactPath);
  console.log(`[release-validate] release-local imports passed for ${result.buildId} (${result.artifactPath})`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`[release-validate] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
