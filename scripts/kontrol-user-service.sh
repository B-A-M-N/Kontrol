#!/usr/bin/env bash
# Install and control a per-user systemd unit for the installed Kontrol core.
# This unit intentionally owns only the MCP core; the checkout stack launcher
# owns adapters/tunnel in development and cannot overlap because both paths
# use the same runtime lock.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="${KONTROL_USER_SERVICE_NAME:-kontrol-core.service}"
CONFIG_ROOT="${XDG_CONFIG_HOME:-${HOME}/.config}"
UNIT_DIR="${CONFIG_ROOT}/systemd/user"
UNIT_PATH="${UNIT_DIR}/${SERVICE_NAME}"
ENV_FILE="${KONTROL_USER_ENV_FILE:-${CONFIG_ROOT}/kontrol/environment}"

require_systemd() {
  command -v systemctl >/dev/null 2>&1 || {
    echo "ERROR: systemctl is required for the user service." >&2
    exit 1
  }
}

select_artifact() {
  local candidate_result="${KONTROL_BUILD_RESULT_PATH:-${ROOT_DIR}/.kontrol-build-result.json}"
  SELECTED_ARTIFACT_PATH=""
  if [[ -f "$candidate_result" ]]; then
    SELECTED_ARTIFACT_PATH="$(node -e 'try { process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).artifactPath || "") } catch {}' "$candidate_result")"
  fi
  if [[ -z "$SELECTED_ARTIFACT_PATH" ]]; then
    SELECTED_ARTIFACT_PATH="$(readlink -f -- "${ROOT_DIR}/dist" 2>/dev/null || true)"
  fi
  if [[ -z "$SELECTED_ARTIFACT_PATH" || ! -d "$SELECTED_ARTIFACT_PATH" || "$SELECTED_ARTIFACT_PATH" != "${ROOT_DIR}/releases/"* ]]; then
    echo "ERROR: no immutable release candidate is available (build result or dist/ must resolve under releases/<buildId>)." >&2
    return 1
  fi
  read -r SELECTED_BUILD_ID SELECTED_SCHEMA_VERSION SELECTED_MAX_SCHEMA_VERSION < <(node -e 'const fs=require("node:fs"); const meta=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(`${meta.buildId || ""} ${meta.schemaVersion ?? ""} ${meta.maxReadableSchemaVersion ?? ""}`)' "${SELECTED_ARTIFACT_PATH}/build-meta.json")
  [[ -n "$SELECTED_BUILD_ID" && "$SELECTED_SCHEMA_VERSION" =~ ^[0-9]+$ && "$SELECTED_MAX_SCHEMA_VERSION" =~ ^[0-9]+$ ]] || { echo "ERROR: immutable artifact has incomplete build/schema metadata: ${SELECTED_ARTIFACT_PATH}" >&2; return 1; }
}

write_unit() {
  mkdir -p -- "$UNIT_DIR"
  select_artifact || return 1
  local temporary="${UNIT_PATH}.tmp-$$"
  cat >"$temporary" <<EOF
[Unit]
Description=Kontrol local MCP core
After=default.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory="${ROOT_DIR}"
EnvironmentFile=-"${ENV_FILE}"
Environment=KONTROL_LAUNCHER=systemd
Environment=KONTROL_EXPECTED_BUILD_ID=${SELECTED_BUILD_ID}
Environment=KONTROL_EXPECTED_SCHEMA_VERSION=${SELECTED_SCHEMA_VERSION}
Environment=KONTROL_ARTIFACT_PATH=${SELECTED_ARTIFACT_PATH}
ExecStart=/usr/bin/env node "${SELECTED_ARTIFACT_PATH}/cli.js" serve
Restart=on-failure
RestartSec=5
KillMode=control-group
Nice=0
CPUWeight=100

[Install]
WantedBy=default.target
EOF
  mv -- "$temporary" "$UNIT_PATH"
  chmod 0644 "$UNIT_PATH"
  echo "Installed ${UNIT_PATH}"
}

load_environment() {
  [[ -f "$ENV_FILE" ]] || return 0
  set -a
  source "$ENV_FILE"
  set +a
}

wait_for_core_ready() {
  local endpoint="http://127.0.0.1:${PORT:-7676}/core-readyz"
  for _ in $(seq 1 30); do
    if curl --silent --show-error --fail --max-time 2 "$endpoint" >/dev/null 2>&1; then
      # Health alone can be satisfied by the old process during a fast unit
      # handoff. When the service has a state directory, require the identity
      # to name the exact artifact selected by this upgrade.
      if [[ -n "${KONTROL_STATE_DIR:-}" && -f "${KONTROL_STATE_DIR}/server.identity.json" ]]; then
        local active_artifact
        active_artifact="$(node -e 'try { process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).artifactPath || "") } catch {}' "${KONTROL_STATE_DIR}/server.identity.json")"
        [[ "$active_artifact" == "$SELECTED_ARTIFACT_PATH" ]] || { sleep 1; continue; }
      fi
      return 0
    fi
    sleep 1
  done
  return 1
}

command="${1:-help}"
case "$command" in
  install)
    require_systemd
    write_unit
    systemctl --user daemon-reload
    ;;
  start)
    require_systemd
    systemctl --user enable --now "$SERVICE_NAME"
    ;;
  stop)
    require_systemd
    systemctl --user stop "$SERVICE_NAME"
    ;;
  restart)
    require_systemd
    echo "Restarting the currently installed immutable Kontrol release (${SERVICE_NAME}). Use 'upgrade' to select the checkout's latest build candidate." >&2
    systemctl --user restart "$SERVICE_NAME"
    ;;
  upgrade)
    require_systemd
    [[ -f "$UNIT_PATH" ]] || { echo "ERROR: ${UNIT_PATH} is not installed; run install first." >&2; exit 1; }
    load_environment
    previous_unit="$(mktemp "${TMPDIR:-/tmp}/kontrol-user-service.XXXXXX")"
    cp -- "$UNIT_PATH" "$previous_unit"
    if ! write_unit; then
      rm -- "$previous_unit"
      exit 1
    fi
    upgrade_build_id="$SELECTED_BUILD_ID"
    if ! systemctl --user daemon-reload || ! systemctl --user restart "$SERVICE_NAME" || ! wait_for_core_ready; then
      echo "ERROR: upgraded Kontrol release ${upgrade_build_id} did not become ready; restoring the previously installed unit." >&2
      cp -- "$previous_unit" "$UNIT_PATH"
      chmod 0644 "$UNIT_PATH"
      systemctl --user daemon-reload || true
      systemctl --user restart "$SERVICE_NAME" || true
      rm -- "$previous_unit"
      exit 1
    fi
    rm -- "$previous_unit"
    echo "Upgraded ${SERVICE_NAME} to immutable build ${upgrade_build_id}."
    ;;
  status)
    require_systemd
    systemctl --user --no-pager status "$SERVICE_NAME"
    ;;
  logs)
    require_systemd
    journalctl --user -u "$SERVICE_NAME" -f
    ;;
  uninstall)
    require_systemd
    systemctl --user disable --now "$SERVICE_NAME" || true
    [[ -f "$UNIT_PATH" ]] && rm -- "$UNIT_PATH"
    systemctl --user daemon-reload
    echo "Removed ${UNIT_PATH}"
    ;;
  help|--help|-h)
    cat <<'HELP'
Usage: scripts/kontrol-user-service.sh {install|upgrade|start|stop|restart|status|logs|uninstall}

Install once, then start the Kontrol core with:
  scripts/kontrol-user-service.sh install
  scripts/kontrol-user-service.sh start

The service owns the immutable release selected at install time. It sets Nice=0,
CPUWeight=100, Restart=on-failure, KillMode=control-group, and a bounded
systemd restart budget. Environment is read from:
  ${ENV_FILE}
restart restarts that installed release. Use upgrade to select the latest
immutable build candidate (falling back to dist/); upgrade verifies core readiness and restores the
previous unit if the candidate does not become ready.
Adapters and tunnels are separate components; use start-all.sh only from a
source checkout when you need the full development stack. Do not run both
against the same state directory or port.
HELP
    ;;
  *)
    echo "Unknown command: $command" >&2
    exit 2
    ;;
esac
