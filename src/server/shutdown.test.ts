import assert from "node:assert/strict";
import { createShutdownController } from "./shutdown.js";

const events: string[] = [];
let releaseDrain!: () => void;
const drainingTurn = new Promise<void>((resolve) => { releaseDrain = resolve; });
let releaseMaintenance!: () => void;
const drainingMaintenance = new Promise<void>((resolve) => { releaseMaintenance = resolve; });
const timer = setInterval(() => undefined, 60_000);
timer.unref();

const shutdown = createShutdownController({
  config: {} as any,
  db: { close: () => { events.push("database-close"); } } as any,
  transports: new Map(), mcpServers: new Map(), mcpSessions: new Map(),
  sessionLifecycle: { recordMcpSessionEnd() {}, reaper: timer, memorySampler: timer } as any,
  mcpAdmission: { close: () => { events.push("mcp-admission-close"); } } as any,
  mcpWaiterAdmission: { close: () => events.push("waiter-admission-close") } as any,
  mcpResourceAdmission: { close: () => events.push("resource-admission-close") } as any,
  startupReconciliation: { stop: () => events.push("startup-stop") },
  maintenance: { stop: async () => { events.push("maintenance-stop-start"); await drainingMaintenance; events.push("maintenance-stop-complete"); } },
  reviewCheckpoints: { drain: async () => { events.push("checkpoint-drain"); } },
  reviewerTurnDispatcher: { stopAndDrain: async () => { events.push("browser-turn-drain-start"); await drainingTurn; events.push("browser-turn-drain-complete"); } },
  reviewBrowserController: { close: async () => { events.push("browser-close"); } },
  dispatcher: undefined, supervisorRuntime: undefined, replyDispatcher: undefined, scheduledJobRuntime: undefined,
  supervisorRuns: { close: () => undefined }, mcpSessionChurnTimer: timer, shuttingDown: { value: false },
  oauthProvider: null, workspaceStore: {}, workSessions: {}, agentRegistry: { close: () => undefined },
  eventStore: { close: () => undefined }, continuationManager: { close: () => undefined }, dispatchOutbox: { close: () => undefined },
  processSessions: { shutdown: async () => undefined }, shutdownMissionVerifiers: async () => undefined,
  integrity: { stop: async () => undefined },
} as any);

const closePromise = shutdown.close();
for (let index = 0; index < 50 && !events.includes("maintenance-stop-start"); index += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2));
}
assert.ok(events.includes("maintenance-stop-start"), "shutdown stops and drains maintenance first");
assert.equal(events.includes("browser-turn-drain-start"), false, "later shutdown phases wait for maintenance to finish");
assert.equal(events.includes("database-close"), false, "the database stays open while maintenance is active");
releaseMaintenance();
for (let index = 0; index < 50 && !events.includes("browser-turn-drain-start"); index += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2));
}
assert.ok(events.includes("browser-turn-drain-start"), "shutdown invokes the in-flight browser-turn drain");
assert.equal(events.includes("browser-close"), false, "the browser controller stays open while an active dispatch drains");
assert.equal(events.includes("database-close"), false, "the database stays open while an active dispatch drains");
releaseDrain();
await closePromise;
assert.ok(events.indexOf("maintenance-stop-complete") < events.indexOf("database-close"), "maintenance drains before database close");
assert.ok(events.indexOf("browser-turn-drain-complete") < events.indexOf("browser-close"), "browser teardown follows the completed turn drain");
assert.ok(events.indexOf("browser-close") < events.indexOf("database-close"), "database close follows browser teardown");
assert.equal(events.at(-1), "database-close", "database is the final shutdown resource");

console.log("server/shutdown.test.ts: browser drain ordering assertions passed");

const guardedEvents: string[] = [];
let activeRequests = 1;
const guarded = createShutdownController({
  config: { mcpShutdownDrainMs: 15 } as any,
  db: { close: () => guardedEvents.push("database-close") } as any,
  transports: new Map([["session", { close: async () => { guardedEvents.push("transport-close"); } }]]) as any,
  mcpServers: new Map(), mcpSessions: new Map(),
  sessionLifecycle: { recordMcpSessionEnd() {}, reaper: timer, memorySampler: timer } as any,
  mcpAdmission: { close() {}, getStats: () => ({ active: activeRequests, activeWeight: 3 }) } as any,
  mcpWaiterAdmission: { close() {}, getStats: () => ({ active: 0, activeWeight: 0 }) } as any,
  mcpResourceAdmission: { close() {}, getStats: () => ({ active: 0, activeWeight: 0 }) } as any,
  startupReconciliation: { stop() {} }, maintenance: { stop() {} },
  reviewCheckpoints: { drain: async () => undefined }, supervisorRuns: { close() {} },
  dispatcher: undefined, supervisorRuntime: undefined, replyDispatcher: undefined, scheduledJobRuntime: undefined,
  mcpSessionChurnTimer: timer, shuttingDown: { value: false }, oauthProvider: null,
  workspaceStore: {}, workSessions: {}, agentRegistry: { close() {} }, eventStore: { close() {} },
  continuationManager: { close() {} }, dispatchOutbox: { close() {} }, processSessions: { shutdown: async () => undefined },
  shutdownMissionVerifiers: async () => undefined, integrity: { stop: async () => undefined },
} as any);
await assert.rejects(guarded.drain(), /MCP drain remains fenced/);
assert.equal(guardedEvents.length, 0, "a stuck handler keeps its transport and database open after the bounded drain window");
activeRequests = 0;
await guarded.drain();
assert.ok(guardedEvents.includes("transport-close"));
assert.ok(guardedEvents.includes("database-close"));

const passiveEvents: string[] = [];
let activeWaiters = 1;
const passive = createShutdownController({
  config: { mcpShutdownDrainMs: 100 } as any,
  db: { close: () => passiveEvents.push("database-close") } as any,
  transports: new Map([[
    "session",
    { close: async () => { passiveEvents.push("transport-close"); activeWaiters = 0; } },
  ]]) as any,
  mcpServers: new Map(), mcpSessions: new Map(),
  sessionLifecycle: { recordMcpSessionEnd() {}, reaper: timer, memorySampler: timer } as any,
  mcpAdmission: { close() {}, getStats: () => ({ active: 0, activeWeight: 0 }) } as any,
  mcpWaiterAdmission: { close() {}, getStats: () => ({ active: activeWaiters, activeWeight: activeWaiters }) } as any,
  mcpResourceAdmission: { close() {}, getStats: () => ({ active: 0, activeWeight: 0 }) } as any,
  startupReconciliation: { stop() {} }, maintenance: { stop() {} },
  reviewCheckpoints: { drain: async () => undefined }, supervisorRuns: { close() {} },
  dispatcher: undefined, supervisorRuntime: undefined, replyDispatcher: undefined, scheduledJobRuntime: undefined,
  mcpSessionChurnTimer: timer, shuttingDown: { value: false }, oauthProvider: null,
  workspaceStore: {}, workSessions: {}, agentRegistry: { close() {} }, eventStore: { close() {} },
  continuationManager: { close() {} }, dispatchOutbox: { close() {} }, processSessions: { shutdown: async () => undefined },
  shutdownMissionVerifiers: async () => undefined, integrity: { stop: async () => undefined },
} as any);
await passive.drain();
assert.ok(passiveEvents.indexOf("transport-close") < passiveEvents.indexOf("database-close"), "passive watchers are woken before stores close");
