#!/usr/bin/env node
/** Validate and receipt the exact installed Caddy bridge configuration. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, fsyncSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const ALLOWED_PATHS = ["/mcp", "/.well-known/*", "/authorize", "/token", "/register", "/revoke", "/healthz"];

function option(name, fallback) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function walk(value, visit, parentMatch = []) {
  if (Array.isArray(value)) { for (const item of value) walk(item, visit, parentMatch); return; }
  if (!value || typeof value !== "object") return;
  const record = value;
  const localPaths = Array.isArray(record.match)
    ? record.match.flatMap((entry) => Array.isArray(entry?.path) ? entry.path : [])
    : [];
  const paths = localPaths.length ? localPaths : parentMatch;
  visit(record, paths);
  for (const child of Object.values(record)) walk(child, visit, paths);
}

export function createCaddyQualificationReceipt({ configText, configPath, caddyVersion, bridgeNode, publicHost, expectedUpstream, expectedHost, buildId, requiredStripHeaders = [], adaptedConfig, qualifiedAt = new Date().toISOString() }) {
  if (typeof configText !== "string" || typeof configPath !== "string" || typeof caddyVersion !== "string"
    || typeof bridgeNode !== "string" || !bridgeNode.trim() || typeof publicHost !== "string"
    || !(typeof expectedUpstream === "string" || Array.isArray(expectedUpstream))
    || typeof buildId !== "string" || !buildId.trim() || !adaptedConfig || typeof adaptedConfig !== "object") {
    throw new Error("Caddy qualification inputs are incomplete");
  }
  const upstreams = (Array.isArray(expectedUpstream) ? expectedUpstream : String(expectedUpstream).split(",")).map((authority) => authority.trim());
  if (!upstreams.length || upstreams.some((authority) => !authority)) throw new Error("expected upstreams must be a nonempty authority list");
  for (const authority of upstreams) {
    let upstreamUrl;
    try { upstreamUrl = new URL(`https://${authority}`); }
    catch { throw new Error("expected upstream must be a host:port authority"); }
    if (upstreamUrl.username || upstreamUrl.password || upstreamUrl.pathname !== "/" || upstreamUrl.search || upstreamUrl.hash || !upstreamUrl.port) {
      throw new Error("expected upstream must be a credential-free host:port authority");
    }
  }
  const configuredSite = configText.match(/^([^\s{}#]+)\s*\{$/m)?.[1];
  if (configuredSite !== publicHost) throw new Error("deployed Caddy site host does not match the expected public host");
  const matcher = configText.match(/^[ \t]*@mcp_or_auth path (.+)$/m)?.[1]?.trim().split(/[ \t]+/) ?? [];
  if (JSON.stringify(matcher) !== JSON.stringify(ALLOWED_PATHS)) throw new Error("deployed Caddy route allowlist does not match the approved bridge contract");
  const proxyLine = configText.match(/^[ \t]*reverse_proxy ([^\n]+)$/m)?.[1]?.trim().replace(/[ \t]*\{$/, "").split(/[ \t]+/) ?? [];
  if (proxyLine.length !== upstreams.length || proxyLine.some((address, index) => address !== `https://${upstreams[index]}`)) {
    throw new Error("deployed Caddy upstream or Host pin differs from the expected bridge route");
  }
  const hostPin = upstreams.length === 1 ? "{upstream_hostport}" : expectedHost;
  if (typeof hostPin !== "string" || !configText.split(/\r?\n/).some((line) => line.trim() === `header_up Host ${hostPin}`)) {
    throw new Error("deployed Caddy upstream or Host pin differs from the expected bridge route");
  }
  if (upstreams.length > 1) {
    if (!/^[ \t]*lb_policy first[ \t]*$/m.test(configText) || !/^[ \t]*health_uri \/healthz[ \t]*$/m.test(configText)) {
      throw new Error("multipath bridge must use ordered active health selection");
    }
    if (/^[ \t]*lb_(?:retries|try_duration|retry_match)\b/m.test(configText)) {
      throw new Error("multipath bridge must not retry ambiguous MCP requests");
    }
    if (!/^[ \t]*tls_server_name kontrol-gateway\.internal[ \t]*$/m.test(configText)
      || !/^[ \t]*tls_trust_pool file \S+[ \t]*$/m.test(configText)
      || !/^[ \t]*tls_client_auth \S+ \S+[ \t]*$/m.test(configText)) {
      throw new Error("multipath bridge must verify the shared gateway identity and present its mTLS service credential");
    }
  }
  if (/tls_insecure_skip_verify/.test(configText)) throw new Error("deployed Caddy config weakens upstream TLS verification");
  if (!/^[ \t]*max_header_size 32KiB[ \t]*$/m.test(configText)) throw new Error("deployed Caddy config must set max_header_size 32KiB");
  if (!/^[ \t]*max_conns_per_host 128[ \t]*$/m.test(configText)) throw new Error("deployed Caddy config must set max_conns_per_host 128");
  if (!/request_body[ \t]*\{[\s\S]*?max_size 8MB[\s\S]*?\}/.test(configText)) throw new Error("deployed Caddy config must cap request bodies at 8MB");
  if (!/Strict-Transport-Security/.test(configText)) throw new Error("deployed Caddy config must set HSTS");
  const deletedHeaders = [...configText.matchAll(/^[ \t]*header_up -([A-Za-z][A-Za-z0-9_-]*)[ \t]*$/gm)].map((match) => match[1].toLowerCase()).sort();
  const expectedDeletes = requiredStripHeaders.map((header) => header.toLowerCase()).sort();
  if (JSON.stringify(deletedHeaders) !== JSON.stringify(expectedDeletes) || !/^[ \t]*header_up -X-Kontrol-[*][ \t]*$/m.test(configText)) {
    throw new Error("deployed Caddy header-strip policy differs from Kontrol's authority-header contract");
  }
  const setHeaders = [...configText.matchAll(/^[ \t]*header_up ([^-][^\n]*)$/gm)].map((match) => match[1].trim()).filter((entry) => entry !== `Host ${hostPin}`);
  if (setHeaders.length) throw new Error("deployed Caddy config sets an unapproved upstream request header");

  const proxies = [];
  let hasPinnedHost = false;
  let hasInsecureTls = false;
  let has404 = false;
  walk(adaptedConfig, (record, paths) => {
    if (record.handler === "reverse_proxy") proxies.push({ record, paths });
    if (record.handler === "reverse_proxy") {
      const dials = Array.isArray(record.upstreams) ? record.upstreams.map((upstream) => upstream?.dial) : [];
      if (JSON.stringify(dials) !== JSON.stringify(upstreams)) throw new Error("adapted Caddy proxy upstreams differ from the expected ordered upstream list");
      if (JSON.stringify(paths) !== JSON.stringify(ALLOWED_PATHS)) throw new Error("adapted Caddy proxy route paths differ from the approved allowlist");
      const header = record.headers?.request?.set?.Host;
      const adaptedHost = upstreams.length === 1 ? "{http.reverse_proxy.upstream.hostport}" : expectedHost;
      if (Array.isArray(header) && header.includes(adaptedHost)) hasPinnedHost = true;
    }
    for (const [key, value] of Object.entries(record)) {
      if ((key === "tls_insecure_skip_verify" || key === "insecure_skip_verify") && value) hasInsecureTls = true;
      if (key === "status_code" && value === 404) has404 = true;
    }
  });
  if (hasInsecureTls) throw new Error("adapted Caddy config weakens upstream TLS verification");
  if (proxies.length !== 1 || !hasPinnedHost || !has404) throw new Error("adapted Caddy config is missing a single pinned proxy route or 404 catch-all");
  return {
    schemaVersion: 1,
    qualificationId: randomUUID(),
    qualifiedAt,
    configPath: resolve(configPath),
    configSha256: createHash("sha256").update(configText).digest("hex"),
    effectiveConfigSha256: createHash("sha256").update(canonicalJson(adaptedConfig)).digest("hex"),
    buildId: buildId.trim().slice(0, 128),
    caddyVersion: caddyVersion.trim().slice(0, 256),
    bridgeNode: bridgeNode.trim().slice(0, 128),
    publicHost,
    upstream: upstreams[0],
    upstreams,
    upstreamSelection: upstreams.length > 1 ? "first_healthy_active_check" : "single",
    automaticRetries: false,
    routeAllowlist: ALLOWED_PATHS,
    evidenceTier: "config_validated",
    routeIsolation: "not_proven_by_config_validation",
  };
}

/**
 * Resolve the bridge header-strip contract from the built artifact when it
 * exists, and from the TypeScript source otherwise.
 */
async function importBridgeStripHeaders() {
  const built = new URL("../dist/ingress/proxy-context.js", import.meta.url);
  if (existsSync(built)) return import(built.href);
  return import(new URL("../src/ingress/proxy-context.ts", import.meta.url));
}

function childEnvironment() {
  const env = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function runCaddy(binary, args) {
  const result = await execFileAsync(binary, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: childEnvironment() });
  return result.stdout;
}

function persistReceipt(path, receipt) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.tmp.${process.pid}.${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(receipt, null, 2) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, absolute);
  const dirFd = openSync(dirname(absolute), "r");
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

async function main() {
  const configPath = option("--config");
  const bridgeNode = option("--bridge-node");
  const publicHost = option("--public-host");
  const expectedUpstream = option("--upstream");
  const expectedHost = option("--upstream-host");
  const receiptPath = option("--receipt");
  const buildId = option("--build-id", process.env.KONTROL_BUILD_ID);
  if (!configPath || !bridgeNode || !publicHost || !expectedUpstream || !receiptPath || !buildId) {
    throw new Error("usage: qualify-caddy-bridge.mjs --config PATH --bridge-node ID --public-host HOST --upstream HOST:PORT[,HOST:PORT] [--upstream-host HOST] --build-id ID --receipt PATH");
  }
  const configText = readFileSync(configPath, "utf8");
  const binary = process.env.KONTROL_CADDY_BIN ?? "caddy";
  const caddyVersion = await runCaddy(binary, ["version"]);
  await runCaddy(binary, ["validate", "--config", configPath, "--adapter", "caddyfile"]);
  const adaptedText = await runCaddy(binary, ["adapt", "--config", configPath, "--adapter", "caddyfile", "--pretty"]);
  let adaptedConfig;
  try { adaptedConfig = JSON.parse(adaptedText); }
  catch { throw new Error("Caddy adapt did not return valid JSON"); }
  // The strip-list contract lives with the source that enforces it. A
  // release qualification reads the built artifact; a source-mode run reads
  // the TypeScript source (the runner then executes this script with tsx).
  const { BRIDGE_STRIP_HEADERS } = await importBridgeStripHeaders();
  const receipt = createCaddyQualificationReceipt({ configText, configPath, caddyVersion, bridgeNode, publicHost, expectedUpstream, expectedHost, buildId, requiredStripHeaders: BRIDGE_STRIP_HEADERS, adaptedConfig });
  persistReceipt(receiptPath, receipt);
  process.stdout.write(`Caddy config validated: ${receipt.configSha256}\nreceipt: ${resolve(receiptPath)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => { process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n"); process.exitCode = 1; });
}
