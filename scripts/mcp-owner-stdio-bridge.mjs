// Separate owner/reviewer stdio entrypoint. Endpoint profiles must use distinct
// owner-public OAuth origins and bearer files; this process never forwards the
// worker attribution envelope.
process.env.KONTROL_BRIDGE_PRINCIPAL = "owner_public";
await import("./mcp-stdio-bridge.mjs");
