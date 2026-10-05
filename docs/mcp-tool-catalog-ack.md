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

Set `KONTROL_MCP_REQUIRE_TOOL_CATALOG_ACK=1` to reject `tools/call` until a
matching acknowledgement arrives. The default is off for compatibility while
clients add extension support. A notification is a client report, not a
cryptographic attestation of a compromised or dishonest host process; the
external qualification workflow correlates it with the host's registered
catalog capture and Kontrol's authenticated per-session diagnostics.
