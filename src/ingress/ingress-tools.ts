/** Authenticated Workspace App access to the same ingress evidence as CLI doctor. */
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { ServerConfig } from "../config.js";
import type { PrincipalRole } from "../policy-enforcement.js";
import { workspaceAppCallableToolMeta } from "../workspace-app-resource.js";
import { applyIngressProfile, disableIngressProfile, listIngressOperationReceipts } from "./controller.js";
import { latestIngressHealthByProfile, listIngressHealthObservations } from "./health-store.js";
import { buildIngressReport, defaultLocalProbe, expectedLocalTargetPort } from "./profile-status.js";
import { readTailscaleFacts, type TailscaleFacts } from "./tailscale-status.js";

export async function readIngressManagementProjection(
  config: ServerConfig,
  deps: { readFacts?: () => Promise<TailscaleFacts>; localProbe?: (port: number) => Promise<boolean>; now?: () => Date } = {},
) {
  const facts = await (deps.readFacts ?? readTailscaleFacts)();
  const ports = new Set((config.ingress?.profiles ?? [])
    .map((profile) => expectedLocalTargetPort(profile, config))
    .filter((port): port is number => port !== null));
  const probes = new Map<number, boolean>();
  for (const port of ports) probes.set(port, await (deps.localProbe ?? defaultLocalProbe)(port));
  const report = buildIngressReport(config, facts, probes);
  const latest = latestIngressHealthByProfile(config.stateDir);
  const receipts = listIngressOperationReceipts(config.stateDir);
  const profiles = report.profiles.map((profile) => {
    const qualification = latest.find((item) => item.profileId === profile.id);
    const recentFailures = listIngressHealthObservations(config.stateDir, profile.id)
      .filter((item) => item.failureClass || item.state === "DOWN" || item.state === "DEGRADED")
      .slice(-5).reverse().map((item) => ({
        observedAt: item.observedAt,
        state: item.state,
        evidenceTier: item.evidenceTier,
        failureClass: item.failureClass ?? item.state.toLowerCase(),
      }));
    const appropriateExternalTier = profile.privacy === "TAILNET_PRIVATE"
      ? qualification?.evidenceTier === "real_tailnet" || qualification?.evidenceTier === "operational"
      : qualification?.evidenceTier === "public_internet" || qualification?.evidenceTier === "operational";
    const externalTest = qualification?.checks.externalHttps === false
      ? "failed"
      : qualification?.checks.externalHttps === true && appropriateExternalTier ? "passed" : "unverified";
    const tls = qualification?.checks.externalHttps === false ? "failed"
      : qualification?.checks.externalHttps === true && appropriateExternalTier ? "verified externally"
        : qualification?.checks.externalHttps === true ? "verified locally" : "unverified";
    const authenticatedChecks = qualification?.checks.oauthChallenge === true && qualification.checks.mcpInitialize === true;
    const auth = qualification?.checks.oauthChallenge === false || qualification?.checks.mcpInitialize === false
      ? "failed"
      : authenticatedChecks && appropriateExternalTier ? "verified externally"
        : authenticatedChecks ? "verified locally" : "unverified";
    const lastOperation = [...receipts].reverse().find((receipt) => receipt.profileId === profile.id);
    return {
      ...profile,
      observed: profile.observed ?? null,
      localObserved: profile.target === "secure_tunnel_listener" ? null : profile.expectedLocalTarget
        ? probes.get(Number(new URL(profile.expectedLocalTarget).port)) ?? null : null,
      authentication: auth,
      tls,
      externalTest,
      qualification: qualification ? {
        state: qualification.state,
        evidenceTier: qualification.evidenceTier,
        observedAt: qualification.observedAt,
        probeOrigin: qualification.probeOrigin,
        checks: qualification.checks,
        metrics: qualification.metrics,
      } : null,
      lastOperation: lastOperation ? {
        action: lastOperation.action,
        state: lastOperation.state,
        updatedAt: lastOperation.updatedAt,
      } : null,
      recentFailures,
    };
  });
  return {
    generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
    cliVersion: report.cliVersion,
    backendState: report.backendState,
    dnsName: report.dnsName,
    profiles,
    notes: [
      "Configured, locally observed, externally tested, and authenticated states are independent evidence levels.",
      "A route mapping alone does not establish external reachability or authenticated MCP readiness.",
      "Failover preference is managed by the client endpoint profile order; this server has no remote preference control channel.",
    ],
  };
}

function forbidden() {
  return { content: [{ type: "text" as const, text: "Forbidden: ingress management requires owner or reviewer authority." }], isError: true as const };
}

export function registerIngressManagementTool(server: McpServer, deps: {
  config: ServerConfig;
  principalRole: PrincipalRole;
}): void {
  registerAppTool(server, "ingress_management", {
    title: "Ingress management",
    description: "Inspect authoritative ingress profile, local route observations, persisted qualification evidence, and recent failures. Reviewer or owner clients may apply or disable an owned Tailscale route after explicit confirmation.",
    inputSchema: {
      action: z.enum(["inspect", "apply", "disable"]),
      profileId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional(),
      confirm: z.boolean().optional(),
    },
    outputSchema: {
      generatedAt: z.string(),
      cliVersion: z.string().nullable(),
      backendState: z.string().nullable(),
      dnsName: z.string().nullable(),
      profiles: z.array(z.object({
        id: z.string(), kind: z.string(), audience: z.string(), externalOrigin: z.string(), target: z.string(), enabled: z.boolean(), privacy: z.string(),
        expectedLocalTarget: z.string().nullable(), observed: z.unknown().nullable(), classification: z.string(), notes: z.array(z.string()),
        localObserved: z.boolean().nullable(), authentication: z.string(), tls: z.string(), externalTest: z.string(),
        qualification: z.unknown().nullable(), lastOperation: z.unknown().nullable(), recentFailures: z.array(z.unknown()),
      })),
      notes: z.array(z.string()),
      operation: z.unknown().optional(),
    },
    _meta: workspaceAppCallableToolMeta(),
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ action, profileId, confirm }) => {
    if (deps.principalRole !== "client" && deps.principalRole !== "reviewer") return forbidden();
    if (action === "inspect") {
      const projection = await readIngressManagementProjection(deps.config);
      return {
        content: [{ type: "text", text: `Ingress status: ${projection.profiles.length} profile(s); Tailscale ${projection.backendState ?? "unavailable"}.` }],
        structuredContent: projection,
        _meta: { tool: "ingress_management", card: { tool: "ingress_management", summary: projection } },
      };
    }
    if (!profileId || confirm !== true) {
      return { content: [{ type: "text", text: "A profile ID and explicit confirmation are required for route changes." }], isError: true };
    }
    const operation = action === "apply"
      ? await applyIngressProfile(deps.config, deps.config.stateDir, profileId)
      : await disableIngressProfile(deps.config, deps.config.stateDir, profileId);
    const projection = { ...(await readIngressManagementProjection(deps.config)), operation };
    return {
      content: [{ type: "text", text: `Ingress ${operation.action} ${operation.profileId}: ${operation.state}.` }],
      structuredContent: projection,
      _meta: { tool: "ingress_management", card: { tool: "ingress_management", summary: projection } },
    };
  });
}
