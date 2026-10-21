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
- DOM selectors and generation observation stay inside `chatgpt-page-driver.ts`.
- The native Chromium controller uses the built-in WebSocket CDP client; do not add Playwright, ActiveTab imports, or a separate browser worker.
- The browser turn dispatcher consumes the existing review dispatch outbox. It never claims handoffs, commits feedback, approves work, or treats generated prose as a verdict.
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
