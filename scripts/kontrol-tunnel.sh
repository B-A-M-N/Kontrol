#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
DESKTOP_PWD="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd -- "$DESKTOP_PWD"

[[ -f .env ]] || {
  echo "ERROR: expected .env in $DESKTOP_PWD" >&2
  exit 1
}

set -a
source .env
set +a

if [[ -n "${KONTROL_TUNNEL_FORWARD_HEADERS:-}" ]]; then
  echo "ERROR: KONTROL_TUNNEL_FORWARD_HEADERS is unsupported; tunnel mode must not add a second MCP auth gate." >&2
  exit 1
fi

TUNNEL_ARGS=(--profile "${KONTROL_TUNNEL_PROFILE:-sample_mcp_with_dcr}")
TUNNEL_ARGS+=("--harpoon.hosts-include-loopback=${KONTROL_HARPOON_INCLUDE_LOOPBACK:-false}")
if [[ -n "${KONTROL_TUNNEL_ID:-}" ]]; then
  TUNNEL_ARGS+=(--control-plane.tunnel-id "$KONTROL_TUNNEL_ID")
fi

# Tunnel mode intentionally has no local bearer challenge, but the WebUI still
# needs an authenticated reviewer principal for review/approval tools. Send a
# secret-backed assertion only to the configured MCP target; tunnel-client's
# mcp.extra-headers flag does not put it on control-plane requests. Keep the
# ACP reviewer secret as a compatibility fallback for existing .env files.
if [[ -z "${KONTROL_TUNNEL_REVIEWER_SECRET:-}" && -n "${KONTROL_ACP_REVIEWER_SECRET:-}" ]]; then
  export KONTROL_TUNNEL_REVIEWER_SECRET="$KONTROL_ACP_REVIEWER_SECRET"
fi
if [[ -n "${KONTROL_TUNNEL_REVIEWER_SECRET:-}" ]]; then
  TUNNEL_ARGS+=(--mcp.extra-headers "X-Kontrol-Tunnel-Reviewer: env:KONTROL_TUNNEL_REVIEWER_SECRET")
fi

case "${1:-run}" in
  --print-effective-args)
    printf '%s\n' "${TUNNEL_ARGS[@]}"
    exit 0
    ;;
  run)
    exec tunnel-client run "${TUNNEL_ARGS[@]}"
    ;;
  --doctor|doctor)
    # Use the same profile, tunnel ID, and Harpoon policy as runtime. The
    # ephemeral health listener avoids colliding with a live generation.
    exec tunnel-client doctor "${TUNNEL_ARGS[@]}" \
      --health.listen-addr 127.0.0.1:0 \
      --explain
    ;;
  *)
    echo "ERROR: usage: $0 [run|--doctor|--print-effective-args]" >&2
    exit 2
    ;;
esac
