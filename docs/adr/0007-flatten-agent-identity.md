# ADR 0007: Flatten Agent Identity and Retire Specialist Roles

## Status

Accepted.

## Context

Yive previously stored permanent Coder, Tester, Reviewer, and custom Roles on
Workers. Those records also carried descriptions and instructions, powered a
Role-template API and marketplace UI, influenced presentation, and were used
for authorization. In practice, a Worker's responsibility changes from one
Dispatch to the next, so permanent specialist metadata becomes stale and gives
the Runtime multiple competing descriptions of the same Agent.

The durable distinction Yive needs is structural: one Agent coordinates a
Workspace and the remaining Agents execute its Dispatches. Provider Sessions,
launch configuration, terminal history, Dispatch history, Notes, Reports, and
conversation projections do not depend on specialist Roles.

## Decision

Each Workspace has exactly one Orchestrator identity and zero or more flat
Worker identities. The Orchestrator identity is derived from the Workspace and
cannot be duplicated, demoted, promoted into, or deleted independently of the
Workspace. Workers cannot create nested Yive teams or become parents of other
Workers.

Persisted and public Agent identity uses only `kind: orchestrator | worker`.
Authorization derives from that kind. A Worker's concrete responsibility is
the text of its active Dispatch; implementation, testing, review, research, and
similar work are not permanent Agent types.

Schema version 54 rebuilds legacy Worker rows without Role or description
columns and removes Role templates. Existing Worker IDs and names remain
unchanged, while launch configuration, run and Provider Session binding,
Dispatches, Notes, Reports, conversation projections, terminal history, and
message history remain in their existing tables. Legacy Role-bearing creation
payloads are rejected rather than silently ignored.

Desktop, mobile, CLI, HTTP, and Relay surfaces no longer expose Role templates,
Role descriptions, Role instructions, specialist badges, Role-derived avatars,
or Role-specific random-name categories.

This decision supersedes only ADR 0006's decision to preserve ordinary
Coder/Tester/Reviewer Roles. ADR 0006's removal of Candidate Acceptance and its
preference for Manual Dispatch remain in force.

## Consequences

- Agent identity and authorization have one shared, stable vocabulary.
- An Orchestrator assigns responsibility explicitly in Dispatch text instead
  of relying on stale Worker metadata.
- Existing durable Agent and conversation state survives the migration.
- Clients must reject or migrate legacy Role-bearing payloads; they must not
  invent a replacement permanent responsibility label.
- Historical schema migrations may retain legacy Role constants solely to read
  old databases. They are not current product concepts or public APIs.
