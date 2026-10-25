import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyIngressProfile, disableIngressProfile, listIngressOperationReceipts, reconcileIngressProfile } from "./controller.js";
import { parseServeMappings, type TailscaleFacts } from "./tailscale-status.js";
import type { IngressConfigSource } from "./profile-status.js";
import type { IngressProfile } from "./types.js";

const profile: IngressProfile = {
  id: "public-https",
  kind: "tailscale_serve",
  audience: "owner_public",
  externalOrigin: "https://node.tail.example.ts.net:8443",
  target: "public_oauth_listener",
  enabled: true,
  managedByKontrol: true,
  allowedHosts: ["node.tail.example.ts.net:8443"],
};
const config: IngressConfigSource = {
  authMode: "oauth",
  publicBaseUrl: profile.externalOrigin,
  publicMcp: { port: 7678 },
  ingress: { profiles: [profile] },
};
const stateDir = mkdtempSync(join(tmpdir(), "kontrol-ingress-controller-"));

function facts(mapped: boolean): TailscaleFacts {
  const parsed = mapped ? parseServeMappings({
    Web: {
      "node.tail.example.ts.net:8443": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:7678" } },
      },
    },
    AllowFunnel: {},
  }) : { mappings: [], schemaSupported: true };
  return {
    cliVersion: "1.90.0",
    backendState: "Running",
    dnsName: "node.tail.example.ts.net",
    serveMappings: parsed.mappings,
    funnelMappings: parsed.mappings,
    serveStatusSchemaSupported: parsed.schemaSupported,
    funnelStatusSchemaSupported: parsed.schemaSupported,
    warnings: [],
  };
}

try {
  let mapped = false;
  const commands: string[][] = [];
  const deps = {
    readFacts: async () => facts(mapped),
    execute: async (args: string[]) => {
      commands.push(args);
      mapped = args.at(-1) !== "off";
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    localProbe: async () => true,
    now: () => new Date("2026-10-25T12:00:00.000Z"),
  };

  const applied = await applyIngressProfile(config, stateDir, profile.id, deps);
  assert.equal(applied.state, "applied");
  assert.deepEqual(commands[0], ["serve", "--bg", "--yes", "--https=8443", "http://127.0.0.1:7678"]);
  assert.equal(listIngressOperationReceipts(stateDir)[0]?.state, "applied", "intent and completion receipt persist durably");

  const disabled = await disableIngressProfile(config, stateDir, profile.id, deps);
  assert.equal(disabled.state, "disabled");
  assert.deepEqual(commands[1], ["serve", "--bg", "--yes", "--https=8443", "--set-path=/", "off"]);
  assert.equal(listIngressOperationReceipts(stateDir)[0]?.state, "disabled", "the ownership receipt is retired after disable");

  // A route on the same authority that Kontrol did not create is never
  // overwritten, and no command is issued.
  const conflictDir = mkdtempSync(join(tmpdir(), "kontrol-ingress-conflict-"));
  try {
    const conflictFacts = facts(true);
    conflictFacts.serveMappings[0]!.identity = {
      ...conflictFacts.serveMappings[0]!.identity!,
      upstreamPort: "7777",
    };
    await assert.rejects(
      () => applyIngressProfile(config, conflictDir, profile.id, { ...deps, readFacts: async () => conflictFacts, execute: async () => { throw new Error("must not execute"); } }),
      /already has another route/,
    );
    assert.equal(listIngressOperationReceipts(conflictDir).length, 0);
  } finally { rmSync(conflictDir, { recursive: true, force: true }); }

  const corruptDir = mkdtempSync(join(tmpdir(), "kontrol-ingress-corrupt-"));
  try {
    writeFileSync(join(corruptDir, "ingress-operations.json"), "{");
    await assert.rejects(() => applyIngressProfile(config, corruptDir, profile.id, deps), /receipt store is corrupt/);
  } finally { rmSync(corruptDir, { recursive: true, force: true }); }

  const interruptedDir = mkdtempSync(join(tmpdir(), "kontrol-ingress-interrupted-"));
  try {
    let interruptedMapped = false;
    let executeCount = 0;
    const interrupted = await applyIngressProfile(config, interruptedDir, profile.id, {
      readFacts: async () => facts(interruptedMapped),
      execute: async () => {
        executeCount++;
        const pending = JSON.parse(readFileSync(join(interruptedDir, "ingress-operations.json"), "utf8"));
        assert.equal(pending.receipts[0].state, "prepared", "durable intent exists before command dispatch");
        interruptedMapped = true;
        return { stdout: "", stderr: "", exitCode: 1 };
      },
      localProbe: async () => true,
    }).catch(() => listIngressOperationReceipts(interruptedDir)[0]!);
    assert.equal(interrupted.state, "reconciliation_required", "nonzero execution is uncertain, not terminal");
    const recovered = await reconcileIngressProfile(config, interruptedDir, profile.id, {
      readFacts: async () => facts(interruptedMapped),
      execute: async () => { throw new Error("reconcile must never redispatch"); },
      localProbe: async () => true,
    });
    assert.equal(recovered?.state, "applied");
    assert.equal(executeCount, 1, "recovery observes the original attempt and never runs a duplicate command");
  } finally { rmSync(interruptedDir, { recursive: true, force: true }); }

  console.log("ingress controller: apply/disable receipts and conflict fencing passed");
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}
