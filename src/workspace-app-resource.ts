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

export function isWorkspaceAppUri(value: unknown): boolean {
  return value === WORKSPACE_APP_URI
    || value === LEGACY_WORKSPACE_APP_URI
    || value === DEVDESKTOP_WORKSPACE_APP_URI
    || value === OPENAI_WORKSPACE_APP_URI;
}

export function workspaceAppToolMeta(visibility: readonly ("model" | "app")[] = ["model", "app"]) {
  return {
    ui: { resourceUri: WORKSPACE_APP_URI, visibility },
    "openai/outputTemplate": OPENAI_WORKSPACE_APP_URI,
    "openai/widgetAccessible": true,
  };
}

export function workspaceAppResourceMeta() {
  return { ui: { prefersBorder: true } };
}
