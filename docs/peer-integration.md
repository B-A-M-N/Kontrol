# Peer integration (opt-in)

Kontrol is, by default, a single-owner control plane: one OAuth owner token (or
a Secure MCP Tunnel) reaches the main `/mcp` listener, and ACP agent/reviewer/
adapter secrets cover the worker side. The **peer** feature adds an optional,
deliberately narrow second path: an independently authenticated remote **peer**
— the primary use case being Meta's hosted Muse agent at `muse.ai` reaching your
Kontrol over a Tailscale tailnet or another approved path — can call a scoped
subset of Kontrol's MCP tools under sharing rules the owner grants.

Peers are **neither reviewers nor workers**. They cannot approve policy
requests, cannot award grants, and cannot act as the WebUI. A peer's access is
limited to the workspace roots and capabilities the owner grants it, and the
default peer profile is read-only inspection.

The peer listener exists **only** when `KONTROL_PEER_ENABLED=1`. With the
feature off, no peer listener is created and the main MCP listener (OAuth /
tunnel) behaves exactly as before.

> **Status:** This milestone implements the peer-listener portion of **C1**
> (a Muse-owned client calling approved Kontrol MCP tools): the read-only
> inspection surface plus, when the owner grants `workspace:propose_patch`,
> review-gated isolated mutation inside managed worktrees. The outbound job
> protocol (**C2**) is implemented with bounded capabilities: peers
> granted the `job:` capability family can claim durable peer-scoped jobs
> over `POST /peer/jobs/claim` (every job route also REQUIRES the matching
> `job:*` capability and answers `403 peer_capability_denied` without it),
> heartbeat them through a dedicated fenced lease renewal bounded by the
> job's `maxRuntimeMs` budget, affirmatively report "not started", and return
> correlated, validated results — with uncertain-outcome reconciliation and
> `actorClass` honesty labeling (`muse_vm_process` only; `meta_muse_agent`
> is rejected because C3 evidence does not exist). The owner enqueues jobs
> through the owner-only `enqueue_peer_job` MCP tool. Successful artifacts are
> staged into the exact managed worktree, captured in a baseline-relative
> snapshot, and submitted through the existing review workflow. Mission-bound
> jobs receive verification against that exact snapshot; without a mission
> contract, verification is `not_configured`. Peers never approve their own
> results. **C3** remains a planned, unsupported follow-on.

## Capability distinction: C1, C2, C3

The Muse integration is described in three distinct capability levels. They must
never be conflated, and evidence for a lower level never implies a higher one.

| Capability | What it means | Status |
| --- | --- | --- |
| **C1** | A Muse-owned client calls an approved subset of Kontrol MCP tools when Muse (not Kontrol) initiates the connection. | **Implemented:** read-only inspection plus opt-in, review-gated mutation in managed worktrees. |
| **C2** | Durable task exchange with software running in the Muse Secure VM via outbound pull. | **Implemented with bounded capabilities:** durable peer jobs, fenced leases, uncertain-outcome reconciliation, validated result staging, exact-worktree snapshots, and review submission. `workspace:run_bounded` remains reserved. Mission verification runs only when a job has a declared verification contract. |
| **C3** | Verified activation of the actual hosted Muse agent — Kontrol initiating turns in a user's real consumer Muse conversation. | **Planned, not supported.** |

**Never claim C3 from C2 evidence.** C2 proves only that software inside the
Muse Secure VM exchanged task data with Kontrol. It says nothing about whether
Meta's hosted consumer Muse agent can be programmatically activated. Muse-side
activation requires a user-approved Muse skill, schedule, or connector that must
be verified separately; the peer listener does **not** provide any API for
initiating turns in a Muse conversation.

Because the peer listener is Muse-initiated outbound (see below), Kontrol does
not start hosted Muse conversations. The owner can enqueue C2 jobs, and
authorized peer software claims them through `/peer/jobs/*`; successful results
enter the existing checkpoint, verification, and human-review path. Capabilities
that remain reserved, including `workspace:run_bounded`, stay inert until a
later milestone activates them.

## Durable peer jobs (C2)

The owner enqueues jobs; the peer pulls them. Nothing runs on the peer unless
the peer itself makes an outbound call.

### Owner side: `enqueue_peer_job` (owner-only MCP tool)

Registered on the owner MCP listener only. It is never part of any peer tool
profile: peers cannot see it in `tools/list`, and calling it by name from a
peer, worker, or reviewer session is denied (`Forbidden: enqueue_peer_job is
owner-only.`). Arguments:

| Argument | Type | Notes |
| --- | --- | --- |
| `peerId` | string, required | Must match an `id` in the credential registry. All authority derives from the stored descriptor, never caller-supplied data. |
| `repositoryId` | string, required | Workspace root. Canonicalized against `KONTROL_ALLOWED_ROOTS` (realpath, like `open_workspace`) and then required to be inside the peer's `grantedRoots`; otherwise denied. |
| `baseRevision` | string, required, nonempty | Immutable git SHA or snapshot identity. |
| `taskClass` | enum | `read_only_audit` \| `propose_patch` \| `bounded_execution`. |
| `instructions` | string, required | UTF-8 instruction text, capped at 256 KiB, delivered verbatim to the peer. The peer also sees its SHA-256 (`instructionHash`) via `/peer/commands`. |
| `allowedOutputs` | string[] of relative path prefixes, **required** | The owner must declare which result manifest paths are permitted. An entry matches when the canonical manifest path equals the entry or begins with `entry + "/"`. `["*"]` is the explicit match-all escape. An **empty** set allows NO file outputs. Entries are normalized (trailing `/` stripped; `..`, backslashes, and absolute paths rejected). |
| `maxRuntimeMs` | int, optional | Runtime budget. Default 600_000, max 3_600_000. |
| `maxArtifactBytes` | int, optional | Result artifact byte cap. Default 1_048_576, max 16_777_216. |

The per-peer active-job cap (`KONTROL_PEER_MAX_CLAIMED_JOBS`) is enforced on
this path: exceeding it returns an error (`peer_jobs_cap_exceeded`).

### Peer side: job routes and required capabilities

Every `/peer/jobs/*` route requires the full authenticated principal to hold
the owner-granted capability (from the credential registry, never the caller):

| Route | Capability |
| --- | --- |
| `POST /peer/jobs/claim` | `job:claim` |
| `POST /peer/jobs/:jobId/started` / `renew` / `fail` / `not-started` | `job:claim` |
| `GET /peer/jobs/:jobId/status` / `instructions`, `GET /peer/commands` | `job:claim` |
| `POST /peer/jobs/:jobId/result` | `job:complete` |
| `POST /peer/jobs/:jobId/cancel-ack` | `job:cancel_ack` |

Missing capabilities answer `403 {"error":{"code":"peer_capability_denied"}}`.
Attempts presented against the wrong URL answer `404 job_attempt_mismatch`;
other peers' jobs answer a scoped `404 job_not_found` with no existence leak.

### Instructions delivery

The claim response and `GET /peer/jobs/:jobId/instructions` return the
`instructions` text verbatim (both require `job:claim`). `/peer/commands`
remains a hash-only poll so a passive poller never receives the raw payload.

### Result receipts and terminalState mapping

`POST /peer/jobs/:jobId/result` validates the receipt against the job AND the
attempt (`receipt.jobId`/`receipt.attemptId` must match; `422
attempt_mismatch` otherwise), enforces `allowedOutputs`, the artifact byte
cap, and the canonical manifest hash. The receipt is persisted on the
attempt. `terminalState` maps to job state:

- `succeeded` → job `result_received`
- `failed` → job `failed` (terminal, reason `peer_reported_failure` prefixed with the first 200 chars of the receipt summary)
- `cancelled` → job `cancelled` (terminal, reason `peer_reported_cancelled` prefixed with the first 200 chars of the receipt summary)

Duplicate results are compared canonically inside the store: an IDENTICAL
repeat returns the stored outcome (idempotent); a DIFFERENT receipt answers
`409 conflicting_result` and never overwrites.

### Runtime budget

The job's `maxRuntimeMs` bounds heartbeat leases once the peer reports
`started`: each `/renew` is clamped to the remaining budget, and an exhausted
budget expires the attempt (`410 runtime_budget_exceeded`). The clock also
runs for claims that never report `started`: the budget starts at claim time
(the attempt's `createdAt`; legacy records use their lease start), so a
claim-without-start cannot renew indefinitely.

### The not-started honesty contract

A claim sets the attempt certainty to `unknown` — a claim is NOT evidence the
peer began work. The peer either reports `started` (certainty becomes
`started`) or affirmatively reports `POST /peer/jobs/:jobId/not-started`
(certainty becomes `not_started`). When a lease expires:

- `not_started` → the job requeues as `pending` (it may be claimed again).
- `started` or `unknown` → the job moves to `awaiting_reconciliation`. It is
  NEVER silently requeued or re-executed. A peer cannot contradict itself:
  `not-started` is rejected with `409 not_started_after_started` once the
  attempt has reported `started`.

The same policy applies on process restart: boot reconciliation never revives
claimed/running jobs. A background reaper (30s interval, unref'd timer)
sweeps expired leases with this exact policy; its teardown is bound to the
peer job routes handle.

### Honest C2 scope

A successful receipt is not approval evidence. Kontrol validates the receipt,
stages its artifacts into the job's exact managed worktree, captures a
baseline-relative snapshot, and creates a submission through the existing
review workflow. When a mission contract is attached, verification binds to
that exact submission and snapshot; otherwise the verification projection is
`not_configured`. Only authenticated reviewer feedback determines approval.
C3 (hosted Muse-agent activation) remains planned and unsupported.

## Reviewer/owner visibility (`list_peer_status`, M5)

The owner/reviewer MCP surface registers a read-only tool `list_peer_status`
(src/peer/peer-tools.ts). Roles: the **owner (authenticated `client`) and
`reviewer`** may call it; **peer and worker sessions are denied** at the
handler (`Forbidden: list_peer_status requires owner or reviewer authority.`),
in addition to the tool never appearing in any peer capability profile
(src/peer/tool-profile.ts) and being denied by the peer execution guard.

What it shows: listener state (`enabled`, `bindHost`, `port`), enrolled peers
(`id`, `credentialId`, `capabilities`, `grantedRoots`), durable jobs with
status, honest per-status `displayHint` (e.g. `result_received` is labeled
"NOT an approvable review submission"), latest-attempt `actorClass` /
`outcomeCertainty`, per-status counts, and honesty notes.

Deliberately excluded — never in the output: `claimToken`, `credentialHash`,
raw job `instructions`. Credential liveness/revocation is registry-
authoritative (`KONTROL_PEER_CREDENTIAL_FILE`) and hot-reloads; the tool's
notes restate that `muse_vm_process` results are never evidence of C3 (hosted
Muse-agent) execution and that peer delivery alone approves nothing — approval
authority remains with the existing reviewer workflow. The WebUI consumes this
surface for display only; it is not an authority path.

## Muse-specific notes

The peer feature targets **Meta's hosted consumer Muse at `muse.ai`** — not
Muse Code and not the Meta Model API. The consumer Muse agent is hosted, runs
inside Meta's infrastructure, and is subject to the **Muse Secure VM**, whose
**Sentinel-controlled egress** restricts network access:

- **Inbound connections to the VM are not ordinarily possible.** You cannot
  point Muse at a port on your machine and have Kontrol call it, and Kontrol
  cannot reach back into the VM. The architecture is therefore **Muse-initiated
  outbound**: Muse's tool or connector makes an outbound HTTPS call to the peer
  listener's address.
- To reach the peer listener, set up a **Tailscale connector** per Meta's and
  Tailscale's documentation, exposing a specific tailnet interface IP (for
  example a `100.x.y.z` Tailscale address) on which Kontrol binds its peer
  listener. The peer listener must be configured to bind only that interface
  (wildcard binds are rejected) so it is reachable on the tailnet and nowhere
  else.
- Kontrol never needs a route back to the VM. `KONTROL_PEER_PORT` is the port
  Muse's outbound client targets; it must differ from the main `PORT`.
- **The peer listener does not and cannot initiate a turn in a consumer Muse
  conversation.** There is no public API for that, and no Kontrol feature
  claims one. Consumer-Muse activation, when it is eventually desired, is a
  separate, user-approved Muse skill/schedule/connector that must be verified
  independently.

## Enabling the feature

```dotenv
# Peer listener (off by default; no peer listener exists without this).
KONTROL_PEER_ENABLED=1
KONTROL_PEER_PORT=7677
KONTROL_PEER_CREDENTIAL_FILE=/home/you/.kontrol/peers.json
```

With `KONTROL_PEER_ENABLED=1`, `KONTROL_PEER_PORT` and
`KONTROL_PEER_CREDENTIAL_FILE` are **required**; startup fails if any required
peer variable is missing or invalid. With `KONTROL_PEER_ENABLED` unset or `0`,
all other `KONTROL_PEER_*` variables are ignored and the peer listener is not
created.

## Configuration reference

All of the following are ignored unless `KONTROL_PEER_ENABLED=1`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `KONTROL_PEER_ENABLED` | *(unset)* | Opt-in. Without `1` no peer listener exists and startup is unchanged. |
| `KONTROL_PEER_BIND_HOST` | `127.0.0.1` | Interface to bind the peer listener on. **Wildcard binds (`0.0.0.0`, `::`, `*`) are rejected.** Use a specific tailnet interface IP (e.g. a `100.x.y.z` Tailscale address) to expose the listener only on the tailnet. |
| `KONTROL_PEER_PORT` | *(required when enabled)* | Port for the peer listener. Must differ from the main `PORT` (default `7676`). |
| `KONTROL_PEER_CREDENTIAL_FILE` | *(required when enabled)* | Absolute path to an operator-owned JSON credential registry (see below). The file must be mode `0600` or `0400`; startup refuses group- or other-readable files. |
| `KONTROL_PEER_MAX_ACTIVE_SESSIONS` | `8` | Cap on concurrent peer MCP sessions. Also reused as the **per-peer managed-worktree cap** for peers granted `workspace:propose_patch` (on top of the existing global and per-project managed-worktree limits). |
| `KONTROL_PEER_MAX_CLAIMED_JOBS` | `8` | Per-peer cap on active (pending/claimed/running/awaiting-reconciliation) durable peer jobs (C2, enforced on the owner-side `enqueue_peer_job` tool). |
| `KONTROL_PEER_REQUEST_BYTES_LIMIT` | `1048576` | Per-request body limit on the peer listener. |

### Credential registry file

The registry is a JSON file owned by the operator. Its permissions are enforced
at startup (mode `0600` or `0400` only).

```json
{
  "version": 1,
  "peers": [
    {
      "id": "meta-muse",
      "credentialId": "v1",
      "credentialHash": "<64 lowercase hex chars>",
      "capabilities": ["workspace:inspect"],
      "grantedRoots": ["/home/you/projects/demo"],
      "notBefore": "2026-01-01T00:00:00Z",
      "expiresAt": "2027-01-01T00:00:00Z",
      "revokedAt": null
    }
  ]
}
```

A peer authenticates by presenting:

```text
Authorization: Bearer <credentialId>:<secret>
```

where `<secret>` is between 16 and 256 characters. **Only the SHA-256 of the
domain-separated string is ever stored — never the plaintext secret.** The hash
is over the exact bytes:

```text
kontrol-peer-credential-v1\0<credentialId>\0<secret>
```

hex-encoded to 64 lowercase characters. Generate a hash with:

```bash
node -e 'const c=require("crypto");console.log(c.createHash("sha256").update(`kontrol-peer-credential-v1\0${process.argv[1]}\0${process.argv[2]}`).digest("hex"))' <credentialId> <secret>
```

Supporting fields:

- `id` — human/operator label for the peer descriptor.
- `credentialId` — the public identifier prefix presented in the bearer token.
  Rotating the credential changes `credentialId` and/or `credentialHash`.
- `credentialHash` — SHA-256 over the domain-separated string, hex-encoded.
- `capabilities` — the capability values granted to this peer (see below).
  `workspace:inspect` is the default; `workspace:propose_patch` additionally
  enables review-gated managed-worktree mutation (see below). The `job:`
  family gates the durable peer job protocol (see below).
- `grantedRoots` — absolute workspace roots this peer may open. Each entry must
  lie inside the server's configured `KONTROL_ALLOWED_ROOTS`.
- `notBefore` — optional UTC activation time; before this the descriptor is
  inert.
- `expiresAt` — optional UTC expiry; after this the descriptor is inert.
- `revokedAt` — optional UTC revocation timestamp.

#### Capability values

| Capability | Meaning | Current milestone |
| --- | --- | --- |
| `workspace:inspect` | Read-only structured inspection (`read`, `grep`, `glob`, `ls`, git tools) plus `open_workspace`. | **Implemented** (default peer profile). |
| `workspace:propose_patch` | Review-gated isolated mutation: peers may open managed worktrees for granted source roots and mutate files inside them (`write`, `edit`) with mandatory checkpoint tracking. Direct checkout mutation is always denied; peers cannot approve their own changes. | **Implemented** (opt-in per peer). |
| `workspace:run_bounded` | Run a bounded command in an approved workspace. | **Reserved** (follow-on). |
| `job:claim` | Claim an outbound task from the job queue (C2); also gates `started`, `renew`, `fail`, `not-started`, `status`, `instructions`, and `/peer/commands`. | **Implemented** via the `/peer/jobs/*` protocol with durable peer-scoped jobs and fenced leases. |
| `job:complete` | Report an outbound task result (C2). | **Implemented** via `POST /peer/jobs/:jobId/result`; validated receipts drive exact-worktree artifact staging and review submission. |
| `job:cancel_ack` | Acknowledge cancellation of an outbound task (C2). | **Implemented** via `POST /peer/jobs/:jobId/cancel-ack`. |

The default peer profile is `workspace:inspect` only. Do not assume any reserved
capability is active in the current milestone.

### Review-gated isolated mutation (`workspace:propose_patch`)

When the owner grants `workspace:propose_patch`, a peer may:

- Open a **managed worktree** (`open_workspace` with `mode: "worktree"`) whose
  **source root** is inside its `grantedRoots`. The worktree itself lives under
  `KONTROL_WORKTREE_ROOT` and is checked against the source root, not the
  worktree path.
- Mutate files **inside that worktree** with `write` and `edit` (the mutation
  tools mapped by the `propose_patch` tool profile).

Every peer mutation is subject to stricter rules than owner/worker mutations:

- **Worktree-only.** Direct checkout mutation is always denied, regardless of
  any other setting. A peer mutation on a non-worktree workspace fails with a
  `workspace_binding_denied` authority error.
- **Mandatory checkpoint tracking.** The peer checkpoint gate runs even when
  `KONTROL_WIDGETS=off`, and the `KONTROL_ALLOW_UNTRACKED_MUTATION` escape
  hatch is **not honored** for peers: peer mutations always remain tracked and
  review-bound. If no usable checkpoint backend exists, the mutation is
  refused.
- **Per-peer worktree cap.** A peer may hold at most
  `KONTROL_PEER_MAX_ACTIVE_SESSIONS` active managed worktrees (the same value
  reused as the concurrent peer-session cap), on top of the existing global and
  per-project managed-worktree limits.
- **Peers are non-reviewers.** A peer can propose changes; it can never
  approve them or its own review checkpoint.
- **Ownership is per-peer and fail-closed.** A peer may only mutate worktrees
  it opened itself: ownership is recorded at open_workspace time in a
  process-local registry and re-checked at every mutation, together with a
  granted-source re-check. list_managed_worktrees shows a peer only its own
  entries — other principals' worktree IDs, paths, and source roots are never
  disclosed. Ownership does not survive a server restart; the peer re-runs
  open_workspace on the source path to re-record it.

### Rotation and revocation

The registry is **hot-reloaded** on file change, so revoking a compromised
credential does not require a restarted server.

- **Revoke:** set `revokedAt` to a timestamp (or an `expiresAt` in the past) and
  write the file; the descriptor becomes inert on the next reload.
- **Rotate:** change `credentialId` and/or `credentialHash`, then have the peer
  present the new `credentialId:<secret>`. Old credential material ceases to
  match once the new hash is loaded.
- Because only hashes are stored, a registry leak does not directly expose a
  usable secret — but the file is still operator-owned secret material; keep it
  mode `0600`/`0400` and treat it accordingly.

Revocation and rotation apply on the registry file's next observed mtime change.
If a rewrite is in flight when the reload fires, requests are served from the
last-good registry (fail-operational) until the new content parses cleanly — so
a credential recorded as revoked in a broken or partially-written file becomes
inert only once the file parses again. Always write the registry atomically
(write to a temp file, then rename it into place) so readers never observe a
partial write.

## Security properties and limits

The peer path is isolated and additive. Its guarantees:

- **Separate listener, minimal surface.** The peer listener exposes only `/mcp`,
  `/peer/*`, and a minimal liveness endpoint. It has **no ACP router, no OAuth
  flow, no diagnostics, and no static Workspace App assets.** There is nothing
  on the peer listener an ACP worker, reviewer, or the WebUI could reach.
- **No peer port / owner port mixing.** Peer credentials cannot be used on the
  owner port, and owner credentials (OAuth owner token, OAuth/tunnel tokens,
  ACP agent/reviewer/adapter secrets) cannot be used on the peer port. Each
  listener authenticates only against its own authority.
- **Peer credentials are entirely separate** from the OAuth owner token and the
  ACP agent/reviewer/adapter secrets. A leaked or compromised peer credential
  cannot be replayed against the owner or worker surfaces.
- **No reviewer/worker authority.** Reviewers and workers are roles that come
  from the owner/ACP authority paths. They can **never** be obtained via peer
  credentials. A peer cannot approve policy requests, award grants, or act as
  the WebUI.
- **Workspace shaping.** A peer cannot reuse an owner `workspaceId` unless its
  current root grants independently allow it. A peer's view is limited to the
  `grantedRoots` the owner granted, each of which must lie inside
  `KONTROL_ALLOWED_ROOTS`. Denied-by-default: `.env` and credential files are
  not accessible to peers unless they fall inside an explicitly granted root's
  readable surface — and the default profile grants only `workspace:inspect`
  over those roots.
- **Bound namespaces.** `KONTROL_PEER_*` variables are inert unless
  `KONTROL_PEER_ENABLED=1`. `KONTROL_PEER_MAX_CLAIMED_JOBS` bounds each
  peer's active durable jobs and is enforced on the owner-side
  `enqueue_peer_job` tool.

The read-only default remains the safe posture because a peer is a hosted,
remotely authenticated caller consuming potentially adversarial project content
— the same prompt-injection exposure that motivates Kontrol's general secure
baseline. With `workspace:propose_patch` granted, mutation is confined to
isolated managed worktrees with mandatory review tracking; the live checkout is
never mutated by a peer. Job capabilities (`workspace:run_bounded`) are still
gated behind later milestones; the `job:` family is active for the durable
peer job protocol with the honest scope described above.

## Rollback

To disable the feature:

1. Unset `KONTROL_PEER_ENABLED` (or set it to `0`), or remove it from the
   environment.
2. Restart the server.

After the restart the peer listener disappears and the owner behavior is
unchanged. The main MCP listener (OAuth / tunnel) never depends on the peer
listener, so rolling back can never affect the owner path. Because all
`KONTROL_PEER_*` variables are ignored while disabled, the peer section can be
left in a shared `.env` harmlessly.
