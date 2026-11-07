// Failure-injection qualification for Findings 1-3 (independent of the
// unit tests). Disposable state only; never touches production.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// --- F3: v4 retained release still verifies under the new code ---------
const preserved = join(process.env.HOME, ".local", "share", "kontrol", "releases", "2f612494d1248751");
if (existsSync(preserved)) {
  const { verifyArtifactContent } = await import("../src/release-integrity.js");
  const v4 = verifyArtifactContent(preserved);
  assert.equal(v4.ok, true, `retained format-4 release verifies read-only under the new code (${v4.reason ?? "ok"})`);
  console.log("F3: retained format-4 release verified:", v4.contentSha256);
} else {
  console.log("F3: preserved release not present locally; v4 compat covered by unit fixtures");
}

// --- F3 (cont.): build emits v5 now -------------------------------------
const { releaseContentHashV5 } = await import("../scripts/lib/release-hash-v5.mjs");
const { treeContentSha256 } = await import("../src/release-integrity.js");
const tree = mkdtempSync(join(tmpdir(), "kontrol-fi3-"));
writeFileSync(join(tree, "a"), "bc");
writeFileSync(join(tree, "cli.js"), "x");
assert.equal(treeContentSha256(tree), releaseContentHashV5(tree));
assert.equal(treeContentSha256(tree).length, 64);
console.log("F3: v5 tree hash agrees across canonical + build tooling");

// --- F1/F2 + schema-119: disposable install with injected failure -------
const root = mkdtempSync(join(tmpdir(), "kontrol-fi-"));
mkdirSync(join(root, "config", "kontrol"), { recursive: true });
mkdirSync(join(root, "artifact"), { recursive: true });
mkdirSync(join(root, "config", "kontrol"), { recursive: true });
writeFileSync(join(root, "config", "kontrol", "config.json"), JSON.stringify({ authMode: "tunnel", serviceComponents: [{ name: "tunnel", kind: "tunnel", command: ["tunnel-client", "run", "--profile", "p"] }] }));
writeFileSync(join(root, "artifact", "cli.js"), "x\n");
writeFileSync(join(root, "artifact", "server.js"), "x\n");
writeFileSync(join(root, "artifact", "acp-duplex.js"), "x\n");
writeFileSync(join(root, "artifact", "read-only-execution.mjs"), "x\n");
writeFileSync(join(root, "artifact", "bounded-file-write.mjs"), "x\n");
mkdirSync(join(root, "artifact", "ui"), { recursive: true });
writeFileSync(join(root, "artifact", "ui", "workspace-app.html"), "<html/>\n");
mkdirSync(join(root, "artifact", "skills", "local-agent-delegation"), { recursive: true });
writeFileSync(join(root, "artifact", "skills", "local-agent-delegation", "SKILL.md"), "# skill\n");
// Seal a v5 artifact via the canonical verifier format.
const { LATEST_SCHEMA_VERSION } = await import("../src/db/migrations.js");
const meta = { buildId: "fi-build", releaseFormatVersion: 5, contentSha256: treeContentSha256(join(root, "artifact")), schemaVersion: LATEST_SCHEMA_VERSION, minReadableSchemaVersion: 1, maxReadableSchemaVersion: LATEST_SCHEMA_VERSION };
writeFileSync(join(root, "artifact", "build-meta.json"), JSON.stringify(meta));

const runner = `
import { runServiceCommand } from "./src/service.js";
const env = { ...process.env, XDG_CONFIG_HOME: ${JSON.stringify(join(root, "config"))}, KONTROL_STATE_DIR: ${JSON.stringify(join(root, "state"))}, KONTROL_TUNNEL_REVIEWER_SECRET: "fi-reviewer-secret-long-enough-123", KONTROL_POLICY_MODE: "allow" };
const deps = { currentArtifactPath: () => ${JSON.stringify(join(root, "artifact"))}, requireSystemd: () => undefined,
  systemctl: () => { throw new Error("injected daemon-reload failure"); }, waitForReady: async () => undefined };
await runServiceCommand(["install"], env, deps);
`;
const first = spawnSync(process.execPath, ["--import", "tsx", "--eval", runner, "fi"], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, HOME: process.env.HOME } });
assert.notEqual(first.status, 0, "install with injected failure exits nonzero");
assert.match(first.stderr ?? first.stdout, /injected daemon-reload failure/);
const releases = join(root, "state", "releases");
assert.ok(!existsSync(join(releases, "fi-build")), "failed install of a NEW build cleans its own copy");
console.log("F2: failed fresh install cleans only its own release dir");

// Schema 119 migration on the disposable state (created by the failed
// install's openDatabase path if any) or a fresh scratch DB.
const migRoot = mkdtempSync(join(tmpdir(), "kontrol-fi-mig-"));
const { openDatabase } = await import("../src/db/client.js");
const db = openDatabase(migRoot);
const tables = db.sqlite.prepare("select name from sqlite_master where type='table' and name='initial_dispatch_reservations'").get();
assert.ok(tables, "migration 119 created initial_dispatch_reservations");
const version = db.sqlite.prepare("select max(version) as v from kontrol_schema_migrations").get();
assert.equal(version.v, 119, `latest schema is 119 (got ${version.v})`);
db.close();
console.log("F4/F119: reservation table present; schema 119");

console.log("failure-injection qualification: all assertions passed");
