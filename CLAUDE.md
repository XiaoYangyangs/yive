# CLAUDE.md

This file gives AI coding tools public-safe project context for Hive. It stays
brief by design: unpublished implementation plans and product strategy are not
published in this repository.

## What Hive Is

Hive is a browser-native workbench for coordinating multiple local CLI agents.
Users create a workspace, start one Orchestrator agent, add worker agents, and
let them communicate through the Runtime-backed `team` CLI.

Key properties:

- Managed Agents are real local Codex or Claude Code PTY processes.
- The web UI talks to a local Node runtime over HTTP and WebSocket on
  `127.0.0.1`.
- Workspace metadata and Runtime-owned Dispatch state are stored locally in SQLite.
- `team send`, `team report`, `team status`, and related commands are only
  injected into Hive-managed agent sessions.

## Public Development Source Of Truth

For public work, use these files as the source of truth:

1. `README.md` / `README.en.md` for user-facing behavior.
2. `AGENTS.md` for coding and review constraints.
3. Existing code and tests for implementation details.
4. GitHub issues and PR discussion for scoped changes.

If behavior is unclear, ask in an issue or PR before inventing protocol changes.

## Agent skills

### Issue tracker

Issues and PRDs are tracked as local markdown files under `.scratch/`; external PRs are not part of the triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The local issue workflow uses the default Matt Pocock skill labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo: read `CONTEXT.md` and relevant ADRs under `docs/adr/` before design, debugging, implementation, or review work. See `docs/agents/domain.md`.

## Engineering Rules

- Keep protocol payloads stable and use snake_case on HTTP/JSON boundaries.
- Preserve the canonical Agent state dimensions documented in `AGENTS.md`; do
  not collapse them into an aggregate `idle`, `working`, or `stopped` status.
- Do not add production fallbacks only to make tests pass.
- Prefer real integration coverage for HTTP, SQLite, and PTY behavior.
- Avoid broad refactors unless they directly support the change being made.

For the full local coding rules, read `AGENTS.md`.
