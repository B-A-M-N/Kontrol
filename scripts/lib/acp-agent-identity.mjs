import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

function safeName(value) {
  return String(value || "agent").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "agent";
}

export function agentIdentityPath(name) {
  if (process.env.KONTROL_ACP_AGENT_STATE_FILE) return process.env.KONTROL_ACP_AGENT_STATE_FILE;
  const stateDir = process.env.KONTROL_STATE_DIR || join(process.cwd(), ".kontrol-state");
  return join(stateDir, `acp-agent-${safeName(name)}.json`);
}

export async function loadAgentIdentity(name) {
  try {
    const value = JSON.parse(await readFile(agentIdentityPath(name), "utf8"));
    if (typeof value?.agentId !== "string" || typeof value?.agentCredential !== "string") return undefined;
    return { agentId: value.agentId, agentCredential: value.agentCredential };
  } catch {
    return undefined;
  }
}

export async function saveAgentIdentity(name, identity) {
  const path = agentIdentityPath(name);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, JSON.stringify(identity), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export async function clearAgentIdentity(name) {
  // The caller may deliberately remove a revoked identity before creating a
  // replacement. Use unlink through a tiny dynamic import to keep this helper
  // compatible with older Node versions that do not expose rm in fs/promises.
  const { unlink } = await import("node:fs/promises");
  await unlink(agentIdentityPath(name)).catch(() => {});
}

export function identityHeaders(identity) {
  if (!identity) return {};
  return {
    "x-kontrol-agent-id": identity.agentId,
    "x-kontrol-agent-credential": identity.agentCredential,
  };
}
