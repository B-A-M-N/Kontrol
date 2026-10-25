# Kontrol Multipath Ingress — Remaining Work

Updated: 2026-10-25
Repository: `/home/bamn/devspace`
Branch: `audit-k02-k04`
HEAD at this handoff: `0bcd952`
Commits are local only. Do not push without separate authorization.
Preserve untracked `.tmp-scratch/`.

Requirement source: `/home/bamn/.codex/attachments/458e9b15-a1ec-4247-aa20-19ec878f9be9/pasted-text-1.txt`

Everything below is **not** implemented yet. Each item states what remains, how
to do it, and what proves it is done.

---

## 1. Real tailnet deployment evidence

**Status:** tooling complete and exercised; the deployment itself is missing.

The tailnet Serve row of the matrix is still `source_verified`. It needs
evidence captured from a real tailnet client against a configured Serve route.

**What is missing:** this host's tailnet has **Serve disabled**.
`tailscale serve --bg --https=8443 …` hangs until it times out and prints
`Serve is not enabled on your tailnet`. Enabling it requires a browser visit
to the tailnet's serve URL — an operator action, not a code change.

**How to do it:**

1. An operator enables Serve on the tailnet (the enable URL is printed by
   `tailscale serve --bg --https=8443 http://127.0.0.1:<port>`).
2. Configure the profile:

   ```json
   {"id":"serve-peer","kind":"tailscale_serve","audience":"peer",
    "externalOrigin":"https://pop-os.tail8d285a.ts.net:8443",
    "target":"peer_listener","enabled":true,"managedByKontrol":true,
    "allowedHosts":["pop-os.tail8d285a.ts.net:8443"]}
   ```

3. Apply it through the receipt-backed controller (never by hand):

   ```sh
   kontrol ingress apply serve-peer --confirm
   ```

4. From a **real tailnet client** (a different node on the tailnet, not the
   serving node), qualify the route:

   ```sh
   npm run probe:serve -- --url https://pop-os.tail8d285a.ts.net:8443 \
     --authorization-file /path/to/peer-bearer --profile-id serve-peer \
     --state-dir ~/.local/share/kontrol --build-id "$BUILD_ID"
   ```

5. Feed the evidence into the matrix:

   ```sh
   npm run qualify:ingress -- --evidence-state-dir ~/.local/share/kontrol
   ```

**Proves it:** `serve-mapping-exact-match` moves from `source_verified` to
`pass` at the `real_tailnet` tier, and the recorded observation carries the
build id, observed route, principal class, session identity hash, operation
id, and failure class.

**Note:** the same Serve route also unblocks
`forged-forwarded-and-x-kontrol-headers` (a tailnet client forging authority
headers at the real route) and the tailnet half of
`sse-idle-timeout-and-45s-post`.

---

## 2. Public-internet deployment evidence

**Status:** tooling complete; no public deployment exists.

Three matrix rows remain `source_verified` at the `public_internet` tier:
`funnel-public-authenticated`, `forged-forwarded-and-x-kontrol-headers`, and
`sse-idle-timeout-and-45s-post`. They need a non-tailnet client against a
public origin.

**What is missing:** a public origin. Either

- **Tailscale Funnel** on this host (`tailscale funnel` — also requires the
  tailnet to have Funnel enabled, and it publishes the node to the public
  internet, so it needs explicit operator authorization), or
- **the public HTTPS bridge** described in `deploy/bridge/README.md`: a VPS
  with its own domain running Caddy, proxying to a private Serve upstream.

**How to do it (bridge path):**

1. Deploy the VPS per `deploy/bridge/README.md` and copy the **packaged**
   `deploy/bridge/Caddyfile.example` (not a source-tree copy).
2. Validate the deployed configuration and record the receipt:

   ```sh
   node scripts/qualify-caddy-bridge.mjs --config /etc/caddy/Caddyfile \
     --bridge-node <tag:kontrol-bridge> --public-host kontrol.example.com \
     --upstream <node>.<tailnet>.ts.net:9443 --build-id "$BUILD_ID" \
     --receipt /var/lib/kontrol/caddy-qualification.json
   ```

3. Prove route isolation against the **deployed** file:

   ```sh
   node scripts/bridge-route-isolation.mjs --config /etc/caddy/Caddyfile \
     --build-id "$BUILD_ID" --receipt /var/lib/kontrol/bridge-isolation.json
   ```

4. Qualify the public origin from a **non-tailnet client**:

   ```sh
   node scripts/probe-ingress-bridge.mjs --url https://kontrol.example.com \
     --authorization-file /path/to/oauth-bearer --workspace-path /path/to/ws \
     --long-post-ms 45000 --profile-id bridge-1 \
     --state-dir ~/.local/share/kontrol --build-id "$BUILD_ID"
   ```

**Proves it:** the three rows move to `pass` at the `public_internet` tier.

---

## 3. The public Funnel/bridge origin decision (Mode A vs Mode B)

**Status:** not decided in this deployment.

The audit's P1-06 requires an explicit decision between:

- **Mode A — stable public identity.** One owned domain is the canonical
  OAuth endpoint; multiple ingress backends sit behind it. The MCP resource
  identity stays stable, so failover is transparent to the client.
- **Mode B — independent endpoint identities.** A Funnel origin and a bridge
  origin are separate endpoints with separate OAuth discovery and separate
  credentials; the client explicitly reauthorizes when switching origins.

The code supports both (the owner bridge requires per-origin bearer files and
refuses to share a credential across origins). The deployment has not chosen.
Mode A is the default the audit recommends for hosted clients; Mode B is the
explicit recovery option.

**Proves it:** a written decision in `docs/ingress.md`, and — for Mode B — an
operator-authorized credential per origin, each with its own resource
identity.

---

## 4. Remaining matrix rows that need a real client

`external-tls-or-dns-failure` needs a real external TLS or DNS failure
observed through the public origin (an expired or wrong-host certificate, or
a DNS failure), captured as a profile-specific failure classification.

The tooling already records honest failure evidence — a probe against an
unmapped route produced `state: DOWN`, `evidenceTier: real_tailnet`,
`failureClass: route-identity-exact` — but that is a synthetic failure, not
an external TLS/DNS failure.

**Proves it:** an observation whose `failureClass` names the specific
external failure (not a route mismatch), captured from the public origin.

---

## 5. Pre-existing failing test (not caused by this work)

`src/mcp-tool-catalog-http.test.ts` fails at:

> release B sends the supported tools/list_changed refresh pulse over the
> existing GET stream

It was reproduced against the original branch HEAD (`9818473`) in a separate
worktree, so it is not a regression from the ingress work. Because the
canonical `test:unit` chain is sequential, that one failure stops the chain
before the remaining tests (the rest of the chain passes when run separately).

**Where to look:** `src/server/mcp-http.ts` — `sendCatalogRefreshPulse` is
called with the `get_stream` phase at the GET handler (line ~388) and with
the `initialized` phase after initialize (line ~1350); the GET-stream pulse
is attempted but the notification does not reach the already-open GET SSE
stream.

**Proves it:** the assertion passes and the whole `npm run test:unit` chain
runs to completion.

---

## 6. Operators' checklist before the next release

- `npm run typecheck`
- `npm run test:manifest`
- `npm run test:syntax`
- `npm run test:unit` (blocked today by item 5)
- `npm run test:integration`
- `npm run test:package`
- `npm run qualify:ingress` — 11 of 18 rows pass at their required tier, 6
  are `source_verified` pending items 1–4, and 0 fail
- `npm run qualify:ingress -- --evidence-state-dir ~/.local/share/kontrol`
  after collecting deployment evidence

**Environment notes:**

- A static Caddy binary was downloaded to `/tmp/caddy` for the local
  route-isolation run. It is not in the repository; `KONTROL_CADDY_BIN`
  selects it. The matrix leaves the Caddy scenarios `unverified` (never
  `pass`) when no Caddy binary is available.
- This host's tailnet has Serve disabled (item 1).
- `tailscale serve` does not fail fast in that state; the controller now
  classifies the failure (`serve_not_enabled`, `command_timed_out`) instead
  of reporting an opaque exit code.
