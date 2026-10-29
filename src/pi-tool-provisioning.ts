import { spawnSync } from "node:child_process";
import { delimiter, dirname } from "node:path";
import { rgPath } from "@vscode/ripgrep";

/** Make Pi's required search executable available without runtime downloads. */
export function provisionPiTools(environment: NodeJS.ProcessEnv = process.env): void {
  const probe = spawnSync(rgPath, ["--version"], { encoding: "utf8", windowsHide: true });
  if (probe.error || probe.status !== 0) {
    const detail = probe.error?.message ?? probe.stderr?.trim() ?? `exit status ${probe.status ?? "unknown"}`;
    throw new Error(`Kontrol requires its bundled ripgrep executable; reinstall with npm ci. ${detail}`);
  }

  const bundledBin = dirname(rgPath);
  const pathEntries = (environment.PATH ?? "").split(delimiter).filter(Boolean);
  const hasBundledBin = pathEntries.some((entry) => entry.toLowerCase() === bundledBin.toLowerCase());
  if (!hasBundledBin) environment.PATH = [bundledBin, ...pathEntries].join(delimiter);

  // Pi's ensureTool helper downloads missing binaries. All required tools are
  // provisioned from the locked npm install; fd remains optional and has a
  // Node glob fallback in Kontrol.
  environment.PI_OFFLINE = "1";
}

provisionPiTools();
