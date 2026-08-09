# Yive Domain Context

This file is the shared glossary and operating context for agents working in this repo. Read it before changing runtime, mobile, Relay, PTY, or team orchestration behavior.

## What Yive Is

Yive is a local browser workbench for coordinating real CLI agents. The desktop runtime starts and owns the local PTY processes; the browser UI, mobile UI, and Relay only control or observe those processes through explicit runtime APIs.

## Core Terms

- **Workspace**: A user-selected project directory managed by Yive. Workspace metadata and Runtime-owned coordination state are stored locally.
- **Orchestrator**: The single coordinator identity for a Workspace. It may be renamed, stopped, restarted, or reconfigured, but it cannot be duplicated, demoted, or deleted independently of its Workspace.
- **Worker**: A flat team-member identity inside a Workspace. Workers are real CLI sessions, not invisible model subagents, and they cannot create nested Yive teams or become parents of other Workers.
- **Worker responsibility**: The concrete work assigned to a Worker by its active Dispatch. Implementation, testing, review, research, and similar responsibilities are task text, not permanent Agent Roles or authorization identities.
- **Managed Agent**: An Orchestrator or Worker process launched and supervised by Yive through a supported Provider Adapter. Managed Agents are distinct from ordinary Workspace Shell terminals.
- **Canonical Agent state**: The Runtime-owned projection of independent process state, Provider conversation activity, active Dispatch identity, queued Dispatch count, nullable queue pause reason, and last observation time. Consumers use this projection directly and never reconstruct an aggregate status from pending work or terminal output.
- **Agent process state**: Whether the Runtime knows the managed Agent process to be `running`, explicitly `stopped`, or unexpectedly `crashed`. Process state does not imply that the Provider conversation is idle and does not complete or cancel a Dispatch.
- **Agent Provider**: The native CLI integration used by a managed Agent. Codex and Claude Code are the complete supported set; model, reasoning, authentication, and other Provider-specific preferences remain in the Provider's own configuration.
- **Workspace Shell**: An ordinary interactive shell rooted in a Workspace. It is not a managed Agent, has no Agent identity or Provider Session, and is not part of the Team hierarchy.
- **Dispatch**: A persisted assignment from an Orchestrator to a Worker. A Dispatch represents work ownership and its lifecycle, not supplemental conversation about that work.
- **Dispatch note**: Append-only supplemental context attached to an existing Dispatch. It may contain concise text and referenced Artifacts, but it does not replace the original assignment, create a new Dispatch, or increase the Worker's task queue; it is delivered without forced interruption and must be acknowledged before the Dispatch can be finally reported.
- **Dispatch report**: A persisted final result submitted by a Worker for one Dispatch and delivered to the Orchestrator.
- **Final report slot**: The single immutable terminal-result position owned by one Dispatch. Identical transport retries return its existing receipt without repeating effects; a conflicting later payload cannot overwrite it.
- **Runtime**: The local Node process that owns workspaces, PTYs, SQLite state, HTTP routes, and WebSockets.
- **Relay**: A public or LAN routing service for paired desktop and mobile clients. Relay routes authenticated envelopes; it must not read local workspaces or run agents.
- **Desktop connector**: The desktop-side client that connects local runtime state to Relay.
- **Mobile controller**: The phone UI that controls an already running desktop runtime. It must not expose CLI agent tokens or run agents itself.
- **Chat view**: The default mobile Agent view for reading and sending structured conversational turns. It presents conversation content independently from raw terminal rendering.
- **Conversation turn**: A user input or Agent reply whose author and boundaries are verified by Yive-owned records or a provider-native session source. Unclassified terminal output is not a conversation turn.
- **CLI session**: A provider-owned conversational session identified by the CLI's durable session identity. It remains the same session when its terminal process restarts and successfully resumes that identity.
- **Active CLI session**: The CLI session identity currently verified for an Agent's live terminal run. Chat submissions require this identity and are never provisionally assigned to a terminal run while session detection is unresolved.
- **Agent conversation**: The ordered conversation turns associated with one Agent in one CLI session, regardless of whether a turn originated on desktop or mobile. A new CLI session starts a new Agent conversation; a new terminal run or device switch alone does not.
- **Historical conversation**: An Agent conversation whose CLI session is not currently active for that Agent. It is read-only in Chat and cannot be resumed, merged, or made active from the Chat view.
- **Conversation projection**: Yive's local, durable copy of verified conversation turns and limited activity metadata derived from a CLI session. It excludes hidden reasoning, raw terminal history, raw tool logs, credentials, and environment data.
- **Conversation recording boundary**: The Provider source position from which Yive began observing one CLI session. Conversation projection never backfills turns before this boundary, including when an older session is resumed later.
- **Stale conversation projection**: A conversation projection that remains readable while its active Provider source cannot currently be refreshed or verified. Its activity state is unknown, so queued submissions do not leave the queue automatically.
- **Dismissed conversation**: A historical conversation whose Yive projection the user removed from local history. Its provider-native source is untouched, and Yive retains only enough identity metadata to avoid importing it again automatically.
- **Chat submission**: A complete user message recorded by Yive and delivered to the active CLI session through its real PTY. Delivery and provider-session confirmation are distinct states, and failed delivery is never retried automatically.
- **Delivered chat submission**: A chat submission already written to the PTY. It is an immutable conversation fact and cannot be edited, withdrawn, or individually deleted from Chat.
- **Confirmed chat submission**: A delivered chat submission matched to a verified user turn in the Provider-native session source. Delayed confirmation does not make PTY delivery a failure.
- **Chat draft**: Unsubmitted text and image selection stored only on the mobile device for one Agent and CLI session. Drafts never move across conversations or enter the Runtime submission queue until the user submits them.
- **Chat attachment**: An image bound atomically to one chat submission and represented in its conversation turn. General document transfer remains File exchange rather than Chat attachment behavior.
- **Safe chat content**: Conversation content rendered as passive Markdown without executable HTML, scripts, iframes, or remote images. External navigation requires confirmation, and local absolute paths are not exposed to mobile clients.
- **Undelivered chat submission**: A chat submission for which the mobile controller did not receive Runtime acceptance. It remains visible and retryable under the same identity but is never sent automatically after connectivity returns.
- **Chat submission authority**: Permission to deliver one complete chat submission without acquiring terminal ownership. It grants no terminal viewing, resize, or ongoing keystroke control.
- **Chat input normalization**: The deliberate clearing of the CLI's current editable input line with `Ctrl+U` immediately before a chat submission is written. It prevents message concatenation but discards any unsubmitted desktop draft on that line.
- **Queued chat submission**: A chat submission bound to one Provider and CLI session, retained visibly while its Agent conversation is busy, and delivered in order after the current turn finishes. The user may cancel it before delivery or explicitly override the wait.
- **Paused chat submission**: A persisted queued chat submission awaiting user confirmation after Runtime restart or another loss of reliable active-session context. It cannot resume automatic delivery until explicitly confirmed.
- **Migrated chat submission**: A new chat submission created when the user explicitly copies a paused message from its original CLI session into the currently active conversation. The original submission remains unsent and is never silently retargeted.
- **Forced chat submission**: A queued chat submission that the user explicitly chooses to deliver immediately while the Agent conversation is still busy. It sends the complete message without `Ctrl+C` or any other interruption command; the CLI Agent decides when to react.
- **Working reply**: The transient Agent-side conversation item shown while the current turn is in progress. Its activity state may update immediately, but its body contains only reply content verified by the provider-native session source.
- **Unread reply**: A completed verified Agent reply that the user has not yet brought into the latest visible region of its conversation on that mobile device. Tool progress and working-state updates do not create unread replies.
- **Conversation activity state**: The busy, idle, or unknown state derived from verified Provider turn boundaries for one Agent conversation. Terminal silence and generic Agent status do not prove that a conversation is idle.
- **Agent state observation time**: The most recent time at which the source supporting the canonical Agent state was observed. Quiet does not make healthy idle evidence stale; an unreadable or unverifiable active Provider source instead yields unknown conversation activity.
- **Tool activity summary**: A compact, secondary account of verified tool activity within an Agent turn. It communicates progress, outcome, and duration without treating raw tool logs or hidden reasoning as conversation turns.
- **Raw terminal view**: The alternate mobile Agent view that exposes the real PTY interaction surface for terminal-native workflows and diagnostic fallback.
- **Terminal run**: A runtime-managed PTY session for an agent.
- **Terminal restore**: The process of attaching a viewer to an existing terminal run and reconstructing enough terminal output for the viewer to become useful.
- **Restore window**: The bounded portion of terminal history used for initial terminal restore. It is a performance-oriented view of recent output, not the complete persisted terminal history.
- **Scrollback inertia**: A mobile-only local viewing behavior where normal terminal history continues decelerating after touch release. It must not send PTY input and does not apply to alternate-screen TUI scrolling.
- **Terminal scroll settings**: Mobile terminal-page settings that tune local terminal viewing behavior such as scrollback inertia frame rate. They do not change PTY output, terminal ownership, or CLI input semantics.
- **Terminal ownership**: The rule that only one viewer at a time may control the real PTY size and input authority.
- **Takeover**: An explicit mobile mode where the phone becomes the active owner of the real PTY size. It must be visible, reversible, and restored on release when possible.
- **Passive viewer**: A viewer that may receive output but must not resize the real PTY.
- **Active viewer**: The viewer that currently owns terminal size and may send owner-scoped resize operations.
- **File exchange**: Temporary mobile/desktop file transfer. It is not workspace persistence and must not execute or preview unsafe files automatically.
- **Team Help**: Authenticated, role-aware command discovery generated from the Runtime Team command registry. Root Help lists only commands the current Orchestrator or Worker may use; command Help owns syntax, effects, errors, and one example.
- **Runtime Context**: A bounded, Runtime-owned projection of current Team responsibility and canonical Agent state. It is queried explicitly with `team context` and does not replay message history, Tasks content, credentials, or internal machine identifiers.
- **Context compaction boundary**: A Provider-native `compact_boundary` or `context_compacted` event. Yive may respond with one bounded Runtime Context snapshot; the Provider's compression summary is never projected as a conversation turn.

## Development Guardrails

- Treat the real PTY as the source of truth. If desktop terminal state is already bad, diagnose desktop/runtime state before changing mobile rendering.
- Preserve the public protocol boundary: HTTP and JSON payloads use snake_case.
- Preserve the flat Agent identity model: one Orchestrator and zero or more Workers per Workspace. Do not persist or serialize specialist Roles, Role descriptions, Role instructions, or Role templates.
- Preserve the managed Provider boundary: managed Agents use only Codex or Claude Code, while arbitrary shell commands remain confined to Workspace Shell terminals. Do not restore custom Agent commands, command presets, generic Session capture, or Yive-owned Provider credentials and model settings.
- Preserve the canonical Agent state model. Keep process state, Provider conversation activity, Dispatch responsibility, queue state, and observation time independent; automation requiring an idle boundary rejects busy or unknown activity.
- Preserve progressive disclosure. Do not append Team tutorials or generic reminder envelopes to normal user, Dispatch, Status, or Report messages; use authenticated Help and explicit Runtime Context instead. Do not create, read, or refer Agents to `.hive/PROTOCOL.md`.
- Keep mobile tokens, UI tokens, Relay tokens, and CLI agent tokens isolated.
- Keep Relay dumb: authenticate, route, track presence, and transfer temporary files only.
- For mobile terminal work, read `requirements/mobile-remote-control/TERMINAL_CONTRACT.md` and `docs/adr/0001-mobile-terminal-ownership.md` first.
- For broad design changes, add or update an ADR before changing code.
