#!/usr/bin/env bash
# Restart the complete Kontrol generation through a serialized transaction.
# Candidate preparation happens while the current tmux generation is serving;
# the deployment controller retains recovery ownership through the cutover.
set -euo pipefail
cd "$(dirname "$0")"

DESKTOP_PWD="$PWD"
export DESKTOP_PWD
ENV_FILE="${KONTROL_ENV_FILE:-$DESKTOP_PWD/.env}"
[[ -f "$ENV_FILE" ]] || { echo "ERROR: environment file missing: $ENV_FILE" >&2; exit 1; }
set -a
source "$ENV_FILE"
set +a
export KONTROL_ENV_FILE="$ENV_FILE"

DEPLOYMENT_ID="deployment-$(date +%s)-$$"
START_ARGS=("$@")
DEPLOYMENT_LOCK_TOKEN=""
DEPLOYMENT_LOCK_OWNED=0
HANDOFF_STARTED=0
PREVIOUS_ARTIFACT_PATH=""
PREVIOUS_BUILD_ID=""
PREPARED_CANDIDATE_BUILD_ID=""

resolve_state_dir() {
  node --import tsx --input-type=module -e '
    import { loadConfig } from "./src/config.ts";
    process.stdout.write(loadConfig().stateDir);
  '
}

EFFECTIVE_STATE_DIR="$(resolve_state_dir)"
[[ -n "$EFFECTIVE_STATE_DIR" ]] || { echo "ERROR: Kontrol resolved an empty state directory." >&2; exit 1; }
export KONTROL_STATE_DIR="$EFFECTIVE_STATE_DIR"

DEPLOYMENT_LOCK_TOKEN="$(node --import tsx src/deployment-lock.ts acquire \
  --state-dir "$KONTROL_STATE_DIR" \
  --operation restart \
  --deployment-id "$DEPLOYMENT_ID" \
  --pid "$$")"
export DEPLOYMENT_LOCK_TOKEN KONTROL_DEPLOYMENT_LOCK_TOKEN="$DEPLOYMENT_LOCK_TOKEN" KONTROL_DEPLOYMENT_ID="$DEPLOYMENT_ID"
DEPLOYMENT_LOCK_OWNED=1

runtime_owner_info() {
  node --import tsx --input-type=module -e '
    import { isRuntimeLockLive, readRuntimeLock } from "./src/runtime-lock.ts";
    const lock = readRuntimeLock(process.env.KONTROL_STATE_DIR);
    if (lock && isRuntimeLockLive(lock)) process.stdout.write(JSON.stringify(lock));
  ' 2>/dev/null || true
}

json_field() {
  local json="$1" field="$2"
  node -e 'try { const value = JSON.parse(process.argv[1])[process.argv[2]]; if (value !== undefined && value !== null) process.stdout.write(String(value)); } catch {}' "$json" "$field"
}

json_file_field() {
  local path="$1" field="$2"
  node -e 'try { const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; if (value !== undefined && value !== null) process.stdout.write(String(value)); } catch {}' "$path" "$field"
}

release_deployment_lock() {
  if [[ "$DEPLOYMENT_LOCK_OWNED" == "1" && -n "$DEPLOYMENT_LOCK_TOKEN" ]]; then
    node --import tsx src/deployment-lock.ts release \
      --state-dir "$KONTROL_STATE_DIR" \
      --token "$DEPLOYMENT_LOCK_TOKEN" >/dev/null 2>&1 || true
    DEPLOYMENT_LOCK_OWNED=0
  fi
}

on_exit() {
  local status=$?
  if [[ "$HANDOFF_STARTED" == "1" && "$status" != "0" && -n "$PREVIOUS_ARTIFACT_PATH" ]]; then
    local live_owner
    live_owner="$(runtime_owner_info)"
    if [[ -n "$live_owner" ]]; then
      echo "ERROR: activation failed, but another live generation owns runtime.lock; leaving it in charge: $live_owner" >&2
    else
      echo "[!] Activation exited before establishing a healthy owner; attempting exact previous-generation recovery." >&2
      # A failed activation may also have lost the inherited deployment lock.
      # Do not pass a stale token to the recovery controller: release our own
      # valid token when possible, then let the fresh controller acquire a new
      # transaction lock. If the token is still valid, keep it and serialize
      # recovery under the same transaction.
      if ! node --import tsx src/deployment-lock.ts check \
        --state-dir "$KONTROL_STATE_DIR" \
        --token "$DEPLOYMENT_LOCK_TOKEN" >/dev/null 2>&1; then
        release_deployment_lock
        DEPLOYMENT_LOCK_TOKEN=""
        export DEPLOYMENT_LOCK_TOKEN KONTROL_DEPLOYMENT_LOCK_TOKEN="" KONTROL_DEPLOYMENT_ID="" KONTROL_RUNTIME_LOCK_TOKEN=""
      fi
      if KONTROL_USE_EXISTING_DIST=true \
        KONTROL_ROLLBACK_ACTIVE=true \
        KONTROL_ROLLBACK_ATTEMPT=true \
        KONTROL_RECOVERY_DELEGATED=true \
        KONTROL_RUNTIME_LOCK_TOKEN="" \
        KONTROL_ACTIVATE_ARTIFACT_PATH="$PREVIOUS_ARTIFACT_PATH" \
        KONTROL_ROLLBACK_REQUESTED_BUILD_ID="${PREPARED_CANDIDATE_BUILD_ID:-unknown}" \
        KONTROL_ROLLBACK_FAILED_BUILD_ID="${PREPARED_CANDIDATE_BUILD_ID:-unknown}" \
        KONTROL_ROLLBACK_REASON="candidate activation failed after the old generation was stopped" \
        ./start-all.sh --activate-existing "${START_ARGS[@]}"; then
        status=0
      else
        echo "ERROR: exact previous generation could not be recovered: $PREVIOUS_ARTIFACT_PATH" >&2
      fi
    fi
  fi
  release_deployment_lock
  trap - EXIT
  exit "$status"
}
trap on_exit EXIT

OWNER_INFO="$(runtime_owner_info)"
if [[ -n "$OWNER_INFO" ]]; then
  OWNER_LAUNCHER="$(json_field "$OWNER_INFO" launcher)"
  PREVIOUS_ARTIFACT_PATH="$(json_field "$OWNER_INFO" artifactPath)"
  PREVIOUS_BUILD_ID="$(json_field "$OWNER_INFO" buildId)"
  case "$OWNER_LAUNCHER" in
    tmux-stack)
      # The deployment lock remains held by this shell across both phases.
      # start-all validates the inherited token and uses transaction-specific
      # candidate state, so a second restart cannot cross the cutover.
      if ! KONTROL_USE_EXISTING_DIST=false ./start-all.sh --prepare-only; then
        echo "ERROR: candidate preparation failed; the current Kontrol generation was left running." >&2
        exit 1
      fi
      PREPARED_CANDIDATE_BUILD_ID="$(json_file_field "${KONTROL_STATE_DIR}/candidate.${DEPLOYMENT_ID}.json" buildId)"
      HANDOFF_STARTED=1
      ./stop-all.sh
      KONTROL_USE_EXISTING_DIST=true ./start-all.sh --activate-existing "$@"
      HANDOFF_STARTED=0
      ;;
    systemd)
      echo "Kontrol is already managed by systemd. Use: scripts/kontrol-user-service.sh restart" >&2
      exit 1
      ;;
    dev-watch)
      echo "Kontrol is already managed by the dev watcher. Stop that watcher before restarting the persistent stack." >&2
      exit 1
      ;;
    *)
      echo "Kontrol is already managed by ${OWNER_LAUNCHER}; use its owning launcher to restart it." >&2
      exit 1
      ;;
  esac
else
  # No existing owner: start-all validates the inherited deployment lock, then
  # releases it after the new generation is committed.
  ./start-all.sh "$@"
fi
