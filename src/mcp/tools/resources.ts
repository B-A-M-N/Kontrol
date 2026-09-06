/**
 * Workspace App MCP resources: the content-hashed app plus the legacy,
 * OpenAI-compatibility, and DevDesktop-migration template URIs. Extracted
 * verbatim from src/mcp/workspace-server.ts (P1.3).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { ServerConfig } from "../../config.js";
import { logEvent } from "../../logger.js";
import {
  DEVDESKTOP_WORKSPACE_APP_URI,
  LEGACY_WORKSPACE_APP_URI,
  OPENAI_WORKSPACE_APP_URI,
  WORKSPACE_APP_BUILD_ID,
  WORKSPACE_APP_HTML,
  WORKSPACE_APP_URI,
  workspaceAppResourceMeta,
} from "../../workspace-app-resource.js";

export function registerWorkspaceAppResources(
  server: McpServer,
  config: ServerConfig,
  onWorkspaceAppResource: ((uri: string) => void) | undefined,
): void {
  registerAppResource(
    server,
    "Kontrol Workspace App",
    WORKSPACE_APP_URI,
    {
      description: "Interactive Kontrol workspace and review interface.",
      _meta: workspaceAppResourceMeta(),
    },
    async () => {
      onWorkspaceAppResource?.(WORKSPACE_APP_URI);
      logEvent(config.logging, "info", "workspace_app_resource_served", {
        uri: WORKSPACE_APP_URI,
        buildId: WORKSPACE_APP_BUILD_ID,
        mimeType: RESOURCE_MIME_TYPE,
        bytes: Buffer.byteLength(WORKSPACE_APP_HTML, "utf8"),
      });
      return { contents: [{ uri: WORKSPACE_APP_URI, mimeType: RESOURCE_MIME_TYPE, text: WORKSPACE_APP_HTML, _meta: workspaceAppResourceMeta() }] };
    },
  );
  // Existing ChatGPT cards already cache the original URI under OpenAI's
  // output-template key. Serve its legacy representation so Retry can repair
  // those cards; new MCP Apps use the content-hashed standards URI above.
  server.registerResource(
    "Kontrol Workspace App (legacy)",
    LEGACY_WORKSPACE_APP_URI,
    { mimeType: "text/html+skybridge", description: "Legacy ChatGPT template." },
    async () => {
      onWorkspaceAppResource?.(LEGACY_WORKSPACE_APP_URI);
      logEvent(config.logging, "info", "workspace_app_resource_served", {
        uri: LEGACY_WORKSPACE_APP_URI,
        buildId: WORKSPACE_APP_BUILD_ID,
        mimeType: "text/html+skybridge",
        bytes: Buffer.byteLength(WORKSPACE_APP_HTML, "utf8"),
      });
      return { contents: [{ uri: LEGACY_WORKSPACE_APP_URI, mimeType: "text/html+skybridge", text: WORKSPACE_APP_HTML }] };
    },
  );
  server.registerResource(
    "Kontrol Workspace App (OpenAI compatibility)",
    OPENAI_WORKSPACE_APP_URI,
    { mimeType: "text/html+skybridge", description: "OpenAI compatibility template." },
    async () => {
      onWorkspaceAppResource?.(OPENAI_WORKSPACE_APP_URI);
      logEvent(config.logging, "info", "workspace_app_resource_served", {
        uri: OPENAI_WORKSPACE_APP_URI,
        buildId: WORKSPACE_APP_BUILD_ID,
        mimeType: "text/html+skybridge",
        bytes: Buffer.byteLength(WORKSPACE_APP_HTML, "utf8"),
      });
      return { contents: [{ uri: OPENAI_WORKSPACE_APP_URI, mimeType: "text/html+skybridge", text: WORKSPACE_APP_HTML }] };
    },
  );
  server.registerResource(
    "Kontrol Workspace App (DevDesktop migration)",
    DEVDESKTOP_WORKSPACE_APP_URI,
    { mimeType: "text/html+skybridge", description: "Compatibility template for cached DevDesktop cards." },
    async () => {
      onWorkspaceAppResource?.(DEVDESKTOP_WORKSPACE_APP_URI);
      logEvent(config.logging, "info", "workspace_app_resource_served", {
        uri: DEVDESKTOP_WORKSPACE_APP_URI,
        buildId: WORKSPACE_APP_BUILD_ID,
        mimeType: "text/html+skybridge",
        bytes: Buffer.byteLength(WORKSPACE_APP_HTML, "utf8"),
      });
      return { contents: [{ uri: DEVDESKTOP_WORKSPACE_APP_URI, mimeType: "text/html+skybridge", text: WORKSPACE_APP_HTML }] };
    },
  );
}
