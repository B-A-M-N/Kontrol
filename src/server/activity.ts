/**
 * Kontrol-native activity surface (Finding 9): a loopback-only,
 * diagnostics-credential-gated HTML page plus its JSON projection over
 * the existing MCP operation diagnostics. It renders actual operations
 * (including direct workspace tool calls with no work session), is
 * usable independently of any MCP host (e.g. in a desktop browser while
 * voice interaction runs elsewhere), and shows only scoped metadata.
 * No new authentication, tunnel, or orchestration controller.
 */
import { timingSafeEqual } from "node:crypto";
import type { ServerConfig } from "../config.js";
import { requestIp } from "../logger.js";
import type { McpSessionState } from "./mcp-session-state.js";
import { projectActivity } from "./activity-projection.js";
import type { McpOperationDiagnostics } from "./mcp-operation-diagnostics.js";
import type { Request, Response } from "express";

export interface ActivityDeps {
  readonly config: ServerConfig;
  readonly mcpSessions: Map<string, McpSessionState>;
  readonly operationDiagnostics: McpOperationDiagnostics;
  /** workSessionId → workspaceSessionId lookup (may be empty). */
  workSessionWorkspace?: ReadonlyMap<string, string> | (() => ReadonlyMap<string, string>);
}

function gated(deps: ActivityDeps, req: Request, res: Response): boolean {
  const ip = requestIp(req, deps.config.logging.trustProxy) || "";
  if (ip && !ip.startsWith("127.") && !ip.startsWith("::1") && ip !== "::ffff:127.0.0.1") {
    res.status(403).json({ ok: false, error: "Forbidden: activity is loopback-only" });
    return false;
  }
  if (!deps.config.diagnosticsSecret) {
    res.status(404).json({ ok: false, error: "Activity disabled" });
    return false;
  }
  const provided = req.header("x-kontrol-diagnostics") || "";
  const expected = deps.config.diagnosticsSecret;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(403).json({ ok: false, error: "Forbidden: valid X-Kontrol-Diagnostics credential required" });
    return false;
  }
  return true;
}

export function handleActivityData(deps: ActivityDeps, req: Request, res: Response): unknown {
  if (!gated(deps, req, res)) return undefined;
  const snapshot = deps.operationDiagnostics.snapshot();
  const workspaces = typeof deps.workSessionWorkspace === "function"
    ? deps.workSessionWorkspace()
    : deps.workSessionWorkspace ?? new Map<string, string>();
  return res.json(projectActivity(
    { active: snapshot.active as Array<Record<string, unknown>>, recent: snapshot.recent as unknown as Array<Record<string, unknown>> },
    deps.mcpSessions,
    workspaces,
  ));
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Kontrol — Activity</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:1100px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left;font-size:13px}.stale{color:#b06000}</style></head>
<body><h1>Kontrol activity</h1>
<p>Loopback-only. Enter the diagnostics credential to load the live projection (kept in memory only, never in the URL).</p>
<p><input id="secret" type="password" placeholder="X-Kontrol-Diagnostics credential"> <button id="load">Load</button> <span id="status"></span></p>
<table id="active"></table><h2>Recent</h2><table id="recent"></table>
<script>
let secret = "";
async function load(){
  const r = await fetch("/activity/data", {headers: {"x-kontrol-diagnostics": secret}});
  const status = document.getElementById("status");
  if(!r.ok){ status.textContent = "Load failed: " + r.status; return; }
  const data = await r.json();
  status.textContent = "Updated " + data.generatedAt + " — " + data.counts.active + " active, " + data.counts.recent + " recent (" + data.counts.excludedUnattributed + " unattributed excluded)";
  const render = (rows, el) => {
    el.innerHTML = "<tr><th>Status</th><th>Tool</th><th>Owner</th><th>Work session</th><th>Workspace</th><th>Elapsed</th><th>Started</th></tr>" + rows.map(row =>
      "<tr" + (row.stale ? ' class="stale"' : "") + "><td>" + row.status + (row.errorClass ? " (" + row.errorClass + ")" : "") + "</td><td>" + (row.toolName || row.method) + "</td><td>" + row.owner + "</td><td>" + (row.workSessionId || "—") + "</td><td>" + (row.workspaceSessionId || "—") + "</td><td>" + row.elapsedMs + " ms</td><td>" + row.startedAt + "</td></tr>"
    ).join("");
  };
  render(data.active, document.getElementById("active"));
  render(data.recent, document.getElementById("recent"));
}
document.getElementById("load").addEventListener("click", () => {
  secret = document.getElementById("secret").value;
  load();
  setInterval(load, 5000);
});
</script></body></html>`;

export function handleActivityPage(_deps: ActivityDeps, _req: Request, res: Response): unknown {
  res.type("html").send(PAGE);
  return undefined;
}
