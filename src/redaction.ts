/**
 * P0.6: one sanitizer for every durable/observable tool telemetry surface —
 * console logging, work-session tool-event persistence, the durable event
 * log, diagnostic previews, and ACP output summaries.
 *
 * Shell telemetry additionally stores a hash + bounded redacted preview
 * instead of raw command text: a command like `env`, `cat ~/.aws/credentials`,
 * or `echo "$SOME_SECRET"` must not leave credentials in SQLite or event
 * history forever. This compounds the P0.1 environment isolation — even if a
 * secret reaches a shell command string, it must not persist.
 */

const DEFAULT_PREVIEW_LENGTH = 160;

import { createHash } from "node:crypto";

/** Keys whose values must never be persisted, regardless of value shape. */
const SENSITIVE_KEY_PATTERN =
  /(?:^|[_\-.])(?:token|secret|password|credential|private[_\-.]?key|api[_\-.]?key|authorization|cookie|session)(?:$|[_\-.])|(^|[_\-.])(kontrol|acp|oauth|reviewer|tunnel)(?:$|[_\-.])/i;

/** Value patterns redacted even without a sensitive key (Bearer headers, etc). */
const VALUE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: "Bearer [REDACTED]" },
  { pattern: /Basic\s+[A-Za-z0-9+/=]+/gi, replacement: "Basic [REDACTED]" },
  { pattern: /(?:authorization|cookie|set-cookie)\s*:\s*\S+/gi, replacement: "[REDACTED]" },
];

const REDACTED = "[REDACTED]";

/** Keys of env-like records whose entire presence is reportable but not their value. */
export function isSensitiveKeyName(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/** Redact occurrences of exact configured secret values. */
export function redactExactSecrets(text: string, secrets: Iterable<string>): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= 8 && result.includes(secret)) {
      result = result.split(secret).join(REDACTED);
    }
  }
  return result;
}

/** Deep-redact a JSON-able value before it is stringified for persistence. */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = isSensitiveKeyName(key) ? REDACTED : redactValue(entry);
    }
    return result;
  }
  return value;
}

export function redactString(text: string): string {
  let result = text;
  for (const { pattern, replacement } of VALUE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  // key=value / key: value forms where the key looks sensitive
  result = result.replace(
    /([A-Za-z0-9_\-]*(?:token|secret|password|credential|private[_\-]?key|api[_\-]?key)[a-z0-9_\-]*)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s&"'`]+)/gi,
    (_match, key: string) => `${key}=${REDACTED}`,
  );
  // Control-plane namespaces never belong in telemetry values.
  result = result.replace(
    /\b(KONTROL_[A-Z0-9_]*|ACP_[A-Z0-9_]*|OAUTH_[A-Z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s&"'`]+)/g,
    (_match, key: string) => `${key}=${REDACTED}`,
  );
  return result;
}

/** Redact, then bound to a preview length. */
export function redactedPreview(text: string, maxLength: number = DEFAULT_PREVIEW_LENGTH): string {
  const redacted = redactString(text);
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength - 3)}...` : redacted;
}

/**
 * P0.6 storage model for shell telemetry: identity, shape, and outcome —
 * never the raw command string. `commandHash` (SHA-256) keeps correlation
 * and dedup possible without keeping the text.
 */
export interface ShellTelemetryRecord {
  commandHash: string;
  commandPreview: string;
  commandLength: number;
}

export async function shellTelemetry(
  command: string,
  previewLength: number = DEFAULT_PREVIEW_LENGTH,
): Promise<ShellTelemetryRecord> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(command));
  return {
    commandHash: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    commandPreview: redactedPreview(command, previewLength),
    commandLength: command.length,
  };
}

/** Synchronous variant for hot paths that cannot await (hash via one-shot). */
export function shellTelemetrySync(command: string, previewLength: number = DEFAULT_PREVIEW_LENGTH): ShellTelemetryRecord {
  return {
    commandHash: createHash("sha256").update(command).digest("hex"),
    commandPreview: redactedPreview(command, previewLength),
    commandLength: command.length,
  };
}
