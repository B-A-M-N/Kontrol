import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LEGACY_WORKSPACE_APP_URI = "ui://kontrol/workspace-app.html";
// The OpenAI tunnel can replay cards created while this project was named
// DevDesktop. Retain this exact URI until those cached cards age out.
export const DEVDESKTOP_WORKSPACE_APP_URI = "ui://devdesktop/workspace-app.html";
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const localWorkspaceApp = join(moduleDirectory, "ui", "workspace-app.html");
const sourceWorkspaceApp = join(process.cwd(), "dist", "ui", "workspace-app.html");
// Compiled immutable releases carry their UI beside this module. Source-mode
// tsx runs retain the checkout dist/ fallback used by the development server.
export const WORKSPACE_APP_HTML = readFileSync(
  existsSync(localWorkspaceApp) ? localWorkspaceApp : sourceWorkspaceApp,
  "utf8",
);
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
 * requests (checked via the diagnostics counters at release time), delete
 * its constant, its entry in isWorkspaceAppUri(), and its serving branch.
 * Never remove blindly — a host replaying old card metadata would break
 * invisibly. Current status (recorded at MVP freeze):
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
