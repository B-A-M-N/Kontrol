# Review Browser Transport

## Purpose

This subtree owns browser-backed transport into one explicitly selected WebUI reviewer conversation.

## Ownership

Review workflow stores own submissions, reviewer claims, and verdict authority. This subtree may observe and submit browser turns; it cannot claim handoffs, commit feedback, approve work, or alter review policy.

## Local Contracts

- Browser profile selection is explicit. Never fall back to another profile or conversation.
- Conversation URLs are validated and fingerprinted; browser tab IDs are ephemeral.
- Conversation creation is disabled unless an operator explicitly enables it.
- Browser generation and prompt acceptance are transport evidence only. Only authenticated MCP review tools commit feedback.
- Authentication and verification screens stop work for human action. Do not bypass them.
- Manual authentication uses the same private persistent profile in official Chrome without CDP; controlled review starts only after that process exits and Kontrol verifies the ChatGPT session after relaunch.
- Authentication state is durable and separate from browser generation/process status. Browser readiness timestamps never assert authentication; a restarted process must positively inspect the exact bound ChatGPT conversation before dispatch or binding.
- Manual-auth handoff records PID, process-start identity, boot identity, and generation. After restart, continue only when process ownership is proven dead; live or ambiguous owners keep the handoff pending.
- Authentication failures suspend queued browser-turn events without consuming retry budget. Human authentication and a fresh positive page observation resume only authentication-suspended events.
- Exact-binding ambiguity or mismatch suspends that thread's queued events without consuming retry budget. An explicit successful rebind resumes only that thread's binding-suspended events.
- An exact bound conversation in `generation_active` remains valid and busy; do not mark it for recovery or send another turn until generation settles.
- Never accept credentials, recovery codes, OTPs, or cookies through MCP; a blocked handoff preserves the review route and queued packet.
- Manual authentication and controlled review must share the profile ownership lock and cannot overlap. The default manual-auth executable must be official Chrome; arbitrary Chromium is not a silent fallback.
- Manual authentication verifies the selected executable reports the official Google Chrome product, including explicitly configured paths. Store only bounded, redacted stderr diagnostics and report browser product plus whether CDP was enabled for that launch.
- Clean controller shutdown closes the owned controlled Chrome process so its loopback CDP endpoint does not outlive Kontrol. Health reports process, CDP, authentication, binding, and dispatch states independently.
- `open_reviewer_browser_login` is compatibility-only and returns `manual_authentication_required`; it never opens an identity-provider page under CDP.
- DOM selectors and generation observation stay inside `chatgpt-page-driver.ts`.
- The native Chromium controller uses the built-in WebSocket CDP client; do not add Playwright, ActiveTab imports, or a separate browser worker.
- The browser turn dispatcher consumes the existing review dispatch outbox. It never claims handoffs, commits feedback, approves work, or treats generated prose as a verdict.
- MCP app review remains the primary human-review path. Native CDP is an
  optional delivery and generation-observation transport; it never extracts a
  review verdict or commits feedback. Any future authorized model-API reviewer
  remains a separate transport with the same durable review authority layer.
- Browser turn dispatch wakes from post-commit outbox notifications and reconciles pending rows once at startup. Delayed retries use one timer for the next eligible deadline; there is no recurring outbox or page-generation poll.
- Visible prompt acceptance is transport evidence only. The browser attempt remains active until authenticated feedback commits through the review workflow.
- Reviewer profile and binding controls are reviewer-only MCP tools. Do not create a reviewer dashboard; human approval remains in the existing Approval Center.

## Work Guidance

Keep browser transport independent from ACP coding-agent selection and from provider-native implementing-agent sessions. Do not add TopHatMCP dependencies, imports, services, or protocol compatibility code.

## Verification

- `npm run typecheck`
- `npm run test:review-browser`

## Child DOX Index

| Path | Purpose |
|---|---|
| `profile-store.ts`, `chrome-process.ts`, `cdp-client.ts`, `target-binding.ts` | Private profile lifecycle, owned Chromium/CDP, and exact conversation recovery. |
| `chatgpt-page-driver.ts`, `browser-controller.ts`, `turn-dispatcher.ts` | Narrow ChatGPT DOM operations and durable browser-turn transport. |
| `contracts.test.ts` | Contract tests without launching a live browser or contacting ChatGPT. |
