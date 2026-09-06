/**
 * Shared zod output schemas and tool-annotation constants for the MCP
 * workspace surface. Extracted verbatim from src/mcp/workspace-server.ts
 * (P1.3).
 */
import * as z from "zod/v4";

export function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    status: z.string().optional(),
    approvalId: z.string().optional(),
    retryable: z.boolean().optional(),
    ...extra,
  };
}

/**
 * Explicit opaque operation-resume identity (audit P1). A caller whose tool
 * call returned approval_required retries with the SAME arguments plus this
 * field set to the approvalId it was shown. The server verifies the echoed
 * operation content against the durable approval row before honoring the
 * original human decision, so a reconnect that lost its conversation
 * correlation can still consume "Approve Once" instead of prompting again.
 */
export const approvalResumeIdSchema = z
  .string()
  .optional()
  .describe(
    "Opaque resume token: the approvalId returned in a prior approval_required result. Retry the identical tool call with this field set to consume the human's original decision.",
  );

export const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

export const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

export const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

export const reviewFileOutputSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  additions: z.number(),
  removals: z.number(),
});

export const reviewSummaryOutputSchema = z.object({
  files: z.number(),
  additions: z.number(),
  removals: z.number(),
});

export const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
export const EDIT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
export const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
