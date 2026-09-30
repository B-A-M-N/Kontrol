function timestamp(value) {
  const parsed = typeof value === "number" ? value : Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeHeaders(headers) {
  return Array.isArray(headers)
    ? Object.fromEntries(headers.filter((header) => typeof header?.name === "string")
      .map((header) => [header.name.toLowerCase(), String(header.value ?? "")]))
    : {};
}

function requestPath(value) {
  try {
    const url = new URL(value);
    return url.pathname;
  } catch {
    return typeof value === "string" ? value.split("?")[0] : "";
  }
}

function operationTime(operation) {
  return timestamp(operation.startedAt ?? operation.startedAtMs)
    ?? timestamp(operation.finishedAt ?? operation.finishedAtMs);
}

function isMcpFailure(operation) {
  return (Number(operation.httpStatus) >= 400)
    || operation.responseCloseClassification === "response_closed_before_finish"
    || operation.responseCloseClassification === "response_incomplete"
    || operation.handlerStillRunning === true;
}

export function correlateHostStreamEvidence({
  har,
  kontrolRecords = [],
  tunnelRecords = [],
  windowMs = 5_000,
  urlPattern = "/backend-api/conversation",
}) {
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) throw new Error("HAR file is missing log.entries");
  if (!Number.isInteger(windowMs) || windowMs < 0) throw new Error("windowMs must be a non-negative integer");
  const pattern = new RegExp(urlPattern);
  const relevant = entries.filter((entry) => pattern.test(String(entry?.request?.url ?? "")));
  const observations = relevant.map((entry) => {
    const url = String(entry.request?.url ?? "");
    const startedAt = timestamp(entry.startedDateTime);
    const responseStatus = Number(entry.response?.status ?? 0);
    const errorText = entry._error ?? entry._failureText ?? entry.response?._error;
    const browserOutcome = errorText || responseStatus === 0
      ? "browser_network_error"
      : responseStatus >= 400
        ? "http_error"
        : "http_response_without_stream_completion_proof";
    const requestHeaders = normalizeHeaders(entry.request?.headers);
    const responseHeaders = normalizeHeaders(entry.response?.headers);
    // Cloudflare assigns CF-Ray on the origin response path. Kontrol's
    // echoed correlation header is also most reliably present in the HAR
    // response, so inspect both sides before falling back to timestamps.
    const externalCorrelationId = responseHeaders["cf-ray"]
      ?? responseHeaders["x-kontrol-correlation-id"]
      ?? responseHeaders["x-request-id"]
      ?? requestHeaders["cf-ray"]
      ?? requestHeaders["x-kontrol-correlation-id"]
      ?? requestHeaders["x-request-id"];
    const operations = kontrolRecords
      .filter((operation) => operation && typeof operation === "object")
      .map((operation) => ({ operation, at: operationTime(operation) }))
      .filter((item) => item.at !== undefined && startedAt !== undefined)
      .map((item) => ({ ...item, deltaMs: item.at - startedAt }));
    const exact = externalCorrelationId
      ? operations.filter(({ operation }) => operation.externalCorrelationId === externalCorrelationId)
      : [];
    const candidates = exact.length > 0
      ? exact
      : operations.filter(({ deltaMs }) => Math.abs(deltaMs) <= windowMs);
    const nearest = [...candidates].sort((a, b) => Math.abs(a.deltaMs) - Math.abs(b.deltaMs))[0];
    const tunnelMatch = tunnelRecords.find((record) => {
      const at = timestamp(record?.ts ?? record?.timestamp ?? record?.time);
      return at !== undefined
        && startedAt !== undefined
        && Math.abs(at - startedAt) <= windowMs
        && (record?.event === "tunnel_delivery_failed"
          || record?.event === "upstream_response_incomplete"
          || record?.event === "response_forwarding_failed");
    });
    let interpretation = "insufficient_correlation_evidence";
    if (tunnelMatch) interpretation = "intermediary_delivery_failure_observed_near_host_request";
    else if (nearest && isMcpFailure(nearest.operation)) interpretation = "mcp_failure_or_unfinished_operation_observed_near_host_request";
    else if (nearest) interpretation = "mcp_completion_temporally_near_host_request_causation_unproven";
    else interpretation = "no_mcp_operation_observed_within_correlation_window";
    return {
      startedAt: entry.startedDateTime,
      durationMs: Number.isFinite(Number(entry.time)) ? Number(entry.time) : undefined,
      urlPath: requestPath(url),
      responseStatus: Number.isFinite(responseStatus) ? responseStatus : undefined,
      browserError: typeof errorText === "string" ? errorText.slice(0, 300) : undefined,
      browserOutcome,
      externalCorrelationId,
      correlationKind: exact.length > 0 ? "exact_external_id" : nearest ? "timestamp_proximity" : "none",
      nearestOperationDeltaMs: nearest?.deltaMs,
      mcpOperation: nearest ? {
        operationId: nearest.operation.operationId,
        requestId: nearest.operation.requestId,
        sessionIdPrefix: nearest.operation.sessionIdPrefix,
        generationId: nearest.operation.generationId,
        rpcMethod: nearest.operation.rpcMethod,
        toolName: nearest.operation.toolName,
        httpStatus: nearest.operation.httpStatus,
        responseBytes: nearest.operation.responseBytes,
        responseCloseClassification: nearest.operation.responseCloseClassification,
        admissionWaitMs: nearest.operation.admissionWaitMs,
        executionDurationMs: nearest.operation.executionDurationMs,
        handlerStillRunning: nearest.operation.handlerStillRunning,
      } : undefined,
      interpretation,
    };
  });
  return {
    kind: "kontrol-host-stream-correlation",
    createdAt: new Date().toISOString(),
    windowMs,
    matchedHostRequests: observations.length,
    observations,
    limitations: [
      "HAR does not expose all ChatGPT server-to-tool dispatch traffic.",
      "Kontrol completion proves only local response-stream completion, not intermediary delivery or ChatGPT acceptance.",
      "Timestamp proximity is diagnostic evidence, not proof of causation.",
    ],
  };
}
