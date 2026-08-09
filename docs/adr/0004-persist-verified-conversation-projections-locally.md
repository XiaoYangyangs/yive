# ADR 0004: Persist Verified Conversation Projections Locally

## Status

Accepted.

## Context

Reading provider session files for every mobile request would make pagination and refresh expensive, while relying on those files indefinitely would make Yive history disappear when a Provider moves or removes them. Copying complete provider logs would retain hidden reasoning, tool noise, and sensitive local data that Chat does not need.

## Decision

The local Runtime persists a rebuildable conversation projection in SQLite after a Codex or Claude Code session source verifies each conversational turn. The projection stores only the normalized user messages, Agent replies, timestamps, origins, delivery state, and limited tool activity metadata required by Chat. It excludes hidden reasoning, raw terminal output, raw tool logs, credentials, environment data, and unrelated provider records. Relay transports authenticated requests and responses but never owns or persists conversation projections.

Conversation projections have no automatic expiry. Deleting a Workspace or Agent removes its projections. A user may remove an individual historical projection without deleting the provider-native session; Yive retains a lightweight dismissal marker so later source scans do not silently re-import it.

Yive does not scan or backfill provider history that predates this feature or a conversation's first observation. When an older CLI session becomes active, the Runtime records its current source checkpoint as the conversation recording boundary and projects only subsequent verified turns.

## Consequences

- Chat history remains readable and paginates locally when a provider session file is temporarily unavailable or later removed.
- The UI must identify stale projections when the active source cannot be refreshed.
- Database migrations, deletion semantics, data export, and sensitive-content tests must cover conversation projections.
- Provider adapters remain responsible for verification and incremental checkpoints; the projection is not permission to infer messages from terminal output.
- Existing Provider history remains untouched and invisible unless new turns are observed after that session's recording boundary.
