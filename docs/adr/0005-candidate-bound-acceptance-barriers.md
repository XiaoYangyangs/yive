# ADR 0005: Candidate-Bound Acceptance Barriers

## Status

Superseded by ADR 0006.

## Context

Serial Tester/Reviewer handoffs, polling, and repeated Orchestrator wake-ups make verification expensive and can mix evidence from different code versions. A moving Workspace also makes it unclear what a successful test actually verified. We need an opt-in workflow that preserves ordinary Manual Dispatch behavior while making verification repeatable and auditable.

## Decision

The first formal workflow is `candidate-acceptance`. It binds every Acceptance Gate to an immutable committed Candidate and runs Tester, Reviewer, and full CI in parallel after fast preflight. Workflow roles bind to reusable Execution Profiles that separate CLI, model Provider, concrete model, reasoning policy, and user-defined budget class. Workflow start pins the selected profile revision for every role, and every Attempt copies and revalidates that exact revision without silently changing models. The initial plan also stores separate Coder, Tester, and Reviewer briefs; an optional Candidate checkpoint may wake the Orchestrator once before preflight and Gate scheduling, while automatic continuation remains the default.

Runtime persists structured Gate reports, aggregates them in one immutable Acceptance Barrier, and emits one durable aggregate Wake Event only when the workflow needs an Orchestrator decision or reaches a final conclusion. Passing Differential acceptance advances automatically to a fresh full Final acceptance; it cannot approve a Candidate. Required Gates cannot be waived, remediation requires explicit Orchestrator approval, and local Candidate acceptance does not depend on a Git remote or push.

## Consequences

- Gate reports can be collected without waking or burdening the Orchestrator individually.
- A report is meaningful only together with its Candidate and Acceptance round; later Workspace changes require a new Candidate.
- Runtime must own durable Workflow state, idempotency, report validation, Barrier aggregation, Wake Events, and isolated Acceptance worktrees.
- Workflow logic remains independent from model vendors, while unavailable or incompatible Execution Profiles stop affected work instead of causing an unaudited fallback.
- Role-specific instructions can be prepared before the Orchestrator sleeps; exceptional objectives can pay for one explicit post-Candidate checkpoint instead of making every objective wake the Orchestrator.
- The strict final full sweep costs more than reusing earlier evidence, but prevents differential or stale evidence from being mistaken for full verification.
- Manual Dispatch remains available for objectives that do not need this Workflow.
