/**
 * Shared tool-result helpers: content inspection, text summaries, error
 * previews, and the failed-call log path. Extracted verbatim from
 * src/mcp/workspace-server.ts (P1.3).
 */
import { performance } from "node:perf_hooks";
import type { ServerConfig } from "../config.js";
import { redactedPreview } from "../redaction.js";
import { logToolCall, type ToolLogFields } from "./tool-logging.js";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export const MAX_INSPECTION_RESULT_BYTES = 48_000;

export interface BoundedInspectionContent {
  content: ToolContent[];
  truncated: boolean;
  returnedLines: number;
  characters: number;
  bytes: number;
}

/** Bound text sent by structured inspection tools and keep a useful continuation point. */
export function boundInspectionContent(
  content: ToolContent[],
  options: { maxBytes?: number; offset?: number; nextOffset?: number; sourceTruncated?: boolean } = {},
): BoundedInspectionContent {
  const maxBytes = Math.max(256, options.maxBytes ?? MAX_INSPECTION_RESULT_BYTES);
  const textBlocks = content.filter((block): block is { type: "text"; text: string } => block.type === "text");
  const text = contentText(textBlocks);
  const textBytes = Buffer.byteLength(text, "utf8");
  if (textBytes <= maxBytes && !options.sourceTruncated) {
    return {
      content,
      truncated: false,
      returnedLines: contentLineCount(text),
      characters: text.length,
      bytes: textBytes,
    };
  }

  const sourceLimitMarker = "\n\n[The inspection tool limited this result. Narrow the path/pattern or continue with the reported read offset.]";
  if (options.sourceTruncated && textBytes + Buffer.byteLength(sourceLimitMarker, "utf8") <= maxBytes) {
    let markerAppended = false;
    const withLimitNotice = content.map((block) => {
      if (block.type !== "text") return block;
      const next = !markerAppended ? { ...block, text: `${block.text}${sourceLimitMarker}` } : block;
      markerAppended = true;
      return next;
    });
    return {
      content: withLimitNotice,
      truncated: true,
      returnedLines: contentLineCount(text),
      characters: text.length + sourceLimitMarker.length,
      bytes: textBytes + Buffer.byteLength(sourceLimitMarker, "utf8"),
    };
  }

  const markerReserve = 192;
  const budget = Math.max(1, maxBytes - markerReserve);
  let end = 0;
  let usedBytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + characterBytes > budget) break;
    usedBytes += characterBytes;
    end += character.length;
  }
  const newline = text.lastIndexOf("\n", end);
  if (newline >= Math.floor(end * 0.5)) end = newline;
  const kept = text.slice(0, end);
  const returnedLines = contentLineCount(kept);
  const nextOffset = options.nextOffset ?? ((options.offset ?? 1) + returnedLines);
  const marker = `\n\n[Kontrol capped this inspection at ${returnedLines} returned lines and ${Buffer.byteLength(kept, "utf8")} bytes. Continue with offset=${nextOffset} for read, or narrow the search/list scope.]`;
  const boundedText = `${kept}${marker}`;
  return {
    content: [textBlock(boundedText)],
    truncated: true,
    returnedLines,
    characters: boundedText.length,
    bytes: Buffer.byteLength(boundedText, "utf8"),
  };
}

export interface DiffStats {
  additions: number;
  removals: number;
}

export function contentText(content: ToolContent[]): string {
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function toolErrorPreview(content: ToolContent[]): string | undefined {
  const text = redactedPreview(contentText(content).replace(/\s+/g, " ").trim());
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

export function logFailedToolResponse(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  content: ToolContent[],
  startedAt: number,
): void {
  logToolCall(config, {
    ...fields,
    success: false,
    durationMs: Math.round(performance.now() - startedAt),
    error: toolErrorPreview(content),
  });
}

export function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

export function textSummary(content: ToolContent[]): {
  lines: number;
  characters: number;
} {
  const text = contentText(content);
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}

export function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n").length
    : content.split("\n").length;
}

export function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}

export function newFilePatch(path: string, content: string): string {
  const lines =
    content.length === 0
      ? []
      : content.endsWith("\n")
        ? content.slice(0, -1).split("\n")
        : content.split("\n");
  const hunkLength = lines.length;
  const hunkRange = hunkLength === 0 ? "+0,0" : `+1,${hunkLength}`;
  const body = lines.map((line) => `+${line}`).join("\n");

  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 ${hunkRange} @@`,
    body,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
