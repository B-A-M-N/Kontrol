import { atomicWriteJson } from "./managed-agent-process.mjs";
import { readFile } from "node:fs/promises";

const DEFAULT_EVENT_LIMIT = 512;
const DEFAULT_TERMINAL_LIMIT = 100;

/** Durable, ordered adapter-to-controller event delivery. Terminal entries are
 * retained until the controller echoes the exact event and dispatch receipt. */
export function createAdapterEventSpool({
  eventPath,
  terminalPath,
  sequencePath = `${eventPath}.sequences`,
  deliver,
  acknowledgeTerminal,
  maxEvents = DEFAULT_EVENT_LIMIT,
  maxTerminalEvents = DEFAULT_TERMINAL_LIMIT,
}) {
  if (!eventPath || !terminalPath || typeof deliver !== "function") {
    throw new Error("Adapter event spool requires paths and a delivery function.");
  }
  const pendingEvents = new Map();
  const pendingTerminalEvents = new Map();
  const runQueues = new Map();
  const runDeliveryLocks = new Map();
  const sequenceHighWater = new Map();
  let saveQueue = Promise.resolve();
  let flushPromise;

  async function load() {
    const readDurableJson = async (filePath, fallback) => {
      try { return JSON.parse(await readFile(filePath, "utf8")); }
      catch (error) {
        if (error?.code === "ENOENT") return fallback;
        throw new Error(`Cannot load durable adapter event state at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const [events, terminals, sequences] = await Promise.all([
      readDurableJson(eventPath, []),
      readDurableJson(terminalPath, []),
      readDurableJson(sequencePath, {}),
    ]);
    for (const entry of Array.isArray(events) ? events : []) {
      if (entry?.runId && entry?.event?.event_id) pendingEvents.set(entry.event.event_id, entry);
    }
    for (const entry of Array.isArray(terminals) ? terminals : []) {
      if (entry?.runId && entry?.event?.event_id) pendingTerminalEvents.set(entry.event.event_id, entry);
    }
    if (sequences && typeof sequences === "object" && !Array.isArray(sequences)) {
      for (const [remoteRunId, sequence] of Object.entries(sequences)) {
        if (Number.isSafeInteger(sequence) && sequence >= 0) sequenceHighWater.set(remoteRunId, sequence);
      }
    }
    for (const entry of [...pendingEvents.values(), ...pendingTerminalEvents.values()]) {
      const remoteRunId = entry.event.remote_run_id;
      if (typeof remoteRunId === "string") {
        sequenceHighWater.set(remoteRunId, Math.max(sequenceHighWater.get(remoteRunId) ?? 0, entry.event.event_sequence));
      }
    }
    if (pendingEvents.size > maxEvents || pendingTerminalEvents.size > maxTerminalEvents) {
      throw new Error("Adapter event spool exceeds its configured recovery capacity.");
    }
  }

  function save() {
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      await Promise.all([
        atomicWriteJson(eventPath, [...pendingEvents.values()]),
        atomicWriteJson(terminalPath, [...pendingTerminalEvents.values()]),
        atomicWriteJson(sequencePath, Object.fromEntries(sequenceHighWater)),
      ]);
    });
    return saveQueue;
  }

  function enqueue(runId, event, terminal = false, beforeDelivery) {
    const queueKey = String(runId);
    const preceding = runQueues.get(queueKey) ?? Promise.resolve();
    const operation = preceding.catch(() => {}).then(async () => {
      if (typeof event?.event_id !== "string" || !event.event_id || !Number.isInteger(event.event_sequence)
        || typeof event.remote_run_id !== "string" || !event.remote_run_id) {
        throw new Error("Adapter events require a stable identity and sequence.");
      }
      const target = terminal ? pendingTerminalEvents : pendingEvents;
      const existing = target.get(event.event_id);
      if (existing && JSON.stringify(existing.event) !== JSON.stringify(event)) {
        throw new Error(`Adapter event identity conflict: ${event.event_id}`);
      }
      if (!existing) {
        const highWater = sequenceHighWater.get(event.remote_run_id) ?? 0;
        if (event.event_sequence <= highWater) {
          throw new Error(`Adapter event sequence did not advance for ${event.remote_run_id}.`);
        }
        const other = terminal ? pendingEvents.get(event.event_id) : pendingTerminalEvents.get(event.event_id);
        if (other && JSON.stringify(other.event) !== JSON.stringify(event)) {
          throw new Error(`Adapter event identity conflict: ${event.event_id}`);
        }
        const capacity = terminal ? maxTerminalEvents : maxEvents;
        if (target.size >= capacity) throw new Error(`Adapter ${terminal ? "terminal " : ""}event spool is full.`);
        target.set(event.event_id, { runId: queueKey, event, spooledAt: Date.now() });
        sequenceHighWater.set(event.remote_run_id, event.event_sequence);
        await save();
      }
      await beforeDelivery?.();
      await flushRun(queueKey);
      return !pendingEvents.has(event.event_id) && !pendingTerminalEvents.has(event.event_id);
    });
    runQueues.set(queueKey, operation);
    void operation.finally(() => {
      if (runQueues.get(queueKey) === operation) runQueues.delete(queueKey);
    }).catch(() => {});
    return operation;
  }

  async function withRunLock(runId, operation) {
    const preceding = runDeliveryLocks.get(runId) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    runDeliveryLocks.set(runId, current);
    await preceding.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (runDeliveryLocks.get(runId) === current) runDeliveryLocks.delete(runId);
    }
  }

  async function deliverEntry(entry, terminal) {
    let response;
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      try {
        response = await deliver(entry.runId, entry.event);
        if (response?.ok) break;
      } catch { /* retain the durable event and retry below */ }
      response = undefined;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    if (!response?.ok) return false;
    if (terminal) {
      let body;
      try { body = await response.json(); } catch { return false; }
      if (!await acknowledgeTerminal?.(entry.event, body)) return false;
    } else if (typeof response.arrayBuffer === "function") await response.arrayBuffer().catch(() => {});
    const target = terminal ? pendingTerminalEvents : pendingEvents;
    target.delete(entry.event.event_id);
    await save();
    return true;
  }

  async function flushRun(runId) {
    return withRunLock(runId, async () => {
      const events = [...pendingEvents.values()]
        .filter((entry) => entry.runId === runId)
        .sort((left, right) => left.event.event_sequence - right.event.event_sequence);
      for (const entry of events) {
        if (!await deliverEntry(entry, false)) return false;
      }
      const terminals = [...pendingTerminalEvents.values()].filter((entry) => entry.runId === runId)
        .sort((left, right) => left.event.event_sequence - right.event.event_sequence);
      for (const entry of terminals) {
        if ([...pendingEvents.values()].some((event) => event.runId === runId)) return false;
        if (!await deliverEntry(entry, true)) return false;
      }
      return true;
    });
  }

  function flush() {
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      const runIds = new Set([
        ...[...pendingEvents.values()].map((entry) => entry.runId),
        ...[...pendingTerminalEvents.values()].map((entry) => entry.runId),
      ]);
      let delivered = true;
      for (const runId of runIds) delivered = await flushRun(runId) && delivered;
      return delivered;
    })().finally(() => { flushPromise = undefined; });
    return flushPromise;
  }

  function snapshot() {
    return {
      pendingEvents: pendingEvents.size,
      pendingTerminalEvents: pendingTerminalEvents.size,
    };
  }

  function pendingTerminalEntries() {
    return [...pendingTerminalEvents.values()].map((entry) => ({ ...entry }));
  }

  function hasPendingEvent(eventId) {
    return pendingEvents.has(eventId) || pendingTerminalEvents.has(eventId);
  }

  function nextSequence(remoteRunId) {
    return (sequenceHighWater.get(remoteRunId) ?? 0) + 1;
  }

  return { load, enqueue, flush, snapshot, pendingTerminalEntries, hasPendingEvent, nextSequence };
}
