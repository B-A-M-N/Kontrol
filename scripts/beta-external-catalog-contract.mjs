export const REQUIRED_BETA_EXTERNAL_TOOLS = Object.freeze([
  "read",
  "grep",
  "glob",
  "ls",
  "git_status",
  "git_log",
  "git_diff",
  "git_show",
  "poll_process",
]);

function sortedUniqueNames(value) {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || name.length === 0)) return undefined;
  const sorted = [...value].sort();
  if (new Set(sorted).size !== sorted.length) return undefined;
  return sorted;
}

function normalizedOrigin(value) {
  return typeof value === "string" ? value.replace(/\/$/, "") : undefined;
}

function isExternalHttpsTarget(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function workspaceAppResourceUris(toolMetadata) {
  if (!Array.isArray(toolMetadata)) return [];
  const uriPattern = /^ui:\/\/(?:kontrol|devdesktop)\/workspace-app(?:-[a-f0-9]{12})?(?:\.skybridge)?\.html$/i;
  return toolMetadata.flatMap((tool) => [tool?.resourceUri, tool?.legacyOutputTemplate])
    .filter((uri) => typeof uri === "string" && uriPattern.test(uri));
}

function expectedWorkspaceAppMimeType(uri) {
  return /^ui:\/\/kontrol\/workspace-app-[a-f0-9]{12}\.html$/i.test(uri)
    ? "text/html;profile=mcp-app"
    : "text/html+skybridge";
}

function validateWorkspaceAppEvidence(receipt) {
  const app = receipt?.workspaceApp;
  const deployedUri = app?.deployedResourceUri;
  const canonicalUri = typeof deployedUri === "string"
    && /^ui:\/\/kontrol\/workspace-app-[a-f0-9]{12}\.html$/i.test(deployedUri);
  const hostOpenUri = app?.hostOpenWorkspaceResourceUri;
  const hostUriMatches = hostOpenUri === null || hostOpenUri === undefined || hostOpenUri === deployedUri;
  const toolUris = [
    ...workspaceAppResourceUris(receipt?.serverToolMetadata),
    ...workspaceAppResourceUris(receipt?.hostToolMetadata),
  ];
  const requiredUris = new Set([deployedUri, ...toolUris].filter((uri) => typeof uri === "string"));
  const resources = Array.isArray(app?.resources) ? app.resources : [];
  const byUri = new Map(resources.map((resource) => [resource?.uri, resource]));
  const resourceReadsValid = canonicalUri
    && requiredUris.size > 0
    && byUri.size === resources.length
    && [...requiredUris].every((uri) => {
      const resource = byUri.get(uri);
      return resource?.listed === true
        && resource?.read === true
        && resource?.mimeType === expectedWorkspaceAppMimeType(uri)
        && Number.isSafeInteger(resource?.htmlBytes)
        && resource.htmlBytes > 0;
    });
  return {
    valid: Boolean(
      canonicalUri
      && hostUriMatches
      && app?.openWorkspaceUriMatchesCandidate === true
      && resourceReadsValid,
    ),
    canonicalUri,
    hostUriMatches,
    resourceReadsValid: Boolean(resourceReadsValid),
    deployedUri,
    requiredUris: [...requiredUris].sort(),
  };
}

export function validateBetaExternalCatalogReceipt(receipt, { candidateBuildId, expectedMcpVersion, soak } = {}) {
  const hostTools = sortedUniqueNames(receipt?.hostTools);
  const serverTools = sortedUniqueNames(receipt?.serverTools);
  const hostCatalogCapturedAtMs = Date.parse(receipt?.hostCatalogCapturedAt ?? "");
  const probeStartedAtMs = Date.parse(receipt?.startedAt ?? "");
  const probeFinishedAtMs = Date.parse(receipt?.finishedAt ?? "");
  const soakStartedAtMs = Date.parse(soak?.startedAt ?? "");
  const soakFinishedAtMs = Date.parse(soak?.finishedAt ?? "");
  const sameCatalogTools = Boolean(
    hostTools
    && serverTools
    && JSON.stringify(hostTools) === JSON.stringify(serverTools)
    && REQUIRED_BETA_EXTERNAL_TOOLS.every((name) => hostTools.includes(name)),
  );
  const sameCatalogTarget = Boolean(
    normalizedOrigin(receipt?.url)
    && normalizedOrigin(soak?.targetUrl)
    && normalizedOrigin(receipt.url) === normalizedOrigin(soak.targetUrl)
    && isExternalHttpsTarget(receipt?.url),
  );
  const hostCaptureIsOperatorSupplied = Boolean(
    receipt?.hostCapture?.source === "operator_supplied"
    && typeof receipt.hostCapture.captureId === "string"
    && receipt.hostCapture.captureId.length > 0
    && receipt.hostCapture.machineVerified === false
    && typeof receipt.hostCapture.sha256 === "string"
    && /^[a-f0-9]{64}$/.test(receipt.hostCapture.sha256),
  );
  const liveServerProbeIsMachineVerified = Boolean(
    receipt?.liveServerProbe?.source === "fresh_http_initialize_and_tools_list"
    && receipt.liveServerProbe.machineVerified === true
    && normalizedOrigin(receipt.liveServerProbe.url) === normalizedOrigin(receipt.url),
  );
  const streamingEvidenceValid = Boolean(
    receipt?.dualSession === true
    && Number.isInteger(receipt?.heartbeatCountPerSession)
    && receipt.heartbeatCountPerSession >= 2
    && Number.isInteger(receipt?.heartbeatBytesObserved)
    && receipt.heartbeatBytesObserved >= receipt.cycles * 2 * receipt.heartbeatCountPerSession
    && Number.isInteger(receipt?.drainRecoveryEvents)
    && receipt.drainRecoveryEvents >= receipt.cycles * 2
    && Number.isInteger(receipt?.resourceLoadReads)
    && receipt.resourceLoadReads >= receipt.cycles * 2,
  );
  const timeOrderValid = Boolean(
    Number.isFinite(hostCatalogCapturedAtMs)
    && Number.isFinite(probeStartedAtMs)
    && Number.isFinite(probeFinishedAtMs)
    && Number.isFinite(soakStartedAtMs)
    && Number.isFinite(soakFinishedAtMs)
    && hostCatalogCapturedAtMs >= soakStartedAtMs
    && hostCatalogCapturedAtMs <= probeStartedAtMs
    && probeStartedAtMs >= soakFinishedAtMs
    && probeFinishedAtMs >= probeStartedAtMs,
  );
  const buildIdentityMatches = Boolean(
    receipt?.expectedBuildId
    && receipt.expectedBuildId === candidateBuildId
    && expectedMcpVersion
    && receipt.expectedMcpVersion === expectedMcpVersion
    && receipt.serverInfoVersion === expectedMcpVersion
    && receipt.hostCatalogVersion === expectedMcpVersion,
  );
  const workspaceAppCheck = validateWorkspaceAppEvidence(receipt);
  const valid = Boolean(
    receipt?.kind === "kontrol-external-catalog-probe"
    && receipt?.status === "passed"
    && Number.isInteger(receipt?.cycles)
    && receipt.cycles >= 1
    && receipt?.catalogParity === true
    && receipt?.hostCatalogEvidenceSource === "operator_supplied"
    && receipt?.hostCatalogMachineVerified === false
    && hostCaptureIsOperatorSupplied
    && receipt?.liveServerProbeMachineVerified === true
    && liveServerProbeIsMachineVerified
    && buildIdentityMatches
    && sameCatalogTools
    && sameCatalogTarget
    && workspaceAppCheck.valid
    && streamingEvidenceValid
    && timeOrderValid,
  );
  return {
    valid,
    buildIdentityMatches,
    sameCatalogTools,
    sameCatalogTarget,
    workspaceApp: workspaceAppCheck,
    hostCaptureIsOperatorSupplied,
    liveServerProbeIsMachineVerified,
    streamingEvidenceValid,
    timeOrderValid,
    hostCatalogCapturedAt: receipt?.hostCatalogCapturedAt,
    startedAt: receipt?.startedAt,
    finishedAt: receipt?.finishedAt,
    hostTools,
    serverTools,
  };
}
