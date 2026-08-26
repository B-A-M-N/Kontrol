# Kontrol Claude workflow

This directory contains the project-local workflow and agent definitions used
for Kontrol development. The workflow files and agent prompts describe the
review and verification contract; durable ACP state in Kontrol's database is
the authority for work-session status and approval.

`.claude/settings.local.json` is intentionally ignored and machine-local. It
may grant a developer's local runtime permission to invoke tools, but it is
not project policy, acceptance evidence, or a source of workflow truth. Do
not commit secrets or rely on local settings to establish review authority.
