/**
 * Adversarial audit matrix row: "Peer listener bind failure | Whole candidate
 * launch rolls back cleanly, one runtime lock, no orphan listener."
 *
 * This drives the real entrypoint path (runServer) so the exact catch block in
 * src/server.ts that closes both listener objects, releases the runtime lock,
 * and rethrows is exercised end to end. The owner port is bound first and the
 * peer bind then fails, so a buggy rollback would leak the owner listener, the
 * peer listener, or the runtime.lock file. We assert all three are clean.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer as createNetServer, connect } from "node:net";
import { loadConfig } from "./config.js";
import { runServer } from "./server.js";
import { runtimeLockPath } from "./runtime-lock.js";
import { hashPeerCredential } from "./peer/credentials.js";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const address = s.address() as { port: number };
      const port = address.port;
      s.close(() => resolve(port));
    });
  });
}

/** Returns true when a TCP connect to host:port is refused (nothing listening). */
function connectionRefused(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, host);
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => done(false)); // something answered: NOT refused
    socket.once("error", (error: NodeJS.ErrnoException) => {
      done(error.code === "ECONNREFUSED");
    });
    socket.setTimeout(2500, () => done(false)); // default to not-refused if it hangs unexpectedly
  });
}

const root = mkdtempSync(join(tmpdir(), "kontrol-peer-fail-root-"));
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-peer-fail-state-"));
const worktreeRoot = mkdtempSync(join(tmpdir(), "kontrol-peer-fail-worktrees-"));
const configDir = mkdtempSync(join(tmpdir(), "kontrol-peer-fail-config-"));
writeFileSync(join(root, "hello.txt"), "peer-failure-fixture\n");

const PEER_ID = "meta-muse";
const CREDENTIAL_ID = "v1";
const SECRET = randomBytes(24).toString("hex");

function writeRegistry(): string {
  const file = join(configDir, "peer-failure-registry.json");
  writeFileSync(file, JSON.stringify({
    version: 1,
    peers: [{
      id: PEER_ID,
      credentialId: CREDENTIAL_ID,
      credentialHash: hashPeerCredential(CREDENTIAL_ID, SECRET),
      capabilities: ["workspace:inspect"],
      grantedRoots: [root],
    }],
  }, null, 2));
  chmodSync(file, 0o600);
  const future = new Date(Date.now() + 5_000);
  utimesSync(file, future, future);
  return file;
}

const credentialFile = writeRegistry();

async function main(): Promise<void> {
  // Occupy the peer port with a dummy net server so runServer's peer bind must
  // fail with EADDRINUSE after the owner bind already succeeded.
  const peerPort = await freePort();
  const dummyPeer = createNetServer();
  await new Promise<void>((resolve) => dummyPeer.listen(peerPort, "127.0.0.1", resolve));

  const ownerPort = await freePort();

  const config = loadConfig({
    KONTROL_CONFIG_DIR: configDir,
    KONTROL_ALLOWED_ROOTS: root,
    KONTROL_STATE_DIR: stateDir,
    KONTROL_WORKTREE_ROOT: worktreeRoot,
    KONTROL_AUTH_MODE: "tunnel",
    KONTROL_ACP_ENABLED: "false",
    KONTROL_POLICY_MODE: "allow",
    KONTROL_LOG_LEVEL: "error",
    KONTROL_LOG_REQUESTS: "0",
    KONTROL_DIAGNOSTICS_SECRET: "peer-failure-test-secret",
    KONTROL_PEER_ENABLED: "1",
    KONTROL_PEER_BIND_HOST: "127.0.0.1",
    KONTROL_PEER_PORT: String(peerPort),
    KONTROL_PEER_CREDENTIAL_FILE: credentialFile,
    HOST: "127.0.0.1",
    PORT: String(ownerPort),
  });
  assert.ok(config.peer, "peer config must parse for the failure test");

  const lockPath = runtimeLockPath(stateDir);
  assert.equal(existsSync(lockPath), false, "runtime.lock must not exist before runServer");

  // 1. runServer must reject because the peer port is taken.
  let rejected = false;
  try {
    await runServer(config);
  } catch (error) {
    rejected = true;
    assert.match(String(error), /peer listener failed to bind/,
      "runServer must reject with the peer bind failure");
  }
  assert.equal(rejected, true, "runServer must reject when the peer port is occupied");

  // 2. The owner port must NOT be serving afterwards (rollback closed it).
  assert.equal(await connectionRefused("127.0.0.1", ownerPort), true,
    "owner listener must not survive the peer bind failure");

  // 3. The runtime lock must be released (file removed) after rollback.
  assert.equal(existsSync(lockPath), false,
    "runtime.lock must be released after a failed candidate launch");

  // 4. Close my dummy server; then the peer port must also be free — proving
  // runServer did not leave an orphan peer listener behind.
  await new Promise<void>((resolve) => dummyPeer.close(() => resolve()));
  assert.equal(await connectionRefused("127.0.0.1", peerPort), true,
    "peer port must be free after rollback closes the occupancy server");

  console.log("peer-failures: peer bind failure rolls back owner listener + runtime lock, no orphans");
}

await main();
console.log("peer-failures: all assertions passed");