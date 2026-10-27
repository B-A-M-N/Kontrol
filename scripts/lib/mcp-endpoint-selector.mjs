/** Ordered, worker-scoped MCP endpoints with per-route auth and circuits. */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_FAILURE_THRESHOLD = 2;
const DEFAULT_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 900_000;

function loopback(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || host.startsWith("127.") || (isIP(host) === 6 && host.startsWith("::1"));
}

function parseProfile(value, allowedTools) {
  const keys = new Set(["id", "url", "expectedTlsAuthority", "principal", "resourceIdentity", "allowedCapabilities", "allowedResources", "privacy", "auth", "circuitBreaker"]);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.has(key))) throw new Error("endpoint profile has unsupported fields");
  if (typeof value.id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(value.id)) throw new Error("endpoint profile ID is invalid");
  let url;
  try { url = new URL(value.url); } catch { throw new Error("endpoint " + value.id + " URL is invalid"); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/mcp") throw new Error("endpoint " + value.id + " URL must be a credential-free /mcp URL");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && value.privacy === "private" && loopback(url.hostname))) {
    throw new Error("endpoint " + value.id + " must use HTTPS, except private loopback development endpoints");
  }
  if (String(value.expectedTlsAuthority ?? "").toLowerCase() !== url.host.toLowerCase()) throw new Error("endpoint " + value.id + " TLS authority must exactly match its URL authority");
  if (value.principal !== "worker" && value.principal !== "owner_public") throw new Error("endpoint " + value.id + " principal must be worker or owner_public");
  if (value.privacy !== "private" && value.privacy !== "public") throw new Error("endpoint " + value.id + " privacy must be private or public");
  if (value.privacy === "public" && url.protocol !== "https:") throw new Error("public endpoint " + value.id + " must use HTTPS");
  if (!Array.isArray(value.allowedCapabilities) || value.allowedCapabilities.some((name) => typeof name !== "string" || !allowedTools.has(name))) throw new Error("endpoint " + value.id + " capabilities exceed the worker allowlist");
  if (new Set(value.allowedCapabilities).size !== value.allowedCapabilities.length) throw new Error("endpoint " + value.id + " has duplicate capabilities");
  const allowedResources = value.allowedResources ?? [];
  if (!Array.isArray(allowedResources) || allowedResources.length > 64 || allowedResources.some((uri) => typeof uri !== "string" || uri.length < 1 || uri.length > 2048 || /[\x00-\x1f]/.test(uri))) throw new Error("endpoint " + value.id + " allowedResources must be a bounded exact URI list");
  if (new Set(allowedResources).size !== allowedResources.length) throw new Error("endpoint " + value.id + " has duplicate resource URIs");
  if (value.resourceIdentity !== undefined && value.resourceIdentity !== null) {
    let resource;
    try { resource = new URL(value.resourceIdentity); } catch { throw new Error("endpoint " + value.id + " resource identity is invalid"); }
    if (resource.origin !== url.origin || resource.pathname !== "/mcp" || resource.search || resource.hash || resource.username || resource.password) throw new Error("endpoint " + value.id + " resource identity must match its exact /mcp OAuth resource");
  }
  const auth = value.auth;
  if (!auth || typeof auth !== "object" || Array.isArray(auth) || Object.keys(auth).some((key) => !["type", "credentialRef"].includes(key))) throw new Error("endpoint " + value.id + " authentication profile is invalid");
  if (auth.type === "bearer_file") {
    if (typeof auth.credentialRef !== "string" || !isAbsolute(auth.credentialRef) || !value.resourceIdentity) throw new Error("endpoint " + value.id + " bearer auth requires an absolute credential file and OAuth resource identity");
  } else if (auth.type === "worker_envelope") {
    if (value.principal !== "worker" || value.privacy !== "private" || auth.credentialRef !== undefined) throw new Error("worker-envelope auth is restricted to private worker profiles");
  } else if (auth.type === "none") {
    if (value.principal !== "worker" || value.privacy !== "private" || !loopback(url.hostname)) throw new Error("unauthenticated endpoints are restricted to private worker loopback");
  } else throw new Error("endpoint " + value.id + " authentication type is unsupported");
  const breaker = value.circuitBreaker ?? {};
  if (!breaker || typeof breaker !== "object" || Array.isArray(breaker) || Object.keys(breaker).some((key) => !["failureThreshold", "cooldownMs"].includes(key))) throw new Error("endpoint circuit policy is invalid");
  const failureThreshold = breaker.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const cooldownMs = breaker.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  if (!Number.isInteger(failureThreshold) || failureThreshold < 1 || failureThreshold > 10 || !Number.isInteger(cooldownMs) || cooldownMs < 1000 || cooldownMs > MAX_COOLDOWN_MS) throw new Error("endpoint circuit policy is out of bounds");
  if (value.privacy === "public" && (value.principal !== "owner_public" || auth.type !== "bearer_file" || !value.resourceIdentity)) throw new Error("public endpoints require the owner_public principal, endpoint-specific OAuth bearer credentials, and resource identity");
  return Object.freeze({
    id: value.id, url: url.href, expectedTlsAuthority: url.host.toLowerCase(),
    principal: value.principal, resourceIdentity: value.resourceIdentity ?? null,
    allowedCapabilities: Object.freeze([...value.allowedCapabilities]), allowedResources: Object.freeze([...allowedResources]), privacy: value.privacy,
    auth: Object.freeze({ type: auth.type, ...(auth.credentialRef ? { credentialRef: resolve(auth.credentialRef) } : {}) }),
    circuitBreaker: Object.freeze({ failureThreshold, cooldownMs }),
  });
}

export function parseMcpEndpointProfiles(text, allowedTools, expectedPrincipal) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("KONTROL_BRIDGE_ENDPOINTS must be valid JSON"); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8) throw new Error("KONTROL_BRIDGE_ENDPOINTS must contain 1 to 8 ordered profiles");
  const profiles = parsed.map((value) => parseProfile(value, allowedTools));
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) throw new Error("endpoint profile IDs must be unique");
  const principals = new Set(profiles.map((profile) => profile.principal));
  if (principals.size > 1 || expectedPrincipal && ![...principals].every((principal) => principal === expectedPrincipal)) throw new Error("one MCP transport cannot mix endpoint principals");
  const credentialOrigins = new Map();
  for (const profile of profiles) {
    if (profile.auth.type !== "bearer_file") continue;
    const origin = new URL(profile.url).origin;
    const previous = credentialOrigins.get(profile.auth.credentialRef);
    if (previous && previous !== origin) throw new Error("an OAuth credential file cannot be shared across endpoint origins");
    credentialOrigins.set(profile.auth.credentialRef, origin);
  }
  return Object.freeze(profiles);
}

export class EndpointPreferenceStore {
  #path;
  #profileIds;

  constructor(path, profiles) {
    if (typeof path !== "string" || !isAbsolute(path)) throw new Error("endpoint preference file path must be absolute");
    this.#path = resolve(path);
    this.#profileIds = profiles.map((profile) => profile.id);
  }

  read() {
    if (!existsSync(this.#path)) return [...this.#profileIds];
    const stats = lstatSync(this.#path);
    if (!stats.isFile() || stats.isSymbolicLink()
      // Windows Node stats do not report Unix permission bits; this file only
      // stores endpoint ordering, while its ACL inherits the user's profile.
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())) {
      throw new Error("endpoint preference file must be an owner-only regular file");
    }
    let value;
    try { value = JSON.parse(readFileSync(this.#path, "utf8")); }
    catch { throw new Error("endpoint preference file is corrupt; refusing to change failover order"); }
    if (!value || value.version !== 1 || !Array.isArray(value.endpointIds)) throw new Error("endpoint preference file has an unsupported schema");
    this.#validate(value.endpointIds);
    return [...value.endpointIds];
  }

  write(endpointIds) {
    this.#validate(endpointIds);
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.tmp.${randomUUID()}`;
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ version: 1, endpointIds, updatedAt: new Date().toISOString() })); fsyncSync(fd); }
    catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
    finally { closeSync(fd); }
    try {
      renameSync(temporary, this.#path);
      // Windows does not expose directory handles that Node can fsync. The
      // preference payload itself is flushed before the atomic rename above;
      // supported Linux production releases also flush the containing entry.
      if (process.platform !== "win32") {
        const dirFd = openSync(dirname(this.#path), "r");
        try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      }
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      throw error;
    }
    return [...endpointIds];
  }

  #validate(endpointIds) {
    if (!Array.isArray(endpointIds) || endpointIds.length !== this.#profileIds.length
      || endpointIds.some((id) => typeof id !== "string")
      || new Set(endpointIds).size !== endpointIds.length
      || endpointIds.some((id) => !this.#profileIds.includes(id))) {
      throw new Error("endpoint preference must be an exact ordering of the configured endpoint IDs");
    }
  }
}

/** Reads a fresh private credential file for every transport generation. */
export function authorizationForEndpoint(endpoint) {
  if (endpoint.auth.type === "none" || endpoint.auth.type === "worker_envelope") return "";
  let stats;
  try { stats = statSync(endpoint.auth.credentialRef); } catch { throw new Error("endpoint " + endpoint.id + " credential file is unavailable"); }
  // Node exposes POSIX mode bits on Unix. On Windows, permission authority is
  // the inherited ACL; stat.mode is a compatibility value and cannot prove
  // whether the current user is the only principal allowed to read the file.
  // Linux is the supported production lifecycle platform.
  if (!stats.isFile() || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)
    || (typeof process.getuid === "function" && stats.uid !== process.getuid())) throw new Error("endpoint " + endpoint.id + " credential file must be owner-only");
  const authorization = readFileSync(endpoint.auth.credentialRef, "utf8").trim();
  if (!/^Bearer [^\s]+$/.test(authorization) || /[\x00-\x1f]/.test(authorization)) throw new Error("endpoint " + endpoint.id + " credential file must contain one raw Bearer value");
  return authorization;
}

/** Bind fetch, authentication, and redirects to one endpoint authority. */
export function endpointFetch(endpoint, fetcher = fetch) {
  const origin = new URL(endpoint.url).origin;
  return async (input, init = {}) => {
    let target = new URL(typeof input === "string" || input instanceof URL ? input : input.url, endpoint.url);
    if (target.origin !== origin) throw new Error("MCP endpoint request attempted to leave its configured origin");
    for (let hop = 0; hop <= 5; hop += 1) {
      const response = await fetcher(target, { ...init, redirect: "manual" });
      if (response.status < 301 || response.status > 308) return response;
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location || hop === 5) throw new Error("MCP endpoint redirect was invalid or exceeded the hop limit");
      const next = new URL(location, target);
      if (next.origin !== origin) throw new Error("MCP endpoint refused a cross-origin redirect");
      target = next;
    }
    throw new Error("MCP endpoint redirect was invalid");
  };
}

/** Reattach a previously successful worker checkout to a freshly initialized MCP session. */
export async function restoreWorkerWorkspaceContext(client, workspace) {
  if (!workspace) return;
  const response = await client.callTool({ name: "open_workspace", arguments: workspace.arguments });
  const restoredId = response?.structuredContent?.workspaceId;
  if (response?.isError || restoredId !== workspace.workspaceId) {
    throw new Error("MCP endpoint could not restore the worker's authorized workspace context");
  }
}

export class McpEndpointSelector {
  #profiles;
  #states;
  #cursor = -1;
  #now;
  #order;

  constructor(profiles, { now = () => Date.now() } = {}) {
    if (!Array.isArray(profiles) || profiles.length === 0) throw new Error("at least one MCP endpoint profile is required");
    this.#profiles = profiles;
    this.#states = profiles.map(() => ({ failures: 0, openUntil: 0, halfOpen: false, attempts: 0, successes: 0 }));
    this.#now = now;
    this.#order = profiles.map((_, index) => index);
  }

  setPreference(endpointIds) {
    if (!Array.isArray(endpointIds) || endpointIds.length !== this.#profiles.length
      || new Set(endpointIds).size !== endpointIds.length) throw new Error("endpoint preference must be an exact ordering of configured endpoints");
    const order = endpointIds.map((id) => this.#profiles.findIndex((profile) => profile.id === id));
    if (order.some((index) => index < 0)) throw new Error("endpoint preference contains an unknown endpoint");
    this.#order = order;
    this.#cursor = -1;
    return [...endpointIds];
  }

  select() {
    const now = this.#now();
    for (let step = 1; step <= this.#order.length; step += 1) {
      const position = (this.#cursor + step) % this.#order.length;
      const index = this.#order[position];
      if (!this.#states[index].halfOpen && this.#states[index].openUntil <= now) {
        this.#cursor = position;
        this.#states[index].halfOpen = this.#states[index].openUntil > 0;
        this.#states[index].attempts += 1;
        return this.#profiles[index];
      }
    }
    const nextOpen = Math.min(...this.#states.map((state) => state.openUntil));
    const error = new Error("all MCP endpoint circuits are open");
    error.retryAfterMs = Math.max(1, nextOpen - now);
    throw error;
  }

  record(profileId, ok) {
    const index = this.#profiles.findIndex((profile) => profile.id === profileId);
    if (index < 0) throw new Error("unknown MCP endpoint profile");
    const state = this.#states[index];
    state.halfOpen = false;
    if (ok) { state.failures = 0; state.openUntil = 0; state.successes += 1; return; }
    state.failures += 1;
    if (state.failures >= this.#profiles[index].circuitBreaker.failureThreshold) {
      state.openUntil = this.#now() + this.#profiles[index].circuitBreaker.cooldownMs;
      state.failures = 0;
    }
  }

  snapshot() {
    const now = this.#now();
    return this.#order.map((index) => ({
      id: this.#profiles[index].id, privacy: this.#profiles[index].privacy, principal: this.#profiles[index].principal,
      state: this.#states[index].halfOpen ? "half_open" : this.#states[index].openUntil > now ? "circuit_open" : "eligible",
      retryInMs: Math.max(0, this.#states[index].openUntil - now),
      attempts: this.#states[index].attempts, successes: this.#states[index].successes,
    }));
  }
}
