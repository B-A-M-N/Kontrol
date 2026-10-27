export type McpFailureClass =
  | "transport_closed"
  | "connection_reset"
  | "session_expired"
  | "temporarily_unavailable"
  | "protocol_error"
  | "authorization_denied"
  | "tool_error"
  | "ambiguous_completion";

function errorParts(value: unknown): { message: string; status?: number; code?: number | string; name?: string } {
  if (typeof value === "string") return { message: value };
  if (!value || typeof value !== "object") return { message: String(value) };
  const item = value as Record<string, unknown>;
  const response = item.response && typeof item.response === "object" ? item.response as Record<string, unknown> : undefined;
  const cause = item.cause && typeof item.cause === "object" ? item.cause as Record<string, unknown> : undefined;
  const status = Number(response?.status ?? item.status ?? item.statusCode ?? cause?.status);
  const code = item.code ?? cause?.code;
  const message = [item.message, cause?.message, item.error]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
  return {
    message,
    ...(Number.isFinite(status) && status > 0 ? { status } : {}),
    ...(typeof code === "number" || typeof code === "string" ? { code } : {}),
    ...(typeof item.name === "string" ? { name: item.name } : {}),
  };
}

/** Classifies host/SDK failures without treating JSON-RPC application errors as transport loss. */
export function classifyMcpFailure(value: unknown): McpFailureClass {
  const { message, status, code, name } = errorParts(value);
  const text = `${name ?? ""} ${String(code ?? "")} ${message}`.toLowerCase();
  if (status === 404 || /\bhttp(?: status)? 404\b|session (?:is )?(?:expired|unknown|not found)|unknown session|session expired/.test(text)) return "session_expired";
  if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|authorization denied|permission denied/.test(text)) return "authorization_denied";
  if (status === 429 || status === 502 || status === 503 || status === 504 || /\bhttp(?: status)? (?:429|502|503|504)\b|temporarily unavailable|overloaded|capacity is temporarily exhausted/.test(text)) return "temporarily_unavailable";
  if (/econnreset|connection reset|socket hang up|econnaborted|networkerror|failed to fetch/.test(text)) return "connection_reset";
  if (/connection closed|transport closed|transport is closed|app is already connected|channel closed|peer closed/.test(text)) return "transport_closed";
  if (/json.?rpc|protocol|parse error|invalid request|unexpected response/.test(text)) return "protocol_error";
  if (/may have committed|response was lost|ambiguous completion/.test(text)) return "ambiguous_completion";
  return "tool_error";
}

export function isMcpReconnectFailure(failure: McpFailureClass): boolean {
  return failure === "transport_closed" || failure === "connection_reset"
    || failure === "session_expired" || failure === "temporarily_unavailable";
}
