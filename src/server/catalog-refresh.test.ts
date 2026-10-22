import assert from "node:assert/strict";
import { sendCatalogRefreshNotification } from "./catalog-refresh.js";

const state = {
  toolListRefreshSent: false,
  resourceListRefreshSent: true,
  toolListRefreshAttempts: 0,
  resourceListRefreshAttempts: 1,
  toolListRefreshSuccesses: 0,
  resourceListRefreshSuccesses: 1,
  toolListRefreshFailures: 0,
  resourceListRefreshFailures: 0,
  toolListRefreshInFlight: false,
  resourceListRefreshInFlight: false,
};
let sends = 0;
const failures: unknown[] = [];
const rejectOnce = async () => {
  sends += 1;
  throw new Error("injected transport close");
};
const sendAfterRecovery = async () => { sends += 1; };
const onFailure = (error: unknown) => failures.push(error);

assert.equal(await sendCatalogRefreshNotification(state, "tools", rejectOnce, onFailure, 1_000), "failed");
assert.equal(await sendCatalogRefreshNotification(state, "tools", sendAfterRecovery, onFailure, 1_099), "backoff");
assert.equal(await sendCatalogRefreshNotification(state, "tools", sendAfterRecovery, onFailure, 1_100), "sent");
assert.equal(await sendCatalogRefreshNotification(state, "tools", sendAfterRecovery, onFailure, 2_000), "already_sent");
assert.equal(await sendCatalogRefreshNotification(state, "resources", sendAfterRecovery, onFailure, 2_000), "already_sent");
assert.equal(sends, 2, "only the failed channel retries and successful channels are never duplicated");
assert.equal(state.toolListRefreshAttempts, 2);
assert.equal(state.toolListRefreshFailures, 1);
assert.equal(state.toolListRefreshSuccesses, 1);
assert.equal(failures.length, 1);

const exhausted = {
  ...state,
  toolListRefreshSent: false,
  toolListRefreshAttempts: 2,
  toolListRefreshFailures: 2,
  toolListRefreshLastAttemptMs: 5_000,
};
assert.equal(await sendCatalogRefreshNotification(exhausted, "tools", rejectOnce, onFailure, 5_199), "backoff");
assert.equal(await sendCatalogRefreshNotification(exhausted, "tools", rejectOnce, onFailure, 5_200), "failed");
assert.equal(await sendCatalogRefreshNotification(exhausted, "tools", sendAfterRecovery, onFailure, 7_000), "exhausted");
assert.equal(exhausted.toolListRefreshAttempts, 3, "retry count is bounded");

let release!: () => void;
const inFlightState = { ...state, toolListRefreshSent: false, toolListRefreshInFlight: false, toolListRefreshAttempts: 0, toolListRefreshLastAttemptMs: undefined };
const pending = sendCatalogRefreshNotification(inFlightState, "tools", () => new Promise<void>((resolve) => { release = resolve; }), onFailure, 10_000);
assert.equal(await sendCatalogRefreshNotification(inFlightState, "tools", sendAfterRecovery, onFailure, 10_001), "in_flight");
release();
assert.equal(await pending, "sent");

console.log("catalog-refresh.test.ts: bounded retry and success de-duplication assertions passed");
