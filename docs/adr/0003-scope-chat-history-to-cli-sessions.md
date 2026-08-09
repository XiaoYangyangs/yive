# ADR 0003: Scope Chat History to CLI Sessions

## Status

Accepted.

## Context

An Agent may have many terminal runs and may use different provider-native sessions over time. Joining those records by Agent or terminal run would either split one resumed conversation or merge unrelated contexts. Allowing Chat to resume an old session would also make a reading interface responsible for CLI lifecycle control.

## Decision

Each Agent conversation is scoped to exactly one provider-owned CLI session identity. Terminal restarts that resume the same identity continue the conversation; a different CLI session starts a separate conversation. Historical conversations are read-only in Chat. Chat does not resume, activate, merge, or switch CLI sessions; users perform those lifecycle operations explicitly in the raw terminal, and Chat follows the session that becomes active.

## Consequences

- Conversation storage and pagination keys must include provider and CLI session identity rather than only Agent or terminal run IDs.
- Yive must detect active CLI session identity changes even when a user performs resume operations interactively in an existing terminal run.
- The historical conversation list can navigate records but offers no resume action.
- Queued submissions remain bound to the Provider and CLI session active when they were created. A session change pauses them; moving their content to the new active conversation is an explicit user action that creates a new submission identity.
