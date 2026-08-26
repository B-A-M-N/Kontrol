#!/usr/bin/env bash
# Install and control a per-user systemd unit for the installed Kontrol server.
# The package service launches the built product directly; checkout-only
# orchestration remains the separate start-all.sh development path.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="${KONTROL_USER_SERVICE_NAME:-kontrol.service}"
CONFIG_ROOT="${XDG_CONFIG_HOME:-${HOME}/.config}"
UNIT_DIR="${CONFIG_ROOT}/systemd/user"
UNIT_PATH="${UNIT_DIR}/${SERVICE_NAME}"

require_systemd() {
  command -v systemctl >/dev/null 2>&1 || {
    echo "ERROR: systemctl is required for the user service." >&2
    exit 1
  }
}

write_unit() {
  mkdir -p -- "$UNIT_DIR"
  local temporary="${UNIT_PATH}.tmp-$$"
  cat >"$temporary" <<EOF
[Unit]
Description=Kontrol local MCP server
After=default.target

[Service]
Type=simple
WorkingDirectory="${ROOT_DIR}"
ExecStart=/usr/bin/env node "${ROOT_DIR}/dist/cli.js" serve
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
    systemctl --user restart "$SERVICE_NAME"
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
Usage: scripts/kontrol-user-service.sh {install|start|stop|restart|status|logs|uninstall}

Install once, then start the stack with:
  scripts/kontrol-user-service.sh install
  scripts/kontrol-user-service.sh start

The service owns the installed dist/cli.js server. It sets Nice=0,
CPUWeight=100, Restart=on-failure, and KillMode=control-group. Adapters and
tunnels are separate deployment components; use start-all.sh only from a
source checkout when you need the full development stack.
HELP
    ;;
  *)
    echo "Unknown command: $command" >&2
    exit 2
    ;;
esac
