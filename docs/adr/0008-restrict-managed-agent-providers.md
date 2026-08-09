# ADR 0008: Restrict Managed Agent Providers to Codex and Claude Code

## Status

Accepted.

## Context

Yive previously exposed OpenCode, Gemini, user-created command presets, and
arbitrary startup commands as if they were equivalent managed Agent Providers.
Those paths depended on Provider-specific prompt heuristics, input profiles,
Session scanners, and resume behavior that could not satisfy the native
instruction, verified activity, durable Session, and interruption contracts
required by Team coordination.

Ordinary project shell access is a separate need. Treating a Workspace Shell
as an Agent would give it an identity and coordination semantics it does not
have, while removing it would make routine terminal work unnecessarily hard.

## Decision

Codex and Claude Code are the complete managed Agent Provider set. Every
Orchestrator and Worker stores one of those Provider identities and launches
through its native Provider Adapter. Worker creation inherits the
Orchestrator's Provider unless the Orchestrator explicitly selects the other
supported Provider.

Yive does not persist arbitrary Agent commands, command presets, environment
overrides, Provider credentials, models, reasoning settings, or generic
Session-capture rules. Those preferences remain in the native Provider
configuration. Unsupported legacy launch configurations and their Session
bindings are retired during migration and are never guessed into Codex or
Claude Code.

Workspace Shell terminals remain available through their independent Runtime
and UI surface. They are not managed Agents, do not join the Team hierarchy,
and do not acquire a Provider or Provider Session.

## Consequences

- HTTP, CLI, desktop, mobile, Relay, and persisted managed-Agent boundaries
  expose only `codex` and `claude`.
- Provider Adapters own native instruction injection, Session capture and
  resume, verified activity, prompt readiness, and current-turn interruption.
- Removing a legacy launch configuration can leave its Agent stopped and
  unconfigured; explicit user action is required instead of silently changing
  its Provider.
- Tests may inject deterministic Codex or Claude fixtures behind the Provider
  Adapter boundary, but public production APIs cannot configure arbitrary
  managed-Agent commands.
