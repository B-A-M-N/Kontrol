#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
DESKTOP_PWD="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd -- "$DESKTOP_PWD"

ENV_FILE="${KONTROL_ENV_FILE:-$DESKTOP_PWD/.env}"
[[ -f "$ENV_FILE" ]] || {
  echo "ERROR: expected environment file at $ENV_FILE" >&2
  exit 1
}

set -a
source "$ENV_FILE"
set +a
export KONTROL_ENV_FILE="$ENV_FILE"

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

# The tunnel always asserts reviewer authority with KONTROL_TUNNEL_REVIEWER_SECRET
# (the server's first-precedence credential). Resolve it from the dedicated
# variable, the legacy ACP reviewer secret, or the 0600 auth file — never
# assume the legacy environment variable exists. The value travels only in
# the process environment toward tunnel-client's env: reference.
if [[ -z "${KONTROL_TUNNEL_REVIEWER_SECRET:-}" ]]; then
  auth_file_secret="$(
    node -e 'const fs=require("node:fs");try{const auth=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(typeof auth.tunnelReviewerSecret==="string"?auth.tunnelReviewerSecret:"")}catch{process.exit(1)}' \
      "${KONTROL_CONFIG_DIR:-$HOME/.kontrol}/auth.json" 2>/dev/null || true
  )"
  if [[ -n "${auth_file_secret:-}" ]]; then
    export KONTROL_TUNNEL_REVIEWER_SECRET="$auth_file_secret"
  fi
  unset auth_file_secret
fi

# Ask-capability is computed by the same compiled policy loader used by the
# server. This keeps secure-baseline defaults, aliases, and strict malformed
# value handling identical across both startup paths.
#
# Generation pinning: the tunnel MUST use the exact immutable candidate the
# launcher started. Never select a CLI merely because it can answer
# `config effective-policy` — a stale dist/ projection (e.g. schema 53 build)
# lacks `service wait-core-ready` and would make `tunnel-client run` unreachable.
POLICY_CLI=""
if [[ -n "${KONTROL_POLICY_CLI_PATH:-}" ]]; then
  POLICY_CLI="$KONTROL_POLICY_CLI_PATH"
elif [[ -n "${KONTROL_ARTIFACT_PATH:-}" && -f "${KONTROL_ARTIFACT_PATH}/cli.js" ]]; then
  POLICY_CLI="${KONTROL_ARTIFACT_PATH}/cli.js"
fi
# No explicit artifact: fail closed when a generation identity is expected,
# rather than guessing a possibly-stale dist/ projection.
if [[ -z "$POLICY_CLI" && -n "${KONTROL_EXPECTED_BUILD_ID:-}" ]]; then
  echo "ERROR: Kontrol CLI is unavailable for expected build $KONTROL_EXPECTED_BUILD_ID; set KONTROL_POLICY_CLI_PATH or KONTROL_ARTIFACT_PATH to the selected immutable candidate." >&2
  exit 1
fi
if [[ -z "$POLICY_CLI" ]]; then
  # Dev/direct-script fallback only (no generation identity expected). Prefer
  # dist/ only when it matches the expected build; otherwise use source via tsx.
  if [[ -f "${DESKTOP_PWD}/dist/cli.js" && -f "${DESKTOP_PWD}/dist/build-meta.json" ]]; then
    dist_build_id="$(node -e 'try{process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).buildId||"")}catch{}' "${DESKTOP_PWD}/dist/build-meta.json" 2>/dev/null || true)"
    if [[ -z "${KONTROL_EXPECTED_BUILD_ID:-}" ]] || [[ "$dist_build_id" == "${KONTROL_EXPECTED_BUILD_ID}" ]]; then
      POLICY_CLI="${DESKTOP_PWD}/dist/cli.js"
    fi
  fi
  if [[ -z "$POLICY_CLI" && -f "${DESKTOP_PWD}/src/cli.ts" && -x "${DESKTOP_PWD}/node_modules/.bin/tsx" ]]; then
    # Source checkout fallback: execute the same CLI implementation through
    # tsx when the checkout's immutable dist projection is stale or absent.
    POLICY_COMMAND=(node --import tsx "${DESKTOP_PWD}/src/cli.ts")
    POLICY_CLI=""
  fi
fi
if [[ -n "$POLICY_CLI" ]]; then
  if [[ ! -f "$POLICY_CLI" ]]; then
    echo "ERROR: Kontrol CLI not found at $POLICY_CLI." >&2
    exit 1
  fi
  # Reject inconsistent artifact identity before launching any component.
  cli_dir="$(cd -- "$(dirname -- "$POLICY_CLI")" && pwd)"
  if [[ -n "${KONTROL_EXPECTED_BUILD_ID:-}" && -f "${cli_dir}/build-meta.json" ]]; then
    cli_build_id="$(node -e 'try{process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).buildId||"")}catch{}' "${cli_dir}/build-meta.json" 2>/dev/null || true)"
    if [[ -z "$cli_build_id" || "$cli_build_id" != "${KONTROL_EXPECTED_BUILD_ID}" ]]; then
      echo "ERROR: Kontrol CLI generation mismatch (expected $KONTROL_EXPECTED_BUILD_ID, found ${cli_build_id:-missing} at $POLICY_CLI); refusing to start the tunnel." >&2
      exit 1
    fi
  fi
  POLICY_COMMAND=(node "$POLICY_CLI")
elif [[ -z "${POLICY_COMMAND+x}" ]]; then
  echo "ERROR: Kontrol CLI is unavailable; run npm run build first." >&2
  exit 1
fi
if ! EFFECTIVE_POLICY_JSON="$("${POLICY_COMMAND[@]}" config effective-policy --json)"; then
  echo "ERROR: effective policy could not be loaded; refusing to start the tunnel." >&2
  exit 1
fi
if [[ -z "${KONTROL_TUNNEL_REVIEWER_SECRET:-}" ]] \
  && node -e '
    const fs = require("node:fs");
    const policy = JSON.parse(fs.readFileSync(0,"utf8"));
    process.exit(policy.canAsk === true ? 0 : 1);
  ' <<<"$EFFECTIVE_POLICY_JSON"; then
  echo "ERROR: KONTROL_AUTH_MODE=tunnel with an ask-capable policy requires a reviewer credential." >&2
  echo "       Set KONTROL_TUNNEL_REVIEWER_SECRET (or KONTROL_ACP_REVIEWER_SECRET), or use a" >&2
  echo "       non-interactive policy posture (KONTROL_POLICY_MODE=allow). Ask-gated tools" >&2
  echo "       would otherwise create approvals that no reviewer surface can open or resolve." >&2
  exit 1
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
    # Bounded core-readiness gate for direct/script starts (systemd units
    # carry the same gate as ExecStartPre). Ordering the tunnel after the
    # core is not readiness: without this wait the tunnel's single initial
    # MCP probe can race a still-starting core and permanently disable its
    # channel. Fails closed within KONTROL_TUNNEL_CORE_WAIT_MS (60s).
    # Backend-aware: pass the exact candidate identity so a tmux launch never
    # waits on an unrelated systemd `service.json` record.
    WAIT_CORE_ARGS=(--timeout-ms "${KONTROL_TUNNEL_CORE_WAIT_MS:-60000}")
    if [[ -n "${KONTROL_EXPECTED_BUILD_ID:-}" ]]; then
      WAIT_CORE_ARGS+=(--expected-build-id "$KONTROL_EXPECTED_BUILD_ID")
    fi
    if [[ -n "${KONTROL_ARTIFACT_PATH:-}" ]]; then
      WAIT_CORE_ARGS+=(--artifact-path "$KONTROL_ARTIFACT_PATH")
    fi
    if [[ -n "${KONTROL_STATE_DIR:-}" ]]; then
      WAIT_CORE_ARGS+=(--state-dir "$KONTROL_STATE_DIR")
    fi
    if [[ -n "${PORT:-}" ]]; then
      WAIT_CORE_ARGS+=(--port "${PORT:-7676}")
    fi
    if ! "${POLICY_COMMAND[@]}" service wait-core-ready "${WAIT_CORE_ARGS[@]}"; then
      echo "ERROR: core was not ready; refusing to start the tunnel with a doomed initial probe." >&2
      exit 1
    fi
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
