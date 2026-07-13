#!/usr/bin/env bash
set -euo pipefail
cd /home/bamn/devspace
# Use a dedicated port so the adapter does not collide with the DevSpace MCP
# server (PORT=7676). start-all.sh exports ACP_ADAPTER_PORT for us.
exec env ACP_ADAPTER_PORT="${ACP_ADAPTER_PORT:-9877}" node scripts/acp-crush-adapter.mjs
