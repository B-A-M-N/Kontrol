#!/usr/bin/env bash
# stop-all.sh — stop whichever Kontrol-owned stack is active.
#
# Backend resolution is delegated to src/lifecycle-cli.ts (the executable
# face of src/lifecycle-coordinator.ts): tmux sessions are stopped here
# with exact-match selectors, and an active systemd stack is stopped through
# the coordinator so every managed component — not just the core — drains.
# The script exits nonzero when anything in the requested scope survives.
#
# Flags (verification covers exactly the requested scope):
#   --tmux-only     stop tmux sessions only, ignore a systemd stack
#   --systemd-only  stop the systemd stack only, ignore tmux sessions
#   --core-only     stop only the core (kontrol-server session / core unit)
set -u
cd "$(dirname "$0")"

TMUX_ONLY=0
SYSTEMD_ONLY=0
CORE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --tmux-only) TMUX_ONLY=1 ;;
    --systemd-only) SYSTEMD_ONLY=1 ;;
    --core-only) CORE_ONLY=1 ;;
    -h|--help)
      echo "Usage: $0 [--tmux-only] [--systemd-only] [--core-only]"
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg" >&2
      echo "Usage: $0 [--tmux-only] [--systemd-only] [--core-only]" >&2
      exit 1
      ;;
  esac
done

if [[ "$TMUX_ONLY" == "1" && "$SYSTEMD_ONLY" == "1" ]]; then
  echo "ERROR: --tmux-only and --systemd-only are mutually exclusive." >&2
  exit 1
fi

# Canonical owned tmux sessions (mirrors MANAGED_TMUX_SESSIONS in
# src/lifecycle-coordinator.ts; lifecycle-coordinator.test.ts asserts they
# match). Exact-match selectors (=name) below guarantee we never signal an
# unrelated session by prefix collision.
SESSIONS=("kontrol-server" "kontrol-tunnel" "kontrol-supervisor" "kontrol-adapter" "kontrol-adapter-crush" "kontrol-adapter-hermes" "kontrol-adapter-muse" "kontrol-adapter-musefi" "kontrol-beta-soak")
if [[ "$CORE_ONLY" == "1" ]]; then
  SESSIONS=("kontrol-server")
fi

# Core systemd unit (mirrors the serviceName default in src/service.ts).
CORE_UNIT="${KONTROL_USER_SERVICE_NAME:-kontrol-core.service}"

# Per-invocation scratch only: mktemp under TMPDIR plus an EXIT trap, so
# concurrent invocations never share a file and the checkout stays clean.
# Nothing is sourced from a path another process could be writing.
SCRATCH_DIR="$(mktemp -d "${TMPDIR:-/tmp}/stop-all.XXXXXX")"
trap 'rm -rf "$SCRATCH_DIR"' EXIT
BACKEND_ENV="$SCRATCH_DIR/backend.env"
VERIFY_ENV="$SCRATCH_DIR/verify.env"

BACKEND="unknown"
if [[ "$TMUX_ONLY" == "1" ]]; then
  BACKEND="tmux"
elif [[ "$SYSTEMD_ONLY" == "1" ]]; then
  BACKEND="systemd"
elif node --import tsx src/lifecycle-cli.ts resolve-backend --format=shell >"$BACKEND_ENV" 2>"$BACKEND_ENV.err"; then
  # shellcheck disable=SC1091
  . "$BACKEND_ENV"
  BACKEND="${LIFECYCLE_BACKEND:-unknown}"
else
  echo "[!] Backend resolution failed; cannot prove which stack owns the deployment." >&2
  cat "$BACKEND_ENV.err" 2>/dev/null >&2 || true
  exit 1
fi

case "$BACKEND" in
  tmux|systemd|mixed|none) ;;
  *)
    echo "[!] Unexpected backend resolution: $BACKEND" >&2
    exit 1
    ;;
esac

echo "[*] Stopping Kontrol stack (backend: $BACKEND)..."

stop_tmux_sessions() {
  local any=0
  for s in "${SESSIONS[@]}"; do
    if tmux has-session -t "=$s" 2>/dev/null; then
      any=1
      echo "  - Sending SIGINT to $s"
      tmux send-keys -t "=$s" C-c 2>/dev/null || true
    fi
  done
  if [[ "$any" == "0" ]]; then
    echo "  - No owned tmux sessions found."
    return 0
  fi

  echo -n "[*] Waiting for graceful exit"
  local graceful=0
  for _ in $(seq 1 10); do
    local alive=0
    for s in "${SESSIONS[@]}"; do
      if tmux has-session -t "=$s" 2>/dev/null; then
        alive=1
        break
      fi
    done
    if [[ "$alive" == "0" ]]; then
      graceful=1
      break
    fi
    echo -n "."
    sleep 1
  done
  echo ""

  for s in "${SESSIONS[@]}"; do
    if tmux has-session -t "=$s" 2>/dev/null; then
      echo "  - Escalating: killing $s"
      tmux kill-session -t "=$s" 2>/dev/null || true
    fi
  done
}

FAILURES=0

if [[ "$BACKEND" == "tmux" || "$BACKEND" == "mixed" ]] && [[ "$SYSTEMD_ONLY" == "0" ]]; then
  stop_tmux_sessions
fi

# An active systemd stack is stopped through the coordinator so the whole
# configured component set (core + tunnel + adapters + target) drains in
# reverse dependency order — never just the core.
if [[ "$BACKEND" == "systemd" || "$BACKEND" == "mixed" ]] && [[ "$TMUX_ONLY" == "0" ]]; then
  if [[ "$CORE_ONLY" == "1" ]]; then
    echo "  - Stopping systemd core unit $CORE_UNIT"
    if ! systemctl --user stop "$CORE_UNIT"; then
      echo "  ! failed to stop $CORE_UNIT" >&2
      FAILURES=1
    fi
  else
    echo "  - Stopping systemd stack via lifecycle coordinator"
    if ! node --import tsx src/lifecycle-cli.ts stop-systemd-stack; then
      echo "  ! systemd stack did not stop cleanly" >&2
      FAILURES=1
    fi
  fi
fi

# --- Scope-correct verification ---
#
# Each mode verifies exactly the scope it stopped; an intentionally
# surviving out-of-scope component (a tunnel after --core-only, tmux
# sessions after --systemd-only) is not a failure. Coordinator data is
# trusted only when the probe reported no errors; otherwise direct
# systemctl/tmux probes are used, and an unprovable scope fails closed.

have_systemctl() { command -v systemctl >/dev/null 2>&1; }
have_tmux() { command -v tmux >/dev/null 2>&1; }

VERIFY_OK=1
note_failure() {
  echo "$1" >&2
  VERIFY_OK=0
}

# Direct systemd probe, independent of the coordinator. Prints one active
# owned unit per line. Returns nonzero when systemctl itself is unavailable,
# so a missing probe can never look like a stopped stack.
direct_active_systemd_units() {
  have_systemctl || return 1
  systemctl --user list-units 'kontrol-*.service' 'kontrol.target' "$CORE_UNIT" \
    --state=active --no-legend --no-pager 2>/dev/null | awk 'NF {print $1}'
}

RESOLVED=1
if ! node --import tsx src/lifecycle-cli.ts resolve-backend --format=shell >"$VERIFY_ENV" 2>/dev/null; then
  RESOLVED=0
  echo "[!] Verification re-resolution failed; using direct probes." >&2
fi
if [[ "$RESOLVED" == "1" ]]; then
  # shellcheck disable=SC1091
  . "$VERIFY_ENV"
fi
# Coordinator data is evidence only when its own probes succeeded: an
# "unknown" backend or any probe error means the empty lists prove nothing.
COORDINATOR_TRUSTED=0
if [[ "$RESOLVED" == "1" && "${LIFECYCLE_BACKEND:-unknown}" != "unknown" && -z "${LIFECYCLE_PROBE_ERRORS:-}" ]]; then
  COORDINATOR_TRUSTED=1
fi

# Active owned systemd units, one per line, from the trusted source.
systemd_units_now() {
  local raw
  if [[ "$COORDINATOR_TRUSTED" == "1" ]]; then
    raw="${LIFECYCLE_SYSTEMD_UNITS:-}"
    [[ -z "$raw" ]] && return 0
    # shellcheck disable=SC2086
    printf '%s\n' $raw
  else
    direct_active_systemd_units
  fi
}

# Named systemd units must all be inactive. An unprovable scope fails.
check_systemd_units() {
  local units
  if ! units="$(systemd_units_now)"; then
    note_failure "[!] Cannot probe systemd state; refusing to report success."
    return 0
  fi
  local u
  for u in "$@"; do
    if printf '%s\n' "$units" | grep -qxF "$u"; then
      note_failure "[!] $u still active after stop"
    fi
  done
}

# No owned systemd unit may be active. An unprovable scope fails.
check_systemd_units_all() {
  local units
  if ! units="$(systemd_units_now)"; then
    note_failure "[!] Cannot probe systemd state; refusing to report success."
    return 0
  fi
  if [[ -n "$units" ]]; then
    # shellcheck disable=SC2086
    note_failure "[!] systemd units still active after stop: $(printf '%s' $units | tr '\n' ' ')"
  fi
}

# Named tmux sessions must all be gone (direct exact-match probes).
check_tmux_sessions() {
  if ! have_tmux; then
    note_failure "[!] tmux unavailable; cannot verify tmux scope stopped."
    return 0
  fi
  local s
  for s in "$@"; do
    if tmux has-session -t "=$s" 2>/dev/null; then
      note_failure "  ! $s still alive after kill"
    fi
  done
}

if [[ "$TMUX_ONLY" == "1" ]]; then
  # The systemd side was intentionally untouched; only owned tmux sessions
  # in this invocation's scope must be gone.
  check_tmux_sessions "${SESSIONS[@]}"
elif [[ "$SYSTEMD_ONLY" == "1" ]]; then
  # Tmux sessions were intentionally untouched; only the systemd scope must
  # be stopped — the whole stack, or just the core with --core-only.
  if [[ "$CORE_ONLY" == "1" ]]; then
    check_systemd_units "$CORE_UNIT"
  else
    check_systemd_units_all
  fi
elif [[ "$CORE_ONLY" == "1" ]]; then
  # Only the core was stopped on each backend; auxiliaries surviving on
  # either backend is the requested outcome, not a failure.
  check_systemd_units "$CORE_UNIT"
  check_tmux_sessions "kontrol-server"
else
  # Default: the aggregate owned stack must be fully gone on both backends.
  if [[ "$COORDINATOR_TRUSTED" == "1" ]]; then
    if [[ "${LIFECYCLE_BACKEND:-unknown}" != "none" ]]; then
      note_failure "[!] Owned components still alive after stop: systemd[${LIFECYCLE_SYSTEMD_UNITS:-}] tmux[${LIFECYCLE_TMUX_SESSIONS:-}]"
    fi
  else
    check_systemd_units_all
    check_tmux_sessions "${SESSIONS[@]}"
  fi
fi

if [[ "$VERIFY_OK" == "0" ]]; then
  FAILURES=1
fi

if [[ "$FAILURES" == "1" ]]; then
  echo "[!] Some components in the requested scope could not be stopped." >&2
  exit 1
fi

if [[ "$TMUX_ONLY" == "1" ]]; then
  echo "[*] Done. Owned tmux sessions stopped."
elif [[ "$SYSTEMD_ONLY" == "1" ]]; then
  echo "[*] Done. Systemd scope stopped."
elif [[ "$CORE_ONLY" == "1" ]]; then
  echo "[*] Done. Core stopped."
else
  echo "[*] Done. All owned components stopped."
fi
