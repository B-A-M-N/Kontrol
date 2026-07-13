export interface AcpAgentRef {
  name: string;
  url: string;
  description?: string;
}

export interface AcpRunResult {
  agentName: string;
  runId: string;
  status: string;
  output: Array<{ role: string; parts: Array<{ content_type: string; content?: string }> }>;
  sessionId?: string;
  error?: string;
}

export interface AcpClient {
  listAgents(serverUrl: string): Promise<Array<{ name: string; description: string }>>;
  createRun(serverUrl: string, agentName: string, input: string, sessionId?: string): Promise<AcpRunResult>;
  getRun(serverUrl: string, runId: string): Promise<AcpRunResult>;
  resumeRun(serverUrl: string, runId: string, sessionId: string, verdict: string, comments?: string): Promise<AcpRunResult>;
}

export function createAcpClient(): AcpClient {
  return new HttpAcpClient();
}

class HttpAcpClient implements AcpClient {
  async listAgents(serverUrl: string): Promise<Array<{ name: string; description: string }>> {
    const url = `${serverUrl.replace(/\/+$/, "")}/agents`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`ACP agent list failed: ${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as { agents: Array<{ name: string; description: string }> };
    return body.agents ?? [];
  }

  async createRun(
    serverUrl: string,
    agentName: string,
    input: string,
    sessionId?: string,
  ): Promise<AcpRunResult> {
    const url = `${serverUrl.replace(/\/+$/, "")}/runs`;
    const body = {
      agent_name: agentName,
      mode: "sync",
      ...(sessionId ? { session_id: sessionId } : {}),
      input: [
        {
          role: "user",
          parts: [{ content_type: "text/plain", content: input }],
        },
      ],
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "unknown");
      throw new Error(`ACP createRun failed: ${response.status} - ${errorBody}`);
    }

    const result = (await response.json()) as {
      agent_name: string;
      run_id: string;
      status: string;
      session_id?: string;
      output?: Array<{ role: string; parts: Array<{ content_type: string; content?: string }> }>;
      error?: { message: string };
    };

    return {
      agentName: result.agent_name,
      runId: result.run_id,
      status: result.status,
      output: result.output ?? [],
      sessionId: result.session_id,
      error: result.error?.message,
    };
  }

  async getRun(serverUrl: string, runId: string): Promise<AcpRunResult> {
    const url = `${serverUrl.replace(/\/+$/, "")}/runs/${encodeURIComponent(runId)}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`ACP getRun failed: ${response.status}`);
    }

    const result = (await response.json()) as {
      agent_name: string;
      run_id: string;
      status: string;
      session_id?: string;
      output?: Array<{ role: string; parts: Array<{ content_type: string; content?: string }> }>;
      error?: { message: string };
    };

    return {
      agentName: result.agent_name,
      runId: result.run_id,
      status: result.status,
      output: result.output ?? [],
      sessionId: result.session_id,
      error: result.error?.message,
    };
  }

  async resumeRun(
    serverUrl: string,
    runId: string,
    sessionId: string,
    verdict: string,
    comments?: string,
  ): Promise<AcpRunResult> {
    const url = `${serverUrl.replace(/\/+$/, "")}/runs/${encodeURIComponent(runId)}`;
    const body = {
      run_id: runId,
      mode: "sync",
      await_resume: {
        session_id: sessionId,
        verdict,
        comments: comments ?? "",
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "unknown");
      throw new Error(`ACP resumeRun failed: ${response.status} - ${errorBody}`);
    }

    const result = (await response.json()) as {
      agent_name: string;
      run_id: string;
      status: string;
      session_id?: string;
      output?: Array<{ role: string; parts: Array<{ content_type: string; content?: string }> }>;
      error?: { message: string };
    };

    return {
      agentName: result.agent_name,
      runId: result.run_id,
      status: result.status,
      output: result.output ?? [],
      sessionId: result.session_id,
      error: result.error?.message,
    };
  }
}
