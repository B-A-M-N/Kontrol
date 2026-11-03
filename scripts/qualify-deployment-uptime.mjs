// Retrospective CI check for the currently deployed immutable systemd release.
// The deployment earns operational stability after one uninterrupted process
// generation has remained live and core-ready for the policy window.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const MIN_UPTIME_MS = 12 * 60 * 60 * 1_000;

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`Cannot read qualification input ${path}: ${error.message}`); }
}

function processStartToken(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const closingParen = stat.lastIndexOf(")");
  if (closingParen < 0) throw new Error(`Invalid /proc/${pid}/stat`);
  const startTicks = stat.slice(closingParen + 2).trim().split(/\s+/)[19];
  if (!startTicks) throw new Error(`Missing process start token for PID ${pid}`);
  return `proc:${startTicks}`;
}

function requireLiveProcess(pid, expectedToken, label) {
  if (!Number.isInteger(pid) || pid < 2) throw new Error(`${label} has invalid PID`);
  process.kill(pid, 0);
  if (processStartToken(pid) !== expectedToken) throw new Error(`${label} PID was reused or its start token changed`);
}

function parseArgs(argv) {
  const args = { stateDir: process.env.KONTROL_STATE_DIR || join(homedir(), ".local/share/kontrol"),
    serviceDataDir: process.env.KONTROL_SERVICE_DATA_DIR || join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "kontrol"),
    expectedBuildId: process.env.KONTROL_QUALIFY_EXPECTED_BUILD_ID || undefined,
    expectedSourceSha: process.env.KONTROL_QUALIFY_EXPECTED_SOURCE_SHA || undefined,
    report: process.env.KONTROL_QUALIFY_REPORT || join(process.cwd(), "deployment-uptime-qualification.json"),
    persistentReceipt: process.env.KONTROL_QUALIFY_PERSISTENT_RECEIPT || undefined,
    persist: false,
    commitPersistentReceipt: false,
    requireQualified: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--require-qualified") args.requireQualified = true;
    else if (value === "--persist") args.persist = true;
    else if (value === "--commit-persistent-receipt") args.commitPersistentReceipt = true;
    else if (["--state-dir", "--service-data-dir", "--expected-build-id", "--expected-source-sha", "--report", "--persistent-receipt"].includes(value)) {
      const next = argv[++index];
      if (!next) throw new Error(`${value} requires a value`);
      const key = { "--state-dir": "stateDir", "--service-data-dir": "serviceDataDir", "--expected-build-id": "expectedBuildId", "--expected-source-sha": "expectedSourceSha", "--report": "report", "--persistent-receipt": "persistentReceipt" }[value];
      args[key] = next;
    } else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

async function qualify(options, dependencies = {}) {
  const now = dependencies.now ?? Date.now();
  const read = dependencies.readJson ?? readJson;
  const fetcher = dependencies.fetch ?? fetch;
  const stateDir = resolve(options.stateDir);
  const serviceDataDir = resolve(options.serviceDataDir);
  const identity = read(join(stateDir, "server.identity.json"));
  const lock = read(join(stateDir, "runtime.lock"));
  const service = read(join(serviceDataDir, "service.json"));

  if (service.serviceName !== "kontrol-core.service") throw new Error("Installed service is not kontrol-core.service");
  if (!identity.instanceId || !identity.generationId || !identity.artifactPath || !identity.buildId) throw new Error("Runtime identity is incomplete");
  if (identity.buildDirty !== 0) throw new Error("Running artifact was built from a dirty source tree");
  if (identity.generationId !== lock.generationId || identity.buildId !== lock.buildId || identity.artifactPath !== lock.artifactPath) {
    throw new Error("Runtime identity and runtime lock do not describe the same generation");
  }
  if (identity.buildId !== service.buildId || identity.artifactPath !== service.artifactPath) {
    throw new Error("Running generation does not match the installed immutable service release");
  }
  if (options.expectedBuildId && identity.buildId !== options.expectedBuildId) throw new Error("Running buildId does not match the requested candidate");

  const metadata = read(join(identity.artifactPath, "build-meta.json"));
  if (metadata.buildId !== identity.buildId || metadata.gitSha !== identity.buildSha || Number(metadata.gitDirty) !== 0) {
    throw new Error("Immutable artifact metadata does not match the running identity");
  }
  if (options.expectedSourceSha && metadata.gitSha !== options.expectedSourceSha) throw new Error("Running source SHA does not match the workflow commit");
  if (typeof metadata.contentSha256 !== "string" || !/^[a-f0-9]{16,64}$/i.test(metadata.contentSha256)) throw new Error("Artifact content identity is missing or invalid");

  requireLiveProcess(identity.pid, identity.processStartTime, "Kontrol server");
  requireLiveProcess(lock.launcherPid, lock.launcherStartToken, "Kontrol launcher");
  const active = dependencies.systemdActive
    ? dependencies.systemdActive()
    : spawnSync("systemctl", ["--user", "is-active", service.serviceName], { encoding: "utf8" }).status === 0;
  if (!active) throw new Error("systemd reports kontrol-core.service is not active");

  const port = Number(lock.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Runtime lock has an invalid serving port");
  const response = await fetcher(`http://127.0.0.1:${port}/core-readyz`, { signal: AbortSignal.timeout(5_000), cache: "no-store" });
  if (!response.ok) throw new Error(`/core-readyz returned HTTP ${response.status}`);
  const readiness = await response.json();
  if (readiness.ok !== true || readiness.ready !== true) throw new Error("/core-readyz did not report ready");
  const operationalResponse = await fetcher(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(5_000), cache: "no-store" });
  if (!operationalResponse.ok) throw new Error(`/readyz returned HTTP ${operationalResponse.status}`);
  const operationalReadiness = await operationalResponse.json();
  if (operationalReadiness.ok !== true || operationalReadiness.ready !== true) throw new Error("/readyz did not report ready");

  const startedAtMs = Date.parse(identity.startedAt);
  if (!Number.isFinite(startedAtMs) || startedAtMs > now) throw new Error("Runtime identity has an invalid future start time");
  const uptimeMs = now - startedAtMs;
  const report = {
    kind: "kontrol-deployment-uptime-qualification",
    schemaVersion: 1,
    status: uptimeMs >= MIN_UPTIME_MS ? "qualified" : "pending",
    qualified: uptimeMs >= MIN_UPTIME_MS,
    policy: { minimumUptimeMs: MIN_UPTIME_MS, uninterruptedRuntimeGenerationRequired: true, coreReadinessRequired: true },
    checkedAt: new Date(now).toISOString(),
    uptimeMs,
    startedAt: identity.startedAt,
    deployment: {
      buildId: identity.buildId,
      contentSha256: metadata.contentSha256,
      sourceSha: metadata.gitSha,
      schemaVersion: metadata.schemaVersion,
      artifactPath: identity.artifactPath,
      generationId: identity.generationId,
      instanceId: identity.instanceId,
      processStartTime: identity.processStartTime,
      pid: identity.pid,
      launcherPid: lock.launcherPid,
      launcherStartToken: lock.launcherStartToken,
      serviceName: service.serviceName,
    },
    checks: { serviceActive: true, runtimeIdentityMatchesLock: true, installedReleaseMatchesRuntime: true, serverProcessLive: true, launcherProcessLive: true, coreReady: true, operationalReady: true },
    workflow: {
      repository: process.env.GITHUB_REPOSITORY || null,
      runId: process.env.GITHUB_RUN_ID || null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
      workflowSha: process.env.GITHUB_SHA || null,
    },
  };
  return report;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.commitPersistentReceipt) {
    if (!options.persistentReceipt) options.persistentReceipt = join(resolve(options.stateDir), "ci-qualification", "deployment-uptime.json");
    const pendingPath = resolve(options.report);
    const attestedReport = readJson(pendingPath);
    if (attestedReport.kind !== "kontrol-deployment-uptime-qualification" || attestedReport.qualified !== true) {
      throw new Error("Refusing to persist a non-qualified uptime report");
    }
    const liveReport = await qualify(options);
    if (!liveReport.qualified
        || liveReport.deployment.buildId !== attestedReport.deployment?.buildId
        || liveReport.deployment.generationId !== attestedReport.deployment?.generationId
        || liveReport.deployment.contentSha256 !== attestedReport.deployment?.contentSha256) {
      throw new Error("Deployment generation changed before the attested receipt could be persisted");
    }
    const persistentPath = resolve(options.persistentReceipt);
    mkdirSync(dirname(persistentPath), { recursive: true, mode: 0o700 });
    const persistentTemp = `${persistentPath}.tmp-${process.pid}`;
    writeFileSync(persistentTemp, `${JSON.stringify(attestedReport, null, 2)}\n`, { mode: 0o600 });
    renameSync(persistentTemp, persistentPath);
    console.log(`[deployment-uptime] persisted qualified generation=${attestedReport.deployment.generationId}`);
  } else {
    let report = await qualify(options);
    let newlyQualified = !options.persist && report.qualified;
    if (options.persist && !options.persistentReceipt) {
      options.persistentReceipt = join(resolve(options.stateDir), "ci-qualification", "deployment-uptime.json");
    }
    if (options.persistentReceipt && report.qualified) {
      const persistentPath = resolve(options.persistentReceipt);
      let existing;
      if (existsSync(persistentPath)) {
        try { existing = JSON.parse(readFileSync(persistentPath, "utf8")); } catch { /* replace an unreadable old receipt atomically */ }
      }
      const reusable = existing?.qualified === true
        && existing?.deployment?.buildId === report.deployment.buildId
        && existing?.deployment?.generationId === report.deployment.generationId
        && existing?.deployment?.contentSha256 === report.deployment.contentSha256
        && existing?.deployment?.sourceSha === report.deployment.sourceSha;
      if (reusable) report = existing;
      else newlyQualified = true;
    }
    const path = resolve(options.report);
    mkdirSync(dirname(path), { recursive: true });
    const tempPath = `${path}.tmp-${process.pid}`;
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    writeFileSync(tempPath, serialized, { mode: 0o600 });
    renameSync(tempPath, path);
    const sha256 = createHash("sha256").update(serialized).digest("hex");
    console.log(`[deployment-uptime] ${report.status.toUpperCase()} build=${report.deployment.buildId} generation=${report.deployment.generationId} uptime_hours=${(report.uptimeMs / 3_600_000).toFixed(2)} sha256=${sha256}`);
    console.log(`[deployment-uptime] report=${path}`);
    if (process.env.GITHUB_OUTPUT) {
      writeFileSync(process.env.GITHUB_OUTPUT, `qualified=${report.qualified}\nnewlyQualified=${newlyQualified}\nbuildId=${report.deployment.buildId}\ngenerationId=${report.deployment.generationId}\n`, { flag: "a" });
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      writeFileSync(process.env.GITHUB_STEP_SUMMARY, `## Kontrol deployment uptime\n\n- Status: **${report.status}**\n- Build: \`${report.deployment.buildId}\`\n- Generation: \`${report.deployment.generationId}\`\n- Uptime: ${(report.uptimeMs / 3_600_000).toFixed(2)} hours (minimum 12)\n- Receipt SHA-256: \`${sha256}\`\n`, { flag: "a" });
    }
    if (!report.qualified && options.requireQualified) process.exitCode = 1;
  }
} catch (error) {
  console.error(`[deployment-uptime] NOT QUALIFIED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
