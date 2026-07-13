import assert from "node:assert/strict";
import { signWorkerToken, verifyWorkerToken, WorkerTokenError, TOKEN_TTL_MS } from "../src/acp-worker-token.mjs";

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log("  PASS:", name); pass++; } catch (e) { throw new Error(`FAIL: ${name} -> ${e.message}`); }
};

// The exact shape callRemoteAgent() sends into the adapter.
// (used conceptually; extractTask lives in the .mjs adapter and is tested in extract-task.test.mjs)
void 0;

const secret = "test-secret";
const baseClaims = {
  role: "worker",
  workSessionId: "ws_1",
  workspaceSessionId: "wss_1",
  runId: "r1",
  continuationId: "c1",
  exp: Date.now() + TOKEN_TTL_MS,
};

console.log("== worker token ==");
t("valid round-trip preserves claims", () => {
  const c = verifyWorkerToken(signWorkerToken(baseClaims, secret), secret);
  assert.equal(c.workSessionId, "ws_1");
  assert.equal(c.workspaceSessionId, "wss_1");
  assert.equal(c.runId, "r1");
  assert.equal(c.continuationId, "c1");
});
t("wrong secret rejected", () => {
  assert.throws(() => verifyWorkerToken(signWorkerToken(baseClaims, secret), "wrong"), WorkerTokenError);
});
t("tampered signature rejected", () => {
  const tok = signWorkerToken(baseClaims, secret).slice(0, -2) + "ZZ";
  assert.throws(() => verifyWorkerToken(tok, secret), WorkerTokenError);
});
t("tampered payload rejected", () => {
  const tok = signWorkerToken(baseClaims, secret);
  const [h, p, s] = tok.split(".");
  const bad = Buffer.from(JSON.stringify({ ...baseClaims, workSessionId: "forged" })).toString("base64url");
  assert.throws(() => verifyWorkerToken(`${h}.${bad}.${s}`, secret), WorkerTokenError);
});
t("expired rejected", () => {
  assert.throws(() => verifyWorkerToken(signWorkerToken({ ...baseClaims, exp: Date.now() - 1000 }, secret), secret), WorkerTokenError);
});
t("malformed rejected", () => {
  assert.throws(() => verifyWorkerToken("a.b", secret), WorkerTokenError);
  assert.throws(() => verifyWorkerToken("too.many.dots.here", secret), WorkerTokenError);
});
t("missing role rejected", () => {
  const { role, ...noRole } = baseClaims;
  assert.throws(() => verifyWorkerToken(signWorkerToken(noRole, secret), secret), WorkerTokenError);
});

console.log(`\nworker-token: ${pass} passed\n`);
