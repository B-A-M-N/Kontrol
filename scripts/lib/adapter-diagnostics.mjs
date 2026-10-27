// Secret hygiene for adapter diagnostic output.
//
// An adapter log is an operator-facing surface, but it is still a log: a
// launcher traceback can echo a profile path, an authorization header, a
// bearer token, or a control-plane secret. Everything the adapters print to
// their own log therefore passes through this scrubber first. The same
// redaction rules that protect durable receipts protect the log.

const REDACTED = "[REDACTED]";

/** Value patterns redacted even without a sensitive key. */
const VALUE_PATTERNS = [
  { pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: "Bearer [REDACTED]" },
  { pattern: /Basic\s+[A-Za-z0-9+/=]+/gi, replacement: "Basic [REDACTED]" },
  { pattern: /(?:authorization|cookie|set-cookie)\s*:\s*\S+/gi, replacement: REDACTED },
];

/** key=value / key: value forms whose key looks sensitive. */
const SENSITIVE_KEY_PATTERN =
  /([A-Za-z0-9_\-]*(?:token|secret|password|credential|private[\-_]?key|api[\-_]?key|access[\-_]?key|refresh[\-_]?key|agent[\-_]?key)[a-z0-9_\-]*)\s*[=:]\s*("[^"]*"|[^\s&"]+)/gi;

/** Control-plane namespaces never belong in a log line. */
const CONTROL_PLANE_PATTERN =
  /\b(KONTROL_[A-Z0-9_]*|ACP_[A-Z0-9_]*|OAUTH_[A-Z0-9_]*|REVIEWER_[A-Z0-9_]*|TUNNEL_[A-Z0-9_]*)\s*[=:]\s*("[^"]*"|[^\s&"]+)/g;

/** A JSON Web Token: three base64url segments. */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;

/**
 * Remove credential material from diagnostic text before it is printed or
 * persisted. This is deliberately conservative: it redacts shapes that look
 * like secrets rather than trying to know every credential the operator has.
 */
export function scrubAdapterDiagnostic(text) {
  let result = String(text ?? "");
  for (const { pattern, replacement } of VALUE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  result = result.replace(SENSITIVE_KEY_PATTERN, (_match, key) => key + "=" + REDACTED);
  result = result.replace(CONTROL_PLANE_PATTERN, (_match, key) => key + "=" + REDACTED);
  result = result.replace(JWT_PATTERN, REDACTED);
  return result;
}

/** Scrub, then keep only the last maxBytes bytes of UTF-8 text. */
export function scrubbedDiagnosticTail(text, maxBytes) {
  const scrubbed = scrubAdapterDiagnostic(text);
  const encoded = Buffer.from(scrubbed, "utf8");
  if (encoded.byteLength <= maxBytes) return scrubbed;
  let start = Math.max(0, encoded.byteLength - maxBytes);
  while (start < encoded.byteLength && (encoded[start] & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString("utf8");
}

/**
 * A stable, non-revealing category for a failed spawn.
 *
 * The category never contains the child's stderr, the spawn error message, or
 * a path. It is the only part of a probe failure that may travel into an
 * error message, because that message reaches a scheduled-job receipt.
 */
export function probeFailureCategory(result) {
  if (result?.error) {
    return result.error.code === "ETIMEDOUT" ? "timed_out" : "spawn_failed";
  }
  const status = result?.status;
  if (status === null || status === undefined) return "terminated_without_status";
  return "exit_" + status;
}

/**
 * The bounded, scrubbed detail of a failed spawn. Log-only: it may contain a
 * traceback, so it must never be placed in an error message.
 */
export function probeFailureDetail(result, maxBytes = 2_000) {
  const parts = [];
  if (result?.error?.message) parts.push("error=" + scrubbedDiagnosticTail(result.error.message, 512));
  if (result?.stdout) parts.push("stdout=" + scrubbedDiagnosticTail(result.stdout, 512));
  if (result?.stderr) parts.push("stderr=" + scrubbedDiagnosticTail(result.stderr, maxBytes));
  return parts.join(" ");
}
