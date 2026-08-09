# ADR 0006: Remove Candidate Acceptance Orchestration

## Status

Accepted.

## Context

The candidate-bound workflow successfully modeled parallel verification and aggregated reporting, but it required users to understand Workflow Intents, Acceptance Plans, Execution Profiles, role briefs, Gates, Barriers, checkpoints, and recovery controls before work could begin. The resulting configuration and UI burden outweighed the Token savings from avoiding intermediate Orchestrator reports and made routine multi-Agent collaboration harder to operate.

## Decision

Remove the `candidate-acceptance` Workflow and its dedicated Execution Profile system as product concepts. Preserve Manual Dispatch, Dispatch notes, ordinary Coder/Tester/Reviewer roles, and general team coordination. Future reductions in Orchestrator Token usage should use a smaller Runtime-owned batching or notification policy that does not require a second orchestration model, a separate launch configuration catalog, or a formal Workflow lifecycle.

## Consequences

- Yive returns to one primary coordination model: explicit user/Orchestrator Dispatches and Worker reports.
- Candidate, Gate, Barrier, Workflow Intent, Acceptance Plan, and Execution Profile surfaces and persisted state are retired together rather than left partially active.
- The active installation contained no user-created Workflow, Candidate, Gate, credential, profile-pin, or role-default records when this decision was made, so retired tables are removed without an archive; non-Workflow Workspace, Agent, Dispatch, note, chat, and terminal data remain intact.
- Durable Dispatch notes and unrelated reliability fixes remain available.
- Any future automated verification feature must justify its concepts independently and begin from a minimal user interaction rather than reviving the removed Workflow by default.
