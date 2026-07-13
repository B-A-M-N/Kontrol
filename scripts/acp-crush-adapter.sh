#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "${KONTROL_HOME:-$(dirname "$SCRIPT_DIR")}"
# Use a dedicated port so the adapter does not collide with the Kontrol MCP
# server (PORT=7676). start-all.sh exports ACP_ADAPTER_PORT for us.
exec env ACP_ADAPTER_PORT="${ACP_ADAPTER_PORT:-9877}" node scripts/acp-crush-adapter.mjs
