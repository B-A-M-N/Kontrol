import { createHash } from "node:crypto";
import { z } from "zod/v4";

export const TOOL_CATALOG_ACK_METHOD = "notifications/experimental/kontrol/tool-catalog-accepted";
export const TOOL_CATALOG_ACK_CAPABILITY = "kontrol.dev/tool-catalog-ack-v1";

export interface ToolCatalogFingerprint {
  sha256: string;
  toolCount: number;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Fingerprint the exact tools/list descriptor set using stable JSON object-key
 * ordering and name ordering. MCP clients implementing the catalog-ack-v1
 * extension must hash the callable tool catalog they actually registered.
 */
export function fingerprintToolCatalog(value: unknown): ToolCatalogFingerprint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const tools = (value as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return undefined;
  const namedTools = tools.map((tool) => {
    if (!tool || typeof tool !== "object" || typeof (tool as { name?: unknown }).name !== "string") return undefined;
    return tool as Record<string, unknown>;
  });
  if (namedTools.some((tool) => !tool)) return undefined;
  const sortedTools = (namedTools as Array<Record<string, unknown>>).sort((a, b) =>
    String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0);
  if (new Set(sortedTools.map((tool) => tool.name)).size !== sortedTools.length) return undefined;
  const sha256 = createHash("sha256").update(canonicalJson(sortedTools)).digest("hex");
  return { sha256, toolCount: sortedTools.length };
}

export const ToolCatalogAcceptedNotificationSchema = z.object({
  method: z.literal(TOOL_CATALOG_ACK_METHOD),
  params: z.object({
    contractVersion: z.literal(1),
    serverVersion: z.string().min(1).max(256),
    hostCatalogSha256: z.string().regex(/^[a-f0-9]{64}$/),
    hostToolCount: z.number().int().nonnegative(),
  }),
});

export type ToolCatalogAcceptedNotification = z.infer<typeof ToolCatalogAcceptedNotificationSchema>;
