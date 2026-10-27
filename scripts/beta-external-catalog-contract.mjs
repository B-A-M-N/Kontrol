import { createHash } from "node:crypto";

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

function normalizedToolInputSchemas(value) {
  if (!Array.isArray(value)) return undefined;
  const entries = value.map((tool) => {
    if (typeof tool?.name !== "string" || !tool.inputFields) return undefined;
    const properties = sortedUniqueNames(tool.inputFields.properties);
    const required = sortedUniqueNames(tool.inputFields.required);
    if (!properties || !required || !tool.inputFields.types || typeof tool.inputFields.types !== "object") return undefined;
    return [tool.name, { properties, required, types: tool.inputFields.types }];
  });
  if (entries.some((entry) => !entry)) return undefined;
  const byName = new Map(entries);
  if (byName.size !== entries.length) return undefined;
  return Object.fromEntries([...byName.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function hasApprovalResumeInputs(schemas) {
  const guarded = ["bash", "exec_command", "write", "edit", "apply_patch", "read", "git_status", "git_log", "git_diff", "git_show"];
  return guarded.every((name) => !schemas || !Object.hasOwn(schemas, name)
    || schemas[name].properties.includes("approvalResumeId"));
}

function normalizedOrigin(value) {
  return typeof value === "string" ? value.replace(/\/$/, "") : undefined;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprintToolDescriptors(value) {
  if (!Array.isArray(value) || value.some((tool) => !tool || typeof tool !== "object" || Array.isArray(tool)
    || typeof tool.name !== "string" || tool.name.length === 0)) return undefined;
  const sorted = [...value].sort((a, b) => a.name.localeCompare(b.name));
  if (new Set(sorted.map((tool) => tool.name)).size !== sorted.length) return undefined;
  return createHash("sha256").update(canonicalJson(sorted)).digest("hex");
}

function contentAddressedEvidenceRecord(record) {
  if (!record || typeof record !== "object" || typeof record.contentSha256 !== "string") return false;
  const { contentSha256, ...content } = record;
  return /^[a-f0-9]{64}$/.test(contentSha256)
    && createHash("sha256").update(canonicalJson(content)).digest("hex") === contentSha256;
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

function isLoopbackHttpTarget(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
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
  const deployedCompatibilityUri = app?.deployedCompatibilityUri;
  const canonicalUri = typeof deployedUri === "string"
    && /^ui:\/\/kontrol\/workspace-app-[a-f0-9]{12}\.html$/i.test(deployedUri);
  const canonicalCompatibilityUri = typeof deployedCompatibilityUri === "string"
    && /^ui:\/\/kontrol\/workspace-app-[a-f0-9]{12}\.skybridge\.html$/i.test(deployedCompatibilityUri);
  const hostRendererUriMatches = app?.hostRendererResourceUri === deployedUri
    && app?.hostRendererCompatibilityUri === deployedCompatibilityUri;
  const toolUris = [
    ...workspaceAppResourceUris(receipt?.serverToolMetadata),
    ...workspaceAppResourceUris(receipt?.hostToolMetadata),
  ];
  const requiredUris = new Set([deployedUri, deployedCompatibilityUri, ...toolUris].filter((uri) => typeof uri === "string"));
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
      && canonicalCompatibilityUri
      && hostRendererUriMatches
      && app?.hostRendererUrisMatchCandidate === true
      && resourceReadsValid,
    ),
    canonicalUri,
    canonicalCompatibilityUri,
    hostRendererUriMatches,
    resourceReadsValid: Boolean(resourceReadsValid),
    deployedUri,
    deployedCompatibilityUri,
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
  const serverInputSchemas = normalizedToolInputSchemas(receipt?.serverToolMetadata);
  const hostInputSchemas = normalizedToolInputSchemas(receipt?.hostToolMetadata);
  const sameCatalogInputSchemas = Boolean(
    serverInputSchemas
    && hostInputSchemas
    && JSON.stringify(serverInputSchemas) === JSON.stringify(hostInputSchemas)
    && hasApprovalResumeInputs(serverInputSchemas),
  );
  const transportMode = receipt?.transport?.mode ?? "public_https";
  const sameOrigin = Boolean(
    normalizedOrigin(receipt?.url)
    && normalizedOrigin(soak?.targetUrl)
    && normalizedOrigin(receipt.url) === normalizedOrigin(soak.targetUrl),
  );
  const sameCatalogTarget = transportMode === "public_https"
    ? Boolean(sameOrigin && isExternalHttpsTarget(receipt?.url))
    : transportMode === "secure_mcp_tunnel"
      ? Boolean(
        sameOrigin
        && isLoopbackHttpTarget(receipt?.url)
        && receipt?.transport?.scheme === "https"
        && receipt?.transport?.source === "operator_supplied_host_capture"
        && soak?.transport?.mode === "secure_mcp_tunnel"
        && typeof receipt?.transport?.tunnelId === "string"
        && receipt.transport.tunnelId.startsWith("tunnel_")
        && receipt.transport.tunnelId === soak?.transport?.tunnelId
        && receipt?.hostCapture?.transport?.source === "operator_supplied"
        && receipt.hostCapture.transport.kind === "openai_secure_mcp_tunnel"
        && receipt.hostCapture.transport.scheme === "https"
        && receipt.transport.tunnelId === receipt?.hostCapture?.transport?.tunnelId,
      )
      : false;
  const hostCaptureIsOperatorSupplied = Boolean(
    receipt?.hostCapture?.source === "operator_supplied"
    && typeof receipt.hostCapture.captureId === "string"
    && receipt.hostCapture.captureId.length > 0
    && receipt.hostCapture.machineVerified === false
    && typeof receipt.hostCapture.sha256 === "string"
    && /^[a-f0-9]{64}$/.test(receipt.hostCapture.sha256),
  );
  const handshake = receipt?.hostCatalogHandshake;
  const handshakeAcceptedAtMs = Date.parse(handshake?.acceptedAt ?? "");
  const handshakeEvidence = handshake?.evidenceRecord;
  const handshakeEvidenceValid = Boolean(
    contentAddressedEvidenceRecord(handshakeEvidence)
    && handshakeEvidence.recordType === "catalog_acknowledgement"
    && handshakeEvidence.recordId === handshake.evidenceId
    && handshakeEvidence.captureId === receipt?.hostCapture?.captureId
    && handshakeEvidence.serverBuildId === receipt?.expectedBuildId
    && handshakeEvidence.serverVersion === receipt?.expectedMcpVersion
    && handshakeEvidence.sessionIdSha256 === receipt?.hostCapture?.sessionIdSha256
    && handshakeEvidence.status === "accepted"
    && handshakeEvidence.hostCatalogSha256 === handshake.hostCatalogSha256
    && handshakeEvidence.serverCatalogSha256 === handshake.serverCatalogSha256
    && handshakeEvidence.toolCount === handshake.toolCount
    && handshakeEvidence.observedAt === handshake.acceptedAt,
  );
  const hostCatalogHandshakeMachineVerified = Boolean(
    handshake?.source === "authenticated_server_diagnostics"
    && handshake.machineVerified === true
    && handshake.method === "notifications/experimental/kontrol/tool-catalog-accepted"
    && handshake.contractVersion === 1
    && /^[a-f0-9]{64}$/.test(handshake.sessionIdSha256 ?? "")
    && handshake.sessionIdSha256 === receipt?.hostCapture?.sessionIdSha256
    && /^[a-f0-9]{64}$/.test(handshake.hostCatalogSha256 ?? "")
    && handshake.hostCatalogSha256 === handshake.serverCatalogSha256
    && handshake.hostCatalogSha256 === handshake.clientCatalogSha256
    && handshake.captureId === receipt?.hostCapture?.captureId
    && handshake.serverBuildId === receipt?.expectedBuildId
    && handshake.serverVersion === receipt?.expectedMcpVersion
    && handshakeEvidenceValid
    && Number.isInteger(handshake.toolCount)
    && handshake.toolCount === hostTools?.length
    && Number.isFinite(handshakeAcceptedAtMs)
    && handshakeAcceptedAtMs >= soakStartedAtMs
    && handshakeAcceptedAtMs <= soakFinishedAtMs,
  );
  const serverCatalogEvidence = receipt?.serverCatalogEvidence;
  const serverDescriptorSha256 = fingerprintToolDescriptors(receipt?.serverToolDescriptors);
  const receiptHostDescriptorSha256 = fingerprintToolDescriptors(receipt?.hostToolDescriptors);
  const capturedServerDescriptorSha256 = fingerprintToolDescriptors(receipt?.externalHostObservation?.toolsListResult?.tools);
  const registeredHostDescriptorSha256 = fingerprintToolDescriptors(receipt?.externalHostObservation?.registeredCatalog);
  const serverCatalogEvidenceValid = Boolean(
    contentAddressedEvidenceRecord(serverCatalogEvidence)
    && serverCatalogEvidence.source === "fresh_http_tools_list"
    && serverCatalogEvidence.serverVersion === receipt?.expectedMcpVersion
    && serverCatalogEvidence.catalogSha256 === serverDescriptorSha256
    && fingerprintToolDescriptors(serverCatalogEvidence.tools) === serverDescriptorSha256
    && capturedServerDescriptorSha256 === serverDescriptorSha256
    && receiptHostDescriptorSha256 === registeredHostDescriptorSha256
    && receiptHostDescriptorSha256 === serverDescriptorSha256
    && receipt?.externalHostObservation?.serverCatalogSha256 === serverDescriptorSha256
    && registeredHostDescriptorSha256 === receipt?.externalHostObservation?.hostCatalogSha256
    && receipt?.externalHostObservation?.registeredCatalog?.length === receipt?.hostToolDescriptors?.length
  );
  const probeClientAcknowledgements = Array.isArray(receipt?.probeClientAcknowledgements)
    ? receipt.probeClientAcknowledgements
    : [];
  const probeClientAcknowledgementsValid = Boolean(
    probeClientAcknowledgements.length >= Math.max(3, (receipt?.cycles ?? 0) * 3)
    && probeClientAcknowledgements.every((acknowledgement) =>
      acknowledgement?.source === "kontrol_probe_client"
      && acknowledgement.status === "accepted"
      && acknowledgement.captureId === receipt?.hostCapture?.captureId
      && /^[a-f0-9]{64}$/.test(acknowledgement.sessionIdSha256 ?? "")
      && acknowledgement.sessionIdSha256 !== receipt?.hostCapture?.sessionIdSha256
      && acknowledgement.serverVersion === receipt?.expectedMcpVersion
      && acknowledgement.serverCatalogSha256 === serverDescriptorSha256
      && acknowledgement.probeClientCatalogSha256 === serverDescriptorSha256
      && acknowledgement.toolCount === receipt?.serverToolDescriptors?.length)
    && new Set(probeClientAcknowledgements.map((acknowledgement) => acknowledgement.sessionIdSha256)).size
      === probeClientAcknowledgements.length,
  );
  const liveServerProbeIsMachineVerified = Boolean(
    receipt?.liveServerProbe?.source === "fresh_http_initialize_and_tools_list"
    && receipt.liveServerProbe.machineVerified === true
    && normalizedOrigin(receipt.liveServerProbe.url) === normalizedOrigin(receipt.url)
    && (receipt.liveServerProbe.transportMode === undefined || receipt.liveServerProbe.transportMode === transportMode),
  );
  const externalHostObservationValid = Boolean(
    contentAddressedEvidenceRecord(receipt?.externalHostObservation)
    && receipt.externalHostObservation.observationSource === "operator_reported"
    && receipt.externalHostObservation.captureId === receipt?.hostCapture?.captureId
    && receipt.externalHostObservation.sessionIdSha256 === receipt?.hostCapture?.sessionIdSha256
    && receipt.externalHostObservation.serverVersion === receipt?.expectedMcpVersion
    && receipt.externalHostObservation.acknowledgement?.captureId === receipt?.hostCapture?.captureId
    && receipt.externalHostObservation.acknowledgement?.hostCatalogSha256 === registeredHostDescriptorSha256
    && receipt.externalHostObservation.acknowledgement?.hostToolCount === receipt?.hostToolDescriptors?.length
  );
  const serverCatalogVerified = Boolean(
    liveServerProbeIsMachineVerified
    && serverCatalogEvidenceValid
    && receipt?.expectedBuildId === candidateBuildId
    && receipt?.expectedMcpVersion === expectedMcpVersion
    && receipt?.serverInfoVersion === expectedMcpVersion,
  );
  // No currently supported host integration can return ChatGPT's actual
  // registered tool registry to Kontrol. A descriptor list submitted by a
  // reviewer remains operator_reported regardless of its content hash.
  const hostRegistrationVerified = false;
  const externalHostStreaming = receipt?.externalHostStreaming;
  const externalHostStreamingStartedAtMs = Date.parse(externalHostStreaming?.startedAt ?? "");
  const externalHostStreamingFinishedAtMs = Date.parse(externalHostStreaming?.finishedAt ?? "");
  const streamingEvidenceRecord = externalHostStreaming?.evidenceRecord;
  const durableStreamingEvidenceValid = Boolean(
    contentAddressedEvidenceRecord(streamingEvidenceRecord)
    && streamingEvidenceRecord.recordType === "external_sse"
    && streamingEvidenceRecord.recordId === externalHostStreaming.evidenceId
    && streamingEvidenceRecord.operationId === externalHostStreaming.operationId
    && streamingEvidenceRecord.operationId === receipt?.hostCapture?.streamingOperationId
    && streamingEvidenceRecord.sessionIdSha256 === receipt?.hostCapture?.sessionIdSha256
    && streamingEvidenceRecord.serverBuildId === receipt?.expectedBuildId
    && streamingEvidenceRecord.serverVersion === receipt?.expectedMcpVersion
    && (!streamingEvidenceRecord.captureId || streamingEvidenceRecord.captureId === receipt?.hostCapture?.captureId)
    && streamingEvidenceRecord.httpMethod === "POST"
    && streamingEvidenceRecord.rpcMethod === "tools/call"
    && streamingEvidenceRecord.toolName === "await_workspace_events"
    && streamingEvidenceRecord.httpStatus === 200
    && streamingEvidenceRecord.startedAt === externalHostStreaming.startedAt
    && streamingEvidenceRecord.finishedAt === externalHostStreaming.finishedAt
    && streamingEvidenceRecord.durationMs === externalHostStreaming.durationMs
    && streamingEvidenceRecord.heartbeatBytes === externalHostStreaming.heartbeatBytes
    && streamingEvidenceRecord.responseBytes === externalHostStreaming.responseBytes
    && streamingEvidenceRecord.responseCloseClassification === externalHostStreaming.responseCloseClassification
    && streamingEvidenceRecord.handlerStillRunning === externalHostStreaming.handlerStillRunning,
  );
  const externalHostStreamingEvidenceValid = transportMode !== "secure_mcp_tunnel"
    || Boolean(
      externalHostStreaming?.source === "authenticated_server_diagnostics"
      && externalHostStreaming.machineVerified === true
      && /^[a-f0-9]{64}$/.test(externalHostStreaming.sessionIdSha256 ?? "")
      && externalHostStreaming.sessionIdSha256 === receipt?.hostCapture?.sessionIdSha256
      && externalHostStreaming.operationId === receipt?.hostCapture?.streamingOperationId
      && externalHostStreaming.serverBuildId === receipt?.expectedBuildId
      && externalHostStreaming.serverVersion === receipt?.expectedMcpVersion
      && durableStreamingEvidenceValid
      && externalHostStreaming.toolName === "await_workspace_events"
      && Number.isInteger(externalHostStreaming.requestedWaitMs)
      && externalHostStreaming.requestedWaitMs >= 45_000
      && Number.isInteger(externalHostStreaming.durationMs)
      && externalHostStreaming.durationMs >= externalHostStreaming.requestedWaitMs - 5_000
      && Number.isInteger(externalHostStreaming.heartbeatBytes)
      && externalHostStreaming.heartbeatBytes > 0
      && Number.isInteger(externalHostStreaming.responseBytes)
      && externalHostStreaming.responseBytes > 0
      && externalHostStreaming.responseCloseClassification === "response_finished"
      && externalHostStreaming.handlerStillRunning === false
      && externalHostStreaming.terminalResultReceived === true
      && Number.isFinite(externalHostStreamingStartedAtMs)
      && Number.isFinite(externalHostStreamingFinishedAtMs)
      && externalHostStreamingStartedAtMs >= soakStartedAtMs
      && externalHostStreamingFinishedAtMs <= soakFinishedAtMs
      && externalHostStreamingFinishedAtMs >= externalHostStreamingStartedAtMs,
    );
  const hostFacingTransportObservation = receipt?.hostFacingTransportObservation;
  const hostFacingTransportObservationValid = transportMode !== "secure_mcp_tunnel"
    || Boolean(
      contentAddressedEvidenceRecord(hostFacingTransportObservation)
      && hostFacingTransportObservation.source === "operator_reported_host_capture"
      && hostFacingTransportObservation.observationSource === "operator_reported"
      && hostFacingTransportObservation.mode === "secure_mcp_tunnel"
      && hostFacingTransportObservation.scheme === "https"
      && hostFacingTransportObservation.tunnelId === receipt?.transport?.tunnelId
      && hostFacingTransportObservation.tunnelId === soak?.transport?.tunnelId
      && hostFacingTransportObservation.captureId === receipt?.hostCapture?.captureId
      && hostFacingTransportObservation.sessionIdSha256 === receipt?.hostCapture?.sessionIdSha256
      && hostFacingTransportObservation.operationId === receipt?.hostCapture?.streamingOperationId
    );
  const externalTransport = receipt?.externalTransport;
  const externalTransportEvidenceRecord = externalTransport?.evidenceRecord;
  const externalTransportEvidenceValid = transportMode === "secure_mcp_tunnel"
    ? false
    : Boolean(
      externalTransport?.source === "authenticated_server_diagnostics"
      && externalTransport.machineVerified === true
      && externalTransport.mode === "public_https"
      && isExternalHttpsTarget(externalTransport.url)
      && normalizedOrigin(externalTransport.url) === normalizedOrigin(receipt?.url)
      && externalTransport.serverBuildId === receipt?.expectedBuildId
      && externalTransport.serverVersion === receipt?.expectedMcpVersion
      && /^[a-f0-9]{64}$/.test(externalTransport.sessionIdSha256 ?? "")
      && externalTransport.sessionIdSha256 === externalTransportEvidenceRecord?.sessionIdSha256
      && externalTransport.operationId === externalTransportEvidenceRecord?.operationId
      && externalTransport.evidenceId === externalTransportEvidenceRecord?.recordId
      && contentAddressedEvidenceRecord(externalTransportEvidenceRecord)
      && externalTransportEvidenceRecord.recordType === "external_sse"
      && externalTransportEvidenceRecord.captureId === receipt?.hostCapture?.captureId
      && externalTransportEvidenceRecord.serverBuildId === receipt?.expectedBuildId
      && externalTransportEvidenceRecord.serverVersion === receipt?.expectedMcpVersion
      && externalTransportEvidenceRecord.httpMethod === "POST"
      && externalTransportEvidenceRecord.rpcMethod === "tools/call"
      && externalTransportEvidenceRecord.toolName === "await_workspace_events"
      && externalTransportEvidenceRecord.httpStatus === 200
      && externalTransportEvidenceRecord.responseCloseClassification === "response_finished"
      && externalTransportEvidenceRecord.handlerStillRunning === false
      && externalTransportEvidenceRecord.durationMs >= 40_000
      && externalTransportEvidenceRecord.heartbeatBytes > 0
      && externalTransportEvidenceRecord.responseBytes > 0
      && contentAddressedEvidenceRecord(externalTransport?.qualificationAssociation?.evidenceRecord)
      && externalTransport.qualificationAssociation.recordId === externalTransport.qualificationAssociation.evidenceRecord.recordId
      && externalTransport.qualificationAssociation.contentSha256 === externalTransport.qualificationAssociation.evidenceRecord.contentSha256
      && externalTransport.qualificationAssociation.serverBuildId === receipt?.expectedBuildId
      && externalTransport.qualificationAssociation.captureId === receipt?.hostCapture?.captureId
      && externalTransport.qualificationAssociation.sessionIdSha256 === externalTransport.sessionIdSha256
      && externalTransport.qualificationAssociation.acknowledgementRecordId === externalTransport.qualificationAssociation.evidenceRecord.acknowledgementRecordId
      && externalTransport.qualificationAssociation.externalSseRecordId === externalTransport.evidenceId
      && externalTransport.qualificationAssociation.evidenceRecord.externalSseRecordId === externalTransport.evidenceId,
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
  const postHeartbeat = receipt?.postHeartbeat;
  const postHeartbeatEvidenceValid = Boolean(
    postHeartbeat?.method === "POST"
    && postHeartbeat?.tool === "await_workspace_events"
    && Number.isInteger(postHeartbeat?.requestedWaitMs)
    && postHeartbeat.requestedWaitMs >= 45_000
    && Number.isInteger(postHeartbeat?.durationMs)
    && postHeartbeat.durationMs >= postHeartbeat.requestedWaitMs - 5_000
    && Number.isInteger(postHeartbeat?.heartbeatCount)
    && postHeartbeat.heartbeatCount >= 2
    && postHeartbeat.terminalResponseReceived === true
    && typeof postHeartbeat.contentType === "string"
    && postHeartbeat.contentType.includes("text/event-stream")
    && postHeartbeat.diagnosticsVerified === true
    && Number.isInteger(postHeartbeat.heartbeatBytes)
    && postHeartbeat.heartbeatBytes > 0
    && Number.isInteger(postHeartbeat.responseBytes)
    && postHeartbeat.responseBytes > 0
    && postHeartbeat.responseCloseClassification === "response_finished"
    && postHeartbeat.handlerStillRunning === false
    && postHeartbeat.stalledWriterEvents === 0,
  );
  const boundedInspectionEvidenceValid = Boolean(
    Number.isInteger(receipt?.boundedInspectionCalls)
    && receipt.boundedInspectionCalls >= receipt.cycles * 8,
  );
  const timeOrderValid = Boolean(
    Number.isFinite(hostCatalogCapturedAtMs)
    && Number.isFinite(probeStartedAtMs)
    && Number.isFinite(probeFinishedAtMs)
    && Number.isFinite(soakStartedAtMs)
    && Number.isFinite(soakFinishedAtMs)
    && hostCatalogCapturedAtMs >= soakStartedAtMs
    && hostCatalogCapturedAtMs <= soakFinishedAtMs
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
  const qualificationEvidenceAssociationValid = Boolean(
    receipt?.qualificationEvidenceAssociation?.source === "authenticated_server_sqlite_evidence"
    && receipt.qualificationEvidenceAssociation.machineVerified === true
    && contentAddressedEvidenceRecord(receipt.qualificationEvidenceAssociation.evidenceRecord)
    && receipt.qualificationEvidenceAssociation.recordId === receipt.qualificationEvidenceAssociation.evidenceRecord.recordId
    && receipt.qualificationEvidenceAssociation.contentSha256 === receipt.qualificationEvidenceAssociation.evidenceRecord.contentSha256
    && receipt.qualificationEvidenceAssociation.serverBuildId === receipt?.expectedBuildId
    && receipt.qualificationEvidenceAssociation.evidenceRecord.serverBuildId === receipt?.expectedBuildId
    && receipt.qualificationEvidenceAssociation.captureId === receipt?.hostCapture?.captureId
    && receipt.qualificationEvidenceAssociation.evidenceRecord.captureId === receipt?.hostCapture?.captureId
    && receipt.qualificationEvidenceAssociation.sessionIdSha256 === receipt?.hostCapture?.sessionIdSha256
    && receipt.qualificationEvidenceAssociation.evidenceRecord.sessionIdSha256 === receipt?.hostCapture?.sessionIdSha256
    && receipt.qualificationEvidenceAssociation.catalogAcknowledgementRecordId === handshake?.evidenceId
    && receipt.qualificationEvidenceAssociation.evidenceRecord.acknowledgementRecordId === handshake?.evidenceId
    && (transportMode !== "secure_mcp_tunnel"
      || (receipt.qualificationEvidenceAssociation.externalSseRecordId === externalHostStreaming?.evidenceId
        && receipt.qualificationEvidenceAssociation.evidenceRecord.externalSseRecordId === externalHostStreaming?.evidenceId))
    && (receipt?.externalCatalogObservationRecord
      ? (receipt.qualificationEvidenceAssociation.observationRecordId === receipt.externalCatalogObservationRecord.recordId
        && receipt.qualificationEvidenceAssociation.evidenceRecord.observationRecordId === receipt.externalCatalogObservationRecord.recordId)
      : (!receipt.qualificationEvidenceAssociation.observationRecordId
        && !receipt.qualificationEvidenceAssociation.evidenceRecord.observationRecordId))
    && (!receipt?.externalCatalogObservationRecord
      || (contentAddressedEvidenceRecord(receipt.externalCatalogObservationRecord)
        && receipt.externalCatalogObservationRecord.observationSource === "operator_reported"
        && receipt.externalCatalogObservationRecord.captureId === receipt?.hostCapture?.captureId
        && receipt.externalCatalogObservationRecord.serverBuildId === receipt?.expectedBuildId
        && receipt.externalCatalogObservationRecord.sessionIdSha256 === receipt?.hostCapture?.sessionIdSha256)),
  );
  const workspaceAppCheck = validateWorkspaceAppEvidence(receipt);
  const valid = Boolean(
    receipt?.kind === "kontrol-external-catalog-probe"
    && receipt?.status === "passed"
    && Number.isInteger(receipt?.cycles)
    && receipt.cycles >= 1
    && receipt?.catalogParity === true
    && receipt?.inputSchemaParity === true
    && sameCatalogInputSchemas
    && externalHostObservationValid
    && serverCatalogVerified
    && hostRegistrationVerified
    && externalTransportEvidenceValid
    && receipt?.hostCatalogEvidenceSource === "operator_supplied"
    && receipt?.hostCatalogMachineVerified === false
    && hostCaptureIsOperatorSupplied
    && hostCatalogHandshakeMachineVerified
    && probeClientAcknowledgementsValid
    && qualificationEvidenceAssociationValid
    && receipt?.liveServerProbeMachineVerified === true
    && liveServerProbeIsMachineVerified
    && buildIdentityMatches
    && sameCatalogTools
    && sameCatalogTarget
    && workspaceAppCheck.valid
    && streamingEvidenceValid
    && postHeartbeatEvidenceValid
    && externalHostStreamingEvidenceValid
    && boundedInspectionEvidenceValid
    && timeOrderValid,
  );
  return {
    valid,
    buildIdentityMatches,
    sameCatalogTools,
    sameCatalogInputSchemas,
    sameCatalogTarget,
    externalHostObservationValid,
    serverCatalogEvidenceValid,
    serverCatalogVerified,
    hostRegistrationVerified,
    hostRegistrationReason: receipt?.externalHostObservation?.status === "host_capture_unsupported"
      ? "host_capture_unsupported"
      : "host_registration_unverified",
    externalTransportVerified: externalTransportEvidenceValid,
    hostFacingTransportObservationValid,
    hostFacingTransportSource: transportMode === "secure_mcp_tunnel"
      ? (hostFacingTransportObservationValid ? "operator_reported" : "unavailable")
      : undefined,
    workspaceApp: workspaceAppCheck,
    hostCaptureIsOperatorSupplied,
    hostCatalogHandshakeMachineVerified,
    probeClientAcknowledgementsValid,
    qualificationEvidenceAssociationValid,
    liveServerProbeIsMachineVerified,
    streamingEvidenceValid,
    postHeartbeatEvidenceValid,
    externalHostStreamingEvidenceValid,
    boundedInspectionEvidenceValid,
    timeOrderValid,
    hostCatalogCapturedAt: receipt?.hostCatalogCapturedAt,
    startedAt: receipt?.startedAt,
    finishedAt: receipt?.finishedAt,
    hostTools,
    serverTools,
  };
}
