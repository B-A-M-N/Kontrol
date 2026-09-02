#!/usr/bin/env bash
# start-all.sh — Kontrol MCP + ACP adapter + OpenAI tunnel
# Reliable daemon start via tmux. Readiness is mandatory before "BOTH UP".
# P1 #41: Transactional — track launched components and roll back on failure.
set -euo pipefail
cd "$(dirname "$0")"
DESKTOP_PWD="$PWD"
export DESKTOP_PWD

PREPARE_ONLY=0
ACTIVATE_EXISTING=0
for argument in "$@"; do
  case "$argument" in
    --prepare-only) PREPARE_ONLY=1 ;;
    --activate-existing) ACTIVATE_EXISTING=1 ;;
    *) echo "ERROR: unknown start-all.sh option: $argument" >&2; exit 2 ;;
  esac
done

# --- Source .env FIRST so all config is available ---
ENV_FILE="${KONTROL_ENV_FILE:-$DESKTOP_PWD/.env}"
[[ -f "$ENV_FILE" ]] || { echo "ERROR: environment file missing: $ENV_FILE" >&2; exit 1; }
set -a; source "$ENV_FILE"; set +a
printf -v ENV_FILE_QUOTED '%q' "$ENV_FILE"
if [[ "$ACTIVATE_EXISTING" == "1" ]]; then
  export KONTROL_USE_EXISTING_DIST=true
  export KONTROL_SKIP_PREFLIGHT_TESTS=true
elif [[ "$PREPARE_ONLY" == "1" ]]; then
  # Preparation always produces a fresh immutable candidate. The environment
  # file may have been written for a baseline that reuses dist/, but it must
  # not turn a requested transactional restart into a no-op.
  export KONTROL_USE_EXISTING_DIST=false
fi

# Recovery may be delegated to a fresh controller after the old generation has
# already been stopped. Translate the durable handoff metadata back into the
# controller's local state before any activation decisions are made.
ROLLBACK_ACTIVE="${KONTROL_ROLLBACK_ACTIVE:-${ROLLBACK_ACTIVE:-false}}"

# --- Reviewer secret required for the WebUI review loop (Nelson/Ralphie) ---
if [[ "${KONTROL_ACP_ENABLED:-true}" != "false" && -z "${KONTROL_ACP_REVIEWER_SECRET:-}" ]]; then
  echo "ERROR: KONTROL_ACP_REVIEWER_SECRET is required when ACP is enabled (the WebUI review loop needs reviewer authority)." >&2
  echo "Set it to a long random value, e.g. \`openssl rand -hex 32\`." >&2
  exit 1
fi

# --- Safety: explicit LAUNCH_DIR with cleanup trap (set -u safe) ---
LAUNCH_DIR="$(mktemp -d)"
cleanup() {
  if [[ "${RUNTIME_LOCK_OWNED:-0}" == "1" && -n "${RUNTIME_LOCK_TOKEN:-}" ]]; then
    node --import tsx src/runtime-lock.ts release --state-dir "$KONTROL_STATE_DIR" --token "$RUNTIME_LOCK_TOKEN" >/dev/null 2>&1 || true
  fi
  if [[ "${DEPLOYMENT_LOCK_OWNED:-0}" == "1" && -n "${DEPLOYMENT_LOCK_TOKEN:-}" ]]; then
    node --import tsx src/deployment-lock.ts release --state-dir "$KONTROL_STATE_DIR" --token "$DEPLOYMENT_LOCK_TOKEN" >/dev/null 2>&1 || true
  fi
  if [[ -n "${LAUNCH_DIR:-}" && -d "$LAUNCH_DIR" ]]; then
    rm -rf "$LAUNCH_DIR"
  fi
}
# --- P1 #41: Track components launched this invocation for rollback ---
LAUNCHED_SESSIONS=()
STARTUP_COMMITTED=0
ROLLBACK_IN_PROGRESS=0
ROLLBACK_SUCCEEDED=0
RECOVERY_DELEGATED=0
CANDIDATE_ACTIVATION_ATTEMPTED=0
CANDIDATE_ARTIFACT_PATH=""
CANDIDATE_BUILD_ID=""
FAILED_CANDIDATE_ARTIFACT_PATH=""
REQUESTED_BUILD_ID=""
ROLLBACK_REQUESTED_BUILD_ID="${KONTROL_ROLLBACK_REQUESTED_BUILD_ID:-}"
ROLLBACK_FAILED_BUILD_ID="${KONTROL_ROLLBACK_FAILED_BUILD_ID:-}"
ROLLBACK_REASON="${KONTROL_ROLLBACK_REASON:-}"
PREVIOUS_BUILD_ID=""
PREVIOUS_ARTIFACT_PATH=""
COMMITTED_PREVIOUS_BUILD_ID=""
COMMITTED_PREVIOUS_ARTIFACT_PATH=""
LAST_KNOWN_GOOD_BUILD_ID=""
LAST_KNOWN_GOOD_ARTIFACT_PATH=""
DATABASE_ORIGINAL_SCHEMA_VERSION=""
DATABASE_CANDIDATE_SCHEMA_VERSION=""
DATABASE_BACKUP_PATH=""
DATABASE_MIGRATION_OCCURRED="false"
DATABASE_ROLLBACK_RESTORE_REQUIRED="false"
DATABASE_RESTORED_AT=""
DATABASE_FAILED_PATH=""
ARTIFACT_SCHEMA_VERSION=""
ARTIFACT_MAX_READABLE_SCHEMA_VERSION=""
COMMITTED_GENERATION_PRESENT=0
LAUNCH_GENERATION_ID="gen-$(date +%s)-$$"
RUNTIME_LOCK_TOKEN="${KONTROL_RUNTIME_LOCK_TOKEN:-}"
RUNTIME_LOCK_OWNED=0
DEPLOYMENT_ID="${KONTROL_DEPLOYMENT_ID:-deployment-$(date +%s)-$$}"
DEPLOYMENT_LOCK_TOKEN="${KONTROL_DEPLOYMENT_LOCK_TOKEN:-}"
DEPLOYMENT_LOCK_OWNED=0
DEPLOYMENT_LOCK_VALIDATED=0
SAFE_DEPLOYMENT_ID="${DEPLOYMENT_ID//[^a-zA-Z0-9._-]/_}"
PREFLIGHT_LOG="${KONTROL_PREFLIGHT_LOG:-${TMPDIR:-/tmp}/kontrol-preflight-$(date +%Y%m%d-%H%M%S)-$$.log}"

# Resolve and claim the deployment before any build or tmux mutation. A second
# launcher must stop here instead of promoting artifacts underneath a live
# supervisor or competing for the configured MCP port.
STATE_DIR_ERROR="$LAUNCH_DIR/state-dir-error.log"
if ! EFFECTIVE_STATE_DIR="$(node --import tsx --input-type=module -e 'import { loadConfig } from "./src/config.ts"; process.stdout.write(loadConfig().stateDir)' 2>"$STATE_DIR_ERROR")"; then
  echo "ERROR: could not resolve Kontrol state directory." >&2
  [[ -s "$STATE_DIR_ERROR" ]] && cat "$STATE_DIR_ERROR" >&2 || true
  exit 1
fi
if [[ -z "$EFFECTIVE_STATE_DIR" ]]; then
  echo "ERROR: Kontrol resolved an empty state directory." >&2
  exit 1
fi
export KONTROL_STATE_DIR="$EFFECTIVE_STATE_DIR"
export KONTROL_LAUNCH_GENERATION_ID="$LAUNCH_GENERATION_ID"
DATABASE_MIGRATION_RECORD_PATH="$KONTROL_STATE_DIR/database-migration.${SAFE_DEPLOYMENT_ID}.json"

GENERATION_RECORD="$KONTROL_STATE_DIR/generation.json"
CANDIDATE_RECORD="${KONTROL_CANDIDATE_RECORD:-$KONTROL_STATE_DIR/candidate.${DEPLOYMENT_ID}.json}"
DEPLOYMENT_RECORD="${KONTROL_DEPLOYMENT_RECORD:-$KONTROL_STATE_DIR/deployment.${DEPLOYMENT_ID}.json}"
write_generation_record() {
  local status="$1" requested_build_id="$2" active_build_id="$3" rollback="$4" failed_build_id="$5" reason="$6" artifact_path="$7"
  local previous_build_id="${8:-${PREVIOUS_BUILD_ID:-}}" previous_artifact_path="${9:-${PREVIOUS_ARTIFACT_PATH:-}}"
  local last_good_build_id="${10:-${LAST_KNOWN_GOOD_BUILD_ID:-}}" last_good_artifact_path="${11:-${LAST_KNOWN_GOOD_ARTIFACT_PATH:-}}"
  node --input-type=module -e '
    import { mkdirSync, renameSync, writeFileSync } from "node:fs";
    import { dirname } from "node:path";
    const [path, status, requested, active, rollback, failed, reason, artifact, previous, previousArtifact, lastGood, lastGoodArtifact] = process.argv.slice(1);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const record = {
      status,
      requestedBuildId: requested || null,
      activeBuildId: active || null,
      rollback: rollback === "true",
      failedBuildId: failed || null,
      reason: reason || null,
      generationId: process.env.KONTROL_LAUNCH_GENERATION_ID || null,
      artifactPath: artifact || null,
      previousBuildId: previous || null,
      previousArtifactPath: previousArtifact || null,
      lastKnownGoodBuildId: lastGood || null,
      lastKnownGoodArtifactPath: lastGoodArtifact || null,
      updatedAt: new Date().toISOString(),
    };
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  ' "$GENERATION_RECORD" "$status" "$requested_build_id" "$active_build_id" "$rollback" "$failed_build_id" "$reason" "$artifact_path" "$previous_build_id" "$previous_artifact_path" "$last_good_build_id" "$last_good_artifact_path"
}

write_candidate_record() {
  local status="$1" build_id="$2" artifact_path="$3" reason="${4:-}"
  node --input-type=module -e '
    import { mkdirSync, renameSync, writeFileSync } from "node:fs";
    import { dirname } from "node:path";
    const [path, status, buildId, artifactPath, reason] = process.argv.slice(1);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const record = { status, buildId: buildId || null, artifactPath: artifactPath || null, reason: reason || null, preparedAt: new Date().toISOString() };
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  ' "$CANDIDATE_RECORD" "$status" "$build_id" "$artifact_path" "$reason"
}

write_deployment_record() {
  local status="$1" reason="${2:-}" outcome="${3:-}" \
    requested_build_id="${REQUESTED_BUILD_ID:-}" candidate_build_id="${CANDIDATE_BUILD_ID:-}" \
    candidate_artifact_path="${CANDIDATE_ARTIFACT_PATH:-}" failed_build_id="${ROLLBACK_FAILED_BUILD_ID:-}"
  node --input-type=module -e '
    import { mkdirSync, renameSync, writeFileSync } from "node:fs";
    import { dirname } from "node:path";
    const [path, deploymentId, status, reason, outcome, requested, candidate, candidateArtifact, databaseOriginal, databaseCandidate, databaseBackup, databaseMigrationOccurred, databaseRollbackRequired, databaseRestoredAt, databaseFailedPath, previous, previousArtifact, lastGood, lastGoodArtifact, failed] = process.argv.slice(1);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const record = {
      deploymentId,
      operation: process.env.KONTROL_DEPLOYMENT_OPERATION || "stack-start",
      pid: process.pid,
      status,
      outcome: outcome || null,
      reason: reason || null,
      requestedBuildId: requested || null,
      candidateBuildId: candidate || null,
      candidateArtifactPath: candidateArtifact || null,
      database: {
        originalSchemaVersion: databaseOriginal || null,
        candidateSchemaVersion: databaseCandidate || null,
        backupPath: databaseBackup || null,
        migrationOccurred: databaseMigrationOccurred === "true",
        rollbackRestoreRequired: databaseRollbackRequired === "true",
        restoredAt: databaseRestoredAt || null,
        failedDatabasePath: databaseFailedPath || null,
      },
      previousBuildId: previous || null,
      previousArtifactPath: previousArtifact || null,
      lastKnownGoodBuildId: lastGood || null,
      lastKnownGoodArtifactPath: lastGoodArtifact || null,
      failedBuildId: failed || null,
      updatedAt: new Date().toISOString(),
    };
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  ' "$DEPLOYMENT_RECORD" "$DEPLOYMENT_ID" "$status" "$reason" "$outcome" "$requested_build_id" "$candidate_build_id" "$candidate_artifact_path" "${DATABASE_ORIGINAL_SCHEMA_VERSION:-}" "${DATABASE_CANDIDATE_SCHEMA_VERSION:-}" "${DATABASE_BACKUP_PATH:-}" "${DATABASE_MIGRATION_OCCURRED:-false}" "${DATABASE_ROLLBACK_RESTORE_REQUIRED:-false}" "${DATABASE_RESTORED_AT:-}" "${DATABASE_FAILED_PATH:-}" "$PREVIOUS_BUILD_ID" "$PREVIOUS_ARTIFACT_PATH" "$LAST_KNOWN_GOOD_BUILD_ID" "$LAST_KNOWN_GOOD_ARTIFACT_PATH" "$failed_build_id"
}

read_json_field() {
  local path="$1" field="$2"
  node -e 'try { const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; if (value !== undefined && value !== null) process.stdout.write(String(value)); } catch {}' "$path" "$field"
}

read_json_text_field() {
  local json="$1" field="$2"
  node -e 'try { const value = JSON.parse(process.argv[1])[process.argv[2]]; if (value !== undefined && value !== null) process.stdout.write(String(value)); } catch {}' "$json" "$field"
}

capture_database_deployment_state() {
  local inspection
  inspection="$(node --import tsx src/db/deployment-backup.ts inspect \
    --state-dir "$KONTROL_STATE_DIR" \
    --deployment-id "$DEPLOYMENT_ID" \
    --candidate-schema-version "${DATABASE_CANDIDATE_SCHEMA_VERSION:-0}")" || {
      echo "ERROR: could not inspect the database before candidate activation." >&2
      return 1
    }
  DATABASE_ORIGINAL_SCHEMA_VERSION="$(read_json_text_field "$inspection" originalSchemaVersion)"
  DATABASE_CANDIDATE_SCHEMA_VERSION="$(read_json_text_field "$inspection" candidateSchemaVersion)"
  DATABASE_BACKUP_PATH="$(read_json_text_field "$inspection" backupPath)"
  DATABASE_ROLLBACK_RESTORE_REQUIRED="$(read_json_text_field "$inspection" rollbackRestoreRequired)"
}

load_database_migration_state() {
  local migration_state
  migration_state="$(node --import tsx src/db/deployment-backup.ts status \
    --state-dir "$KONTROL_STATE_DIR" \
    --deployment-id "$DEPLOYMENT_ID" 2>/dev/null || true)"
  [[ -n "$migration_state" ]] || return 0
  DATABASE_BACKUP_PATH="$(read_json_text_field "$migration_state" backupPath)"
  DATABASE_ORIGINAL_SCHEMA_VERSION="$(read_json_text_field "$migration_state" originalSchemaVersion)"
  DATABASE_CANDIDATE_SCHEMA_VERSION="$(read_json_text_field "$migration_state" candidateSchemaVersion)"
  DATABASE_MIGRATION_OCCURRED="$(read_json_text_field "$migration_state" migrationOccurred)"
  DATABASE_ROLLBACK_RESTORE_REQUIRED="$(read_json_text_field "$migration_state" rollbackRestoreRequired)"
  DATABASE_RESTORED_AT="$(read_json_text_field "$migration_state" restoredAt)"
  DATABASE_FAILED_PATH="$(read_json_text_field "$migration_state" failedDatabasePath)"
}

restore_database_if_needed() {
  local rollback_max rollback_original restore_result
  local restore_args=()
  rollback_max="$(read_json_field "$LAST_KNOWN_GOOD_ARTIFACT_PATH/build-meta.json" maxReadableSchemaVersion)"
  if [[ ! "$rollback_max" =~ ^[0-9]+$ ]]; then
    rollback_max="$(read_json_field "$LAST_KNOWN_GOOD_ARTIFACT_PATH/build-meta.json" schemaVersion)"
  fi
  if [[ ! "$rollback_max" =~ ^[0-9]+$ && "${DATABASE_ORIGINAL_SCHEMA_VERSION:-}" =~ ^[0-9]+$ ]]; then
    # Pre-generation releases did not publish schema compatibility metadata;
    # the captured live schema is the conservative compatibility ceiling for
    # the binary that was serving it.
    rollback_max="$DATABASE_ORIGINAL_SCHEMA_VERSION"
  fi
  rollback_original="${DATABASE_ORIGINAL_SCHEMA_VERSION:-}"
  if [[ ! "$rollback_max" =~ ^[0-9]+$ ]]; then
    echo "ERROR: last-known-good artifact has no valid maxReadableSchemaVersion: $LAST_KNOWN_GOOD_ARTIFACT_PATH" >&2
    return 1
  fi
  if [[ "$rollback_original" =~ ^[0-9]+$ ]]; then
    restore_args+=(--expected-original-schema-version "$rollback_original")
  fi
  restore_result="$(node --import tsx src/db/deployment-backup.ts restore \
    --state-dir "$KONTROL_STATE_DIR" \
    --deployment-id "$DEPLOYMENT_ID" \
    --max-readable-schema-version "$rollback_max" \
    "${restore_args[@]}")" || {
      echo "ERROR: database rollback could not verify/restore the deployment-bound backup." >&2
      return 1
    }
  DATABASE_BACKUP_PATH="$(read_json_text_field "$restore_result" backupPath)"
  DATABASE_RESTORED_AT="$(read_json_text_field "$restore_result" restoredAt)"
  DATABASE_FAILED_PATH="$(read_json_text_field "$restore_result" failedDatabasePath)"
  if [[ "$(read_json_text_field "$restore_result" restored)" == "true" ]]; then
    DATABASE_MIGRATION_OCCURRED="true"
    DATABASE_ROLLBACK_RESTORE_REQUIRED="true"
    echo "[*] Restored the exact pre-migration database backup for deployment ${DEPLOYMENT_ID}." >&2
  fi
}

resolve_artifact_path() {
  local requested_path="$1"
  local resolved_path
  resolved_path="$(readlink -f -- "$requested_path" 2>/dev/null || true)"
  if [[ -z "$resolved_path" || ! -d "$resolved_path" ]]; then
    echo "ERROR: immutable artifact does not exist: $requested_path" >&2
    return 1
  fi
  case "$resolved_path" in
    "$DESKTOP_PWD/releases/"*) ;;
    *)
      echo "ERROR: serving artifact is outside immutable releases/: $resolved_path" >&2
      return 1
      ;;
  esac
  local directory_build_id="${resolved_path##*/}"
  local metadata_build_id="$(read_json_field "$resolved_path/build-meta.json" buildId)"
  ARTIFACT_SCHEMA_VERSION="$(read_json_field "$resolved_path/build-meta.json" schemaVersion)"
  ARTIFACT_MAX_READABLE_SCHEMA_VERSION="$(read_json_field "$resolved_path/build-meta.json" maxReadableSchemaVersion)"
  if [[ -z "$metadata_build_id" || "$metadata_build_id" != "$directory_build_id" ]]; then
    echo "ERROR: immutable artifact identity mismatch (directory=$directory_build_id metadata=${metadata_build_id:-missing})." >&2
    return 1
  fi
  ACTIVE_ARTIFACT_PATH="$resolved_path"
  ARTIFACT_BUILD_ID="$metadata_build_id"
  return 0
}

resolve_dist_artifact() {
  if [[ ! -L "$DESKTOP_PWD/dist" ]]; then
    echo "ERROR: dist/ must be an immutable releases/<buildId> symlink when used as an artifact selector." >&2
    return 1
  fi
  resolve_artifact_path "$DESKTOP_PWD/dist"
}

load_committed_generation() {
  if [[ -f "$GENERATION_RECORD" ]]; then
    local committed_artifact committed_build previous_build previous_artifact last_good_build last_good_artifact
    committed_artifact="$(read_json_field "$GENERATION_RECORD" artifactPath)"
    committed_build="$(read_json_field "$GENERATION_RECORD" activeBuildId)"
    previous_build="$(read_json_field "$GENERATION_RECORD" previousBuildId)"
    previous_artifact="$(read_json_field "$GENERATION_RECORD" previousArtifactPath)"
    last_good_build="$(read_json_field "$GENERATION_RECORD" lastKnownGoodBuildId)"
    last_good_artifact="$(read_json_field "$GENERATION_RECORD" lastKnownGoodArtifactPath)"
    if [[ -n "$committed_artifact" ]] && resolve_artifact_path "$committed_artifact" >/dev/null 2>&1; then
      COMMITTED_GENERATION_PRESENT=1
      PREVIOUS_BUILD_ID="$ARTIFACT_BUILD_ID"
      PREVIOUS_ARTIFACT_PATH="$ACTIVE_ARTIFACT_PATH"
    fi
    COMMITTED_PREVIOUS_BUILD_ID="$previous_build"
    COMMITTED_PREVIOUS_ARTIFACT_PATH="$previous_artifact"
    LAST_KNOWN_GOOD_BUILD_ID="${last_good_build:-$committed_build}"
    LAST_KNOWN_GOOD_ARTIFACT_PATH="$last_good_artifact"
  fi
  # Migration path for a running pre-generation-record checkout. This is only
  # a fallback selector; build-atomic never rotates it and activation commits
  # the new release only after readiness succeeds.
  if [[ -z "$PREVIOUS_ARTIFACT_PATH" && -L "$DESKTOP_PWD/dist" ]] && resolve_dist_artifact >/dev/null 2>&1; then
    PREVIOUS_BUILD_ID="$ARTIFACT_BUILD_ID"
    PREVIOUS_ARTIFACT_PATH="$ACTIVE_ARTIFACT_PATH"
  fi
  if [[ -z "$LAST_KNOWN_GOOD_ARTIFACT_PATH" ]]; then
    LAST_KNOWN_GOOD_BUILD_ID="$PREVIOUS_BUILD_ID"
    LAST_KNOWN_GOOD_ARTIFACT_PATH="$PREVIOUS_ARTIFACT_PATH"
  fi
  return 0
}

update_dist_projection() {
  local target="$1"
  local projection="$DESKTOP_PWD/dist"
  local next_projection="${projection}.next-${BASHPID:-$$}"
  if [[ -L "$projection" || ! -e "$projection" ]]; then
    rm -f -- "$next_projection"
    ln -s -- "$target" "$next_projection"
    mv -Tf -- "$next_projection" "$projection"
    return 0
  fi
  echo "[!] dist/ is a regular directory; leaving the development projection unchanged (generation.json is authoritative)." >&2
  return 0
}

launch_generation() {
LAUNCHED_SESSIONS=()
write_deployment_record "activating" "launching immutable artifact" "" || true
DEV_HOST="${HOST:-127.0.0.1}"
DEV_PORT="${PORT:-7676}"
EXPECTED_BUILD_ID="$CANDIDATE_BUILD_ID"
export KONTROL_EXPECTED_BUILD_ID="$EXPECTED_BUILD_ID"
resolve_artifact_path "$CANDIDATE_ARTIFACT_PATH" || return 1
if [[ "$EXPECTED_BUILD_ID" != "$ARTIFACT_BUILD_ID" ]]; then
  echo "ERROR: candidate build metadata changed while selecting the immutable artifact." >&2
  return 1
fi
EXPECTED_SCHEMA_VERSION="${ARTIFACT_SCHEMA_VERSION:-${DATABASE_ORIGINAL_SCHEMA_VERSION:-0}}"
if [[ ! "$EXPECTED_SCHEMA_VERSION" =~ ^[0-9]+$ ]]; then
  echo "ERROR: candidate artifact has no valid schemaVersion." >&2
  return 1
fi
export KONTROL_EXPECTED_SCHEMA_VERSION="$EXPECTED_SCHEMA_VERSION"
if [[ "${ROLLBACK_ACTIVE:-false}" != "true" ]]; then
  REQUESTED_BUILD_ID="$EXPECTED_BUILD_ID"
fi
# A normal start/restart is allowed to activate the already-committed release
# again. The last-known-good equality check belongs only to rollback: rejecting
# it here makes a clean restart after a process crash impossible when the
# source bytes have not changed. The rollback path below still refuses to
# self-restore a failed candidate.
write_generation_record "candidate" "$REQUESTED_BUILD_ID" "" "${ROLLBACK_ACTIVE:-false}" "${ROLLBACK_ACTIVE:+$ROLLBACK_FAILED_BUILD_ID}" "${ROLLBACK_ACTIVE:+$ROLLBACK_REASON}" "$ACTIVE_ARTIFACT_PATH" "$PREVIOUS_BUILD_ID" "$PREVIOUS_ARTIFACT_PATH" "$LAST_KNOWN_GOOD_BUILD_ID" "$LAST_KNOWN_GOOD_ARTIFACT_PATH"
node --import tsx src/runtime-lock.ts update \
  --state-dir "$KONTROL_STATE_DIR" \
  --token "$RUNTIME_LOCK_TOKEN" \
  --generation-id "$LAUNCH_GENERATION_ID" \
  --build-id "$EXPECTED_BUILD_ID" \
  --artifact-path "$ACTIVE_ARTIFACT_PATH" \
  --port "$DEV_PORT"
export KONTROL_ARTIFACT_PATH="$ACTIVE_ARTIFACT_PATH"
CRUSH_ACP_PORT="${ACP_ADAPTER_PORT:-9877}"
HERMES_ACP_PORT="${HERMES_ACP_ADAPTER_PORT:-9911}"
HERMES_ACP_COMPAT_PATH="$DESKTOP_PWD/scripts/hermes-acp-compat"
SERVER_LOG="${KONTROL_SERVER_LOG:-${TMPDIR:-/tmp}/kontrol-server-$(date +%Y%m%d-%H%M%S)-$$.log}"
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
    return 1
  fi
  CRUSH_HELP="$(timeout 5 "$CRUSH_CLI_BIN" run --help 2>&1 || true)"
  if ! grep -q "Run a single prompt in non-interactive mode" <<<"$CRUSH_HELP"; then
    echo "ERROR: CRUSH_BIN does not appear to be the CRUSH CLI runner: $CRUSH_CLI_BIN" >&2
    echo "Do not use crush-acp; it is the ACP/TUI transport binary." >&2
    return 1
  fi
  if ! grep -q -- "--quiet" <<<"$CRUSH_HELP"; then
    echo "ERROR: CRUSH_BIN ($CRUSH_CLI_BIN) does not support --quiet, which the ACP adapter requires." >&2
    return 1
  fi
  export CRUSH_BIN="$CRUSH_CLI_BIN"
  echo "[*] Coding agent: CRUSH ($CRUSH_BIN)"
fi

if [[ "$START_HERMES_ADAPTER" != "false" ]]; then
  if ! command -v "${HERMES_BIN:-hermes}" >/dev/null 2>&1; then
    if [[ "$START_HERMES_ADAPTER" == "true" ]]; then
      echo "ERROR: Hermes binary not found: ${HERMES_BIN:-hermes}" >&2
      return 1
    fi
    START_HERMES_ADAPTER="false"
  elif ! PYTHONPATH="$HERMES_ACP_COMPAT_PATH:${PYTHONPATH:-}" "${HERMES_BIN:-hermes}" acp --check >/dev/null 2>&1; then
    if [[ "$START_HERMES_ADAPTER" == "true" ]]; then
      echo "ERROR: hermes acp --check failed." >&2
      return 1
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
printf -v SERVER_LOG_QUOTED '%q' "$SERVER_LOG"
printf -v GENERATION_EXPORT 'export KONTROL_LAUNCH_GENERATION_ID=%q KONTROL_EXPECTED_BUILD_ID=%q KONTROL_EXPECTED_SCHEMA_VERSION=%q KONTROL_DEPLOYMENT_ID=%q KONTROL_DEPLOYMENT_RECORD=%q KONTROL_RUNTIME_LOCK_TOKEN=%q KONTROL_ARTIFACT_PATH=%q;' "$LAUNCH_GENERATION_ID" "$EXPECTED_BUILD_ID" "$EXPECTED_SCHEMA_VERSION" "$DEPLOYMENT_ID" "$DEPLOYMENT_RECORD" "$RUNTIME_LOCK_TOKEN" "$ACTIVE_ARTIFACT_PATH"
printf -v SERVER_ARTIFACT '%q' "$ACTIVE_ARTIFACT_PATH/cli.js"
tmux new-session -d -s kontrol-server -c "$DESKTOP_PWD" "set -a && source ${ENV_FILE_QUOTED} && set +a && ${GENERATION_EXPORT} ${SERVER_AGENT_EXPORT} exec node ${SERVER_ARTIFACT} serve >>${SERVER_LOG_QUOTED} 2>&1"
LAUNCHED_SESSIONS+=("kontrol-server")
echo "[*] Kontrol server log: $SERVER_LOG"

# Mandatory: liveness + discovery before anything downstream
echo -n "[*] Waiting for kontrol to serve"
DEV_READY=0
for _ in $(seq 1 60); do
  if ! tmux has-session -t kontrol-server 2>/dev/null; then
    echo ""
    echo "ERROR: kontrol server exited before readiness." >&2
    echo "Kontrol server log: $SERVER_LOG" >&2
    if [[ -s "$SERVER_LOG" ]]; then
      tail -n 120 "$SERVER_LOG" >&2 || true
    else
      echo "(server log is empty)" >&2
    fi
    return 1
  fi
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
  echo "Kontrol server log: $SERVER_LOG" >&2
  if [[ -s "$SERVER_LOG" ]]; then
    tail -n 120 "$SERVER_LOG" >&2 || true
  else
    echo "(server log is empty; the process may still be blocked before logging)" >&2
  fi
  return 1
fi
echo " kontrol ready."

echo "[*] Probing MCP App template..."
if ! node scripts/probe-workspace-app.mjs --url "http://${DEV_HOST}:${DEV_PORT}/mcp"; then
  echo "ERROR: MCP App template probe failed. Aborting." >&2
  return 1
fi
echo "[*] MCP App template probe passed."

# --- Start managed ACP adapters ---
wait_adapter_health() {
  local name="$1" port="$2" session="$3" log_file="$4"
  echo -n "[*] Waiting for ${name} adapter readiness"
  local ok=0
  for _ in $(seq 1 30); do
    local health_response health code
    health_response=$(curl -s -w $'\n%{http_code}' --max-time 2 "http://127.0.0.1:${port}/health" 2>/dev/null || true)
    code="${health_response##*$'\n'}"
    health="${health_response%$'\n'*}"
    [[ "$code" == "$health_response" ]] && code=000
    if [[ "$code" == "200" ]] \
      && grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' <<<"$health" \
      && grep -Eq '"ready"[[:space:]]*:[[:space:]]*true' <<<"$health" \
      && grep -Eq '"reconciled"[[:space:]]*:[[:space:]]*true' <<<"$health" \
      && grep -Eq '"lifecycle"[[:space:]]*:[[:space:]]*"READY"' <<<"$health"; then
      ok=1; break
    fi
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
  tmux new-session -d -s kontrol-adapter-crush -c "$DESKTOP_PWD" "set -a && source ${ENV_FILE_QUOTED} && set +a && ${GENERATION_EXPORT} exec env ACP_AGENT_BIN=crush PORT=${CRUSH_ACP_PORT} node scripts/acp-crush-adapter.mjs > '$CRUSH_ADAPTER_LOG' 2>&1"
  LAUNCHED_SESSIONS+=("kontrol-adapter-crush")
  wait_adapter_health "CRUSH" "$CRUSH_ACP_PORT" "kontrol-adapter-crush" "$CRUSH_ADAPTER_LOG"
  smoke_adapter "CRUSH" "$CRUSH_ACP_PORT" "cli-coding-agent" "kontrol-adapter-crush"
  EXPECTED_AGENT_ARGS+=(--agent "cli-coding-agent=http://127.0.0.1:${CRUSH_ACP_PORT}")
fi

if [[ "$START_HERMES_ADAPTER" == "true" || "$START_HERMES_ADAPTER" == "auto" ]]; then
  if [[ "$START_HERMES_ADAPTER" != "false" ]]; then
    echo "[*] Starting Hermes native ACP adapter on 127.0.0.1:${HERMES_ACP_PORT} ..."
    tmux new-session -d -s kontrol-adapter-hermes -c "$DESKTOP_PWD" "set -a && source ${ENV_FILE_QUOTED} && set +a && ${GENERATION_EXPORT} exec env HERMES_ACP_ADAPTER_PORT=${HERMES_ACP_PORT} node scripts/acp-hermes-native-adapter.mjs > '$HERMES_ADAPTER_LOG' 2>&1"
    LAUNCHED_SESSIONS+=("kontrol-adapter-hermes")
    if wait_adapter_health "Hermes" "$HERMES_ACP_PORT" "kontrol-adapter-hermes" "$HERMES_ADAPTER_LOG"; then
      if ! smoke_adapter "Hermes" "$HERMES_ACP_PORT" "hermes-agent" "kontrol-adapter-hermes"; then
        if [[ "$START_HERMES_ADAPTER" == "auto" ]]; then
          echo "[!] Hermes adapter smoke failed; continuing in auto mode (set START_HERMES_ADAPTER=true to make it mandatory)"
          START_HERMES_ADAPTER="false"
          tmux kill-session -t kontrol-adapter-hermes 2>/dev/null || true
          LAUNCHED_SESSIONS=("${LAUNCHED_SESSIONS[@]/kontrol-adapter-hermes}")
        else
          return 1
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
      return 1
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
# Bash is secure-by-default and may require a human approval. A boot-time
# readiness probe cannot satisfy an interactive approval, so exercise the
# shell path only when the effective bash policy explicitly allows it. A
# per-tool rule overrides the global mode; with neither configured, the secure
# baseline is `ask`.
EFFECTIVE_BASH_POLICY="${KONTROL_POLICY_TOOL_BASH:-${KONTROL_POLICY_MODE:-ask}}"
if [[ "${EFFECTIVE_BASH_POLICY,,}" == "allow" ]]; then
  PROBE_FLAGS+=(--probe-bash)
fi
if ! node scripts/probe-kontrol-readiness.mjs \
  --url "http://${DEV_HOST}:${DEV_PORT}/mcp" \
  --workspace "$PWD" \
  "${PROBE_FLAGS[@]}" \
  "${EXPECTED_AGENT_ARGS[@]}"; then
  echo "ERROR: KONTROL readiness round-trip failed. Aborting." >&2
  return 1
fi
echo "[*] KONTROL readiness round-trip passed."

if [[ "${KONTROL_ACP_ENABLED:-true}" != "false" ]]; then
  STRICT_READY_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://${DEV_HOST}:${DEV_PORT}/readyz" 2>/dev/null || echo 000)
  if [[ "$STRICT_READY_CODE" != "200" ]]; then
    echo "ERROR: strict KONTROL /readyz did not become ready after agent registration (HTTP $STRICT_READY_CODE)." >&2
    return 1
  fi
fi

if [[ "${KONTROL_OPERATIONAL_UAT:-false}" == "true" ]]; then
  echo "[*] Running optional real-agent operational UAT..."
  if ! KONTROL_UAT_URL="http://${DEV_HOST}:${DEV_PORT}/mcp" node scripts/live-supervisor-uat.mjs; then
    echo "ERROR: operational UAT failed. Aborting." >&2
    return 1
  fi
  echo "[*] Operational UAT passed."
fi

if [[ "${KONTROL_TUNNEL_DOCTOR:-true}" != "false" ]]; then
  echo "[*] Validating tunnel-client configuration (ephemeral health listener)..."
  if ! "$DESKTOP_PWD/scripts/kontrol-tunnel.sh" --doctor; then
    echo "ERROR: tunnel-client doctor failed. Aborting." >&2
    return 1
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
  return 1
fi

echo "[*] Starting persistent component supervisor ..."
SUPERVISOR_STATUS_FILE="${KONTROL_STATE_DIR:-$DESKTOP_PWD/.kontrol-state}/supervisor-status.json"
SUPERVISOR_ARGS=(
  --root "$DESKTOP_PWD"
  --kontrol-url "http://${DEV_HOST}:${DEV_PORT}"
  --tunnel-url "http://127.0.0.1:8080"
  --status-file "$SUPERVISOR_STATUS_FILE"
  --state-dir "${KONTROL_STATE_DIR:-$DESKTOP_PWD/.kontrol-state}"
  --generation-id "$LAUNCH_GENERATION_ID"
  --expected-build-id "$EXPECTED_BUILD_ID"
  --artifact-path "$ACTIVE_ARTIFACT_PATH"
  --crush-port "$CRUSH_ACP_PORT"
  --hermes-port "$HERMES_ACP_PORT"
  --start-crush "$START_CRUSH_ADAPTER"
  --start-hermes "$([[ "$START_HERMES_ADAPTER" != "false" ]] && echo true || echo false)"
  --runtime-lock-token "$RUNTIME_LOCK_TOKEN"
)
if [[ -n "${REQUIRED_AGENT_CONFIG:-}" ]]; then
  SUPERVISOR_ARGS+=(--agents "$REQUIRED_AGENT_CONFIG")
fi
SUPERVISOR_ARGV_ESCAPED=()
for supervisor_arg in "${SUPERVISOR_ARGS[@]}"; do
  printf -v supervisor_arg_quoted '%q' "$supervisor_arg"
  SUPERVISOR_ARGV_ESCAPED+=("$supervisor_arg_quoted")
done
tmux new-session -d -s kontrol-supervisor -c "$DESKTOP_PWD" "set -a && source ${ENV_FILE_QUOTED} && set +a && exec node scripts/kontrol-supervisor.mjs ${SUPERVISOR_ARGV_ESCAPED[*]}"
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
  return 1
fi

# Transfer ownership from this bootstrap shell to the long-lived supervisor.
# Otherwise the EXIT trap would release the lock while the tmux generation
# continued running without lifecycle exclusion.
SUPERVISOR_PID="$(tmux list-panes -t kontrol-supervisor -F '#{pane_pid}' 2>/dev/null | head -n 1 || true)"
if [[ ! "$SUPERVISOR_PID" =~ ^[0-9]+$ ]]; then
  echo "ERROR: could not identify the persistent supervisor process for lock handoff." >&2
  return 1
fi
node --import tsx src/runtime-lock.ts update \
  --state-dir "$KONTROL_STATE_DIR" \
  --token "$RUNTIME_LOCK_TOKEN" \
  --launcher-pid "$SUPERVISOR_PID"
RUNTIME_LOCK_OWNED=0

# All components are healthy. Commit the generation only now. dist/ is merely
# a convenience projection; the immutable artifact path in generation.json
# and the supervisor arguments are the serving authority.
load_database_migration_state
update_dist_projection "$ACTIVE_ARTIFACT_PATH"
if [[ "${ROLLBACK_ACTIVE:-false}" == "true" ]]; then
  write_generation_record "rolled_back" "$ROLLBACK_REQUESTED_BUILD_ID" "$EXPECTED_BUILD_ID" "true" "$ROLLBACK_FAILED_BUILD_ID" "$ROLLBACK_REASON" "$ACTIVE_ARTIFACT_PATH" "$COMMITTED_PREVIOUS_BUILD_ID" "$COMMITTED_PREVIOUS_ARTIFACT_PATH" "$EXPECTED_BUILD_ID" "$ACTIVE_ARTIFACT_PATH"
else
  write_generation_record "active" "$EXPECTED_BUILD_ID" "$EXPECTED_BUILD_ID" "false" "" "" "$ACTIVE_ARTIFACT_PATH" "$PREVIOUS_BUILD_ID" "$PREVIOUS_ARTIFACT_PATH" "$EXPECTED_BUILD_ID" "$ACTIVE_ARTIFACT_PATH"
fi
rm -f -- "$CANDIDATE_RECORD"
if [[ "${ROLLBACK_ACTIVE:-false}" == "true" ]]; then
  write_deployment_record "committed" "$ROLLBACK_REASON" "rolled_back" || true
else
  write_deployment_record "committed" "candidate passed readiness and became the active generation" "active" || true
fi
STARTUP_COMMITTED=1

  echo ""
  if [[ "${ROLLBACK_ACTIVE:-false}" == "true" ]]; then
    echo "=== KONTROL READY — ROLLED BACK ==="
    echo "  candidate: ${ROLLBACK_FAILED_BUILD_ID}"
    echo "  active:    ${EXPECTED_BUILD_ID}"
    echo "  reason:    ${ROLLBACK_REASON}"
  else
    echo "=== KONTROL READY (tunnel, MCP round-trip, configured agents verified) ==="
  fi
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
}

load_committed_generation

# restart-kontrol.sh stops the old tmux generation only after preparation, then
# enters this controller in activation mode. Mark that handoff as recoverable
# before reading the candidate record so a missing/corrupt record can still
# boot the committed last-known-good artifact after the stop.
if [[ "$ACTIVATE_EXISTING" == "1" ]]; then
  CANDIDATE_ACTIVATION_ATTEMPTED=1
  # Load the prepared candidate before runtime ownership acquisition. If the
  # post-stop handoff fails at this boundary, rollback records must still name
  # the actual failed candidate rather than an unhelpful "unknown" placeholder.
  if [[ -n "${KONTROL_ACTIVATE_ARTIFACT_PATH:-}" ]]; then
    CANDIDATE_ARTIFACT_PATH="$KONTROL_ACTIVATE_ARTIFACT_PATH"
    if resolve_artifact_path "$CANDIDATE_ARTIFACT_PATH" >/dev/null 2>&1; then
      CANDIDATE_BUILD_ID="$ARTIFACT_BUILD_ID"
      REQUESTED_BUILD_ID="${KONTROL_ROLLBACK_REQUESTED_BUILD_ID:-$CANDIDATE_BUILD_ID}"
    fi
  elif [[ -f "$CANDIDATE_RECORD" ]]; then
    CANDIDATE_BUILD_ID="$(read_json_field "$CANDIDATE_RECORD" buildId)"
    CANDIDATE_ARTIFACT_PATH="$(read_json_field "$CANDIDATE_RECORD" artifactPath)"
    if [[ -n "$CANDIDATE_BUILD_ID" && -n "$CANDIDATE_ARTIFACT_PATH" ]] && resolve_artifact_path "$CANDIDATE_ARTIFACT_PATH" >/dev/null 2>&1; then
      REQUESTED_BUILD_ID="$CANDIDATE_BUILD_ID"
    fi
  fi
fi

runtime_owner_info() {
  node --import tsx --input-type=module -e '
    import { isRuntimeLockLive, readRuntimeLock } from "./src/runtime-lock.ts";
    const lock = readRuntimeLock(process.env.KONTROL_STATE_DIR);
    if (lock && isRuntimeLockLive(lock)) process.stdout.write(JSON.stringify(lock));
  ' 2>/dev/null || true
}

deployment_lock_is_owned() {
  [[ -n "${DEPLOYMENT_LOCK_TOKEN:-}" ]] || return 1
  KONTROL_DEPLOYMENT_LOCK_TOKEN="$DEPLOYMENT_LOCK_TOKEN" node --import tsx --input-type=module -e '
    import { isDeploymentLockLive, readDeploymentLock } from "./src/deployment-lock.ts";
    const lock = readDeploymentLock(process.env.KONTROL_STATE_DIR);
    if (lock?.token === process.env.KONTROL_DEPLOYMENT_LOCK_TOKEN && isDeploymentLockLive(lock)) process.exit(0);
    process.exit(1);
  ' >/dev/null 2>&1
}

release_owned_deployment_lock() {
  if [[ "${DEPLOYMENT_LOCK_OWNED:-0}" == "1" && -n "${DEPLOYMENT_LOCK_TOKEN:-}" ]]; then
    node --import tsx src/deployment-lock.ts release \
      --state-dir "$KONTROL_STATE_DIR" \
      --token "$DEPLOYMENT_LOCK_TOKEN" >/dev/null 2>&1 || true
    DEPLOYMENT_LOCK_OWNED=0
  fi
}

ensure_runtime_lock_for_recovery() {
  if [[ -n "$RUNTIME_LOCK_TOKEN" ]] && node --import tsx src/runtime-lock.ts check --state-dir "$KONTROL_STATE_DIR" --token "$RUNTIME_LOCK_TOKEN" >/dev/null 2>&1; then
    RUNTIME_LOCK_OWNED=1
    export KONTROL_RUNTIME_LOCK_TOKEN="$RUNTIME_LOCK_TOKEN"
    return 0
  fi
  RUNTIME_LOCK_TOKEN=""
  local live_owner
  live_owner="$(runtime_owner_info)"
  if [[ -n "$live_owner" ]]; then
    echo "ERROR: cannot take recovery ownership because another live generation owns runtime.lock: $live_owner" >&2
    return 1
  fi
  RUNTIME_LOCK_TOKEN="$(node --import tsx src/runtime-lock.ts acquire \
    --state-dir "$KONTROL_STATE_DIR" \
    --launcher tmux-stack \
    --launcher-pid "$$" \
    --generation-id "$LAUNCH_GENERATION_ID" \
    --build-id pending \
    --artifact-path "$DESKTOP_PWD/dist" \
    --port "${PORT:-7676}")" || return 1
  export RUNTIME_LOCK_TOKEN
  export KONTROL_RUNTIME_LOCK_TOKEN="$RUNTIME_LOCK_TOKEN"
  RUNTIME_LOCK_OWNED=1
}

rollback() {
  if [[ "$STARTUP_COMMITTED" == "1" ]]; then
    return 0
  fi
  echo "[!] Rolling back launched components..." >&2
  write_deployment_record "rolling_back" "candidate activation did not reach committed readiness" "" || true
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
  if [[ "$ROLLBACK_IN_PROGRESS" == "0" && "$CANDIDATE_ACTIVATION_ATTEMPTED" == "1" && -n "$LAST_KNOWN_GOOD_ARTIFACT_PATH" && "${KONTROL_ROLLBACK_ATTEMPT:-false}" != "true" ]]; then
    ROLLBACK_IN_PROGRESS=1
    ROLLBACK_REQUESTED_BUILD_ID="${ROLLBACK_REQUESTED_BUILD_ID:-${REQUESTED_BUILD_ID:-unknown}}"
    ROLLBACK_FAILED_BUILD_ID="${ROLLBACK_FAILED_BUILD_ID:-${REQUESTED_BUILD_ID:-unknown}}"
    ROLLBACK_REASON="${ROLLBACK_REASON:-candidate generation failed before startup committed; restored last committed known-good release}"
    echo "[*] Restoring previous known-good build generation..." >&2
    FAILED_CANDIDATE_ARTIFACT_PATH="$CANDIDATE_ARTIFACT_PATH"
    write_candidate_record "failed" "$ROLLBACK_FAILED_BUILD_ID" "$FAILED_CANDIDATE_ARTIFACT_PATH" "$ROLLBACK_REASON" || true
    if [[ "$LAST_KNOWN_GOOD_ARTIFACT_PATH" == "$CANDIDATE_ARTIFACT_PATH" ]]; then
      echo "ERROR: rollback invariant violated: last-known-good artifact equals failed candidate ($LAST_KNOWN_GOOD_ARTIFACT_PATH)." >&2
      write_generation_record "failed" "$ROLLBACK_REQUESTED_BUILD_ID" "" "true" "$ROLLBACK_FAILED_BUILD_ID" "rollback target equals failed candidate; refusing self-rollback" "$CANDIDATE_ARTIFACT_PATH" "$COMMITTED_PREVIOUS_BUILD_ID" "$COMMITTED_PREVIOUS_ARTIFACT_PATH" "$COMMITTED_PREVIOUS_BUILD_ID" "$COMMITTED_PREVIOUS_ARTIFACT_PATH" || true
      return
    fi
    echo "[*] Failed candidate retained at ${CANDIDATE_ARTIFACT_PATH}" >&2
    # A newer candidate may have migrated the live DB before a later readiness
    # check failed. Restore the transaction-bound pre-migration image before
    # asking the older last-known-good binary to open it.
    if ! restore_database_if_needed; then
      echo "ERROR: refusing to launch the previous generation against an incompatible or unverified database." >&2
      write_generation_record "failed" "$ROLLBACK_REQUESTED_BUILD_ID" "" "true" "$ROLLBACK_FAILED_BUILD_ID" "database rollback could not be verified" "$LAST_KNOWN_GOOD_ARTIFACT_PATH" "$COMMITTED_PREVIOUS_BUILD_ID" "$COMMITTED_PREVIOUS_ARTIFACT_PATH" "$COMMITTED_PREVIOUS_BUILD_ID" "$COMMITTED_PREVIOUS_ARTIFACT_PATH" || true
      return
    fi
    load_database_migration_state
    write_deployment_record "rolling_back" "database compatibility checked before previous-generation launch" "" || true
    # Re-enter the same lifecycle controller with the durable committed
    # artifact. The failed release is never made the rollback pointer.
    LAUNCHED_SESSIONS=()
    ROLLBACK_ACTIVE=true
    CANDIDATE_ARTIFACT_PATH="$LAST_KNOWN_GOOD_ARTIFACT_PATH"
    CANDIDATE_BUILD_ID="$LAST_KNOWN_GOOD_BUILD_ID"
    if ! ensure_runtime_lock_for_recovery; then
      echo "ERROR: recovery could not establish runtime ownership; no generation was started by this controller." >&2
      write_generation_record "failed" "$ROLLBACK_REQUESTED_BUILD_ID" "" "true" "$ROLLBACK_FAILED_BUILD_ID" "recovery could not establish runtime ownership" "$LAST_KNOWN_GOOD_ARTIFACT_PATH" "$COMMITTED_PREVIOUS_BUILD_ID" "$COMMITTED_PREVIOUS_ARTIFACT_PATH" "$COMMITTED_PREVIOUS_BUILD_ID" "$COMMITTED_PREVIOUS_ARTIFACT_PATH" || true
      return
    fi
    if launch_generation; then
      ROLLBACK_SUCCEEDED=1
    else
      echo "ERROR: restored Kontrol generation did not become ready." >&2
      stop_owned_sessions 2>/dev/null || true
      write_generation_record "failed" "$ROLLBACK_REQUESTED_BUILD_ID" "" "true" "$ROLLBACK_FAILED_BUILD_ID" "rollback generation failed readiness" "$LAST_KNOWN_GOOD_ARTIFACT_PATH" "$COMMITTED_PREVIOUS_BUILD_ID" "$COMMITTED_PREVIOUS_ARTIFACT_PATH" "$COMMITTED_PREVIOUS_BUILD_ID" "$COMMITTED_PREVIOUS_ARTIFACT_PATH" || true
    fi
  elif [[ "$ROLLBACK_IN_PROGRESS" == "0" && "$CANDIDATE_ACTIVATION_ATTEMPTED" == "1" ]]; then
    write_generation_record "failed" "${REQUESTED_BUILD_ID:-unknown}" "" "false" "${REQUESTED_BUILD_ID:-unknown}" "candidate generation failed and no previous immutable release was available" "$CANDIDATE_ARTIFACT_PATH" "$COMMITTED_PREVIOUS_BUILD_ID" "$COMMITTED_PREVIOUS_ARTIFACT_PATH" "" "" || true
  fi
}

on_exit() {
  local status=$?
  if [[ "$PREPARE_ONLY" == "1" ]]; then
    if [[ "$status" != "0" ]]; then
      write_deployment_record "failed" "candidate preparation failed before activation" "failed" || true
    fi
    cleanup
    trap - EXIT
    exit "$status"
  fi
  if [[ "$STARTUP_COMMITTED" != "1" && "$DEPLOYMENT_LOCK_VALIDATED" == "1" && ("$CANDIDATE_ACTIVATION_ATTEMPTED" == "1" || "${#LAUNCHED_SESSIONS[@]}" -gt 0 || "$RUNTIME_LOCK_OWNED" == "1") ]]; then
    rollback
    if [[ "$ROLLBACK_SUCCEEDED" == "1" ]]; then status=0; fi
  fi
  if [[ "$status" != "0" && "$STARTUP_COMMITTED" != "1" ]]; then
    write_deployment_record "failed" "deployment exited without a committed healthy generation" "failed" || true
  fi
  cleanup
  trap - EXIT
  exit "$status"
}
trap on_exit EXIT

# A deployment lock serializes controllers across the entire candidate
# transaction. It is deliberately separate from runtime.lock: preparation may
# proceed while the current generation continues serving, but two controllers
# must never prepare, stop, or activate against shared generation state at once.
if [[ -n "$DEPLOYMENT_LOCK_TOKEN" ]]; then
  if ! node --import tsx src/deployment-lock.ts check \
      --state-dir "$KONTROL_STATE_DIR" \
      --token "$DEPLOYMENT_LOCK_TOKEN"; then
    # A transient check-command failure is safe to retry when the durable
    # record still names this live transaction. Do not delegate in that case:
    # the parent controller still owns the cutover lock.
    if deployment_lock_is_owned; then
      echo "[!] Deployment-lock check command failed transiently; the live transaction record is still owned by this controller, continuing." >&2
    elif [[ "$ACTIVATE_EXISTING" == "1" && -n "$LAST_KNOWN_GOOD_ARTIFACT_PATH" && "${KONTROL_RECOVERY_DELEGATED:-false}" != "true" ]]; then
      # The deployment lock may have disappeared after the old generation was
      # stopped. The launch function is already defined, so keep recovery in
      # this lifecycle controller instead of recursively invoking start-all.
      echo "[!] Deployment ownership was lost during activation; invoking in-process rollback." >&2
      DEPLOYMENT_LOCK_VALIDATED=1
      rollback
      [[ "$ROLLBACK_SUCCEEDED" == "1" ]] && exit 0
      exit 1
    fi
    if ! deployment_lock_is_owned; then
      exit 1
    fi
  fi
  DEPLOYMENT_LOCK_VALIDATED=1
else
  DEPLOYMENT_LOCK_TOKEN="$(node --import tsx src/deployment-lock.ts acquire \
    --state-dir "$KONTROL_STATE_DIR" \
    --operation "$([[ "$PREPARE_ONLY" == "1" ]] && echo prepare || echo activate)" \
    --deployment-id "$DEPLOYMENT_ID" \
    --pid "$$")"
  export DEPLOYMENT_LOCK_TOKEN
  export KONTROL_DEPLOYMENT_LOCK_TOKEN="$DEPLOYMENT_LOCK_TOKEN"
  export KONTROL_DEPLOYMENT_ID="$DEPLOYMENT_ID"
  DEPLOYMENT_LOCK_OWNED=1
  DEPLOYMENT_LOCK_VALIDATED=1
fi
export KONTROL_DEPLOYMENT_ID="$DEPLOYMENT_ID"
export KONTROL_DEPLOYMENT_OPERATION="$([[ "$PREPARE_ONLY" == "1" ]] && echo prepare || echo activate)"
write_deployment_record "preparing" "deployment controller owns the transaction" "" || true

# runtime.lock is the serving-owner lock. In activation mode this check is
# intentionally after the recovery trap: restart-kontrol.sh has stopped the
# old generation, so any failure here must be able to re-acquire ownership and
# restore the exact committed release before exiting.
if [[ "$PREPARE_ONLY" == "1" ]]; then
  echo "[*] Preparing an immutable candidate without changing the live generation."
else
  if [[ -n "$RUNTIME_LOCK_TOKEN" ]]; then
    node --import tsx src/runtime-lock.ts check --state-dir "$KONTROL_STATE_DIR" --token "$RUNTIME_LOCK_TOKEN"
  else
    RUNTIME_LOCK_LAUNCHER="tmux-stack"
    if ! RUNTIME_LOCK_TOKEN="$(node --import tsx src/runtime-lock.ts acquire \
      --state-dir "$KONTROL_STATE_DIR" \
      --launcher "$RUNTIME_LOCK_LAUNCHER" \
      --launcher-pid "$$" \
      --generation-id "$LAUNCH_GENERATION_ID" \
      --build-id pending \
      --artifact-path "$DESKTOP_PWD/dist" \
      --port "${PORT:-7676}")"; then
      if [[ "$CANDIDATE_ACTIVATION_ATTEMPTED" == "1" && -n "$LAST_KNOWN_GOOD_ARTIFACT_PATH" && "${KONTROL_RECOVERY_DELEGATED:-false}" != "true" ]]; then
        # Keep this post-stop failure in the same controller. on_exit will
        # invoke rollback using the exact committed release.
        echo "[!] Runtime ownership acquisition failed; invoking in-process rollback." >&2
        exit 1
      fi
      exit 1
      fi
      export RUNTIME_LOCK_TOKEN
      export KONTROL_RUNTIME_LOCK_TOKEN="$RUNTIME_LOCK_TOKEN"
      RUNTIME_LOCK_OWNED=1
    fi
  echo "[*] Kontrol state: $KONTROL_STATE_DIR"
fi

# --- Preflight: refuse to launch with broken source ---
if [[ "$ACTIVATE_EXISTING" == "1" && -n "${KONTROL_ACTIVATE_ARTIFACT_PATH:-}" ]]; then
  CANDIDATE_ARTIFACT_PATH="$KONTROL_ACTIVATE_ARTIFACT_PATH"
  resolve_artifact_path "$CANDIDATE_ARTIFACT_PATH" >/dev/null || exit 1
  CANDIDATE_BUILD_ID="$ARTIFACT_BUILD_ID"
  echo "[*] Activating explicitly selected immutable release ${CANDIDATE_BUILD_ID} at ${CANDIDATE_ARTIFACT_PATH}."
elif [[ "$ACTIVATE_EXISTING" == "1" ]]; then
  echo "[*] Activating the previously prepared immutable release; preflight/build already passed."
else
  echo "[*] Preflight: syntax-checking, typechecking, testing, building..."
  if ! node --check scripts/acp-crush-adapter.mjs; then
    echo "ERROR: acp-crush-adapter.mjs failed syntax check. Aborting." >&2
    exit 1
  fi
  if ! node --check scripts/acp-hermes-native-adapter.mjs; then
    echo "ERROR: acp-hermes-native-adapter.mjs failed syntax check. Aborting." >&2
    exit 1
  fi
  if ! node --check scripts/kontrol-supervisor.mjs; then
    echo "ERROR: kontrol-supervisor.mjs failed syntax check. Aborting." >&2
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
fi

# P2 #28: startup profiles. KONTROL_STARTUP_PROFILE selects how much preflight
# runs: dev-fast (typecheck+build, no full test suite), normal (typecheck +
# full unit suite + build), release (everything plus the dirty-checkout guard,
# i.e. KONTROL_RELEASE_MODE=true). Development startup defaults to dev-fast so
# a routine reconnect does not run the entire test suite; use normal/release
# explicitly for the full gate. Legacy env vars are still honored.
STARTUP_PROFILE="${KONTROL_STARTUP_PROFILE:-}"
if [[ -z "$STARTUP_PROFILE" ]]; then
  if [[ "${KONTROL_RELEASE_MODE:-false}" == "true" ]]; then STARTUP_PROFILE="release";
  elif [[ "${KONTROL_SKIP_PREFLIGHT_TESTS:-false}" == "true" || "${KONTROL_USE_EXISTING_DIST:-false}" == "true" ]]; then STARTUP_PROFILE="dev-fast";
  else STARTUP_PROFILE="dev-fast"; fi
fi
case "$STARTUP_PROFILE" in
  release|normal|dev-fast) ;;
  *) echo "ERROR: unknown KONTROL_STARTUP_PROFILE '$STARTUP_PROFILE' (expected release|normal|dev-fast)." >&2; exit 1 ;;
esac
echo "[*] Startup profile: $STARTUP_PROFILE"

if [[ "$STARTUP_PROFILE" == "release" ]]; then
  # The profile is the authoritative release selector. Set the legacy guard
  # variable too so the dirty-check below cannot be bypassed by selecting the
  # profile instead of the older environment flag.
  export KONTROL_RELEASE_MODE=true
  export KONTROL_SKIP_PREFLIGHT_TESTS=false
elif [[ "$STARTUP_PROFILE" == "dev-fast" ]]; then
  export KONTROL_SKIP_PREFLIGHT_TESTS=true
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
if [[ "$ACTIVATE_EXISTING" == "1" ]]; then
  # This mode is entered only after restart-kontrol.sh completed candidate
  # preparation. The candidate record is separate from generation.json, so a
  # failed activation cannot replace the committed active/last-good record.
  if [[ -n "${KONTROL_ACTIVATE_ARTIFACT_PATH:-}" ]]; then
    CANDIDATE_ARTIFACT_PATH="$KONTROL_ACTIVATE_ARTIFACT_PATH"
    resolve_artifact_path "$CANDIDATE_ARTIFACT_PATH" >/dev/null || exit 1
    CANDIDATE_BUILD_ID="$ARTIFACT_BUILD_ID"
    echo "[*] Activating explicitly selected immutable release ${CANDIDATE_BUILD_ID} at ${CANDIDATE_ARTIFACT_PATH}."
  else
    [[ -f "$CANDIDATE_RECORD" ]] || { echo "ERROR: no prepared candidate record at $CANDIDATE_RECORD" >&2; exit 1; }
    CANDIDATE_BUILD_ID="$(read_json_field "$CANDIDATE_RECORD" buildId)"
    CANDIDATE_ARTIFACT_PATH="$(read_json_field "$CANDIDATE_RECORD" artifactPath)"
    [[ -n "$CANDIDATE_BUILD_ID" && -n "$CANDIDATE_ARTIFACT_PATH" ]] || { echo "ERROR: prepared candidate record is incomplete: $CANDIDATE_RECORD" >&2; exit 1; }
    resolve_artifact_path "$CANDIDATE_ARTIFACT_PATH" >/dev/null || exit 1
    [[ "$CANDIDATE_BUILD_ID" == "$ARTIFACT_BUILD_ID" ]] || { echo "ERROR: prepared candidate identity mismatch." >&2; exit 1; }
    echo "[*] Activating prepared immutable candidate ${CANDIDATE_BUILD_ID} at ${CANDIDATE_ARTIFACT_PATH}."
  fi
elif [[ "${KONTROL_USE_EXISTING_DIST:-false}" == "true" ]]; then
  resolve_dist_artifact || exit 1
  CANDIDATE_BUILD_ID="$ARTIFACT_BUILD_ID"
  CANDIDATE_ARTIFACT_PATH="$ACTIVE_ARTIFACT_PATH"
  echo "[*] Reusing previously validated immutable release ${CANDIDATE_BUILD_ID}."
else
  echo "[*] Building an immutable candidate (active generation remains untouched)..."
  if [[ "$PREPARE_ONLY" == "1" ]]; then
    BUILD_RESULT_PATH="${KONTROL_BUILD_RESULT_PATH:-$KONTROL_STATE_DIR/build-result.${DEPLOYMENT_ID}.json}"
  else
    BUILD_RESULT_PATH="$LAUNCH_DIR/build-result.json"
  fi
  export KONTROL_BUILD_RESULT_PATH="$BUILD_RESULT_PATH"
  npm run build
  [[ -f "$BUILD_RESULT_PATH" ]] || { echo "ERROR: atomic build produced no candidate result: $BUILD_RESULT_PATH" >&2; exit 1; }
  CANDIDATE_BUILD_ID="$(read_json_field "$BUILD_RESULT_PATH" buildId)"
  CANDIDATE_ARTIFACT_PATH="$(read_json_field "$BUILD_RESULT_PATH" artifactPath)"
  [[ -n "$CANDIDATE_BUILD_ID" && -n "$CANDIDATE_ARTIFACT_PATH" ]] || { echo "ERROR: atomic build result is incomplete: $BUILD_RESULT_PATH" >&2; exit 1; }
  resolve_artifact_path "$CANDIDATE_ARTIFACT_PATH" >/dev/null || exit 1
  [[ "$CANDIDATE_BUILD_ID" == "$ARTIFACT_BUILD_ID" ]] || { echo "ERROR: candidate build result identity mismatch." >&2; exit 1; }
  echo "[*] Validating candidate module closure and booting it on an isolated port..."
  node scripts/probe-release.mjs --boot "$CANDIDATE_ARTIFACT_PATH"
fi
write_candidate_record "prepared" "$CANDIDATE_BUILD_ID" "$CANDIDATE_ARTIFACT_PATH"
write_deployment_record "prepared" "immutable candidate passed preflight and isolated boot" "" || true
echo "[*] Preflight + build passed."

if [[ "$PREPARE_ONLY" == "1" ]]; then
  echo "[*] Candidate prepared: build=${CANDIDATE_BUILD_ID} artifact=${CANDIDATE_ARTIFACT_PATH}"
  STARTUP_COMMITTED=1
  exit 0
fi

CANDIDATE_ACTIVATION_ATTEMPTED=1
if [[ "${ROLLBACK_ACTIVE:-false}" != "true" ]]; then
  DATABASE_CANDIDATE_SCHEMA_VERSION="${ARTIFACT_SCHEMA_VERSION:-0}"
  capture_database_deployment_state
fi
load_database_migration_state
write_deployment_record "stopping" "candidate is prepared; stopping the previous generation" "" || true

# --- Graceful stop: signal, wait, escalate (P1 #42: only our own sessions) ---
echo "[*] Stopping any stale processes (graceful first)..."
STALE_SESSIONS=("kontrol-adapter" "kontrol-adapter-crush" "kontrol-adapter-hermes" "kontrol-server" "kontrol-tunnel" "kontrol-supervisor")

stop_owned_sessions() {
  local session
  for session in "${STALE_SESSIONS[@]}"; do
    if tmux has-session -t "$session" 2>/dev/null; then
      tmux send-keys -t "$session" C-c 2>/dev/null || true
    fi
  done
  sleep 2
  for session in "${STALE_SESSIONS[@]}"; do
    if tmux has-session -t "$session" 2>/dev/null; then
      tmux kill-session -t "$session" 2>/dev/null || true
    fi
  done
}

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

launch_generation
