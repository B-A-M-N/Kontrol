#!/usr/bin/env bash
# start-all.sh — Kontrol MCP + ACP adapter + OpenAI tunnel
# Reliable daemon start via tmux. Readiness is mandatory before "BOTH UP".
# P1 #41: Transactional — track launched components and roll back on failure.
set -euo pipefail
cd "$(dirname "$0")"
DESKTOP_PWD="$PWD"
export DESKTOP_PWD

# --- Source .env FIRST so all config is available ---
[[ -f .env ]] || { echo "ERROR: .env missing" >&2; exit 1; }
set -a; source .env; set +a

# --- Reviewer secret required for the WebUI review loop (Nelson/Ralphie) ---
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
# --- P1 #41: Track components launched this invocation for rollback ---
LAUNCHED_SESSIONS=()
STARTUP_COMMITTED=0
ROLLBACK_IN_PROGRESS=0
CANDIDATE_BUILD_PROMOTED=0
PREFLIGHT_LOG="${KONTROL_PREFLIGHT_LOG:-${TMPDIR:-/tmp}/kontrol-preflight-$(date +%Y%m%d-%H%M%S)-$$.log}"

rollback() {
  if [[ "$STARTUP_COMMITTED" == "1" ]]; then
    return 0
  fi
  echo "[!] Rolling back launched components..." >&2
  # Graceful shutdown first; escalate only after the grace period.
  for s in "${LAUNCHED_SESSIONS[@]}"; do
    [[ -z "$s" ]] && continue
    tmux send-keys -t "$s" C-c 2>/dev/null || true
  done
  if tmux has-session -t kontrol-supervisor 2>/dev/null; then
    tmux send-keys -t kontrol-supervisor C-c 2>/dev/null || true
    sleep 1
    tmux kill-session -t kontrol-supervisor 2>/dev/null || true
  fi
  sleep 2
  for s in "${LAUNCHED_SESSIONS[@]}"; do
    [[ -z "$s" ]] && continue
    if tmux has-session -t "$s" 2>/dev/null; then
      tmux kill-session -t "$s" 2>/dev/null || true
    fi
  done
  if [[ "$ROLLBACK_IN_PROGRESS" == "0" && "$CANDIDATE_BUILD_PROMOTED" == "1" && -d "$DESKTOP_PWD/dist.previous" && "${KONTROL_ROLLBACK_ATTEMPT:-false}" != "true" ]]; then
    ROLLBACK_IN_PROGRESS=1
    echo "[*] Restoring previous known-good build generation..." >&2
    FAILED_DIST="$DESKTOP_PWD/dist.failed-${BASHPID:-$$}"
    mv -- "$DESKTOP_PWD/dist" "$FAILED_DIST"
    mv -- "$DESKTOP_PWD/dist.previous" "$DESKTOP_PWD/dist"
    rm -rf -- "$FAILED_DIST"
    echo "[*] Relaunching the previous generation with readiness checks..." >&2
    if ! KONTROL_ROLLBACK_ATTEMPT=true KONTROL_USE_EXISTING_DIST=true bash "$DESKTOP_PWD/start-all.sh"; then
      echo "[!] Previous generation could not be restored to READY; inspect the retained supervisor/tmux logs." >&2
    else
      echo "[*] Previous known-good generation restored and READY." >&2
    fi
  fi
}

on_exit() {
  local status=$?
  if [[ "$STARTUP_COMMITTED" != "1" ]]; then
    rollback
  fi
  cleanup
  trap - EXIT
  exit "$status"
}
trap on_exit EXIT

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
if ! node --check scripts/probe-kontrol-readiness.mjs; then
  echo "ERROR: probe-kontrol-readiness.mjs failed syntax check. Aborting." >&2
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
if [[ "${KONTROL_SKIP_PREFLIGHT_TESTS:-false}" == "true" ]]; then
  echo "[*] Skipping test suite because KONTROL_SKIP_PREFLIGHT_TESTS=true."
else
  : > "$PREFLIGHT_LOG"
  # Stream progress so a multi-minute TypeScript/package preflight does not
  # look hung, while retaining the complete log for failure diagnosis.
  if ! npm --silent test 2>&1 | tee "$PREFLIGHT_LOG"; then
    echo "ERROR: tests failed. Full preflight log: $PREFLIGHT_LOG" >&2
    tail -n 120 "$PREFLIGHT_LOG" >&2 || true
    exit 1
  fi
  echo "[*] Test suite passed. Full preflight log: $PREFLIGHT_LOG"
fi

if [[ "${KONTROL_RELEASE_MODE:-false}" == "true" && "${KONTROL_ALLOW_DIRTY_RELEASE:-false}" != "true" ]]; then
  DIRTY_COUNT="$(git status --porcelain | wc -l | tr -d ' ')"
  if [[ "$DIRTY_COUNT" != "0" ]]; then
    echo "ERROR: release mode refuses a dirty checkout ($DIRTY_COUNT changed paths). Set KONTROL_ALLOW_DIRTY_RELEASE=true only for an explicit development override." >&2
    exit 1
  fi
fi
if [[ "${KONTROL_USE_EXISTING_DIST:-false}" == "true" ]]; then
  for artifact in dist/cli.js dist/server.js dist/build-meta.json; do
    [[ -f "$artifact" ]] || { echo "ERROR: requested existing build is missing $artifact" >&2; exit 1; }
  done
  echo "[*] Reusing previously validated dist/ generation."
else
  echo "[*] Building dist/ (launch must NEVER serve stale compiled code)..."
  npm run build
  CANDIDATE_BUILD_PROMOTED=1
fi
echo "[*] Preflight + build passed."

# --- Graceful stop: signal, wait, escalate (P1 #42: only our own sessions) ---
echo "[*] Stopping any stale processes (graceful first)..."
STALE_SESSIONS=("kontrol-adapter" "kontrol-adapter-crush" "kontrol-adapter-hermes" "kontrol-server" "kontrol-tunnel" "kontrol-supervisor")
for s in "${STALE_SESSIONS[@]}"; do
  if tmux has-session -t "$s" 2>/dev/null; then
    tmux send-keys -t "$s" C-c 2>/dev/null || true
  fi
done
sleep 2

# Escalate survivors (only our own sessions)
for s in "${STALE_SESSIONS[@]}"; do
  if tmux has-session -t "$s" 2>/dev/null; then
    tmux kill-session -t "$s" 2>/dev/null || true
  fi
done
sleep 1

DEV_HOST="${HOST:-127.0.0.1}"
DEV_PORT="${PORT:-7676}"
CRUSH_ACP_PORT="${ACP_ADAPTER_PORT:-9877}"
HERMES_ACP_PORT="${HERMES_ACP_ADAPTER_PORT:-9911}"
HERMES_ACP_COMPAT_PATH="$DESKTOP_PWD/scripts/hermes-acp-compat"
CRUSH_ADAPTER_LOG="${TMPDIR:-/tmp}/kontrol-adapter-crush.log"
HERMES_ADAPTER_LOG="${TMPDIR:-/tmp}/kontrol-adapter-hermes.log"
START_CRUSH_ADAPTER="${START_CRUSH_ADAPTER:-true}"
START_HERMES_ADAPTER="${START_HERMES_ADAPTER:-auto}"
EXPECTED_AGENT_ARGS=()

if [[ "$START_CRUSH_ADAPTER" == "true" ]]; then
  CRUSH_CLI_BIN="${CRUSH_BIN:-${HOME}/Crush-ACP/crush}"
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

# Bind strict readiness to the adapter generation selected before KONTROL is
# launched. This makes /readyz fail closed after an adapter dies instead of
# falling back to an empty KONTROL_ACP_AGENTS configuration.
REQUIRED_AGENT_CONFIG="${KONTROL_ACP_AGENTS:-}"
if [[ "$START_CRUSH_ADAPTER" == "true" ]]; then
  REQUIRED_AGENT_CONFIG="${REQUIRED_AGENT_CONFIG:+$REQUIRED_AGENT_CONFIG,}cli-coding-agent=http://127.0.0.1:${CRUSH_ACP_PORT}"
fi
# In auto mode Hermes is optional until its adapter smoke succeeds. Strict
# readiness dynamically includes live registered workers; only an explicitly
# required Hermes generation is pinned in KONTROL_ACP_AGENTS here.
if [[ "$START_HERMES_ADAPTER" == "true" ]]; then
  REQUIRED_AGENT_CONFIG="${REQUIRED_AGENT_CONFIG:+$REQUIRED_AGENT_CONFIG,}hermes-agent=http://127.0.0.1:${HERMES_ACP_PORT}"
fi
if [[ -n "$REQUIRED_AGENT_CONFIG" ]]; then
  export KONTROL_ACP_AGENTS="$REQUIRED_AGENT_CONFIG"
fi
SERVER_AGENT_EXPORT=""
if [[ -n "$REQUIRED_AGENT_CONFIG" ]]; then
  printf -v SERVER_AGENT_EXPORT 'export KONTROL_ACP_AGENTS=%q;' "$REQUIRED_AGENT_CONFIG"
fi

# --- Start Kontrol ---
echo "[*] Starting kontrol MCP server on ${DEV_HOST}:${DEV_PORT}/mcp ..."
tmux new-session -d -s kontrol-server -c "$DESKTOP_PWD" "set -a && source .env && set +a && ${SERVER_AGENT_EXPORT} exec node dist/cli.js serve"
LAUNCHED_SESSIONS+=("kontrol-server")

# Mandatory: liveness + discovery before anything downstream
echo -n "[*] Waiting for kontrol to serve"
DEV_READY=0
for _ in $(seq 1 60); do
  D=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://${DEV_HOST}:${DEV_PORT}/healthz" 2>/dev/null || echo 000)
  R=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://${DEV_HOST}:${DEV_PORT}/core-readyz" 2>/dev/null || echo 000)
  W=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://${DEV_HOST}:${DEV_PORT}/.well-known/oauth-protected-resource" 2>/dev/null || echo 000)
  if [[ "$D" == "200" && "$R" == "200" && "$W" == "200" ]]; then
    DEV_READY=1; break
  fi
  echo -n "."
  sleep 1
done
if [[ "$DEV_READY" != "1" ]]; then
  echo ""
  echo "ERROR: kontrol did not serve /healthz + /core-readyz + discovery in time (healthz=$D core-readyz=$R discovery=$W)." >&2
  exit 1
fi
echo " kontrol ready."

echo "[*] Probing MCP App template..."
if ! node scripts/probe-workspace-app.mjs --url "http://${DEV_HOST}:${DEV_PORT}/mcp"; then
  echo "ERROR: MCP App template probe failed. Aborting." >&2
  exit 1
fi
echo "[*] MCP App template probe passed."

# --- Start managed ACP adapters ---
wait_adapter_health() {
  local name="$1" port="$2" session="$3" log_file="$4"
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
    if [[ -f "$log_file" ]]; then
      echo "  Recent adapter log (${log_file}):" >&2
      tail -n 50 "$log_file" >&2
    else
      echo "  tmux capture-pane -t ${session} -p | tail -30" >&2
    fi
    return 1
  fi
  echo " ${name} adapter healthy."
  return 0
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
      -H "Authorization: Bearer ${KONTROL_ACP_ADAPTER_SECRET:-}" \
      --data "$body" 2>/dev/null || echo "")
    if echo "$response" | grep -q '"smoke_test":true'; then ok=1; break; fi
    echo -n "."
    sleep 1
  done
  if [[ "$ok" != "1" ]]; then
    echo ""
    echo "ERROR: ${name} adapter /runs smoke failed." >&2
    echo "  tmux capture-pane -t ${session} -p | tail -50" >&2
    return 1
  fi
  echo " smoke passed."
  return 0
}

if [[ "$START_CRUSH_ADAPTER" == "true" ]]; then
  echo "[*] Starting CRUSH ACP adapter on 127.0.0.1:${CRUSH_ACP_PORT} ..."
  tmux new-session -d -s kontrol-adapter-crush -c "$DESKTOP_PWD" "set -a && source .env && set +a && exec env ACP_AGENT_BIN=crush PORT=${CRUSH_ACP_PORT} node scripts/acp-crush-adapter.mjs > '$CRUSH_ADAPTER_LOG' 2>&1"
  LAUNCHED_SESSIONS+=("kontrol-adapter-crush")
  wait_adapter_health "CRUSH" "$CRUSH_ACP_PORT" "kontrol-adapter-crush" "$CRUSH_ADAPTER_LOG"
  smoke_adapter "CRUSH" "$CRUSH_ACP_PORT" "cli-coding-agent" "kontrol-adapter-crush"
  EXPECTED_AGENT_ARGS+=(--agent "cli-coding-agent=http://127.0.0.1:${CRUSH_ACP_PORT}")
fi

if [[ "$START_HERMES_ADAPTER" == "true" || "$START_HERMES_ADAPTER" == "auto" ]]; then
  if [[ "$START_HERMES_ADAPTER" != "false" ]]; then
    echo "[*] Starting Hermes native ACP adapter on 127.0.0.1:${HERMES_ACP_PORT} ..."
    tmux new-session -d -s kontrol-adapter-hermes -c "$DESKTOP_PWD" "set -a && source .env && set +a && exec env HERMES_ACP_ADAPTER_PORT=${HERMES_ACP_PORT} node scripts/acp-hermes-native-adapter.mjs > '$HERMES_ADAPTER_LOG' 2>&1"
    LAUNCHED_SESSIONS+=("kontrol-adapter-hermes")
    if wait_adapter_health "Hermes" "$HERMES_ACP_PORT" "kontrol-adapter-hermes" "$HERMES_ADAPTER_LOG"; then
      if ! smoke_adapter "Hermes" "$HERMES_ACP_PORT" "hermes-agent" "kontrol-adapter-hermes"; then
        if [[ "$START_HERMES_ADAPTER" == "auto" ]]; then
          echo "[!] Hermes adapter smoke failed; continuing in auto mode (set START_HERMES_ADAPTER=true to make it mandatory)"
          START_HERMES_ADAPTER="false"
          tmux kill-session -t kontrol-adapter-hermes 2>/dev/null || true
          LAUNCHED_SESSIONS=("${LAUNCHED_SESSIONS[@]/kontrol-adapter-hermes}")
        else
          exit 1
        fi
      fi
      if [[ "$START_HERMES_ADAPTER" != "false" ]]; then
        EXPECTED_AGENT_ARGS+=(--agent "hermes-agent=http://127.0.0.1:${HERMES_ACP_PORT}")
      fi
    elif [[ "$START_HERMES_ADAPTER" == "auto" ]]; then
      echo "[!] Hermes adapter failed; continuing in auto mode (set START_HERMES_ADAPTER=true to make it mandatory)"
      START_HERMES_ADAPTER="false"
      tmux kill-session -t kontrol-adapter-hermes 2>/dev/null || true
      LAUNCHED_SESSIONS=("${LAUNCHED_SESSIONS[@]/kontrol-adapter-hermes}")
    else
      exit 1
    fi
  fi
fi

# Prove the registry and the real MCP tool path after adapters have registered.
# A listening port or adapter /health response alone is not readiness.
echo "[*] Probing registered agents and MCP workspace round-trip..."
PROBE_FLAGS=()
if [[ "${KONTROL_ACP_ENABLED:-true}" == "false" ]]; then
  PROBE_FLAGS+=(--skip-discover)
fi
if ! node scripts/probe-kontrol-readiness.mjs \
  --url "http://${DEV_HOST}:${DEV_PORT}/mcp" \
  --workspace "$PWD" \
  "${PROBE_FLAGS[@]}" \
  "${EXPECTED_AGENT_ARGS[@]}"; then
  echo "ERROR: KONTROL readiness round-trip failed. Aborting." >&2
  exit 1
fi
echo "[*] KONTROL readiness round-trip passed."

if [[ "${KONTROL_ACP_ENABLED:-true}" != "false" ]]; then
  STRICT_READY_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://${DEV_HOST}:${DEV_PORT}/readyz" 2>/dev/null || echo 000)
  if [[ "$STRICT_READY_CODE" != "200" ]]; then
    echo "ERROR: strict KONTROL /readyz did not become ready after agent registration (HTTP $STRICT_READY_CODE)." >&2
    exit 1
  fi
fi

if [[ "${KONTROL_OPERATIONAL_UAT:-false}" == "true" ]]; then
  echo "[*] Running optional real-agent operational UAT..."
  if ! KONTROL_UAT_URL="http://${DEV_HOST}:${DEV_PORT}/mcp" node scripts/live-supervisor-uat.mjs; then
    echo "ERROR: operational UAT failed. Aborting." >&2
    exit 1
  fi
  echo "[*] Operational UAT passed."
fi

if [[ "${KONTROL_TUNNEL_DOCTOR:-true}" != "false" ]]; then
  echo "[*] Validating tunnel-client configuration (ephemeral health listener)..."
  if ! "$DESKTOP_PWD/scripts/kontrol-tunnel.sh" --doctor; then
    echo "ERROR: tunnel-client doctor failed. Aborting." >&2
    exit 1
  fi
  echo "[*] tunnel-client doctor passed."
fi

# --- Start tunnel ---
echo "[*] Starting tunnel-client (profile=${KONTROL_TUNNEL_PROFILE:-sample_mcp_with_dcr}${KONTROL_TUNNEL_ID:+, tunnel=${KONTROL_TUNNEL_ID}}) ..."
tmux new-session -d -s kontrol-tunnel -c "$DESKTOP_PWD" "$DESKTOP_PWD/scripts/kontrol-tunnel.sh"
LAUNCHED_SESSIONS+=("kontrol-tunnel")

# Mandatory: tunnel-client readiness. /healthz only proves the daemon exists;
# /readyz proves control-plane polling and the configured MCP initialize probe.
echo -n "[*] Waiting for tunnel MCP READY"
TUNNEL_OK=0
T="000"
R="000"
for _ in $(seq 1 60); do
  T=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://127.0.0.1:8080/healthz" 2>/dev/null || echo 000)
  R=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://127.0.0.1:8080/readyz" 2>/dev/null || echo 000)
  if [[ "$T" == "200" && "$R" == "200" ]]; then
    TUNNEL_OK=1; break
  fi
  echo -n "."
  sleep 1
done
if [[ "$TUNNEL_OK" != "1" ]]; then
  echo ""
  echo "ERROR: tunnel MCP readiness failed (healthz=$T readyz=$R)." >&2
  echo "  Check: tunnel-client health --port 8080 --json" >&2
  exit 1
fi

echo "[*] Starting persistent component supervisor ..."
SUPERVISOR_STATUS_FILE="${KONTROL_STATE_DIR:-$DESKTOP_PWD/.kontrol-state}/supervisor-status.json"
SUPERVISOR_ARGS=(
  --root "$DESKTOP_PWD"
  --kontrol-url "http://${DEV_HOST}:${DEV_PORT}"
  --tunnel-url "http://127.0.0.1:8080"
  --status-file "$SUPERVISOR_STATUS_FILE"
  --crush-port "$CRUSH_ACP_PORT"
  --hermes-port "$HERMES_ACP_PORT"
  --start-crush "$START_CRUSH_ADAPTER"
  --start-hermes "$([[ "$START_HERMES_ADAPTER" != "false" ]] && echo true || echo false)"
)
if [[ -n "${REQUIRED_AGENT_CONFIG:-}" ]]; then
  SUPERVISOR_ARGS+=(--agents "$REQUIRED_AGENT_CONFIG")
fi
tmux new-session -d -s kontrol-supervisor -c "$DESKTOP_PWD" "set -a && source .env && set +a && exec node '$DESKTOP_PWD/scripts/kontrol-supervisor.mjs' ${SUPERVISOR_ARGS[*]}"
LAUNCHED_SESSIONS+=("kontrol-supervisor")
echo -n "[*] Waiting for component supervisor"
SUPERVISOR_READY=0
for _ in $(seq 1 20); do
  if [[ -s "$SUPERVISOR_STATUS_FILE" ]] && grep -q '"state": "healthy"' "$SUPERVISOR_STATUS_FILE"; then
    SUPERVISOR_READY=1
    break
  fi
  echo -n "."
  sleep 1
done
if [[ "$SUPERVISOR_READY" != "1" ]]; then
  echo ""
  echo "ERROR: component supervisor did not report healthy. Status: $SUPERVISOR_STATUS_FILE" >&2
  [[ -f "$SUPERVISOR_STATUS_FILE" ]] && tail -n 80 "$SUPERVISOR_STATUS_FILE" >&2 || true
  exit 1
fi

# P1 #41: All components healthy — commit startup, disable rollback
STARTUP_COMMITTED=1

echo ""
echo "=== KONTROL READY (tunnel, MCP round-trip, configured agents verified) ==="
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
