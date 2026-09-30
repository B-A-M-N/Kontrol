import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const LEGACY_WORKSPACE_APP_URI = "ui://kontrol/workspace-app.html";
export const WORKSPACE_APP_SMOKE_URI = "ui://kontrol/workspace-app-smoke-v1.html";
// The OpenAI tunnel can replay cards created while this project was named
// DevDesktop. Retain this exact URI until those cached cards age out.
export const DEVDESKTOP_WORKSPACE_APP_URI = "ui://devdesktop/workspace-app.html";

export interface WorkspaceAppArtifactSource {
  /** Where the artifact was found; for diagnostics and failure messages. */
  readonly path: string;
  /** How the resolver chose this path. */
  readonly provenance:
    | "explicit-override"
    | "compiled-release"
    | "built-dev-candidate"
    | "dist-projection";
}

/**
 * Resolve the self-contained Workspace App HTML artifact.
 *
 * P0 fix (source-mode resolution): the previous resolver inferred UI
 * provenance from `moduleDirectory` alone. Under a compiled release that is
 * `dist/` and the sibling `ui/workspace-app.html` is the correct single-file
 * artifact — but under `npm run dev` (tsx) the same rule picked up
 * `src/ui/workspace-app.html`, which is the Vite *input template* (external
 * `<link>` + `<script type="module">`), not a self-contained MCP App. Serving
 * that template through `resources/read` hands the host a broken application
 * resource.
 *
 * The resolver is therefore explicit about what it accepts, in priority
 * order:
 *
 * 1. `KONTROL_WORKSPACE_APP_HTML_PATH` — an explicit override; the dev
 *    watcher (`scripts/dev-server.mjs`) sets it after building the UI into a
 *    dedicated development directory.
 * 2. A sibling `ui/workspace-app.html` next to a *compiled* module — proven
 *    by the presence of `build-meta.json` beside this file (present only in a
 *    release tree; the source tree never has it under `src/`).
 * 3. A built candidate under `<cwd>/dist/ui/workspace-app.html` — accepted
 *    for source-mode only when it exists AND is self-contained (its own
 *    content check), so a stale-but-valid dev projection still works and an
 *    invalid one can never masquerade as the app.
 *
 * The Vite template under `src/ui/` is never a candidate: no rule can return
 * it.
 */
function resolveWorkspaceAppArtifact(): { html: string; source: WorkspaceAppArtifactSource } {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));

  const override = process.env.KONTROL_WORKSPACE_APP_HTML_PATH;
  if (override) {
    const path = resolve(override);
    if (!existsSync(path)) {
      throw new Error(
        `KONTROL_WORKSPACE_APP_HTML_PATH points at a missing Workspace App artifact: ${path}`,
      );
    }
    return { html: readFileSync(path, "utf8"), source: { path, provenance: "explicit-override" } };
  }

  // Compiled release: build-meta.json exists beside this module only when the
  // module itself was emitted by tsc into a release tree. This excludes the
  // source checkout, where moduleDirectory is src/ and there is no metadata.
  const compiledSibling = join(moduleDirectory, "ui", "workspace-app.html");
  if (existsSync(join(moduleDirectory, "build-meta.json")) && existsSync(compiledSibling)) {
    return {
      html: readFileSync(compiledSibling, "utf8"),
      source: { path: compiledSibling, provenance: "compiled-release" },
    };
  }

  // Source checkout: accept an explicitly built dev candidate (dev-server.mjs
  // writes one) or the checkout dist projection — but only after proving the
  // candidate is the built single-file app, not the Vite template.
  const moduleDirName = moduleDirectory.split(/[\\/]/).pop();
  if (moduleDirName === "src" || !existsSync(join(moduleDirectory, "build-meta.json"))) {
    const candidates = [
      process.env.KONTROL_DEV_UI_DIR ? resolve(process.env.KONTROL_DEV_UI_DIR, "workspace-app.html") : undefined,
      resolve(process.cwd(), "dist", "ui", "workspace-app.html"),
    ].filter((path): path is string => Boolean(path));
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      const html = readFileSync(candidate, "utf8");
      if (!isSelfContainedWorkspaceAppHtml(html)) {
        throw new Error(
          `Workspace App artifact at ${candidate} is not a self-contained MCP App (it looks like the Vite input template). `
            + "Rebuild the UI (npm run build:app or npm run dev, which builds it automatically) before serving resources.",
        );
      }
      return {
        html,
        source: {
          path: candidate,
          provenance: process.env.KONTROL_DEV_UI_DIR && candidate.startsWith(resolve(process.env.KONTROL_DEV_UI_DIR))
            ? "built-dev-candidate"
            : "dist-projection",
        },
      };
    }
    // Nothing acceptable exists. Fail loudly rather than silently serving the
    // source template — a missing artifact must be a startup error, not a
    // broken resource body.
    throw new Error(
      "No built Workspace App artifact found. In a source checkout, run `npm run build:app` "
        + "(or `npm run dev`, which builds it) or set KONTROL_WORKSPACE_APP_HTML_PATH to a built workspace-app.html.",
    );
  }

  // Compiled tree without the UI artifact — a broken release build.
  throw new Error(
    `Compiled release at ${moduleDirectory} is missing ui/workspace-app.html; the release build is broken.`,
  );
}

/**
 * Structural check distinguishing the built single-file app from the Vite
 * input template. The template references external `./workspace-app.css` and
 * `./workspace-app.tsx`; the built app inlines everything and carries the
 * Kontrol app bootstrap marker.
 */
export function isSelfContainedWorkspaceAppHtml(html: string): boolean {
  if (html.includes(`src="./workspace-app.tsx"`) || html.includes(`href="./workspace-app.css"`)) return false;
  if (!/<main\b[^>]*\bid=["']app["']/i.test(html)) return false;
  if (!/<title>\s*Kontrol Diff\s*<\/title>/i.test(html)) return false;
  if (!/<style\b[^>]*>[\s\S]*?<\/style>/i.test(html)) return false;
  if (!/<script\b[^>]*>[\s\S]*?<\/script>/i.test(html)) return false;
  if (/<script\b[^>]*\bsrc=["'][^"']+["']/i.test(html)) return false;
  if (/<link\b[^>]*\bhref=["'][^"']+\.css(?:["'?#])/i.test(html)) return false;
  // A single-file MCP App must not depend on any external script, style,
  // image, font, or nested-frame URL. The host may enforce a strict CSP, so
  // proving the built artifact has no external resource tags is stronger than
  // checking only the known Vite template filenames.
  if (/<(?:script|link|img|source|iframe|video|audio)\b[^>]*\b(?:src|href|srcset|poster)\s*=\s*["'][^"']+["']/i.test(html)) return false;
  return true;
}

const resolved = resolveWorkspaceAppArtifact();
export const WORKSPACE_APP_HTML = resolved.html;
export const WORKSPACE_APP_ARTIFACT_SOURCE: WorkspaceAppArtifactSource = resolved.source;
export const WORKSPACE_APP_BUILD_ID = createHash("sha256").update(WORKSPACE_APP_HTML).digest("hex").slice(0, 12);
export const WORKSPACE_APP_URI = `ui://kontrol/workspace-app-${WORKSPACE_APP_BUILD_ID}.html`;
// ChatGPT hosts that still use the legacy OpenAI template key require the
// Skybridge MIME type. Keep this separate from the standards-based MCP App
// resource above so each host receives the representation it understands. New
// tool metadata advertises only WORKSPACE_APP_URI; this URI remains available
// for cached legacy cards and diagnostics.
export const OPENAI_WORKSPACE_APP_URI = `ui://kontrol/workspace-app-${WORKSPACE_APP_BUILD_ID}.skybridge.html`;

// Compatibility URIs are explicit retained resources only. Arbitrary
// historical hashes are rejected rather than being treated as aliases for the
// current bundle; each retained URI must map to an actually registered
// resource.
export type WorkspaceAppResourceKind = "current" | "previous" | "openai" | "legacy" | "devdesktop";

export interface WorkspaceAppResourceEntry {
  readonly uri: string;
  readonly html: string;
  readonly mimeType: string;
  readonly kind: WorkspaceAppResourceKind;
  readonly buildId: string;
  readonly generationId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * P1 #35: measured sunset plan for compatibility resource URIs. Each legacy
 * URI is retained only while it still receives real traffic. The per-URI
 * counters live in server.ts (`workspaceAppResourceMetrics`:
 * currentHashed / openAiCompatibility / legacyKontrol /
 * devDesktopMigration) and are exported under authenticated diagnostics.
 *
 * Removal criterion per URI: after 90 consecutive days of zero recorded
 * requests (checked via the diagnostics export), delete its constant, its
 * entry in isWorkspaceAppUri(), and its serving branch. Never remove blindly
 * — a host replaying old card metadata would break invisibly. Current status
 * (recorded at MVP freeze):
 *   - LEGACY_WORKSPACE_APP_URI: retained (traffic observed)
 *   - OPENAI_WORKSPACE_APP_URI: retained (active OpenAI template key)
 *   - DEVDESKTOP_WORKSPACE_APP_URI: retained (tunnel card cache aging out)
 */

const workspaceAppResourceMetadata = Object.freeze({
  ui: Object.freeze({
    prefersBorder: true,
    permissions: Object.freeze({ clipboardWrite: Object.freeze({}) }),
  }),
});
const workspaceAppToolMetadata = new Map<string, Readonly<Record<string, unknown>>>();
const workspaceAppCallableMetadata = Object.freeze({
  ui: Object.freeze({ visibility: Object.freeze(["app"]) }),
  "openai/widgetAccessible": true,
});
const workspaceAppResourceRegistry = new Map<string, WorkspaceAppResourceEntry>();
const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const LEGACY_APP_RESOURCE_MIME_TYPE = "text/html+skybridge";
const MAX_RETAINED_PREVIOUS_WORKSPACE_APPS = 2;

function resetWorkspaceAppResourceRegistry(): void {
  workspaceAppResourceRegistry.clear();
  workspaceAppResourceRegistry.set(WORKSPACE_APP_URI, Object.freeze({
    uri: WORKSPACE_APP_URI,
    html: WORKSPACE_APP_HTML,
    mimeType: MCP_APP_RESOURCE_MIME_TYPE,
    kind: "current",
    buildId: WORKSPACE_APP_BUILD_ID,
    metadata: workspaceAppResourceMetadata,
  }));
  for (const [uri, kind] of [
    [OPENAI_WORKSPACE_APP_URI, "openai"],
    [LEGACY_WORKSPACE_APP_URI, "legacy"],
    [DEVDESKTOP_WORKSPACE_APP_URI, "devdesktop"],
  ] as const) {
    workspaceAppResourceRegistry.set(uri, Object.freeze({
      uri,
      html: WORKSPACE_APP_HTML,
      mimeType: LEGACY_APP_RESOURCE_MIME_TYPE,
      kind,
      buildId: WORKSPACE_APP_BUILD_ID,
    }));
  }
}

function releaseRootForCurrentArtifact(): string | undefined {
  let directory = dirname(WORKSPACE_APP_ARTIFACT_SOURCE.path);
  for (let depth = 0; depth < 8; depth += 1) {
    if (basename(directory) === "releases") return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}

interface PreviousArtifactReference {
  value: string;
}

/** generation.json is a stable Kontrol-owned record; read only its documented
 * immutable-release pointers. Generic recursive key discovery could mistake
 * a candidate/deployment record for the serving generation and retain the
 * wrong HTML behind an otherwise valid old content hash. */
function previousArtifactReferences(value: unknown): PreviousArtifactReference[] {
  if (typeof value !== "object" || value === null) return [];
  const generation = value as Record<string, unknown>;
  const references = [
    generation.previousArtifactPath,
    generation.lastKnownGoodArtifactPath,
    generation.previousBuildId,
    generation.lastKnownGoodBuildId,
  ];
  return references
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .map((entry) => ({ value: entry }));
}

function resolvePreviousHtmlPaths(value: unknown, releaseRoot: string): string[] {
  const values = typeof value === "string" ? [value] : [];
  const htmlPaths: string[] = [];
  for (const raw of values) {
    const rawPath = /^[a-f0-9]{12,64}$/i.test(raw)
      ? join(releaseRoot, raw)
      : isAbsolute(raw) ? resolve(raw) : resolve(releaseRoot, raw);
    for (const candidate of [rawPath, join(rawPath, "ui", "workspace-app.html"), join(rawPath, "workspace-app.html")]) {
      try {
        const real = realpathSync(candidate);
        const releaseRootReal = realpathSync(releaseRoot);
        if (!real.startsWith(`${releaseRootReal}${sep}`) || !statSync(real).isFile()) continue;
        if (basename(real) !== "workspace-app.html") continue;
        if (statSync(real).size > 20 * 1024 * 1024) continue;
        htmlPaths.push(real);
      } catch {
        // A stale generation pointer may name an already-pruned artifact.
      }
    }
  }
  return [...new Set(htmlPaths)];
}

/**
 * Load the current generation's bounded previous-artifact set. The HTTP
 * fastpath and MCP resources/list share this exact registry, so a hashed URI
 * can never silently resolve to another build's HTML.
 */
export function configureWorkspaceAppResourceRegistry(stateDir?: string): void {
  resetWorkspaceAppResourceRegistry();
  if (!stateDir) return;
  const releaseRoot = releaseRootForCurrentArtifact();
  if (!releaseRoot) return;
  let generation: unknown;
  try {
    generation = JSON.parse(readFileSync(join(stateDir, "generation.json"), "utf8"));
  } catch {
    return;
  }
  const retained = new Set<string>();
  for (const reference of previousArtifactReferences(generation)) {
    for (const htmlPath of resolvePreviousHtmlPaths(reference.value, releaseRoot)) {
      let html: string;
      try { html = readFileSync(htmlPath, "utf8"); } catch { continue; }
      if (!isSelfContainedWorkspaceAppHtml(html)) continue;
      const buildId = createHash("sha256").update(html).digest("hex").slice(0, 12);
      if (buildId === WORKSPACE_APP_BUILD_ID) continue;
      const uri = `ui://kontrol/workspace-app-${buildId}.html`;
      if (retained.has(uri)) continue;
      retained.add(uri);
      workspaceAppResourceRegistry.set(uri, Object.freeze({
        uri,
        html,
        mimeType: MCP_APP_RESOURCE_MIME_TYPE,
        kind: "previous",
        buildId,
        metadata: workspaceAppResourceMetadata,
      }));
      if (retained.size >= MAX_RETAINED_PREVIOUS_WORKSPACE_APPS) return;
    }
  }
}

resetWorkspaceAppResourceRegistry();

export function workspaceAppResourceEntries(): WorkspaceAppResourceEntry[] {
  return [...workspaceAppResourceRegistry.values()];
}

export function workspaceAppResource(value: unknown): WorkspaceAppResourceEntry | undefined {
  return typeof value === "string" ? workspaceAppResourceRegistry.get(value) : undefined;
}

export function isWorkspaceAppHashedUri(value: unknown): value is string {
  return typeof value === "string" && /^ui:\/\/kontrol\/workspace-app-[a-f0-9]{12}\.html$/i.test(value);
}

export function workspaceAppResourceKind(value: unknown): WorkspaceAppResourceKind | undefined {
  return workspaceAppResource(value)?.kind;
}

export function isWorkspaceAppUri(value: unknown): boolean {
  return workspaceAppResourceKind(value) !== undefined;
}

export function workspaceAppToolMeta(visibility: readonly ("model" | "app")[] = ["model", "app"]) {
  const key = visibility.join(",");
  const cached = workspaceAppToolMetadata.get(key);
  if (cached) return cached;
  const metadata = Object.freeze({
    ui: Object.freeze({ resourceUri: WORKSPACE_APP_URI, visibility: [...visibility] }),
    ...(visibility.includes("app") ? { "openai/widgetAccessible": true } : {}),
  });
  workspaceAppToolMetadata.set(key, metadata);
  return metadata;
}

/** Metadata for intentional model-invoked render tools. */
export function workspaceAppRenderToolMeta() {
  return workspaceAppToolMeta(["model"]);
}

/** Metadata for tools the Workspace App may call without mounting the app as their renderer. */
export function workspaceAppCallableToolMeta() {
  return workspaceAppCallableMetadata;
}

export function workspaceAppResourceMeta() {
  return workspaceAppResourceMetadata;
}
