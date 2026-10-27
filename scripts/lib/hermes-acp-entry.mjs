import { basename, dirname, join } from "node:path";

/** Build current-upstream-first Hermes ACP launch candidates. */
export function hermesAcpCandidates({ hermesAcpBin, hermesBin = "hermes", hermesBinPath, hermesBinExplicit = false } = {}) {
  if (hermesAcpBin) {
    return [{ command: hermesAcpBin, args: [], mode: "standalone", source: "HERMES_ACP_BIN" }];
  }

  const candidates = [];
  if (hermesBinPath) {
    const sibling = join(dirname(hermesBinPath), "hermes-acp");
    if (basename(hermesBinPath) === "hermes-acp") {
      candidates.push({ command: hermesBinPath, args: [], mode: "standalone", source: "HERMES_BIN" });
    } else {
      candidates.push({ command: sibling, args: [], mode: "standalone", source: "hermes-acp sibling" });
    }
  }
  if (hermesBinExplicit && hermesBin !== "hermes-acp") {
    candidates.push({ command: hermesBinPath && basename(hermesBinPath) !== "hermes-acp" ? hermesBinPath : hermesBin, args: ["acp"], mode: "subcommand", source: "explicit HERMES_BIN" });
  }
  if (!candidates.some((entry) => entry.command === "hermes-acp")) {
    candidates.push({ command: "hermes-acp", args: [], mode: "standalone", source: "PATH" });
  }
  if (!hermesBinExplicit && hermesBin !== "hermes-acp") {
    candidates.push({ command: hermesBin, args: ["acp"], mode: "subcommand", source: "legacy subcommand" });
  }
  return candidates;
}

/** Probe candidates in order and return the exact launch entry Hermes accepted. */
export function selectHermesAcpEntry(candidates, probe) {
  const attempts = [];
  for (const entry of candidates) {
    let result;
    try {
      result = probe(entry);
    } catch (error) {
      result = { status: null, error };
    }
    attempts.push({ entry, result });
    if (result?.status === 0) return { entry, result, attempts };
  }
  return { entry: null, result: null, attempts };
}

export function formatHermesAcpAttempts(attempts) {
  return attempts.map(({ entry, result }) => {
    const detail = result?.error?.message
      || result?.stderr?.trim()
      || result?.stdout?.trim()
      || `exit status ${result?.status ?? "unknown"}`;
    return `${entry.command} ${[...entry.args, "--check"].join(" ")}: ${detail}`.trim();
  }).join("\n");
}
