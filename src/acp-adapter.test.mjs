import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import the adapter module under a specific agent selection. ACP_AGENT_BIN is
// read from process.env at module-eval time, so set it before importing. The
// query suffix busts the ESM module cache so each env variation re-evaluates.
function loadAdapter(env) {
  process.env.ACP_AGENT_BIN = env.ACP_AGENT_BIN;
  const q = encodeURIComponent(`x=${env.ACP_AGENT_BIN}`);
  return import(`../scripts/acp-crush-adapter.mjs?${q}`);
}

let pass = 0;
const t = async (name, fn) => {
  try {
    await fn();
    console.log("  PASS:", name);
    pass++;
  } catch (e) {
    throw new Error(`FAIL: ${name} -> ${e.message}`);
  }
};

const tempDirs = [];
async function makeRealDir() {
  const dir = await mkdtemp(join(tmpdir(), "dd-adapter-test-"));
  tempDirs.push(dir);
  await writeFile(join(dir, "marker.txt"), "x");
  return realpath(dir);
}

try {
  // ── Unsupported agent selections fail closed ──
  {
    await t("hermes is rejected by the CRUSH HTTP adapter", async () => {
      await assert.rejects(
        () => loadAdapter({ ACP_AGENT_BIN: "hermes" }),
        /Hermes must be integrated through its native `hermes acp` stdio server/,
      );
    });
  }

  // ── CRUSH agent wiring (default) ──
  {
    const mod = await loadAdapter({ ACP_AGENT_BIN: "crush" });
    const args = mod.buildAgentArgs("do the thing");
    await t("crush builds run --debug --quiet argv", () => {
      assert.deepEqual(args, ["run", "--debug", "--quiet", "do the thing"]);
    });
    await t("crush registered agent name is cli-coding-agent", () => {
      assert.equal(mod.REGISTERED_AGENT_NAME, "cli-coding-agent");
    });
  }

  // ── Fail-closed workspace root validation (P0 #6) ──
  {
    const mod = await loadAdapter({ ACP_AGENT_BIN: "crush" });
    const realDir = await makeRealDir();
    await t("valid absolute existing dir is accepted", async () => {
      const r = await mod.validateWorkspaceRoot(realDir);
      assert.equal(r, realDir);
    });
    await t("missing root throws InvalidWorkspaceRootError (no fallback)", async () => {
      await assert.rejects(
        () => mod.validateWorkspaceRoot(undefined),
        (e) => e.name === "InvalidWorkspaceRootError" && e.code === "invalid_workspace_root",
      );
    });
    await t("nonexistent absolute path throws (no fallback)", async () => {
      await assert.rejects(
        () => mod.validateWorkspaceRoot("/nonexistent/path/that/should/not/exist"),
        (e) => e.name === "InvalidWorkspaceRootError",
      );
    });
    await t("existing relative path throws (absolute required)", async () => {
      await assert.rejects(
        () => mod.validateWorkspaceRoot("scripts"),
        (e) => e.name === "InvalidWorkspaceRootError",
      );
    });
    await t("relative path throws (absolute required)", async () => {
      await assert.rejects(
        () => mod.validateWorkspaceRoot("relative/path"),
        (e) => e.name === "InvalidWorkspaceRootError",
      );
    });
    await t("existing file path throws (directory required)", async () => {
      await assert.rejects(
        () => mod.validateWorkspaceRoot(join(process.cwd(), "package.json")),
        (e) => e.name === "InvalidWorkspaceRootError",
      );
    });
  }

  console.log(`acp-adapter.test.mjs: ${pass} passed`);
} finally {
  for (const d of tempDirs) await rm(d, { recursive: true, force: true }).catch(() => {});
}
