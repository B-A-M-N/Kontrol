#!/usr/bin/env bash
# Source-checkout compatibility wrapper. Production lifecycle behavior lives
# in the compiled `kontrol service` command so the published npm package and
# the checkout use the same artifact-selection, quoting, and rollback code.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="${KONTROL_CLI_PATH:-${ROOT_DIR}/dist/cli.js}"
if [[ ! -f "$CLI" ]]; then
  echo "ERROR: compiled Kontrol CLI not found at ${CLI}; run npm run build first." >&2
  exit 1
fi

exec node "$CLI" service "$@"
