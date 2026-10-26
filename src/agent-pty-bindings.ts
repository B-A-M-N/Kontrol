import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./db/client.js";

export type AgentPtyBindingStatus = "attached" | "detached" | "exited" | "lost";

export interface AgentPtyBinding {
  id: string;
  processSessionId: string;
  workspaceSessionId: string;
  workSessionId: string;
  runId: string;
  agentName: string;
  ownerPrincipalId: string;
  processGeneration: number;
  outputCursor: number;
  status: AgentPtyBindingStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

interface AgentPtyBindingRow extends Omit<AgentPtyBinding, "finishedAt"> {
  finishedAt: string | null;
}

export interface AgentPtyBindingStore {
  attach(input: {
    processSessionId: string;
    workspaceSessionId: string;
    workSessionId: string;
    runId: string;
    ownerPrincipalId: string;
    running: boolean;
    outputCursor: number;
  }): AgentPtyBinding;
  advanceOutputCursor(processSessionId: string, processGeneration: number, outputCursor: number): void;
  finish(processSessionId: string, processGeneration: number, outputCursor: number): void;
  markUnresolvedLost(now?: string): number;
  getByProcessSession(processSessionId: string): AgentPtyBinding | undefined;
  listForWorkSession(workSessionId: string, limit?: number): AgentPtyBinding[];
}

function mapRow(row: AgentPtyBindingRow): AgentPtyBinding {
  return {
    ...row,
    finishedAt: row.finishedAt ?? undefined,
  };
}

export function createAgentPtyBindingStore(sqlite: SqliteDatabase): AgentPtyBindingStore {
  const selectedColumns = `id, process_session_id as processSessionId,
    workspace_session_id as workspaceSessionId, work_session_id as workSessionId,
    run_id as runId, agent_name as agentName, owner_principal_id as ownerPrincipalId,
    process_generation as processGeneration, output_cursor as outputCursor,
    status, created_at as createdAt, updated_at as updatedAt, finished_at as finishedAt`;
  const selectByProcess = sqlite.prepare(`select ${selectedColumns} from agent_pty_bindings where process_session_id = ? order by process_generation desc limit 1`);
  const selectByWorkSession = sqlite.prepare(
    `select ${selectedColumns} from agent_pty_bindings where work_session_id = ? order by process_generation desc limit ?`,
  );
  const insertBinding = sqlite.prepare(`
    insert into agent_pty_bindings (
      id, process_session_id, workspace_session_id, work_session_id, run_id,
      agent_name, owner_principal_id, process_generation, output_cursor,
      status, created_at, updated_at, finished_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const attach = sqlite.transaction((input: Parameters<AgentPtyBindingStore["attach"]>[0]) => {
    const authority = sqlite.prepare(`
      select r.agent_name as agent_name, r.workspace_session_id as run_workspace_id,
        r.work_session_id as run_work_session_id, r.status as run_status,
        w.workspace_session_id as session_workspace_id
      from acp_runs r join work_sessions w on w.id = r.work_session_id
      where r.run_id = ? and r.work_session_id = ?
    `).get(input.runId, input.workSessionId) as {
      agent_name?: string;
      run_workspace_id?: string | null;
      run_work_session_id?: string | null;
      run_status?: string;
      session_workspace_id?: string;
    } | undefined;
    if (!authority || authority.run_work_session_id !== input.workSessionId
      || authority.session_workspace_id !== input.workspaceSessionId
      || (authority.run_workspace_id && authority.run_workspace_id !== input.workspaceSessionId)
      || authority.run_status !== "running") {
      throw new Error("Agent PTY binding does not match the authenticated run and workspace session.");
    }
    if (input.ownerPrincipalId !== `worker-work-session:${input.workSessionId}`) {
      throw new Error("Agent PTY binding principal does not match the authenticated work session.");
    }
    const generationRow = sqlite.prepare(
      "select coalesce(max(process_generation), 0) as generation from agent_pty_bindings where work_session_id = ?",
    ).get(input.workSessionId) as { generation: number };
    const now = new Date().toISOString();
    const row: AgentPtyBinding = {
      id: `pty_${randomUUID()}`,
      processSessionId: input.processSessionId,
      workspaceSessionId: input.workspaceSessionId,
      workSessionId: input.workSessionId,
      runId: input.runId,
      agentName: authority.agent_name ?? "unknown",
      ownerPrincipalId: input.ownerPrincipalId,
      processGeneration: generationRow.generation + 1,
      outputCursor: Math.max(0, Math.floor(input.outputCursor)),
      status: input.running ? "attached" : "exited",
      createdAt: now,
      updatedAt: now,
      ...(!input.running ? { finishedAt: now } : {}),
    };
    insertBinding.run(
      row.id, row.processSessionId, row.workspaceSessionId, row.workSessionId, row.runId,
      row.agentName, row.ownerPrincipalId, row.processGeneration, row.outputCursor,
      row.status, row.createdAt, row.updatedAt, row.finishedAt ?? null,
    );
    return row;
  });
  const advance = sqlite.prepare(`
    update agent_pty_bindings set output_cursor = ?, updated_at = ?
    where process_session_id = ? and process_generation = ? and output_cursor < ? and status in ('attached', 'detached')
  `);
  const finish = sqlite.prepare(`
    update agent_pty_bindings set status = 'exited', output_cursor = max(output_cursor, ?),
      updated_at = ?, finished_at = coalesce(finished_at, ?)
    where process_session_id = ? and process_generation = ? and status in ('attached', 'detached')
  `);
  const markLost = sqlite.prepare(`
    update agent_pty_bindings set status = 'lost', updated_at = ?
    where status in ('attached', 'detached')
  `);

  return {
    attach,
    advanceOutputCursor(processSessionId, processGeneration, outputCursor) {
      if (!Number.isSafeInteger(outputCursor) || outputCursor < 0) return;
      const now = new Date().toISOString();
      advance.run(outputCursor, now, processSessionId, processGeneration, outputCursor);
    },
    finish(processSessionId, processGeneration, outputCursor) {
      const now = new Date().toISOString();
      finish.run(Math.max(0, Math.floor(outputCursor)), now, now, processSessionId, processGeneration);
    },
    markUnresolvedLost(now = new Date().toISOString()) {
      return markLost.run(now).changes;
    },
    getByProcessSession(processSessionId) {
      const row = selectByProcess.get(processSessionId) as AgentPtyBindingRow | undefined;
      return row ? mapRow(row) : undefined;
    },
    listForWorkSession(workSessionId, limit = 50) {
      const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(200, limit)) : 50;
      return (selectByWorkSession.all(workSessionId, boundedLimit) as AgentPtyBindingRow[]).map(mapRow);
    },
  };
}
