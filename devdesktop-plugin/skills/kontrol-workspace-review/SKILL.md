---
name: kontrol-workspace-review
description: Direct workspace inspection, code audit, bounded edits, tests, dirty-tree protection, and evidence-based findings for Kontrol. Use for direct WebUI review work before considering optional worker delegation.
version: 0.1.0
---

# Kontrol Workspace Review

Direct inspection and code work inside an opened Kontrol workspace. Direct workspace work comes first; optional worker delegation is bounded assistance only, never the default.

## Opening a workspace

Call `open_workspace` once per local folder or worktree, then reuse the returned `workspaceId`. Do not reopen the same folder unless the ID is rejected, you switch folders, or the user asks.

`AGENTS.md` instructions arrive automatically through `open_workspace` and later tool calls. Follow them.

## Inspection tools

The structured inspection set is available in every tool mode: `read`, `grep`, `glob`, `ls`, `git_status`, `git_log`, `git_diff`, `git_show`. Prefer these over shell equivalents: they enforce root allowlists, symlink containment, output bounds, and file-version hashes.

- `read` returns content plus the SHA-256 of the complete file bytes, capped at 600 lines. Use `offset`/`nextOffset` for longer files.
- `grep`, `glob`, `ls`, and Git output share a bounded text cap and report truncation. Do not assume untruncated output.
- `git_show` with a `path` returns the file or tree object at `<revision>:<path>`; without a path it returns revision metadata and stats.

## Bounded edits

`write` and `edit` accept an optional `expectedContentSha256` precondition, checked under a process-wide mutation coordinator immediately before mutation. Overlapping same-version edits serialize; a `file_version_conflict` leaves all files unchanged. Supply the expected hash whenever you read-then-wrote a file another actor may also touch.

Ordinary `bash` runs in detached process sessions with a bounded yield; a still-running command returns a process session for the read-only `poll_process` tool. One checkout runs one modifying session at a time unless the user explicitly accepts shared-working-tree risk.

## Dirty-tree protection

The checkout may contain unrelated uncommitted work from other agents. Rules:

- Never clean, stash, reset, or blanket-reformat the tree to suit your task.
- Inspect `git_status` before editing so your diff stays attributable.
- Leave unrelated dirty paths untouched. If a file mixes your change with someone else's, flag it for review rather than copying or reverting blindly.
- No commit, push, deploy, or restart without explicit authorization.

## Evidence-based findings

Every finding needs: the observed behavior, the exact file and line (or command and output), and the invariant it violates. Distinguish source-complete (code read) from live-proven (command executed against the running generation). A passing test on a different build does not qualify the current one.

## Authority boundaries (do not cross these)

- Inspection tools are read-only; edits go through `write`/`edit`/`apply_patch` with governing-instruction acknowledgement. Do not use shell redirection to bypass file-tool containment.
- Approval-gated operations return a durable retryable `approval_required` result. The reviewer approves through `provide_policy_approval`; approval of one operation never authorizes a different operation, owner, or workspace.
- Never expose credentials, tokens, or cookies in tool arguments, logs, or findings.

## When to Use This Skill

- Reviewing, diagnosing, or editing code directly in the workspace
- Running tests and reporting exact observed results
- Auditing a dirty checkout without disturbing others' work
- Before deciding whether bounded worker assistance is needed at all
