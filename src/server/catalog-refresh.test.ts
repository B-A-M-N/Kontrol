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

// A send that resolves after its delivery surface ended is not a success: the
// channel stays eligible so the next delivery surface carries it.
const staleState = {
  ...state,
  toolListRefreshSent: false,
  toolListRefreshAttempts: 0,
  toolListRefreshSuccesses: 0,
  toolListRefreshFailures: 0,
  toolListRefreshLastAttemptMs: undefined,
  toolListRefreshInFlight: false,
};
let surfaceAlive = true;
const staleOutcome = await sendCatalogRefreshNotification(staleState, "tools", async () => {
  // The delivery surface ends while this send is in flight.
  surfaceAlive = false;
}, onFailure, 20_000, { isDeliveryStillValid: () => surfaceAlive });
assert.equal(staleOutcome, "stale", "a send that resolves after its delivery surface ended is not a success");
assert.equal(staleState.toolListRefreshSent, false, "a stale delivery never marks the channel sent");
assert.equal(staleState.toolListRefreshSuccesses, 0, "a stale delivery is not counted as a delivered success");
assert.equal(staleState.toolListRefreshFailures, 0, "a stale delivery is not a transport failure");
assert.equal(staleState.toolListRefreshInFlight, false, "a stale delivery releases the in-flight guard");
assert.equal(staleState.toolListRefreshAttempts, 0, "a stale delivery does not consume the retry budget of the next surface");

surfaceAlive = true;
assert.equal(
  await sendCatalogRefreshNotification(staleState, "tools", sendAfterRecovery, onFailure, 21_000, {
    isDeliveryStillValid: () => surfaceAlive,
  }),
  "sent",
  "the channel stays eligible and the next delivery surface carries it",
);
assert.equal(staleState.toolListRefreshSent, true);
assert.equal(staleState.toolListRefreshSuccesses, 1);

// A stale delivery restores the backoff timestamp, not only the attempt
// count. Without the restore the next delivery surface would have to wait
// out a backoff that a discarded send never earned: the attempt it consumed
// never happened on a surface that could carry it.
const staleBackoffState = {
  ...state,
  toolListRefreshSent: false,
  toolListRefreshAttempts: 1,
  toolListRefreshSuccesses: 0,
  toolListRefreshFailures: 0,
  toolListRefreshLastAttemptMs: 1_000,
  toolListRefreshInFlight: false,
};
let staleBackoffSurfaceAlive = true;
assert.equal(
  await sendCatalogRefreshNotification(staleBackoffState, "tools", async () => {
    staleBackoffSurfaceAlive = false;
  }, onFailure, 1_100, { isDeliveryStillValid: () => staleBackoffSurfaceAlive }),
  "stale",
  "a send that resolves after its delivery surface ended is discarded",
);
assert.equal(staleBackoffState.toolListRefreshAttempts, 1, "a stale delivery does not consume the retry budget");
assert.equal(
  staleBackoffState.toolListRefreshLastAttemptMs,
  1_000,
  "a stale delivery restores the backoff timestamp it advanced",
);
staleBackoffSurfaceAlive = true;
assert.equal(
  await sendCatalogRefreshNotification(staleBackoffState, "tools", sendAfterRecovery, onFailure, 1_101, {
    isDeliveryStillValid: () => staleBackoffSurfaceAlive,
  }),
  "sent",
  "the next delivery surface is not delayed by a backoff a discarded send never earned",
);

console.log("catalog-refresh.test.ts: bounded retry and success de-duplication assertions passed");
