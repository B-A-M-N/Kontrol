#!/usr/bin/env bash
# stop-all.sh — graceful teardown of Kontrol + tunnel + ACP adapters
# P1 #42 / P1 #43: Own exact tmux sessions; graceful shutdown before escalation.
set -u
cd "$(dirname "$0")"

echo "[*] Stopping kontrol + tunnel-client + ACP adapters (graceful first)..."

# P1 #43: Graceful shutdown — send SIGINT, wait, then escalate per-session.
# We only touch sessions we own (exact tmux session names).
SESSIONS=("kontrol-server" "kontrol-tunnel" "kontrol-supervisor" "kontrol-adapter" "kontrol-adapter-crush" "kontrol-adapter-hermes")

for s in "${SESSIONS[@]}"; do
  if tmux has-session -t "$s" 2>/dev/null; then
    echo "  - Sending SIGINT to $s"
    tmux send-keys -t "$s" C-c 2>/dev/null || true
  fi
done

# P1 #43: Bounded grace period for graceful shutdown
echo -n "[*] Waiting for graceful exit"
GRACEFUL=0
for _ in $(seq 1 10); do
  ALIVE=0
  for s in "${SESSIONS[@]}"; do
    if tmux has-session -t "$s" 2>/dev/null; then
      ALIVE=1
      break
    fi
  done
  if [[ "$ALIVE" == "0" ]]; then
    GRACEFUL=1
    break
  fi
  echo -n "."
  sleep 1
done
echo ""

# Escalate: kill sessions that survived graceful period
for s in "${SESSIONS[@]}"; do
  if tmux has-session -t "$s" 2>/dev/null; then
    echo "  - Escalating: killing $s"
    tmux kill-session -t "$s" 2>/dev/null || true
  fi
done

# P1 #42: Verify no survivors in our tmux sessions (no broad pkill)
STILL_ALIVE=0
for s in "${SESSIONS[@]}"; do
  if tmux has-session -t "$s" 2>/dev/null; then
    echo "  ! $s still alive after kill"
    STILL_ALIVE=1
  fi
done

if [[ "$STILL_ALIVE" == "1" ]]; then
  echo "[!] Some tmux sessions could not be stopped." >&2
  exit 1
fi

echo "[*] Done. All owned sessions stopped."
