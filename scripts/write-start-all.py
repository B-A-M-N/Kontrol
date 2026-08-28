#!/usr/bin/env python3
"""Validate the checked-in transactional launcher.

There is one authoritative launcher: ``start-all.sh``.  Keeping a second
embedded shell copy caused source/runtime drift and could silently overwrite a
fixed launcher with an older one, so this helper now validates instead of
generating a second source of truth.
"""

from pathlib import Path


launcher = Path(__file__).resolve().parents[1] / "start-all.sh"
text = launcher.read_text()
required = (
    "trap on_exit EXIT",
    "exec node ${SERVER_ARTIFACT} serve",
    "ACTIVE_ARTIFACT_PATH",
    "/healthz",
    "/readyz",
    "probe-kontrol-readiness.mjs",
    "send-keys",
    "STARTUP_COMMITTED=1",
)
missing = [needle for needle in required if needle not in text]
if missing:
    raise SystemExit(f"start-all.sh is missing launcher contract(s): {', '.join(missing)}")

print(f"validated {launcher}")
