#!/usr/bin/env node
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as prompts from "@clack/prompts";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { satisfies } from "semver";
import { loadConfig } from "./config.js";
import {
  generateOwnerToken,
  loadKontrolFiles,
  writeKontrolAuth,
  writeKontrolConfig,
  type KontrolUserConfig,
} from "./user-config.js";
import { expandHomePath } from "./roots.js";
import {
  createRuntimeIdentity,
  isRuntimeIdentityLive,
  readBuildIdentity,
  readRuntimeIdentity,
  removeRuntimeIdentity,
} from "./runtime-identity.js";

type Command = "serve" | "up" | "init" | "doctor" | "config" | "help" | "version";
const require = createRequire(import.meta.url);
const SUPPORTED_NODE_RANGE = ">=22.19 <27";

async function main(argv: string[]): Promise<void> {
  assertSupportedNode();

  const [rawCommand, ...args] = argv;
  const command = normalizeCommand(rawCommand);

  switch (command) {
    case "serve":
      await ensureConfigured();
      await serve();
      return;
    case "up":
      runUp(args);
      return;
    case "init":
      await runInit({ force: args.includes("--force") });
      return;
    case "doctor":
      await runDoctor();
      return;
    case "config":
      runConfigCommand(args);
      return;
    case "help":
      printHelp();
      return;
    case "version":
      printVersion();
      return;
  }
}

function normalizeCommand(command: string | undefined): Command {
  if (!command || command === "serve" || command === "start") return "serve";
  if (command === "up" || command === "init" || command === "doctor" || command === "config") return command;
  if (command === "help" || command === "--help" || command === "-h") return "help";
  if (command === "version" || command === "--version" || command === "-v") return "version";
  throw new Error(`Unknown command: ${command}`);
}

function runUp(args: string[]): void {
  if (args.length > 0) {
    throw new Error("`kontrol up` does not accept arguments.");
  }

  const launcher = resolve(process.cwd(), "start-all.sh");
  if (!existsSync(launcher)) {
    throw new Error(
      "`kontrol up` must be run from a Kontrol checkout containing start-all.sh. "
      + "For a regular installation, configure and run `kontrol serve`.",
    );
  }

  const result = spawnSync("bash", [launcher], { cwd: process.cwd(), stdio: "inherit" });
  if (result.error) throw result.error;
  if (typeof result.status === "number" && result.status !== 0) process.exitCode = result.status;
  if (result.signal) process.exitCode = 1;
}

async function ensureConfigured(): Promise<void> {
  const files = loadKontrolFiles();
  if (files.configExists && files.authExists) return;
  // Tunnel mode is fully configured from the environment. Unlike OAuth mode,
  // it has no owner credential to persist, so requiring ~/.kontrol files here
  // incorrectly opens the interactive setup wizard before the server can bind.
  if (process.env.KONTROL_AUTH_MODE === "tunnel" && process.env.KONTROL_ALLOWED_ROOTS?.trim()) return;
  // P0 #3: environment-only startup requires BOTH a credential and an
  // EXPLICIT allowed-roots configuration. An owner token alone must not
  // silently expose whatever directory the process happened to start in —
  // parseAllowedRoots() would otherwise fall back to process.cwd().
  if (process.env.KONTROL_OAUTH_OWNER_TOKEN && process.env.KONTROL_ALLOWED_ROOTS?.trim()) return;
  if (process.env.KONTROL_OAUTH_OWNER_TOKEN && !process.env.KONTROL_ALLOWED_ROOTS?.trim()) {
    throw new Error(
      [
        "KONTROL_OAUTH_OWNER_TOKEN is set but KONTROL_ALLOWED_ROOTS is not.",
        "",
        "Kontrol fails closed here rather than exposing the current working",
        "directory as the filesystem boundary. Set KONTROL_ALLOWED_ROOTS to an",
        "explicit comma-separated list of directories, or run `kontrol init`.",
      ].join("\n"),
    );
  }

  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      [
        "Kontrol is not configured and this terminal is non-interactive.",
        "",
        "Run:",
        "  kontrol init",
        "",
        "Or provide KONTROL_OAUTH_OWNER_TOKEN and KONTROL_ALLOWED_ROOTS.",
      ].join("\n"),
    );
  }

  await runInit({ force: false });
}

async function runInit({ force }: { force: boolean }): Promise<void> {
  const files = loadKontrolFiles();
  if (!force && files.configExists && files.authExists) {
    prompts.log.info(`Kontrol is already configured at ${files.dir}`);
    prompts.log.info("Run `kontrol init --force` to update it.");
    return;
  }

  try {
    prompts.intro("Kontrol setup");

    const defaultRoots = files.config.allowedRoots?.join(", ") || process.cwd();
    const rootsAnswer = await textPrompt({
      message: `Where are your projects located? Press Enter to use ${defaultRoots}`,
      placeholder: defaultRoots,
      defaultValue: defaultRoots,
      validate: (value) => value?.trim() ? undefined : "Enter at least one project root.",
    });
    const allowedRoots = rootsAnswer
      .split(",")
      .map((root) => resolve(expandHomePath(root.trim())))
      .filter(Boolean);

    const defaultPort = String(files.config.port ?? 7676);
    const portAnswer = await textPrompt({
      message: `Which local port should Kontrol use? Press Enter to use ${defaultPort}`,
      placeholder: defaultPort,
      defaultValue: defaultPort,
      validate: validatePort,
    });
    const port = Number(portAnswer);

    prompts.note(
      [
        "Kontrol needs a public base URL so ChatGPT or Claude can reach this MCP server.",
        "Create a tunnel or reverse proxy with Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or your own HTTPS proxy.",
        "Paste the public origin here, without /mcp.",
        "",
        "Example: https://your-tunnel-host.example.com",
      ].join("\n"),
      "Public URL required",
    );
    const publicBaseUrl = normalizePublicBaseUrl(await textPrompt({
      message: files.config.publicBaseUrl
        ? `What is the public base URL? Press Enter to keep ${files.config.publicBaseUrl}`
        : "What is the public base URL?",
      placeholder: files.config.publicBaseUrl ?? "https://your-tunnel-host.example.com",
      defaultValue: files.config.publicBaseUrl ?? "",
      validate: validateRequiredPublicBaseUrl,
    }));

    const config: KontrolUserConfig = {
      host: files.config.host ?? "127.0.0.1",
      port,
      allowedRoots,
      publicBaseUrl,
    };
    const auth = {
      ownerToken: files.auth.ownerToken ?? generateOwnerToken(),
    };

    const configPath = writeKontrolConfig(config);
    const authPath = writeKontrolAuth(auth);

    prompts.note(
      [
        "Secure default policy: read-only work is frictionless; bash/write/edit/apply_patch require approval unless explicitly overridden (e.g. KONTROL_POLICY_TOOL_BASH=allow or KONTROL_POLICY_MODE=ask).",
        "Child processes receive only an explicit non-secret environment allowlist.",
        "Outbound ACP webhooks are disabled until KONTROL_WEBHOOKS=1 and KONTROL_WEBHOOK_ALLOWED_HOSTS are configured.",
      ].join("\n"),
      "Security posture",
    );

    const lines = [
      `Config: ${configPath}`,
      `Auth: ${authPath}`,
      `Local MCP URL: http://${config.host}:${config.port}/mcp`,
      ...(publicBaseUrl ? [`Public MCP URL: ${publicBaseUrl}/mcp`] : []),
    ];
    prompts.note(lines.join("\n"), "Kontrol configured");
    prompts.note(
      [
        `Owner password: ${auth.ownerToken}`,
        "Use this when ChatGPT or Claude asks you to approve Kontrol access.",
        `Stored at: ${authPath}`,
      ].join("\n"),
      "Owner password",
    );
    prompts.outro("Run `kontrol serve` to start the MCP server.");
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      prompts.cancel("Setup cancelled");
      return;
    }
    throw error;
  }
}

async function serve(): Promise<void> {
  const sqliteStatus = checkSqliteNative();
  if (sqliteStatus !== "ok") {
    throw new Error(
      [
        "better-sqlite3 could not load for this Node runtime.",
        sqliteStatus,
        "",
        "Try reinstalling or rebuilding dependencies under the active Node version:",
        "  npm rebuild better-sqlite3",
      ].join("\n"),
    );
  }

  const { createServer } = await import("./server.js");
  const config = loadConfig();
  const { app, close, drain } = createServer(config);
  const buildMeta = readBuildIdentity(resolve(dirname(fileURLToPath(import.meta.url)), "build-meta.json"));
  const runtimeIdentity = createRuntimeIdentity(config.stateDir, buildMeta);
  const httpServer = app.listen(config.port, config.host, () => {
    // Report the immutable artifact identity produced by the atomic build.
    // Reading Git here would describe the checkout, not necessarily the code
    // that is actually serving requests.
    console.log(`kontrol listening on http://${config.host}:${config.port}/mcp`);
    console.log(`public base url: ${config.publicBaseUrl}`);
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`allowed hosts: ${config.allowedHosts.join(", ")}`);
    if (config.allowedHosts.includes("*")) {
      console.warn("warning: Host header allowlist is disabled because KONTROL_ALLOWED_HOSTS=*");
    }
    console.log(
      config.authMode === "tunnel"
        ? "auth: tunnel mode (loopback only; OAuth disabled on /mcp; ChatGPT connects with No Authentication)"
        : "auth: Owner password approval required",
    );
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    // P0 #2: make the trust posture explicit at startup so a permissive
    // default is never silently inherited.
    const policyPosture = config.policy.defaultMode === "ask"
      ? "ask (everything not explicitly allowed requires approval)"
      : config.policy.defaultMode === "deny"
        ? "deny (everything not explicitly allowed is blocked)"
        : "allow (read-only frictionless; gate shell via KONTROL_POLICY_TOOL_BASH=ask)";
    console.log(`policy: ${policyPosture}`);
    console.log(`build identity: id=${buildMeta.buildId ?? "dev"} commit=${String(buildMeta.gitSha ?? "unknown").slice(0, 12)} dirty=${String(buildMeta.gitDirty ?? "unknown")}`);
  });
  httpServer.once("error", (error) => {
    // Do not leave a live-looking identity behind when binding fails (for
    // example, a stale second `start-all.sh` invocation on the same port).
    removeRuntimeIdentity(config.stateDir, runtimeIdentity.instanceId);
    close();
    console.error(`kontrol failed to listen on ${config.host}:${config.port}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });

  let shuttingDown = false;
  let shutdownStarted = false;
  const shutdown = async () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await drain();
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const deadline = setTimeout(() => {
          httpServer.closeAllConnections?.();
          finish();
        }, 5_000);
        httpServer.close(() => {
          clearTimeout(deadline);
          finish();
        });
      });
      close();
      removeRuntimeIdentity(config.stateDir, runtimeIdentity.instanceId);
      process.exit(0);
    } catch (error) {
      console.error(`kontrol graceful shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      close();
      removeRuntimeIdentity(config.stateDir, runtimeIdentity.instanceId);
      process.exit(1);
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function runDoctor(): Promise<void> {
  const files = loadKontrolFiles();
  console.log(`Config dir: ${files.dir}`);
  console.log(`Config file: ${files.configExists ? files.configPath : "missing"}`);
  console.log(`Auth file: ${files.authExists ? files.authPath : "missing"}`);
  doctorResult("Node/runtime", nodeVersionStatus(), satisfies(process.versions.node, SUPPORTED_NODE_RANGE) ? "" : `current=${process.version}`);
  doctorResult("Node ABI", "PASS", process.versions.modules);
  doctorResult("Platform", "PASS", `${process.platform} ${process.arch}`);
  doctorResult("Git", checkGitAvailable().startsWith("unavailable") ? "UNAVAILABLE" : "PASS", checkGitAvailable());
  doctorResult("Bash shell", checkBashShell().startsWith("unavailable") ? "UNAVAILABLE" : "PASS", checkBashShell());
  doctorResult("SQLite native dependency", checkSqliteNative() === "ok" ? "PASS" : "FAIL", checkSqliteNative());

  try {
    const config = loadConfig();
    const localHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
    doctorResult("Auth mode", "PASS", `${config.authMode}; listen=${config.host}:${config.port}; tunnelExpected=${config.authMode === "tunnel"}`);
    doctorResult("Allowed roots", "PASS", config.allowedRoots.join(", "));
    // P1 #30: verify each configured root actually exists and is a directory.
    const missingRoots = config.allowedRoots.filter((root) => !existsSync(root));
    doctorResult("Root paths exist", missingRoots.length === 0 ? "PASS" : "FAIL", missingRoots.length === 0 ? "all configured roots present" : `missing: ${missingRoots.join(", ")}`);
    // P1 #30: worktree root must be writable for managed worktrees.
    try {
      const worktreeProbe = resolve(config.worktreeRoot, `.kontrol-write-probe-${process.pid}`);
      writeFileSync(worktreeProbe, "");
      rmSync(worktreeProbe, { force: true });
      doctorResult("Worktree root writable", "PASS", config.worktreeRoot);
    } catch (error) {
      doctorResult("Worktree root writable", "FAIL", `${config.worktreeRoot} (${error instanceof Error ? error.message : String(error)})`);
    }
    // P1 #30: policy posture surfaced without printing rules content.
    const bashPolicyMode = config.policy.toolRules.bash ?? config.policy.defaultMode;
    doctorResult(
      "Mutation policy",
      bashPolicyMode === "allow" ? "WARN" : "PASS",
      bashPolicyMode === "allow"
        ? "shell and mutations are globally allowed; the secure baseline (bash/write/edit/apply_patch=ask) has been overridden — set KONTROL_POLICY_TOOL_BASH=ask or unset explicit policy to restore approval gating"
        : `shell/mutations gated (${bashPolicyMode})`,
    );
    // P1 #14: process-session resource controls visible to operators.
    doctorResult(
      "Process limits",
      "PASS",
      `maxRunning=${config.processMaxRunning ?? "64 (default)"} perOwner=${config.processMaxRunningPerOwner ?? "8 (default)"} idleTimeoutMs=${config.processIdleTimeoutMs ?? "900000 (default)"}`,
    );
    if (config.policy.pathRules.length > 0) {
      doctorResult(
        "Shell/path policy",
        bashPolicyMode === "allow" ? "WARN" : "PASS",
        bashPolicyMode === "allow"
          ? "configured path rules cover structured file tools only; shell is allowed (set KONTROL_POLICY_TOOL_BASH=ask or deny, or use an external sandbox)"
          : `structured path rules plus separately gated shell (${bashPolicyMode})`,
      );
    }
    // P1 #30: ACP secret-role completeness — presence only, never values.
    if (config.acpEnabled) {
      const secretRoles = [
        ["agent", config.acpAgentSecret],
        ["reviewer", config.acpReviewerSecret],
        ["adapter", config.acpAdapterSecret],
      ] as const;
      const missingSecrets = secretRoles.filter(([, value]) => !value).map(([role]) => role);
      const legacyOnly = !config.acpSharedSecret ? false : secretRoles.every(([, value]) => !value);
      doctorResult(
        "ACP secrets",
        missingSecrets.length === 0 && !legacyOnly ? "PASS" : legacyOnly ? "WARN" : "WARN",
        missingSecrets.length === 0
          ? legacyOnly ? "legacy shared secret only; split into agent/reviewer/adapter roles" : "all role secrets present"
          : `missing: ${missingSecrets.join(", ")}${config.acpSharedSecret ? "; legacy shared secret also set (broad operator authority)" : ""}`,
      );
      // P1 #30: Bubblewrap is required only when sandboxed verification is on.
      if (process.env.KONTROL_VERIFY_SANDBOX === "true") {
        const bwrap = process.env.KONTROL_BWRAP ?? "/usr/bin/bwrap";
        doctorResult("Bubblewrap sandbox", existsSync(bwrap) ? "PASS" : "FAIL", bwrap);
      }
    }
    doctorResult("Allowed hosts", config.allowedHosts.includes("*") ? "WARN" : "PASS", config.allowedHosts.join(", "));
    doctorResult("Tunnel bind", config.authMode === "tunnel" && !isLoopbackHostForDoctor(config.host) ? "FAIL" : "PASS", config.host);

    const distDir = resolve(process.cwd(), "dist");
    const requiredArtifacts = ["cli.js", "server.js", "acp-duplex.js", "build-meta.json", "ui/workspace-app.html"];
    const missingArtifacts = requiredArtifacts.filter((file) => !existsSync(resolve(distDir, file)));
    doctorResult("Build artifacts", missingArtifacts.length === 0 ? "PASS" : "FAIL", missingArtifacts.length === 0 ? distDir : `missing ${missingArtifacts.join(", ")}`);
    const buildMeta = readBuildIdentity(resolve(distDir, "build-meta.json"));
    if (missingArtifacts.length === 0) {
      doctorResult("Build identity", "PASS", `id=${buildMeta.buildId ?? "missing"} ${buildMeta.version ?? "unknown"} ${String(buildMeta.gitSha ?? "unknown").slice(0, 12)} dirty=${buildMeta.gitDirty ?? "unknown"}`);
    }
    const sourceSha = gitRevision();
    const sourceBuildMismatch = Boolean(sourceSha && buildMeta.gitSha && sourceSha !== buildMeta.gitSha);
    doctorResult("Source/build SHA", sourceBuildMismatch ? "FAIL" : "PASS", `source=${sourceSha ?? "unavailable"} build=${buildMeta.gitSha ?? "unavailable"}`);
    const sourceDirty = gitDirtyFileCount();
    if (sourceDirty !== undefined && Number(buildMeta.gitDirty ?? 0) !== sourceDirty) {
      doctorResult("Source/build dirty state", "WARN", `source=${sourceDirty} build=${buildMeta.gitDirty ?? "unknown"}`);
    } else {
      doctorResult("Source/build dirty state", "PASS", `dirty=${buildMeta.gitDirty ?? sourceDirty ?? "unknown"}`);
    }
    doctorResult("State directory", existsSync(config.stateDir) ? "PASS" : "FAIL", config.stateDir);
    if (existsSync(config.stateDir)) {
      try {
        const mode = statSync(config.stateDir).mode & 0o777;
        doctorResult("State permissions", mode === 0o700 ? "PASS" : "WARN", `mode=${mode.toString(8)}`);
        const fs = statfsSync(config.stateDir);
        const freeBytes = Number(fs.bavail) * Number(fs.bsize);
        doctorResult("Disk space", freeBytes > 100 * 1024 * 1024 ? "PASS" : "WARN", `${Math.round(freeBytes / 1024 / 1024)} MiB free`);
      } catch (error) {
        doctorResult("State filesystem", "UNAVAILABLE", error instanceof Error ? error.message : String(error));
      }
    }

    const identity = readRuntimeIdentity(config.stateDir);
    if (!identity) {
      doctorResult("Server identity", "WARN", "server.identity.json not present");
    } else {
      doctorResult("Server identity", isRuntimeIdentityLive(identity) ? "PASS" : "WARN", `pid=${identity.pid} instance=${identity.instanceId} start=${identity.processStartTime}`);
      if (identity.buildSha !== (buildMeta.gitSha ?? "unknown")) {
        doctorResult("Running/source identity", "FAIL", `running=${identity.buildSha} current-build=${buildMeta.gitSha ?? "unknown"}`);
      }
    }

    if (existsSync(resolve(process.cwd(), "tsconfig.json"))) {
      const typecheck = spawnSync("npm", ["run", "--silent", "typecheck"], { cwd: process.cwd(), stdio: "ignore", timeout: 120_000 });
      doctorResult("TypeScript", typecheck.status === 0 ? "PASS" : typecheck.error ? "UNAVAILABLE" : "FAIL", typecheck.error?.message ?? "typecheck");
    } else {
      doctorResult("TypeScript", "UNAVAILABLE", "not a source checkout");
    }

    const database = inspectDoctorDatabase(config.stateDir);
    for (const [label, result] of Object.entries(database)) doctorResult(label, result.status, result.detail);

    const probe = async (url: string): Promise<{ status: number; text: string }> => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
        return { status: response.status, text: `${response.status} ${response.statusText}` };
      } catch (error) {
        return { status: 0, text: `unreachable (${error instanceof Error ? error.message : String(error)})` };
      }
    };
    const localHealth = await probe(`http://${localHost}:${config.port}/healthz`);
    doctorResult("Local /healthz", localHealth.status === 200 ? "PASS" : localHealth.status === 0 ? "UNAVAILABLE" : "FAIL", localHealth.text);
    const discovery = await probe(`http://${localHost}:${config.port}/.well-known/oauth-protected-resource`);
    doctorResult("Local discovery", discovery.status === 200 ? "PASS" : discovery.status === 0 ? "UNAVAILABLE" : "FAIL", discovery.text);
    const mcp = await probeMcpInitialize(`http://${localHost}:${config.port}/mcp`);
    const expectedMcp = config.authMode === "tunnel" ? mcp.status === 200 : mcp.status === 401;
    doctorResult("Local MCP initialize", expectedMcp ? "PASS" : mcp.status === 0 ? "UNAVAILABLE" : "FAIL", mcp.text);
    if (config.authMode === "tunnel") {
      const tunnelHealth = await probe("http://127.0.0.1:8080/healthz");
      doctorResult("Tunnel process", tunnelHealth.status === 200 ? "PASS" : tunnelHealth.status === 0 ? "UNAVAILABLE" : "FAIL", tunnelHealth.text);
      const tunnelReady = await probe("http://127.0.0.1:8080/readyz");
      doctorResult("Tunnel MCP initialize", tunnelReady.status === 200 ? "PASS" : tunnelReady.status === 0 ? "UNAVAILABLE" : "FAIL", tunnelReady.text);
      doctorResult("Tunnel MCP auth", "PASS", "delegated; no local bearer header");
    } else {
      const publicProbe = await probeMcpInitialize(`${new URL("/mcp", config.publicBaseUrl).toString()}`);
      doctorResult("External MCP initialize", publicProbe.status === 200 ? "PASS" : publicProbe.status === 0 ? "UNAVAILABLE" : "WARN", publicProbe.text);
    }
  } catch (error) {
    doctorResult("Config", "FAIL", error instanceof Error ? error.message : String(error));
  }
}

function doctorResult(label: string, status: "PASS" | "WARN" | "FAIL" | "UNAVAILABLE" | string, detail: string): void {
  console.log(`[${status}] ${label}${detail ? `: ${detail}` : ""}`);
}

function isLoopbackHostForDoctor(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

// Review #10: these are optional probes — outside a git checkout they must
// fail QUIETLY. stdio is captured (never inherited) so Git's "fatal: not a
// git repository" stderr never leaks into release-test output.
function gitRevision(): string | undefined {
  try {
    return (require("node:child_process") as typeof import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return undefined;
  }
}

function gitDirtyFileCount(): number | undefined {
  try {
    const value = (require("node:child_process") as typeof import("node:child_process")).execFileSync("git", ["status", "--porcelain"], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    return value ? value.split("\n").length : 0;
  } catch {
    return undefined;
  }
}

async function probeMcpInitialize(url: string): Promise<{ status: number; text: string }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "doctor", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "kontrol-doctor", version: "1" } } }),
      signal: AbortSignal.timeout(1_500),
    });
    return { status: response.status, text: `${response.status} ${response.statusText}` };
  } catch (error) {
    return { status: 0, text: `unreachable (${error instanceof Error ? error.message : String(error)})` };
  }
}

function inspectDoctorDatabase(stateDir: string): Record<string, { status: "PASS" | "WARN" | "FAIL" | "UNAVAILABLE"; detail: string }> {
  const result: Record<string, { status: "PASS" | "WARN" | "FAIL" | "UNAVAILABLE"; detail: string }> = {};
  const path = join(stateDir, "kontrol.sqlite");
  if (!existsSync(path)) {
    result.Database = { status: "WARN", detail: "kontrol.sqlite not present" };
    return result;
  }
  let db: { pragma: (value: string, options?: { simple?: boolean }) => unknown; prepare: (sql: string) => { all: (...args: unknown[]) => unknown[]; get: (...args: unknown[]) => unknown }; close: () => void } | undefined;
  try {
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    db = new Database(path, { readonly: true, fileMustExist: true }) as typeof db;
    const database = db!;
    const integrity = database.pragma("integrity_check", { simple: true });
    result.Database = { status: integrity === "ok" ? "PASS" : "FAIL", detail: `integrity=${String(integrity)}` };
    const schema = database.prepare("select max(version) as version from kontrol_schema_migrations").get() as { version?: number };
    result["Database schema"] = { status: "PASS", detail: `version=${schema?.version ?? "unknown"}` };
    const count = (sql: string): number => {
      const row = database.prepare(sql).get() as { count?: number; c?: number } | undefined;
      return Number(row?.count ?? row?.c ?? 0);
    };
    const statusCounts = (table: string): string => {
      const rows = db!.prepare(`select status, count(*) as count from ${table} group by status`).all() as Array<{ status: string; count: number }>;
      return rows.map((row) => `${row.status}=${row.count}`).join(", ") || "none";
    };
    result["Event rows"] = { status: "PASS", detail: `total=${count("select count(*) as count from event_log")}; output_delta=${count("select count(*) as count from event_log where type = 'agent.run.output_delta'")}; thought_delta=${count("select count(*) as count from event_log where type = 'agent.run.thought_delta'")}` };
    result["Work-session states"] = { status: "PASS", detail: statusCounts("work_sessions") };
    result["Supervisor states"] = { status: "PASS", detail: statusCounts("supervisor_runs") };
    result["Pending approvals"] = { status: "PASS", detail: statusCounts("approval_requests") };
    const deadLetters = count("select count(*) as count from dispatch_outbox where status = 'dead_lettered'");
    result["Dead-letter supervisor actions"] = { status: deadLetters > 0 ? "WARN" : "PASS", detail: String(deadLetters) };
    const expiredApprovals = count("select count(*) as count from approval_requests where status = 'pending' and expires_at is not null and expires_at < datetime('now')");
    result["Expired approvals"] = { status: expiredApprovals > 0 ? "WARN" : "PASS", detail: String(expiredApprovals) };
    const aliveAgents = count("select count(*) as count from agent_registry where datetime(last_heartbeat, '+' || ttl_seconds || ' seconds') >= datetime('now')");
    result["Registered ACP agents"] = { status: "PASS", detail: String(aliveAgents) };
  } catch (error) {
    result.Database = { status: "UNAVAILABLE", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    try { db?.close(); } catch { /* diagnostic cleanup */ }
  }
  return result;
}

function runConfigCommand(args: string[]): void {
  const [subcommand, key, ...rest] = args;
  const files = loadKontrolFiles();

  if (!subcommand || subcommand === "get") {
    console.log(JSON.stringify(files.config, null, 2));
    return;
  }

  if (subcommand !== "set") {
    throw new Error(`Unknown config command: ${subcommand}`);
  }
  if (key !== "publicBaseUrl") {
    throw new Error("Only `kontrol config set publicBaseUrl <url|null>` is supported right now.");
  }

  const value = rest.join(" ").trim();
  if (!value) {
    throw new Error("Missing publicBaseUrl value.");
  }

  writeKontrolConfig({
    ...files.config,
    publicBaseUrl: normalizeOptionalPublicBaseUrl(value),
  });
  console.log(`Updated ${files.configPath}`);
}

function printHelp(): void {
  console.log(
    [
      "Kontrol",
      "",
      "Usage:",
      "  kontrol                 Run first-time setup if needed, then start the server",
      "  kontrol serve           Start the server",
      "  kontrol up              Start the full local stack from a Kontrol checkout",
      "  kontrol init            Create or update ~/.kontrol/config.json and auth.json",
      "  kontrol doctor          Show config, runtime, and native dependency status",
      "  kontrol config get      Print persisted config",
      "  kontrol config set publicBaseUrl <url|null>",
      "  kontrol -v, --version   Print the installed version",
      "",
      "For temporary tunnels:",
      "  KONTROL_PUBLIC_BASE_URL=https://example.trycloudflare.com kontrol serve",
    ].join("\n"),
  );
}

function printVersion(): void {
  const packageJson = require("../package.json") as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("Unable to read Kontrol package version.");
  }

  console.log(packageJson.version);
}

function normalizeOptionalPublicBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "none") return null;

  return normalizePublicBaseUrl(trimmed);
}

function normalizePublicBaseUrl(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

type TextPromptOptions = Omit<Parameters<typeof prompts.text>[0], "validate"> & {
  defaultValue: string;
  validate?: (value: string | undefined) => string | Error | undefined;
};

async function textPrompt(options: TextPromptOptions): Promise<string> {
  const result = await prompts.text({
    ...options,
    validate: (value) => options.validate?.(value?.trim() ? value : options.defaultValue),
  });
  if (prompts.isCancel(result)) throw new SetupCancelledError();
  const value = String(result).trim();
  return value || options.defaultValue;
}

function validatePort(value: string | undefined): string | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? undefined
    : "Enter a port between 1 and 65535.";
}

function validateRequiredPublicBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "Enter the public URL from your tunnel or reverse proxy.";
  if (trimmed.endsWith("/mcp")) return "Enter the base URL only, without /mcp.";
  return validatePublicBaseUrl(trimmed);
}

function validatePublicBaseUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? undefined
      : "Use an http or https URL.";
  } catch {
    return "Enter a valid URL, for example https://your-tunnel-host.example.com.";
  }
}

function assertSupportedNode(): void {
  if (satisfies(process.versions.node, SUPPORTED_NODE_RANGE)) return;

  throw new Error(
    [
      `Kontrol requires Node ${SUPPORTED_NODE_RANGE}.`,
      `Current Node: ${process.version}`,
      "",
      "Install Node 22 LTS or use a version manager such as nvm, fnm, or mise.",
    ].join("\n"),
  );
}

function nodeVersionStatus(): string {
  return satisfies(process.versions.node, SUPPORTED_NODE_RANGE)
    ? `supported ${SUPPORTED_NODE_RANGE}`
    : `unsupported, requires ${SUPPORTED_NODE_RANGE}`;
}

class SetupCancelledError extends Error {}

function checkSqliteNative(): string {
  try {
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function checkGitAvailable(): string {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

function checkBashShell(): string {
  try {
    const { shell, args } = getShellConfig();
    return `${shell} ${args.join(" ")}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
