/**
 * Workspace App MCP resources: the content-hashed app plus the legacy,
 * OpenAI-compatibility, and DevDesktop-migration template URIs. Extracted
 * verbatim from src/mcp/workspace-server.ts (P1.3).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ServerConfig } from "../../config.js";
import { logEvent } from "../../logger.js";
import {
  WORKSPACE_APP_ARTIFACT_SOURCE,
  WORKSPACE_APP_SMOKE_URI,
  configureWorkspaceAppResourceRegistry,
  workspaceAppResourceEntries,
} from "../../workspace-app-resource.js";

export function registerWorkspaceAppResources(
  server: McpServer,
  config: ServerConfig,
  onWorkspaceAppResource: ((uri: string) => void) | undefined,
): void {
  configureWorkspaceAppResourceRegistry(config.stateDir);
  for (const artifact of workspaceAppResourceEntries()) {
    const name = artifact.kind === "current"
      ? "Kontrol Workspace App"
      : artifact.kind === "previous"
        ? `Kontrol Workspace App (previous ${artifact.buildId})`
        : artifact.kind === "openai"
          ? "Kontrol Workspace App (OpenAI compatibility)"
          : artifact.kind === "legacy"
            ? "Kontrol Workspace App (legacy)"
            : "Kontrol Workspace App (DevDesktop migration)";
    const description = artifact.kind === "current"
      ? "Interactive Kontrol workspace and review interface."
      : artifact.kind === "previous"
        ? "Retained immutable Workspace App artifact for a previously advertised content hash."
        : "Compatibility resource for existing Workspace App cards.";
    const metadata = artifact.metadata ?? {};
    const serve = async () => {
      onWorkspaceAppResource?.(artifact.uri);
      logEvent(config.logging, "info", "workspace_app_resource_served", {
        uri: artifact.uri,
        buildId: artifact.buildId,
        generationId: artifact.generationId ?? config.launchGenerationId,
        resourceKind: artifact.kind,
        mimeType: artifact.mimeType,
        bytes: Buffer.byteLength(artifact.html, "utf8"),
      });
      return {
        contents: [{
          uri: artifact.uri,
          mimeType: artifact.mimeType,
          text: artifact.html,
          ...(Object.keys(metadata).length > 0 ? { _meta: metadata } : {}),
        }],
      };
    };
    if (artifact.kind === "current" || artifact.kind === "previous") {
      registerAppResource(server, name, artifact.uri, { description, _meta: metadata }, serve);
    } else {
      server.registerResource(name, artifact.uri, { mimeType: artifact.mimeType, description }, serve);
    }
  }

  if (config.workspaceAppSmokeEnabled) {
    const smokePath = join(dirname(WORKSPACE_APP_ARTIFACT_SOURCE.path), "workspace-app-smoke.html");
    if (!existsSync(smokePath)) {
      throw new Error(`KONTROL_DEV_WORKSPACE_APP_SMOKE is enabled but the diagnostic app artifact is missing: ${smokePath}`);
    }
    const smokeHtml = readFileSync(smokePath, "utf8");
    if (!/<html\b/i.test(smokeHtml) || !/<script\b[^>]*>[\s\S]*?<\/script>/i.test(smokeHtml)) {
      throw new Error(`Diagnostic Workspace App artifact is not a self-contained HTML app: ${smokePath}`);
    }
    registerAppResource(
      server,
      "Kontrol Workspace App connection smoke",
      WORKSPACE_APP_SMOKE_URI,
      {
        description: "Tiny isolated App SDK handshake check for diagnosing host embedding failures.",
        _meta: { ui: { prefersBorder: true } },
      },
      async () => ({
        contents: [{ uri: WORKSPACE_APP_SMOKE_URI, mimeType: RESOURCE_MIME_TYPE, text: smokeHtml, _meta: { ui: { prefersBorder: true } } }],
      }),
    );
    registerAppTool(
      server,
      "workspace_app_smoke",
      {
        title: "Workspace App connection smoke",
        description: "Open the tiny MCP Apps SDK diagnostic surface and report whether its handshake connects.",
        inputSchema: {},
        _meta: { ui: { resourceUri: WORKSPACE_APP_SMOKE_URI, visibility: ["model"] } },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      async () => ({
        content: [{ type: "text", text: "The diagnostic Workspace App is open. Its status will report whether the MCP Apps handshake connected." }],
        structuredContent: { status: "opened", resourceUri: WORKSPACE_APP_SMOKE_URI },
      }),
    );
  }
}
