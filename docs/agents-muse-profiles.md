# Muse Code, MuseFI, and OpenMuse agent profiles

Three opt-in worker profiles run the standard Muse Code CLI and its
isolated wrappers through the existing generic ACP stdio duplex adapter
(`scripts/acp-stdio-duplex-adapter.mjs`). No new adapter implementation was
added; the profiles are configuration plus lifecycle wiring. All three speak
Muse Code's native ACP v1 (`muse acp`, gated by `MUSE_EXPERIMENTAL_ACP=on`);
none uses `muse serve` (MSP) or any external ACP-to-MSP bridge.

## Profiles

| Profile   | Agent name | Default port | Binary default | Session persistence |
| --------- | ---------- | ------------ | -------------- | ------------------- |
| muse-code | muse-code  | 9922         | `muse`         | operator's Muse config |
| musefi    | musefi     | 9923         | `musefi`       | `$HOME/.config/muse-fi` (wrapper-isolated) |
| openmuse  | openmuse   | 9924         | `openmuse`     | `$HOME/.config/muse-open` (wrapper-isolated) |

MuseFI and OpenMuse are shell wrappers around the same Muse binary: each
unsets provider keys and redirects `XDG_CONFIG_HOME`, so the three profiles
never share a session, config home, or agent identity. Both wrappers speak
ACP v1 over stdio (`acp` subcommand); neither sends ACP v2 methods unless
negotiated.

OpenMuse is restricted to OpenRouter free and stealth models only: its
`~/.config/muse-open/muse/settings.json` model catalog lists exactly four
entries (`stealth/crouton-alpha`, `cohere/north-mini-code:free`,
`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`,
`google/gemma-4-31b-it:free`), all free/stealth, served via the local
gateway `http://127.0.0.1:18769/openrouter/v1` with client header
`X-FI-Local-Client: openmuse` (MuseFI uses `musefi` on the same route).
There is no paid route, no fallback to a paid model, and no credential
sharing with MuseFI beyond the gateway-issued local client credential that
both wrappers read from their own separate `auth.json` files; the upstream
OpenRouter key never leaves the gateway process. MuseFI's existing
installation/profile is reused as-is and is not recreated or overwritten.

## Enabling

```sh
START_MUSE_ADAPTER=true ./start-all.sh          # Muse Code only
START_MUSEFI_ADAPTER=true ./start-all.sh        # MuseFI only
START_OPENMUSE_ADAPTER=true ./start-all.sh      # OpenMuse only
MUSE_BIN=/custom/muse \
MUSEFI_BIN=/custom/musefi \
OPENMUSE_BIN=/custom/openmuse \
START_MUSE_ADAPTER=true START_MUSEFI_ADAPTER=true START_OPENMUSE_ADAPTER=true ./start-all.sh
START_OPENMUSE_ADAPTER=true OPENMUSE_ACP_PORT=9924 ./start-all.sh  # custom port
```

All three default to `false`: an experimental agent must never join boot
silently. When enabled, startup fails closed if the binary is missing, not
executable, or does not expose `muse acp` with an ACP v1 interface. Each
launch is followed by `/health` and a real `/runs` smoke before the agent
name is pinned into `KONTROL_ACP_AGENTS` (`muse-code=127.0.0.1:9922`,
`musefi=127.0.0.1:9923`, `openmuse=127.0.0.1:9924`) and probed dispatchable.

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

`scripts/acp-muse-profiles.test.mjs` launches three adapter instances with
fixture agents and proves: distinct registration names and ports, per-profile
passthrough of the experimental gate, no cross-profile dispatch reroute, and
per-profile state roots (dispatch receipts never cross). `start-all.sh`
additionally namespaces `KONTROL_STATE_DIR` per profile
(`.../adapters/stdio-<agent-name>`), so owned processes, terminal spools,
event spools, session bindings, and agent identity files are per-profile
too. Per-agent concurrency is bounded by the adapter's one child process
per run plus Kontrol's dispatch selection; there is no cross-profile
fallback — a dispatch naming one agent never reroutes to another.

## Live qualification

Unit/integration proof above uses fixture agents, which cannot prove real
Muse inference. The live canary (one dispatch per profile in a disposable
workspace, verifying code modification, tests, review submission, result
retrieval after reconnect, and — only where the ACP extension supports it —
bidirectional messaging) is run separately and reported with its evidence;
worker claims are never reported as independently verified.
