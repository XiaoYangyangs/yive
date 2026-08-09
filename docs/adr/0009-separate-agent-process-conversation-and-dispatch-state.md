# ADR 0009: Separate Agent Process, Conversation, and Dispatch State

## Status

Accepted.

## Context

Yive previously exposed one aggregate Agent status with `idle`, `working`, and
`stopped` values. That field mixed three different facts: whether a PTY process
was alive, whether the Provider conversation was in a turn, and whether a
Worker owned pending work. Consumers then reconstructed meaning from pending
counts, terminal output, or elapsed silence.

Those inferences are unsafe. A running Agent may be busy, idle while retaining
an active Dispatch, idle without a Dispatch, or unreadable. A crashed Agent may
still own an active Dispatch that must remain recoverable. Terminal silence is
also not a Provider turn boundary.

## Decision

The Runtime exposes one canonical Agent state projection with independent
dimensions:

- process state: `running`, `stopped`, or `crashed`;
- Provider conversation activity: `busy`, `idle`, or `unknown`;
- nullable active Dispatch identity;
- queued Dispatch count;
- nullable queue pause reason; and
- last observation time.

The legacy aggregate Agent `status` and pending-task count are not public state
authorities. Desktop, mobile, Relay, Runtime HTTP, and Team consumers use the
canonical projection and do not derive it locally.

Only native Codex and Claude conversation events can establish busy-to-idle
transitions. An unreadable, missing, or otherwise unverifiable active Provider
source yields `unknown` while the last persisted conversation remains readable.
Quiet time alone does not invalidate healthy idle evidence.

Process exits update process state independently of Dispatch persistence. An
explicit stop produces `stopped`; an unexpected exit or unfinished run found
during Runtime recovery produces `crashed`. Neither transition silently closes
an active Dispatch or removes queued work.

Schema v57 conservatively maps every pre-v57 terminal run to `crashed`. The old
`exited` status did not record whether the exit followed an explicit stop, so
migration cannot truthfully reconstruct `stopped`; only post-v57 lifecycle
events can establish that fact.

Canonical state requires at most one active Dispatch per Worker. Schema v57
keeps the earliest legacy `submitted` Dispatch active, moves any later ones
back to a clean `queued` state, and enforces the invariant with a partial unique
index. Orchestrator sends for the same Workspace and Worker are serialized
before message or Dispatch creation, Agent startup, and PTY delivery. A failed
send does not block later sends, and sends to different Workers remain
independent. Direct ledger-only queue creation remains synchronous and does not
participate in this delivery lock.

Any automatic operation requiring a safe Provider boundary must recheck the
current canonical state immediately before delivery. Both `busy` and `unknown`
fail closed. User-authorized forced Chat delivery remains a separate explicit
operation and does not claim an idle boundary.

`queue_pause_reason` is nullable because a queue may not be paused. The queue
lifecycle defines concrete pause reasons when queue activation and failed-report
handling are implemented; absence of a pause is represented as `null`, not an
invented default reason.

## Consequences

- Public JSON uses snake_case fields such as `process_state`,
  `conversation_activity`, and `last_observed_at`.
- Runtime persistence records process state explicitly and marks unfinished runs
  crashed during startup recovery.
- Dispatch persistence cannot represent multiple `submitted` rows for one
  Worker, so canonical active Dispatch projection remains total for migrated and
  newly written data.
- UI presentation may combine dimensions into readable labels, but the source
  payload remains lossless and each dimension stays visible when relevant.
- A Worker can be `running + idle + active`, which means it is awaiting a Report
  rather than available for new work.
- `running + unknown`, `busy`, and `crashed + active` remain distinguishable and
  block automation that requires verified idle state.
- Schema version 57 records the process-state migration. Relay transports the
  new Runtime payload without becoming an Agent-state authority.
