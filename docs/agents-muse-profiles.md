# Muse Code and MuseFI agent profiles

Two opt-in worker profiles run the standard Muse Code CLI and the MuseFI
wrapper through the existing generic ACP stdio duplex adapter
(`scripts/acp-stdio-duplex-adapter.mjs`). No new adapter implementation was
added; the profiles are configuration plus lifecycle wiring.

## Profiles

| Profile   | Agent name | Default port | Binary default | Session persistence |
| --------- | ---------- | ------------ | -------------- | ------------------- |
| muse-code | muse-code  | 9922         | `muse`         | operator's Muse config |
| musefi    | musefi     | 9921+1=9923  | `musefi`       | `$HOME/.config/muse-fi` (wrapper-isolated) |

MuseFI is a 475-byte shell wrapper around the same Muse binary: it unsets
provider keys and redirects `XDG_CONFIG_HOME`, so the two profiles never
share a session, credential, or config home. Both speak ACP v1 over stdio
(`acp` subcommand); neither sends ACP v2 methods unless negotiated.

## Enabling

```sh
START_MUSE_ADAPTER=true ./start-all.sh          # Muse Code only
START_MUSEFI_ADAPTER=true ./start-all.sh        # MuseFI only
MUSE_BIN=/custom/muse \
MUSEFI_BIN=/custom/musefi \
START_MUSE_ADAPTER=true START_MUSEFI_ADAPTER=true ./start-all.sh
```

Both default to `false`: an experimental agent must never join boot silently.
When enabled, startup fails closed if the binary is missing, not executable,
or does not expose `muse acp` with an ACP v1 interface. Each launch is
followed by `/health` and a real `/runs` smoke before the agent name is
pinned into `KONTROL_ACP_AGENTS` (`muse-code=127.0.0.1:9922`,
`musefi=127.0.0.1:9923`) and probed dispatchable.

## Child environment

`safeEnv()` and the child-env allowlist both refuse any variable name
containing `ACP`, so `KONTROL_CHILD_ENV_ALLOWLIST` can never carry the
experimental gate. Profiles instead use `ACP_STDIO_AGENT_ENV_JSON`, an
explicit operator-authored JSON object merged over the sanitized base for
ordinary (non-sandboxed) launches:

```sh
ACP_STDIO_AGENT_ENV_JSON='{"MUSE_EXPERIMENTAL_ACP":"on"}'
```

Keys must be strict `UPPERCASE` identifiers and must never name credential
material (`SECRET`, `TOKEN`, `PASSWORD`, `PRIVATE_KEY`, `CREDENTIAL`,
`COOKIE`, ...); malformed or credential-bearing values fail the adapter at
startup, before registration. Secrets do not belong in the child
environment. No `--trust-workspace` is passed and no `--no-session-log` is
used, so durable provider-session recovery keeps working.

## Isolation guarantees (regression-tested)

`scripts/acp-muse-profiles.test.mjs` launches two adapter instances with
fixture agents and proves: distinct registration names and ports, per-profile
passthrough of the experimental gate (present for one, absent for the
other), no cross-profile dispatch reroute, and per-profile state roots
(dispatch receipts never cross). `start-all.sh` additionally namespaces
`KONTROL_STATE_DIR` per profile (`.../adapters/stdio-<agent-name>`), so
owned processes, terminal spools, event spools, session bindings, and agent
identity files are per-profile too.

## Live qualification (deferred, needs authorization)

Unit/integration proof above uses fixture agents, which cannot prove real
Muse inference. Still required before marking either profile functional: run
the profile against the real binary, dispatch by explicit `agentName`, and
demonstrate a terminal provider turn (`end_turn`) plus review delivery.
