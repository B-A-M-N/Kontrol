import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LEGACY_WORKSPACE_APP_URI = "ui://kontrol/workspace-app.html";
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
  return !html.includes(`src="./workspace-app.tsx"`)
    && !html.includes(`href="./workspace-app.css"`)
    && html.includes("<script");
}

const resolved = resolveWorkspaceAppArtifact();
export const WORKSPACE_APP_HTML = resolved.html;
export const WORKSPACE_APP_ARTIFACT_SOURCE: WorkspaceAppArtifactSource = resolved.source;
export const WORKSPACE_APP_BUILD_ID = createHash("sha256").update(WORKSPACE_APP_HTML).digest("hex").slice(0, 12);
export const WORKSPACE_APP_URI = `ui://kontrol/workspace-app-${WORKSPACE_APP_BUILD_ID}.html`;
// ChatGPT hosts that still use the legacy OpenAI template key require the
// Skybridge MIME type. Keep this separate from the standards-based MCP App
// resource above so each host receives the representation it understands.
export const OPENAI_WORKSPACE_APP_URI = `ui://kontrol/workspace-app-${WORKSPACE_APP_BUILD_ID}.skybridge.html`;

// Hosts can cache the template URI independently of the MCP connection. A
// rebuild therefore must continue serving previously generated hashes; the
// HTML is the same compatibility resource from the host's perspective.
const HISTORICAL_WORKSPACE_APP_URI = /^ui:\/\/kontrol\/workspace-app-[a-f0-9]{12}\.html$/;
const HISTORICAL_OPENAI_WORKSPACE_APP_URI = /^ui:\/\/kontrol\/workspace-app-[a-f0-9]{12}\.skybridge\.html$/;

export type WorkspaceAppResourceKind = "current" | "openai" | "legacy" | "devdesktop";

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

const workspaceAppResourceMetadata = Object.freeze({ ui: Object.freeze({ prefersBorder: true }) });
const workspaceAppToolMetadata = new Map<string, Readonly<Record<string, unknown>>>();

export function workspaceAppResourceKind(value: unknown): WorkspaceAppResourceKind | undefined {
  if (typeof value !== "string") return undefined;
  if (value === WORKSPACE_APP_URI || HISTORICAL_WORKSPACE_APP_URI.test(value)) return "current";
  if (value === OPENAI_WORKSPACE_APP_URI || HISTORICAL_OPENAI_WORKSPACE_APP_URI.test(value)) return "openai";
  if (value === LEGACY_WORKSPACE_APP_URI) return "legacy";
  if (value === DEVDESKTOP_WORKSPACE_APP_URI) return "devdesktop";
  return undefined;
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
    "openai/outputTemplate": OPENAI_WORKSPACE_APP_URI,
    "openai/widgetAccessible": true,
  });
  workspaceAppToolMetadata.set(key, metadata);
  return metadata;
}

export function workspaceAppResourceMeta() {
  return workspaceAppResourceMetadata;
}
