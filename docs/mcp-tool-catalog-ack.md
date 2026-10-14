# MCP tool catalog acknowledgement

Kontrol advertises the `kontrol.dev/tool-catalog-ack-v1` MCP extension. It lets
a client report that it installed the exact tool descriptors returned by
`tools/list`, including input schemas such as `approvalResumeId`.

The host wrapper must do the following on each new MCP transport:

1. Advertise `capabilities.extensions["kontrol.dev/tool-catalog-ack-v1"]` as
   `{ "contractVersion": 1 }` in `initialize`.
2. Read the complete `tools/list` result and register its callable tools.
3. Fingerprint the catalog actually registered by the host. Use SHA-256 over
   UTF-8 canonical JSON: sort tools by ascending JavaScript string order on
   `name`, recursively sort object keys, preserve array order, and omit object
   properties whose value is `undefined`.
4. Send the notification below after registration succeeds:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/experimental/kontrol/tool-catalog-accepted",
  "params": {
    "contractVersion": 1,
    "serverVersion": "the initialize result's serverInfo.version",
    "captureId": "the host capture's stable identifier",
    "hostCatalogSha256": "64 lowercase hex characters",
    "hostToolCount": 42
  }
}
```

`hostCatalogSha256` must describe the host's registered callable catalog, not
just the `tools/list` bytes received from Kontrol. Kontrol accepts the
acknowledgement only after it has observed `tools/list` on that transport and
the version, digest, and tool count match. Authenticated diagnostics report
the result under `mcpSessionMetrics.sessions[].toolCatalogHandshake`.

`captureId` is optional for ordinary MCP clients. External qualification
captures must include the same value in the envelope and acknowledgement. The
server records accepted and rejected acknowledgements in its SQLite
qualification journal with the full session SHA-256, immutable server build and
version, catalog fingerprints, result, and a content hash. The raw MCP session
ID is not persisted.

The journal also records completed POST `await_workspace_events` SSE operations
with their server operation ID, full session hash, build/version, start and
finish times, duration, heartbeat and response byte counts, and close result.
It stores no tool arguments, response bodies, bearer tokens, or conversation
data. Authenticated `/diagnostics?qEvidence=1` can return bounded evidence; use
`qBuild`, `qCapture`, `qSession`, and `qOperation` to select exact records.
Records are retained for 90 days and the journal is capped at 20,000 records.

Secure MCP Tunnel qualification requires the host capture's completed
`streamingCall.operationId`, copied from the `x-kontrol-operation-id` response
header. The probe matches this exact ID together with the complete session
hash, immutable build/version, and compatible start/finish times. Session
prefixes and tool names alone do not establish a match. The capture remains
operator-supplied; the journal records what Kontrol observed.

## External-host observation and reviewer handoff

The reviewer MCP tools `submit_external_catalog_observation` and
`get_external_catalog_observation` provide a versioned, durable capture path.
Submission is limited to the reviewer who owns the currently claimed review
handoff. It records the bounded initialize response, complete `tools/list`
descriptors, optional reported callable descriptors and acknowledgement,
capture/session hashes, and any streaming correlation. The content-addressed
record is attached to that handoff with the reviewer's investigation direction;
`get_review_handoff` returns attachment metadata and the get tool retrieves the
record while the same reviewer context owns the handoff.

The submitter cannot set provenance. These submissions are always
`operator_reported`, even when their descriptor hashes match. Missing
`registeredCatalog` is recorded as `host_capture_unsupported`; Kontrol never
copies `tools/list` into that field. The current ChatGPT connection does not
expose a supported producer for its internal callable registry, so no current
capture can set `hostRegistrationVerified=true`. A passing server catalog or
accepted acknowledgement does not lift that limitation, and the final beta
gate remains unqualified until a genuine host integration supplies that
evidence.

## Refresh and failed probe receipts

Kontrol sends bounded `notifications/tools/list_changed` and
`notifications/resources/list_changed` pulses after initialization and when a
session's GET event stream is established. Authenticated session diagnostics
record attempts, successes, and failures. These records prove server-side
delivery only. The strict-mode integration test simulates release A to B with
a changed callable descriptor set: an acknowledgement for A stays rejected on
B until a fresh catalog is listed and acknowledged. This proves Kontrol rejects
the stale release A acknowledgement; the notification itself does not refresh
ChatGPT's published app registry.

For a published ChatGPT MCP app, a Business, Enterprise, or Edu admin with
app-management permission and a valid connection refreshes the existing app
after release B is deployed: open **Workspace Settings → Apps**, select the
app's **… → Action control → Refresh**, and review the action diff. Newly added
actions are disabled by default and require explicit enablement. This is the
documented ChatGPT refresh path, so reinstalling the connector is not the
qualification procedure. See [OpenAI's ChatGPT MCP app instructions](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).
Capture the release B catalog after the refresh and
start a fresh MCP session before probing. The capture still has
`operator_reported` provenance: Kontrol's current ChatGPT connection exposes
no supported API or callable-registry integration from which Kontrol could
independently verify the host's stored action list. Therefore an A-to-B refresh
capture improves evidence and stale-catalog testing but cannot by itself set
`hostRegistrationVerified=true`.

When `--result-file PATH` is used, probe failures are written atomically to
`PATH.failed.json`, separately from the successful result. The bounded receipt
contains a content hash, safe build/version/capture identifiers, transport
mode, and one machine-readable reason: `host_capture_unsupported`,
`host_acknowledgement_missing`, `server_catalog_incomplete`,
`host_catalog_stale`, `host_registered_subset`, `input_schema_mismatch`,
`catalog_evidence_expired`, `session_correlation_failed`,
`external_stream_not_confirmed`, or `build_identity_mismatch`. Error messages,
local paths, request bodies, and credentials are omitted.

Set `KONTROL_MCP_REQUIRE_TOOL_CATALOG_ACK=1` to reject `tools/call` until a
matching acknowledgement arrives. The default is off for compatibility while
clients add extension support. A notification is a client report, not a
cryptographic attestation of a compromised or dishonest host process; the
external qualification workflow correlates it with the host-reported catalog
capture and Kontrol's authenticated per-session diagnostics. It counts as
verified host registration only when a genuine supported host integration
provides the callable registry.
