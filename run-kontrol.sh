#!/usr/bin/env bash
# run-kontrol.sh — Kontrol server with explicit allowed roots (no .env ambiguity).
cd /home/bamn/devspace
[[ -f .env ]] || { echo "ERROR: .env missing" >&2; exit 1; }
set -a; source .env; set +a

export KONTROL_AUTH_MODE="${KONTROL_AUTH_MODE:-tunnel}"
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-7676}"
export KONTROL_ALLOWED_ROOTS="${KONTROL_ALLOWED_ROOTS:-/home/bamn/devspace,/home/bamn}"
export KONTROL_OAUTH_OWNER_TOKEN="${KONTROL_OAUTH_OWNER_TOKEN:-test-owner-token-that-is-long-enough}"

# --- Validate secrets (don't start half-configured) ---
if [[ -z "${KONTROL_ACP_SHARED_SECRET:-}" ]]; then
  echo "ERROR: KONTROL_ACP_SHARED_SECRET is required when ACP is enabled (.env)." >&2
  exit 1
fi

# --- Preflight: source must be valid BEFORE touching anything ---
echo "[*] Preflight: syntax-checking, typechecking, testing, building..."
if ! node --check scripts/acp-crush-adapter.mjs; then
  echo "ERROR: acp-crush-adapter.mjs failed syntax check. Aborting." >&2
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
echo "[*] Building dist/ (never serve stale compiled code)..."
npm run build
echo "[*] Preflight + build passed. Starting server..."

exec node dist/cli.js serve
