#!/usr/bin/env bash
# Restart the complete Kontrol generation through the transactional launcher.
# The launcher performs the build gate before replacing any live process.
set -euo pipefail
cd "$(dirname "$0")"
exec ./start-all.sh "$@"
