# ADR 0010: Progressive Team Help and Runtime Context

## Status

Accepted.

## Context

Yive previously taught Team coordination through a large startup tutorial,
repeated reminder envelopes on normal turns, and a generated
`.hive/PROTOCOL.md`. These surfaces became stale, duplicated command syntax,
leaked internal context into prompts, and encouraged Agents to treat old task
text as current responsibility.

## Decision

- One Runtime-owned Team command registry is the source for authorization and
  authenticated root/command Help.
- Root Help is role-aware. An unauthenticated CLI receives only a discovery
  message; command syntax is disclosed after Agent authentication.
- `team context` is the source for current facts. Default Orchestrator context
  is bounded team state; focused Worker and Dispatch context expands only the
  authorized responsibility and delivered supporting material.
- Default member summaries and focused queue/Note collections use bounded
  windows with total or truncation metadata. Status and cancellation details
  are shown only while they remain current for the active or latest lifecycle.
- Normal user input is written byte-for-byte unchanged. Dispatch, Status, and
  Report prompts carry event metadata and body only; they do not append generic
  tutorials, reminders, or nested-agent instructions.
- Restart recovery injects one bounded Runtime Context projection. Native
  Provider Session resume injects nothing. If the projection is unavailable,
  the Agent receives only a concise instruction to run `team context`.
- Provider-native `compact_boundary` and `context_compacted` events may trigger
  one bounded Context projection. Compression summaries, hidden reasoning,
  credentials, and internal Workspace/Agent/Session identifiers are excluded.
- Yive no longer creates or reads `.hive/PROTOCOL.md`. A file with the legacy
  auto-generated signature is removed at Workspace startup; user-authored files
  at that path are preserved.

## Consequences

- Help and Context evolve with the Runtime registry and public authorization
  boundary instead of a Workspace-local document.
- Agents can recover current responsibility through an explicit, bounded
  query without replaying message history or relying on a Workspace-local backlog.
- Provider compaction remains observable at the source boundary while its
  provider-generated summary never becomes a Yive conversation turn.
- Existing managed protocol files are cleaned up conservatively. Runtime-owned
  Dispatch state remains the coordination source of truth.
