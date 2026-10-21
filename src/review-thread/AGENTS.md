# Review Thread Authority

## Purpose

This directory owns durable reviewer-thread identity, explicit activation authority, and message lifecycle for bounded review loops.

## Ownership

The review workflow and handoff stores own submission and feedback authority. This subtree owns the persistent reviewer context associated with a route generation.

## Local Contracts

- There is one Kontrol reviewer thread per `(routeId, routeEpoch)`.
- Activation secrets are one-time, expiring, principal-scoped capabilities. Persist only SHA-256 hashes and consume grants transactionally.
- Reviewer authorization comes from the authenticated principal and server-issued MCP transport session. Caller-supplied conversation IDs and attribution headers are never authorization.
- A fresh transport session must present a valid one-time activation grant before it can retrieve packets or claim feedback authority; copying the original conversation ID does not transfer the binding.
- Host conversation IDs are correlation metadata; `hostBindingVerified` remains false without a trusted host adapter receipt.
- Thread messages are immutable per `(threadId, submissionId, reviewEpoch)` and distinguish activation wait, queued delivery, presentation, claim, and committed feedback.
- The bounded reviewer packet is prepared and content-hashed with the submission transaction; a retry cannot replace an already-prepared packet.
- The implementing agent's provider-native session is independent of the reviewer thread and work-session IDs.
- Reviewer decisions travel through the existing MCP handoff tools; do not build a separate reviewer-facing UI or approval screen. Human approvals use the existing Approval Center.

## Work Guidance

Keep thread activation and reviewer claims fail-closed across route-epoch changes, pause/resume, release, and reviewer rebinding. Host message delivery is transport into the active WebUI context, not a reviewer UI surface. Do not add a background ChatGPT conversation-creation assumption.

## Verification

- `npm run test:review-thread`
- `node src/acp-stdio-duplex-integration.test.mjs`
- `npm run typecheck`

## Child DOX Index

| Path | Purpose |
|------|---------|
| None | This directory contains the thread store and its lifecycle tests. |
