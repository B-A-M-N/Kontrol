#!/usr/bin/env bash
# start-all.sh — Kontrol MCP + ACP adapter + OpenAI tunnel
# Reliable daemon start via tmux. Readiness is mandatory before "BOTH UP".
set -euo pipefail
cd "$(dirname "$0")"
DESKTOP_PWD="$PWD"

# --- Source .env FIRST so all config is available ---
[[ -f .env ]] || { echo "ERROR: .env missing" >&2; exit 1; }
set -a; source .env; set +a

# --- Reviewer secret required for the WebUI review loop (Nelson/Ralphie) ---
# The WebUI reaches Kontrol through the tunnel as a reviewer; without the
# reviewer secret forwarded as X-Kontrol-Reviewer-Token it would arrive as
# an ordinary client and submit_to_coding_agent / provide_review_feedback
# would be forbidden. Refuse to launch rather than start in a broken state.
if [[ "${KONTROL_ACP_ENABLED:-true}" != "false" && -z "${KONTROL_ACP_REVIEWER_SECRET:-}" ]]; then
  echo "ERROR: KONTROL_ACP_REVIEWER_SECRET is required when ACP is enabled (the WebUI review loop needs reviewer authority)." >&2
  echo "Set it to a long random value, e.g. \`openssl rand -hex 32\`." >&2
  exit 1
fi

# --- Safety: explicit LAUNCH_DIR with cleanup trap (set -u safe) ---
LAUNCH_DIR="$(mktemp -d)"
cleanup() {
  if [[ -n "${LAUNCH_DIR:-}" && -d "$LAUNCH_DIR" ]]; then
    rm -rf "$LAUNCH_DIR"
  fi
}
trap cleanup EXIT

# --- Preflight: refuse to launch with broken source ---
echo "[*] Preflight: syntax-checking, typechecking, testing, building..."
if ! node --check scripts/acp-crush-adapter.mjs; then
  echo "ERROR: acp-crush-adapter.mjs failed syntax check. Aborting." >&2
  exit 1
fi
if ! node --check scripts/acp-hermes-native-adapter.mjs; then
  echo "ERROR: acp-hermes-native-adapter.mjs failed syntax check. Aborting." >&2
  exit 1
fi
if ! python3 -m py_compile scripts/hermes-native-runner.py; then
  echo "ERROR: hermes-native-runner.py failed syntax check. Aborting." >&2
  exit 1
fi
if ! npm run --silent typecheck; then
  echo "ERROR: typecheck failed. Aborting." >&2
  exit 1
fi
if ! npm --silent test 2>/dev/null; then
  echo "ERROR: tests failed. Aborting." >&2
  exit 1
fi
echo "[*] Building dist/ (launch must NEVER serve stale compiled code)..."
npm run build
echo "[*] Preflight + build passed."

# --- Graceful stop: signal, wait, escalate ---
echo "[*] Stopping any stale processes (graceful first)..."
for s in kontrol-adapter kontrol-adapter-crush kontrol-adapter-hermes kontrol-server kontrol-tunnel; do
  tmux send-keys -t "$s" C-c 2>/dev/null || true
done
sleep 2

# Escalate survivors
pkill -9 -f "cli.js serve" >/dev/null 2>&1 || true
pkill -9 -f "tunnel-client" >/dev/null 2>&1 || true
pkill -9 -f "acp-crush-adapter.mjs" >/dev/null 2>&1 || true
pkill -9 -f "acp-hermes-native-adapter.mjs" >/dev/null 2>&1 || true
tmux kill-session -t kontrol-server 2>/dev/null || true
tmux kill-session -t kontrol-tunnel 2>/dev/null || true
tmux kill-session -t kontrol-adapter 2>/dev/null || true
tmux kill-session -t kontrol-adapter-crush 2>/dev/null || true
tmux kill-session -t kontrol-adapter-hermes 2>/dev/null || true
sleep 1

DEV_HOST="${HOST:-127.0.0.1}"
DEV_PORT="${PORT:-7676}"
CRUSH_ACP_PORT="${ACP_ADAPTER_PORT:-9877}"
HERMES_ACP_PORT="${HERMES_ACP_ADAPTER_PORT:-9911}"
HERMES_ACP_COMPAT_PATH="$DESKTOP_PWD/scripts/hermes-acp-compat"
START_CRUSH_ADAPTER="${START_CRUSH_ADAPTER:-true}"
START_HERMES_ADAPTER="${START_HERMES_ADAPTER:-auto}"

if [[ "$START_CRUSH_ADAPTER" == "true" ]]; then
  CRUSH_CLI_BIN="${CRUSH_BIN:-/home/bamn/Crush-ACP/crush}"
  if [[ ! -x "$CRUSH_CLI_BIN" ]]; then
    echo "ERROR: CRUSH CLI binary not executable: $CRUSH_CLI_BIN" >&2
    echo "Set CRUSH_BIN to the built CRUSH CLI binary, or set START_CRUSH_ADAPTER=false." >&2
    exit 1
  fi
  CRUSH_HELP="$(timeout 5 "$CRUSH_CLI_BIN" run --help 2>&1 || true)"
  if ! grep -q "Run a single prompt in non-interactive mode" <<<"$CRUSH_HELP"; then
    echo "ERROR: CRUSH_BIN does not appear to be the CRUSH CLI runner: $CRUSH_CLI_BIN" >&2
    echo "Do not use crush-acp; it is the ACP/TUI transport binary." >&2
    exit 1
  fi
  # P0 #1: the adapter launches CRUSH with `--quiet` (NOT `--no-color`, which the
  # installed build does not support and which previously killed every real
  # dispatch with "Unknown flag: --no-color"). Refuse to launch if the binary
  # cannot accept the flag the adapter actually uses — the old preflight only
  # grepped the description text and never validated the flag itself.
  if ! grep -q -- "--quiet" <<<"$CRUSH_HELP"; then
    echo "ERROR: CRUSH_BIN ($CRUSH_CLI_BIN) does not support --quiet, which the ACP adapter requires." >&2
    exit 1
  fi
  export CRUSH_BIN="$CRUSH_CLI_BIN"
  echo "[*] Coding agent: CRUSH ($CRUSH_BIN)"
fi

if [[ "$START_HERMES_ADAPTER" != "false" ]]; then
  if ! command -v "${HERMES_BIN:-hermes}" >/dev/null 2>&1; then
    if [[ "$START_HERMES_ADAPTER" == "true" ]]; then
      echo "ERROR: Hermes binary not found: ${HERMES_BIN:-hermes}" >&2
      exit 1
    fi
    START_HERMES_ADAPTER="false"
  elif ! PYTHONPATH="$HERMES_ACP_COMPAT_PATH:${PYTHONPATH:-}" "${HERMES_BIN:-hermes}" acp --check >/dev/null 2>&1; then
    if [[ "$START_HERMES_ADAPTER" == "true" ]]; then
      echo "ERROR: hermes acp --check failed." >&2
      exit 1
    fi
    echo "[*] Hermes native adapter disabled: hermes acp --check failed."
    START_HERMES_ADAPTER="false"
  else
    echo "[*] Coding agent: Hermes native ACP (${HERMES_BIN:-hermes})"
  fi
fi

# --- Build the tunnel launcher as a file (avoids argv word-split bugs) ---
  cat > "$LAUNCH_DIR/tunnel.sh" <<EOF
  #!/usr/bin/env bash
  cd "$DESKTOP_PWD"
  set -a; source .env; set +a
  # P1 #9: secrets are NEVER placed in argv. tunnel-client reads header values
  # via the env:VARNAME mechanism (see \`tunnel-client run --help\`), so the
  # literal secret never appears in /proc/<pid>/cmdline (which any local process
  # can read). The token itself is sourced from .env and only referenced here by
  # NAME — the literal value is written nowhere in this file. The Bearer prefix
  # is attached to an env var so it can be passed through env: as well.
  # OPERATOR ACTION: rotate the tunnel + reviewer secrets after deploying — they
  # were previously exposed in argv.
  export KONTROL_TUNNEL_AUTH_HEADER="Bearer \${KONTROL_TUNNEL_TOKEN}"
  exec tunnel-client run --profile sample_mcp_with_dcr \\
    --mcp.extra-headers "Authorization: env:KONTROL_TUNNEL_AUTH_HEADER" \\
    --mcp.extra-headers "X-Kontrol-Reviewer-Token: env:KONTROL_ACP_REVIEWER_SECRET"
EOF
chmod +x "$LAUNCH_DIR/tunnel.sh"

# --- Start Kontrol ---
echo "[*] Starting kontrol MCP server on ${DEV_HOST}:${DEV_PORT}/mcp ..."
tmux new-session -d -s kontrol-server "cd '$PWD' && set -a && source .env && set +a && node dist/cli.js serve"

# Mandatory: /healthz + discovery before anything downstream
echo -n "[*] Waiting for kontrol to serve"
DEV_READY=0
for _ in $(seq 1 60); do
  D=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://${DEV_HOST}:${DEV_PORT}/healthz" 2>/dev/null || echo 000)
  W=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://${DEV_HOST}:${DEV_PORT}/.well-known/oauth-protected-resource" 2>/dev/null || echo 000)
  if [[ "$D" == "200" && "$W" == "200" ]]; then
    DEV_READY=1; break
  fi
  echo -n "."
  sleep 1
done
if [[ "$DEV_READY" != "1" ]]; then
  echo ""
  echo "ERROR: kontrol did not serve /healthz + discovery in time." >&2
  exit 1
fi
echo " kontrol ready."

# --- Start managed ACP adapters ---
wait_adapter_health() {
  local name="$1" port="$2" session="$3"
  echo -n "[*] Waiting for ${name} adapter readiness"
  local ok=0
  for _ in $(seq 1 30); do
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://127.0.0.1:${port}/health" 2>/dev/null || echo 000)
    if [[ "$code" == "200" ]]; then ok=1; break; fi
    echo -n "."
    sleep 1
  done
  if [[ "$ok" != "1" ]]; then
    echo ""
    echo "ERROR: ${name} adapter did not become healthy on :${port}." >&2
    echo "  tmux capture-pane -t ${session} -p | tail -30" >&2
    exit 1
  fi
  echo " ${name} adapter healthy."
}

smoke_adapter() {
  local name="$1" port="$2" agent="$3" session="$4"
  echo -n "[*] Running ${name} adapter /runs smoke"
  local body
  body="{\"agent_name\":\"${agent}\",\"mode\":\"async\",\"input\":[{\"role\":\"user\",\"parts\":[{\"content_type\":\"text/plain\",\"content\":\"KONTROL_ADAPTER_SMOKE\"}]}],\"parent_run_id\":\"startup-smoke-${agent}\",\"smoke_test\":true}"
  local ok=0
  for _ in $(seq 1 10); do
    local response
    response=$(curl -s --max-time 5 -X POST "http://127.0.0.1:${port}/runs" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${KONTROL_ACP_ADAPTER_SECRET:-${KONTROL_ACP_SHARED_SECRET:-}}" \
      --data "$body" 2>/dev/null || echo "")
    if echo "$response" | grep -q '"smoke_test":true'; then ok=1; break; fi
    echo -n "."
    sleep 1
  done
  if [[ "$ok" != "1" ]]; then
    echo ""
    echo "ERROR: ${name} adapter /runs smoke failed." >&2
    echo "  tmux capture-pane -t ${session} -p | tail -50" >&2
    exit 1
  fi
  echo " smoke passed."
}

wait_agent_registered() {
  local agent="$1"
  echo -n "[*] Waiting for ${agent} registration in Kontrol..."
  local ok=0
  local last_status=""
  local last_body=""
  local kontrol_secret="${KONTROL_ACP_SHARED_SECRET:-${KONTROL_ACP_AGENT_SECRET:-${KONTROL_ACP_REVIEWER_SECRET:-}}}"
  if [[ -z "$kontrol_secret" ]]; then
    echo ""
    echo "ERROR: no Kontrol ACP auth secret is configured for registry probing." >&2
    exit 1
  fi
  for _ in $(seq 1 45); do
    local reg
    local tmp_body
    tmp_body="$(mktemp)"
    last_status=$(curl -s -o "$tmp_body" -w "%{http_code}" --max-time 3 -H "Authorization: Bearer ${kontrol_secret}" "http://${DEV_HOST}:${DEV_PORT}/acp/agents/${agent}" 2>/dev/null || echo "000")
    reg="$(cat "$tmp_body" 2>/dev/null || true)"
    rm -f "$tmp_body"
    last_body="$reg"
    if [[ "$last_status" == "200" ]] && echo "$reg" | grep -q "\"name\":\"${agent}\""; then ok=1; break; fi
    echo -n "."
    sleep 1
  done
  if [[ "$ok" != "1" ]]; then
    echo ""
    echo "ERROR: ${agent} was not confirmed registered (last_status=${last_status})." >&2
    if [[ -n "$last_body" ]]; then
      echo "  last_body=${last_body}" >&2
    fi
    exit 1
  fi
  echo " ${agent} registered."
}

if [[ "$START_CRUSH_ADAPTER" == "true" ]]; then
  echo "[*] Starting CRUSH ACP adapter on 127.0.0.1:${CRUSH_ACP_PORT} ..."
  tmux new-session -d -s kontrol-adapter-crush "cd '$PWD' && set -a && source .env && set +a && ACP_AGENT_BIN=crush PORT=${CRUSH_ACP_PORT} node scripts/acp-crush-adapter.mjs"
  wait_adapter_health "CRUSH" "$CRUSH_ACP_PORT" "kontrol-adapter-crush"
  smoke_adapter "CRUSH" "$CRUSH_ACP_PORT" "cli-coding-agent" "kontrol-adapter-crush"
  wait_agent_registered "cli-coding-agent"
fi

if [[ "$START_HERMES_ADAPTER" == "true" || "$START_HERMES_ADAPTER" == "auto" ]]; then
  if [[ "$START_HERMES_ADAPTER" != "false" ]]; then
    echo "[*] Starting Hermes native ACP adapter on 127.0.0.1:${HERMES_ACP_PORT} ..."
    tmux new-session -d -s kontrol-adapter-hermes "cd '$PWD' && set -a && source .env && set +a && HERMES_ACP_ADAPTER_PORT=${HERMES_ACP_PORT} node scripts/acp-hermes-native-adapter.mjs"
    wait_adapter_health "Hermes" "$HERMES_ACP_PORT" "kontrol-adapter-hermes"
    smoke_adapter "Hermes" "$HERMES_ACP_PORT" "hermes-agent" "kontrol-adapter-hermes"
    wait_agent_registered "hermes-agent"
  fi
fi

# --- Start tunnel ---
echo "[*] Starting tunnel-client ..."
tmux new-session -d -s kontrol-tunnel "$LAUNCH_DIR/tunnel.sh"

# Mandatory: tunnel readiness
echo -n "[*] Waiting for tunnel READY"
TUNNEL_OK=0
T="000"
R=""
for _ in $(seq 1 60); do
  T=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://127.0.0.1:8080/healthz" 2>/dev/null || echo 000)
  R=$(curl -s --max-time 2 "http://127.0.0.1:8080/metrics" 2>/dev/null | awk '/^readiness\{.*\} / { print $NF; exit }' || true)
  if [[ "$T" == "200" && "$R" == "1" ]]; then
    TUNNEL_OK=1; break
  fi
  echo -n "."
  sleep 1
done
if [[ "$TUNNEL_OK" != "1" ]]; then
  echo ""
  echo "ERROR: tunnel did not become ready (tunnel=$T ready=$R)." >&2
  exit 1
fi

# P1 #9: fail closed if either configured secret leaked into a process command
# line. Secrets must reach the tunnel client via environment-variable references
# (see tunnel.sh), never as literal arguments. Rotate the tunnel + reviewer
# secrets after deploying this change — they were previously exposed in argv.
assert_no_secret_in_cmdline() {
  local secret="$1" label="$2"
  [[ -z "$secret" ]] && return 0
  local f cmdline
  for f in /proc/[0-9]*/cmdline; do
    cmdline="$(tr '\0' ' ' < "$f" 2>/dev/null || true)"
    if [[ "$cmdline" == *"$secret"* ]]; then
      echo "ERROR: $label secret value detected in a process command line. Refusing to continue." >&2
      echo "  Rotate $label now (it was exposed to local process inspection)." >&2
      exit 1
    fi
  done
}
assert_no_secret_in_cmdline "$KONTROL_TUNNEL_TOKEN" "KONTROL_TUNNEL_TOKEN"
assert_no_secret_in_cmdline "$KONTROL_ACP_REVIEWER_SECRET" "KONTROL_ACP_REVIEWER_SECRET"

echo ""
echo "=== BOTH UP (tunnel READY, adapter HEALTHY, agent REGISTERED) ==="
echo "  MCP:      http://${DEV_HOST}:${DEV_PORT}/mcp"
if [[ "$START_CRUSH_ADAPTER" == "true" ]]; then
  echo "  CRUSH:    http://127.0.0.1:${CRUSH_ACP_PORT}  (cli-coding-agent)"
fi
if [[ "$START_HERMES_ADAPTER" == "true" || "$START_HERMES_ADAPTER" == "auto" ]]; then
  echo "  Hermes:   http://127.0.0.1:${HERMES_ACP_PORT}  (hermes-agent)"
fi
echo "  Tunnel:   http://127.0.0.1:8080/ui"
echo "  Logs:     tmux attach -t kontrol-server | kontrol-adapter-crush | kontrol-adapter-hermes | kontrol-tunnel"
echo "  Stop:     bash stop-all.sh"
