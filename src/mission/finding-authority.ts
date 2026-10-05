import { createHash } from "node:crypto";

export type FindingStatusInput = "open" | "claimed_resolved" | "verified_resolved" | "waived";

export function assertFindingStatusTransition(input: { id: string; status: FindingStatusInput; waiverReason?: string }): void {
  if (input.status === "verified_resolved") {
    throw new Error(`Finding ${input.id} cannot be directly marked verified_resolved; use independent resolution evidence.`);
  }
  if (input.status === "waived" && !input.waiverReason?.trim()) {
    throw new Error(`Waiving finding ${input.id} requires a waiverReason.`);
  }
}

export function fingerprintFinding(finding: {
  category?: string | null;
  scope?: string | null;
  description: string;
  requiredAction: string;
  evidence?: unknown[] | string | null;
}): string {
  const rawEvidence = typeof finding.evidence === "string" ? parseJson<unknown[]>(finding.evidence, []) : finding.evidence ?? [];
  const locations = rawEvidence.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as Record<string, unknown>;
    return [value.file, value.path, value.symbol]
      .filter((part): part is string => typeof part === "string")
      .map(normalizeFindingText);
  }).sort();
  return createHash("sha256").update(JSON.stringify({
    category: normalizeFindingText(finding.category ?? "correctness"),
    scope: normalizeFindingText(finding.scope ?? "in_scope"),
    locations: [...new Set(locations)],
    requiredAction: normalizeFindingText(finding.requiredAction),
    description: normalizeFindingText(finding.description),
  })).digest("hex");
}

export function mergeFindingEvidence(existing: unknown[], incoming: unknown[]): unknown[] {
  const seen = new Set(existing.map((entry) => JSON.stringify(entry)));
  const merged = [...existing];
  for (const entry of incoming) {
    const encoded = JSON.stringify(entry);
    if (!seen.has(encoded)) {
      seen.add(encoded);
      merged.push(entry);
    }
  }
  return merged;
}

function normalizeFindingText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(?:line|ln|at)\s*\d+\b/gi, "line")
    .replace(/\b\d+(?::\d+)+\b/g, "position")
    .replace(/[^a-z0-9_./ -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
