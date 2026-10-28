/**
 * Durable, profile-scoped Tailscale Serve/Funnel controller. This module only
 * runs argument-vector commands constructed from validated profile data. It
 * never invokes `serve reset` or `funnel reset` and records intent before each
 * mutating command so a later reconcile can resolve a lost response.
 */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { syncDirectory } from "../fs-durability.js";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import type { IngressConfigSource } from "./profile-status.js";
import { defaultLocalProbe, expectedLocalTargetPort, expectedRouteIdentity, validationContextFromConfig } from "./profile-status.js";
import { readTailscaleFacts, type IngressRouteIdentity, type TailscaleFacts, type TailscaleExecResult } from "./tailscale-status.js";
import { validateIngressProfiles } from "./validate.js";
import type { IngressProfile } from "./types.js";

export type IngressOperationState = "prepared" | "command_completed" | "applied" | "disabled" | "failed" | "reconciliation_required";
export interface IngressOperationReceipt {
  operationId: string;
  profileId: string;
  action: "apply" | "disable";
  state: IngressOperationState;
  createdAt: string;
  updatedAt: string;
  cliVersion: string | null;
  intendedRoute: IngressRouteIdentity;
  observedRoute?: IngressRouteIdentity;
  failureClass?: "command_failed" | "command_timed_out" | "serve_not_enabled" | "mapping_mismatch" | "listener_unready" | "observation_unknown";
}
interface IngressReceiptStore { version: 1; receipts: IngressOperationReceipt[] }
export interface IngressControllerDependencies {
  readFacts?: () => Promise<TailscaleFacts>;
  execute?: (args: string[]) => Promise<TailscaleExecResult>;
  localProbe?: (port: number) => Promise<boolean>;
  now?: () => Date;
}

const STORE_NAME = "ingress-operations.json";
const MAX_RECEIPTS = 256;
const COMMAND_TIMEOUT_MS = 10_000;

function nowIso(deps: IngressControllerDependencies): string { return (deps.now?.() ?? new Date()).toISOString(); }

function loadStore(stateDir: string): IngressReceiptStore {
  const path = join(stateDir, STORE_NAME);
  if (!existsSync(path)) return { version: 1, receipts: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("ingress operation receipt store is corrupt; refusing route mutation"); }
  if (!parsed || typeof parsed !== "object" || (parsed as IngressReceiptStore).version !== 1 || !Array.isArray((parsed as IngressReceiptStore).receipts)) {
    throw new Error("ingress operation receipt store has an unsupported shape; refusing route mutation");
  }
  const store = parsed as IngressReceiptStore;
  const states = new Set<IngressOperationState>(["prepared", "command_completed", "applied", "disabled", "failed", "reconciliation_required"]);
  for (const receipt of store.receipts) {
    const route = receipt?.intendedRoute;
    if (typeof receipt?.operationId !== "string" || typeof receipt.profileId !== "string"
      || (receipt.action !== "apply" && receipt.action !== "disable") || !states.has(receipt.state)
      || !route || typeof route.hostname !== "string" || typeof route.listenPort !== "string"
      || typeof route.handlerPath !== "string" || (route.upstreamScheme !== "http" && route.upstreamScheme !== "https")
      || typeof route.upstreamHost !== "string" || typeof route.upstreamPort !== "string"
      || typeof route.upstreamPath !== "string" || typeof route.allowFunnel !== "boolean") {
      throw new Error("ingress operation receipt store contains an invalid record; refusing route mutation");
    }
  }
  return store;
}

function saveStore(stateDir: string, store: IngressReceiptStore): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, STORE_NAME);
  const temporary = `${path}.tmp.${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(store)); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
  syncDirectory(stateDir);
}

function withMutationLock<T>(stateDir: string, run: () => Promise<T>): Promise<T> {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = join(stateDir, "ingress-controller.lock");
  let fd: number;
  try { fd = openSync(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        const existing = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
        if (typeof existing.pid === "number" && Number.isInteger(existing.pid)) {
          try { process.kill(existing.pid, 0); }
          catch (probeError) {
            if ((probeError as NodeJS.ErrnoException).code === "ESRCH") unlinkSync(lockPath);
          }
        }
        fd = openSync(lockPath, "wx", 0o600);
      } catch {
        throw new Error("another ingress mutation is active, or ingress-controller.lock needs operator reconciliation");
      }
    } else throw error;
  }
  writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  fsyncSync(fd);
  return run().finally(() => {
    closeSync(fd);
    try { unlinkSync(lockPath); } catch { /* preserve the operation receipt if cleanup fails */ }
  });
}

async function defaultExecute(args: string[]): Promise<TailscaleExecResult> {
  const allowed = /^(serve|funnel) --bg --yes --https=\d{1,5}( --set-path=\/)?( http:\/\/127\.0\.0\.1:\d{1,5})?( off)?$/;
  const command = args.join(" ");
  if (!allowed.test(command) || args.some((arg) => arg === "reset" || arg.includes(";"))) {
    throw new Error("refusing unsupported Tailscale mutation command");
  }
  const binary = process.env.KONTROL_TAILSCALE_BIN ?? "tailscale";
  return new Promise((resolveResult) => {
    execFile(binary, args, { timeout: COMMAND_TIMEOUT_MS, encoding: "utf8", maxBuffer: 128 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code = error?.code;
      resolveResult({
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr.slice(-4096) : "",
        exitCode: !error ? 0 : typeof code === "number" ? code : error.killed ? 124 : code === "ENOENT" ? 127 : 1,
      });
    });
  });
}

/**
 * Classify a failed Tailscale mutation command.
 *
 * The Tailscale CLI prints the actionable reason on stdout or stderr and can
 * hang (the serve command waits for a tailnet that has Serve disabled). The
 * operator must see the actual reason — "Serve is not enabled on your
 * tailnet" is an enablement task, not an opaque non-zero exit — so the
 * classification is derived from the output, and the output itself is kept
 * for the operator message.
 */
export function classifyCommandFailure(result: TailscaleExecResult): IngressOperationReceipt["failureClass"] {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.exitCode === 124) return "command_timed_out";
  if (output.includes("serve is not enabled") || output.includes("funnel is not enabled")) return "serve_not_enabled";
  return "command_failed";
}

/** The operator-facing reason for a failed command, with no host paths. */
export function commandFailureMessage(result: TailscaleExecResult): string {
  const output = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 4)
    .join(" ");
  // A Tailscale message can contain a node id and a login URL; both are
  // operator-facing and contain no credential material.
  return output.slice(0, 400);
}

function selectProfile(config: IngressConfigSource, profileId: string): IngressProfile {
  const profiles = config.ingress?.profiles ?? [];
  validateIngressProfiles(profiles, validationContextFromConfig(config));
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error(`unknown ingress profile: ${profileId}`);
  if (profile.kind !== "tailscale_serve" && profile.kind !== "tailscale_funnel") throw new Error(`profile ${profileId} is not controlled by Tailscale`);
  if (profile.target === "secure_tunnel_listener") throw new Error("secure tunnel listener cannot be controlled through Tailscale ingress");
  return profile;
}

function targetArgs(profile: IngressProfile, port: number): string[] {
  const url = new URL(profile.externalOrigin);
  const listenPort = url.port || "443";
  return [profile.kind === "tailscale_funnel" ? "funnel" : "serve", "--bg", "--yes", `--https=${listenPort}`, `http://127.0.0.1:${port}`];
}

function requiredRouteIdentity(profile: IngressProfile, port: number, dnsName: string | null): IngressRouteIdentity {
  const identity = expectedRouteIdentity(profile, port, dnsName);
  if (!identity || identity.hostname === null) throw new Error("configured route does not match the observed Tailscale node");
  return { ...identity, hostname: identity.hostname };
}

function offArgs(profile: IngressProfile): string[] {
  const url = new URL(profile.externalOrigin);
  const listenPort = url.port || "443";
  return [profile.kind === "tailscale_funnel" ? "funnel" : "serve", "--bg", "--yes", `--https=${listenPort}`, "--set-path=/", "off"];
}

function sameAuthority(route: IngressRouteIdentity, intended: IngressRouteIdentity): boolean {
  return route.hostname === intended.hostname && route.listenPort === intended.listenPort;
}

function findExactRoute(facts: TailscaleFacts, profile: IngressProfile, intended: IngressRouteIdentity): IngressRouteIdentity | undefined {
  const mappings = profile.kind === "tailscale_funnel" ? facts.funnelMappings : facts.serveMappings;
  return mappings.find((mapping) => mapping.identity && sameIdentity(mapping.identity, intended))?.identity;
}

function sameIdentity(left: IngressRouteIdentity, right: IngressRouteIdentity): boolean {
  return left.hostname === right.hostname && left.listenPort === right.listenPort && left.handlerPath === right.handlerPath
    && left.upstreamScheme === right.upstreamScheme && left.upstreamHost === right.upstreamHost
    && left.upstreamPort === right.upstreamPort && left.upstreamPath === right.upstreamPath && left.allowFunnel === right.allowFunnel;
}

function validateObservation(facts: TailscaleFacts, profile: IngressProfile, intended: IngressRouteIdentity): void {
  if (facts.backendState !== "Running") throw new Error(`Tailscale backend is ${facts.backendState ?? "unknown"}; refusing ingress mutation`);
  const supported = profile.kind === "tailscale_funnel" ? facts.funnelStatusSchemaSupported : facts.serveStatusSchemaSupported;
  const relevantReadFailed = facts.warnings.some((warning) => profile.kind === "tailscale_funnel"
    ? warning.startsWith("tailscale status --json") || warning.startsWith("tailscale funnel status --json")
    : warning.startsWith("tailscale status --json") || warning.startsWith("tailscale serve status --json"));
  if (!supported || relevantReadFailed || !facts.dnsName || facts.dnsName.toLowerCase() !== intended.hostname.toLowerCase()) {
    throw new Error("Tailscale route schema or node identity is unverified; refusing ingress mutation");
  }
}

function makeReceipt(profile: IngressProfile, action: "apply" | "disable", intendedRoute: IngressRouteIdentity, facts: TailscaleFacts, deps: IngressControllerDependencies): IngressOperationReceipt {
  const timestamp = nowIso(deps);
  return { operationId: randomUUID(), profileId: profile.id, action, state: "prepared", createdAt: timestamp, updatedAt: timestamp, cliVersion: facts.cliVersion, intendedRoute };
}

function commitReceipt(stateDir: string, store: IngressReceiptStore, receipt: IngressOperationReceipt, deps: IngressControllerDependencies): void {
  receipt.updatedAt = nowIso(deps);
  const index = store.receipts.findIndex((item) => item.operationId === receipt.operationId);
  if (index < 0) store.receipts.push(receipt);
  else store.receipts[index] = receipt;
  store.receipts = store.receipts.slice(-MAX_RECEIPTS);
  saveStore(stateDir, store);
}

export async function applyIngressProfile(config: IngressConfigSource, stateDir: string, profileId: string, deps: IngressControllerDependencies = {}): Promise<IngressOperationReceipt> {
  return withMutationLock(resolve(stateDir), async () => {
    const profile = selectProfile(config, profileId);
    if (!profile.enabled) throw new Error(`profile ${profileId} is disabled; enable it in configuration before apply`);
    const port = expectedLocalTargetPort(profile, config);
    if (port === null) throw new Error(`target listener ${profile.target} is not enabled`);
    const factsReader = deps.readFacts ?? (() => readTailscaleFacts());
    const facts = await factsReader();
    const intended = requiredRouteIdentity(profile, port, facts.dnsName);
    validateObservation(facts, profile, intended);
    const store = loadStore(stateDir);
    const expectedAuthority = `${intended.hostname}:${intended.listenPort}`;
    const sameAuthorityRoutes = facts.serveMappings.filter((mapping) => mapping.hostPort === expectedAuthority || (mapping.identity && sameAuthority(mapping.identity, intended)));
    const exact = findExactRoute(facts, profile, intended);
    if (exact) {
      const prior = [...store.receipts].reverse().find((item) => item.profileId === profileId && item.state === "applied" && item.intendedRoute && sameIdentity(item.intendedRoute, intended));
      if (prior) return prior;
      throw new Error("an exact route already exists but Kontrol has no ownership receipt; refusing to claim or replace it");
    }
    if (sameAuthorityRoutes.length > 0) throw new Error("the configured Tailscale host/port already has another route; refusing to overwrite operator or other-profile state");

    const receipt = makeReceipt(profile, "apply", intended, facts, deps);
    commitReceipt(stateDir, store, receipt, deps); // durable intent precedes Tailscale mutation
    const execute = deps.execute ?? defaultExecute;
    const result = await execute(targetArgs(profile, port));
    if (result.exitCode !== 0) {
      // A non-zero exit does not prove that the daemon left its route
      // unchanged. Keep the intent active until a fresh status observation.
      receipt.state = "reconciliation_required"; receipt.failureClass = classifyCommandFailure(result);
      commitReceipt(stateDir, store, receipt, deps);
      const reason = commandFailureMessage(result);
      throw new Error(`Tailscale ${profile.kind === "tailscale_funnel" ? "funnel" : "serve"} command failed (exit ${result.exitCode}, ${receipt.failureClass})${reason ? `: ${reason}` : ""}`);
    }
    receipt.state = "command_completed";
    commitReceipt(stateDir, store, receipt, deps);

    const after = await factsReader();
    const observed = findExactRoute(after, profile, intended);
    if (!observed) {
      receipt.state = "reconciliation_required"; receipt.failureClass = "mapping_mismatch";
      commitReceipt(stateDir, store, receipt, deps);
      throw new Error("Tailscale command completed but exact route was not observed; reconcile before retrying");
    }
    receipt.observedRoute = observed;
    const locallyReady = await (deps.localProbe ?? defaultLocalProbe)(port);
    if (!locallyReady) {
      // The route is still exact and was absent before this operation, so this
      // controller owns it and may remove only this profile's route.
      const routesAtAuthority = after.serveMappings.filter((mapping) => mapping.hostPort === `${intended.hostname}:${intended.listenPort}`);
      if (routesAtAuthority.length !== 1) {
        receipt.state = "reconciliation_required"; receipt.failureClass = "observation_unknown";
        commitReceipt(stateDir, store, receipt, deps);
        throw new Error("local target listener is not ready and route ownership is ambiguous; no automatic rollback was attempted");
      }
      const rollback = await execute(offArgs(profile));
      const rollbackFacts = await factsReader();
      if (rollback.exitCode === 0 && !findExactRoute(rollbackFacts, profile, intended)) {
        receipt.state = "failed"; receipt.failureClass = "listener_unready";
      } else {
        receipt.state = "reconciliation_required"; receipt.failureClass = "observation_unknown";
      }
      commitReceipt(stateDir, store, receipt, deps);
      throw new Error(`local target listener did not pass its MCP authentication probe; route rollback ${receipt.state === "failed" ? "confirmed" : "requires reconciliation"}`);
    }
    receipt.state = "applied";
    commitReceipt(stateDir, store, receipt, deps);
    return receipt;
  });
}

export async function disableIngressProfile(config: IngressConfigSource, stateDir: string, profileId: string, deps: IngressControllerDependencies = {}): Promise<IngressOperationReceipt> {
  return withMutationLock(resolve(stateDir), async () => {
    const profile = selectProfile(config, profileId);
    const port = expectedLocalTargetPort(profile, config);
    if (port === null) throw new Error(`target listener ${profile.target} is not enabled`);
    const factsReader = deps.readFacts ?? (() => readTailscaleFacts());
    const facts = await factsReader();
    const intended = requiredRouteIdentity(profile, port, facts.dnsName);
    validateObservation(facts, profile, intended);
    const store = loadStore(stateDir);
    const owner = [...store.receipts].reverse().find((item) => item.profileId === profileId && item.state === "applied" && sameIdentity(item.intendedRoute, intended));
    if (!owner) throw new Error("Kontrol has no applied ownership receipt for this route; refusing to disable external state");
    const exact = findExactRoute(facts, profile, intended);
    if (!exact) {
      owner.state = "disabled";
      commitReceipt(stateDir, store, owner, deps);
      return owner;
    }
    const receipt = makeReceipt(profile, "disable", intended, facts, deps);
    commitReceipt(stateDir, store, receipt, deps);
    const result = await (deps.execute ?? defaultExecute)(offArgs(profile));
    if (result.exitCode !== 0) {
      receipt.state = "reconciliation_required"; receipt.failureClass = classifyCommandFailure(result);
      commitReceipt(stateDir, store, receipt, deps);
      const reason = commandFailureMessage(result);
      throw new Error(`Tailscale route disable command failed (exit ${result.exitCode}, ${receipt.failureClass})${reason ? `: ${reason}` : ""}`);
    }
    receipt.state = "command_completed";
    commitReceipt(stateDir, store, receipt, deps);
    const after = await factsReader();
    if (findExactRoute(after, profile, intended)) {
      receipt.state = "reconciliation_required"; receipt.failureClass = "mapping_mismatch";
      commitReceipt(stateDir, store, receipt, deps);
      throw new Error("disable command completed but the owned route remains; reconcile before retrying");
    }
    receipt.state = "disabled";
    commitReceipt(stateDir, store, receipt, deps);
    owner.state = "disabled";
    commitReceipt(stateDir, store, owner, deps);
    return receipt;
  });
}

export async function reconcileIngressProfile(config: IngressConfigSource, stateDir: string, profileId: string, deps: IngressControllerDependencies = {}): Promise<IngressOperationReceipt | undefined> {
  return withMutationLock(resolve(stateDir), async () => {
    const profile = selectProfile(config, profileId);
    const store = loadStore(resolve(stateDir));
    const receipt = [...store.receipts].reverse().find((item) => item.profileId === profileId && ["prepared", "command_completed", "reconciliation_required"].includes(item.state));
    if (!receipt) return [...store.receipts].reverse().find((item) => item.profileId === profileId);
    const facts = await (deps.readFacts ?? (() => readTailscaleFacts()))();
    validateObservation(facts, profile, receipt.intendedRoute);
    const exact = findExactRoute(facts, profile, receipt.intendedRoute);
    if (receipt.action === "apply" && exact) {
      const port = expectedLocalTargetPort(profile, config);
      if (port === null || !(await (deps.localProbe ?? defaultLocalProbe)(port))) {
        receipt.state = "reconciliation_required"; receipt.failureClass = "listener_unready";
      } else {
        receipt.state = "applied"; receipt.observedRoute = exact; delete receipt.failureClass;
      }
    } else if (receipt.action === "disable" && !exact) {
      receipt.state = "disabled"; delete receipt.failureClass;
    } else {
      receipt.state = "reconciliation_required";
    }
    commitReceipt(resolve(stateDir), store, receipt, deps);
    return receipt;
  });
}

export function listIngressOperationReceipts(stateDir: string): IngressOperationReceipt[] {
  return loadStore(resolve(stateDir)).receipts.map((receipt) => ({ ...receipt }));
}
