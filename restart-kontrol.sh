#!/usr/bin/env bash
# Restart the committed Kontrol artifact by default. --rebuild prepares,
# validates, and activates a fresh immutable candidate before cutover.
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

# Explicit activation selector: --activate-artifact <path or releases/<buildId>>
# resumes/activates a previously prepared candidate without re-preparing.
# The value is validated as an immutable artifact by start-all.sh.
ACTIVATE_ARTIFACT_PATH=""
REBUILD_CANDIDATE=0
RESTART_INSTALLED=1
FILTERED_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --activate-artifact)
      [[ $# -ge 2 ]] || { echo "ERROR: --activate-artifact requires a path argument" >&2; exit 2; }
      ACTIVATE_ARTIFACT_PATH="$2"
      shift 2
      ;;
    --rebuild)
      REBUILD_CANDIDATE=1
      RESTART_INSTALLED=0
      shift
      ;;
    --restart-installed)
      RESTART_INSTALLED=1
      shift
      ;;
    *)
      FILTERED_ARGS+=("$1")
      shift
      ;;
  esac
done
if [[ "$REBUILD_CANDIDATE" == "1" && "$RESTART_INSTALLED" == "1" ]]; then
  echo "ERROR: --rebuild and --restart-installed are mutually exclusive." >&2
  exit 2
fi
if [[ -n "$ACTIVATE_ARTIFACT_PATH" ]]; then
  [[ "$ACTIVATE_ARTIFACT_PATH" = /* ]] || ACTIVATE_ARTIFACT_PATH="$DESKTOP_PWD/$ACTIVATE_ARTIFACT_PATH"
  export KONTROL_ACTIVATE_ARTIFACT_PATH="$ACTIVATE_ARTIFACT_PATH"
fi

DEPLOYMENT_ID="deployment-$(date +%s)-$$"
START_ARGS=("${FILTERED_ARGS[@]+"${FILTERED_ARGS[@]}"}")
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
        ./start-all.sh --activate-existing "${START_ARGS[@]+"${START_ARGS[@]}"}"; then
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
if [[ -n "$OWNER_INFO" && -n "$(json_field "$OWNER_INFO" launcher)" ]]; then
  OWNER_LAUNCHER="$(json_field "$OWNER_INFO" launcher)"
  PREVIOUS_ARTIFACT_PATH="$(json_field "$OWNER_INFO" artifactPath)"
  PREVIOUS_BUILD_ID="$(json_field "$OWNER_INFO" buildId)"
  case "$OWNER_LAUNCHER" in
    tmux-stack)
      # The deployment lock remains held by this shell across both phases.
      # start-all validates the inherited token and uses transaction-specific
      # candidate state, so a second restart cannot cross the cutover.
      if [[ -n "$ACTIVATE_ARTIFACT_PATH" ]]; then
        # Explicit artifact activation: use the exact named immutable release.
        echo "[*] Explicit artifact activation requested: $ACTIVATE_ARTIFACT_PATH" >&2
        HANDOFF_STARTED=1
        ./stop-all.sh
        KONTROL_USE_EXISTING_DIST=true ./start-all.sh --activate-existing "${START_ARGS[@]+"${START_ARGS[@]}"}"
        HANDOFF_STARTED=0
      elif [[ "$REBUILD_CANDIDATE" == "1" ]]; then
        if ! KONTROL_USE_EXISTING_DIST=false ./start-all.sh --prepare-only; then
          echo "ERROR: candidate preparation failed; the current Kontrol generation was left running." >&2
          exit 1
        fi
        PREPARED_CANDIDATE_BUILD_ID="$(json_file_field "${KONTROL_STATE_DIR}/candidate.${DEPLOYMENT_ID}.json" buildId)"
        HANDOFF_STARTED=1
        ./stop-all.sh
        KONTROL_USE_EXISTING_DIST=true ./start-all.sh --activate-existing "${START_ARGS[@]+"${START_ARGS[@]}"}"
        HANDOFF_STARTED=0
      else
        [[ -n "$PREVIOUS_ARTIFACT_PATH" ]] || { echo "ERROR: runtime.lock does not identify the installed immutable artifact." >&2; exit 1; }
        echo "[*] Restarting committed release $PREVIOUS_BUILD_ID at $PREVIOUS_ARTIFACT_PATH without rebuilding." >&2
        HANDOFF_STARTED=1
        PREPARED_CANDIDATE_BUILD_ID="$PREVIOUS_BUILD_ID"
        ./stop-all.sh
        KONTROL_USE_EXISTING_DIST=true KONTROL_ACTIVATE_ARTIFACT_PATH="$PREVIOUS_ARTIFACT_PATH" ./start-all.sh --activate-existing "${START_ARGS[@]+"${START_ARGS[@]}"}"
        HANDOFF_STARTED=0
      fi
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
  # With no live process, the committed generation record still identifies
  # the immutable release for a normal restart.
  if [[ -n "$ACTIVATE_ARTIFACT_PATH" ]]; then
    KONTROL_USE_EXISTING_DIST=true ./start-all.sh --activate-existing "${START_ARGS[@]+"${START_ARGS[@]}"}"
  elif [[ "$RESTART_INSTALLED" == "1" ]]; then
    COMMITTED_ARTIFACT_PATH="$(json_file_field "$KONTROL_STATE_DIR/generation.json" artifactPath)"
    [[ -n "$COMMITTED_ARTIFACT_PATH" ]] || { echo "ERROR: no committed immutable artifact is recorded; use the normal restart to build one." >&2; exit 1; }
    KONTROL_USE_EXISTING_DIST=true KONTROL_ACTIVATE_ARTIFACT_PATH="$COMMITTED_ARTIFACT_PATH" ./start-all.sh --activate-existing "${START_ARGS[@]+"${START_ARGS[@]}"}"
  else
    KONTROL_USE_EXISTING_DIST=false ./start-all.sh "${START_ARGS[@]+"${START_ARGS[@]}"}"
  fi
fi
