# Devdesktop plugin update — packaging report (v1.0.1 candidate, NOT uploaded)

## Archive

- Path: `/home/bamn/devspace/devdesktop-plugin/devdesktop-plugin-update-1.0.1.zip`
- SHA-256: `17a0008183d7198746c35614cf74d519a4500cf0be6e2d1914ae90174cb1dafa`
- Refreshed after Path B slice: `ralphie-muntz-loop` and `kontrol-pty-messaging` now document the bounded 4-tool PTY relay set (`submit_for_review`, `await_review_feedback`, `post_agent_message`, `await_agent_reply`); staged copies re-verified byte-identical, validator 62/62 PASS, archive rebuilt.
- Contents: `plugin.json`, `.codex-plugin/plugin.json`, `skills/<7 names>/SKILL.md` (18 zip entries, no `.app.json`, no validator, no report, no symlinks, no secrets)
- Staging source: `/home/bamn/devspace/devdesktop-plugin/` (in-repo, permanent)
- Validator: `/home/bamn/devspace/devdesktop-plugin/validate.mjs` — 62/62 PASS (`node validate.mjs`, exit 0)

## What changed

- Plugin name preserved: `dev-6a526f280aec81919bd3c5c6b9ad5a15` (no rename, no new plugin, same App ID family).
- Version `1.0.0` → `1.0.1` in both manifests. Confirm the live release is still `1.0.0` / `PluginRelease_a50fac8fcf008191bbbe577c737117ae` before uploading; if it moved, re-read and re-bump.
- `.app.json` intentionally omitted (overlay-only update preserves omitted files). Both manifests still declare `./.app.json`.
- 3 canonical repo skills patched (`.codex/skills/*/SKILL.md`, staged copies byte-identical):
  - `ralphie-muntz-loop`: generic worker framing, no duplicate session creation, timeout = still-pending, worker-side authority boundaries.
  - `nelson-wiggum-loop`: generic healthy `role:agent` worker map, no-reroute rule, reviewer-side authority boundaries.
  - `kontrol-supervised-mission`: mission-gated dispatch with worker-type selection, correction-round vs terminal-verdict reconciliation, mission-tool exposure conditional.
- 4 new canonical skills authored (repo + package): `kontrol-workspace-review`, `kontrol-acp-harness`, `kontrol-pty-messaging`, `kontrol-review-thread`.

## Discrepancy matrix (condensed)

All roles verified against source; skills now match:

- `submit_to_coding_agent` / `call_acp_agent` / `discover_agents` / `provide_review_feedback` / mission + handoff tools: reviewer-only. PTY credential: only `submit_for_review` + `await_review_feedback`. `post_agent_message`: worker-only; `resolve_agent_message`: reviewer-only; reply tools: worker-or-client (not over PTY credential). `configure_review_loop` modes: `pinned_conversation|isolated_review`; host `createThread:false`; activation is a one-time principal-bound grant, conversation IDs are correlation only. Browser/CDP output is transport evidence, never a verdict.

## NOT verified from here (operator-side blockers)

1. The installed release files (`.app.json`, `.codex-plugin/plugin.json`, exact release ID) live in ChatGPT's backend, not on this machine — no local copy exists. Fresh-read the release before `update_plugin` and confirm interface/display metadata carried over unchanged.
2. `update_plugin` parameter schema is unverified from here. Use the ChatGPT Plugin Creator surface (dashboard Upload/Update flow) with the exact backend `plugin_id`, the absolute archive path above, and a freshly read `expected_release_id`. No deleted paths.
3. Post-upload: read back the file inventory, verify version/release ID, confirm the App connection still works, open a fresh MCP connection if discovery is stale, confirm all 7 skills appear, and exercise (but do not impersonate) reviewer/ACP/PTY/thread flows.

## Release and rollback notes

- Skill-only overlay: safe to roll back by re-uploading the previous archive (no tool, connection, or identity changes in this package).
- Dispatch tools were NOT modified; no MCP catalog, auth, or runtime change ships here.

## Exact installation (DO NOT RUN without explicit authorization)

1. Fresh-read the installed plugin release; record its release ID.
2. Upload `/home/bamn/devspace/devdesktop-plugin/devdesktop-plugin-update-1.0.1.zip` as an **update to the existing plugin** (`plugin_asdk_app_6a526f280aec81919bd3c5c6b9ad5a15`), with the fresh `expected_release_id`.
3. Verify per §9 of the tasking (inventory, version, App connection, 7 skills, flows).
