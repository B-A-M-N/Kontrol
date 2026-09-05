/**
 * Zod request schemas for the ACP HTTP surface.
 *
 * Extracted verbatim from acp-server.ts (P1 decomposition).
 */
import * as z from "zod/v4";

export const acpRunRequestSchema = z.object({
  agent_name: z.string().min(1),
  input: z.array(z.object({
    parts: z.array(z.object({ content: z.string().optional() }).passthrough()).optional(),
  }).passthrough()).min(1),
  mode: z.enum(["sync", "async", "stream"]).optional(),
  session_id: z.string().min(1).optional(),
  work_session_id: z.string().min(1).optional(),
  workspace_id: z.string().min(1).optional(),
  workspace_session_id: z.string().min(1).optional(),
  webhook_url: z.string().min(1).optional(),
});

export const agentRegistrationSchema = z.object({
  name: z.string().min(1).max(200),
  url: z.string().url(),
  description: z.string().max(2_000).optional(),
  publicKey: z.string().max(10_000).optional(),
  capabilities: z.array(z.string().max(200)).max(100).optional(),
  tags: z.array(z.string().max(100)).max(100).optional(),
  ttlSeconds: z.number().int().min(10).max(31_536_000).optional(),
  role: z.string().max(100).optional(),
});

export const acpRunEventSchema = z.object({
  remote_run_id: z.string().min(1).optional(),
  work_session_id: z.string().min(1).optional(),
  agent_id: z.string().min(1).optional(),
  // P0 #7: adapters echo the dispatch attempt number. Events from a
  // superseded attempt (an earlier continuation of the same logical run) are
  // rejected so a late event from attempt N cannot mutate attempt N+1.
  attempt_number: z.number().int().positive().optional(),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
});
