import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LEGACY_WORKSPACE_APP_URI = "ui://kontrol/workspace-app.html";
// The OpenAI tunnel can replay cards created while this project was named
// DevDesktop. Retain this exact URI until those cached cards age out.
export const DEVDESKTOP_WORKSPACE_APP_URI = "ui://devdesktop/workspace-app.html";
export const WORKSPACE_APP_HTML = readFileSync(fileURLToPath(new URL("../dist/ui/workspace-app.html", import.meta.url)), "utf8");
export const WORKSPACE_APP_BUILD_ID = createHash("sha256").update(WORKSPACE_APP_HTML).digest("hex").slice(0, 12);
export const WORKSPACE_APP_URI = `ui://kontrol/workspace-app-${WORKSPACE_APP_BUILD_ID}.html`;
// ChatGPT hosts that still use the legacy OpenAI template key require the
// Skybridge MIME type. Keep this separate from the standards-based MCP App
// resource above so each host receives the representation it understands.
export const OPENAI_WORKSPACE_APP_URI = `ui://kontrol/workspace-app-${WORKSPACE_APP_BUILD_ID}.skybridge.html`;

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

export function isWorkspaceAppUri(value: unknown): boolean {
  return value === WORKSPACE_APP_URI
    || value === LEGACY_WORKSPACE_APP_URI
    || value === DEVDESKTOP_WORKSPACE_APP_URI
    || value === OPENAI_WORKSPACE_APP_URI;
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
