# Mobile Terminal UX Strategy

## Goal

Build the best practical mobile experience for controlling Hive agents from a phone.
The mobile UI must feel like a native chat/control surface while preserving access to the
real desktop CLI when needed.

The current raw xterm mirror is accurate, but it is not enough for mobile:

- Long desktop terminal lines are hard to read on a narrow screen.
- Resizing the real PTY from mobile can break the desktop view.
- Viewer-only reflow can desynchronize TUI cursor state, input echo, and alternate-screen output.
- Font squeezing makes text visually poor.

## Key Constraint

Desktop terminal quality comes from resizing the real PTY to the desktop panel.
Mobile cannot blindly reuse that behavior because it would resize the computer's active CLI.

Therefore the mobile product needs two layers:

1. A mobile-first agent conversation surface for normal use.
2. A raw terminal surface for exact PTY control and debugging.

## Recommended Architecture

Team research conclusion:

- Mobile: raw xterm is accurate but not mobile-friendly; the main UI should be chat-first.
- Desktop: the stable desktop behavior depends on FitAddon-driven real PTY resize.
- Backend: the existing terminal hub already distinguishes active and passive viewers; mobile takeover should be modeled as explicit resize ownership.
- Test/Safety: the solution must prove that passive mobile viewing never resizes the desktop PTY, while takeover is explicit, reversible, and safe.

### 1. Agent Conversation View

Default mobile view should be a chat-like timeline:

- User prompts, agent replies, status updates, command summaries, and file/image attachments are shown as messages.
- Long text wraps naturally.
- Uploaded images are visible as image attachments rather than terminal text paths.
- Dangerous actions such as stop/restart remain behind a menu and confirmation.
- Saving is presented as a binding to the current Provider-native CLI session, never as a terminal snapshot. Safe stop checks that binding without sending content; only a separately confirmed recovery checkpoint may add one visible minimal turn.
- The raw terminal remains available from the agent detail page.

Implementation direction:

- Follow [`CHAT_VIEW_PLAN.md`](./CHAT_VIEW_PLAN.md) for the accepted conversation design.
- Build a verified, local SQLite conversation projection from incremental Codex and Claude Code native session records. Do not infer conversation turns from PTY output.
- Use a distinct `chat_submit` lifecycle for whole-message PTY delivery; do not disguise Chat as raw `terminal_input`.
- Keep upload file ids as internal transport handles. Before delivery, bind them to the current submission and put only structured, normalized Workspace-relative Artifact references in Provider input; never put an absolute path or attachment-registry lookup tutorial in terminal input. Attachment-bearing mobile actions negotiate Artifact contract v2, which preserves caller-authored terminal text and retires the old `registry_path` result shape explicitly.
- Start recording at each session's first Yive observation and do not scan or backfill older Provider history.
- Keep Chat independent from terminal restore, takeover, and terminal WebSockets.

### 2. Raw Terminal View

Raw terminal mode remains a faithful PTY mirror:

- Keep `propagateResize=false` for normal mobile viewing so the phone does not resize the desktop PTY.
- Preserve the terminal's real cols/rows for correctness.
- Use horizontal panning or a dedicated "fit" experiment only as an optional display aid.
- Do not make squeezed text the default.
- Raw terminal should be framed as "advanced/exact terminal", not the primary mobile reading experience.
- The current `passive=1` / `propagateResize=false` path is the correct default safety boundary.

### 3. Mobile Takeover Mode

For users who need a fully correct mobile terminal layout:

- Add an explicit "phone takeover" action.
- When enabled, mobile becomes the active controller and the real PTY is resized for the phone.
- Desktop becomes passive or clearly indicates that the phone is controlling the terminal size.
- On exit, restore the desktop terminal size if the desktop viewer is still connected.

This is the only terminal-native way to get correct mobile reflow for full-screen TUIs.
It must be explicit because it affects the desktop session.

Suggested protocol direction:

- Client query: `mode=active|passive|takeover`, plus existing `clientId`, `cols`, `rows`, `pixelWidth`, `pixelHeight`.
- Client control messages:
  - `{ type: "takeover_request", cols, rows, restore_on_release?: boolean }`
  - `{ type: "takeover_release" }`
  - `{ type: "resize", cols, rows, pixelWidth?, pixelHeight? }`
- Server control messages:
  - `{ type: "takeover_granted", previousSize, cols, rows }`
  - `{ type: "takeover_denied", reason }`
  - `{ type: "size_owner_changed", ownerClientId, mode, cols, rows }`
  - Extend restore messages with optional owner metadata.

Suggested server state:

```ts
type TerminalSizeOwner =
  | null
  | {
      clientId: string
      mode: "desktop" | "mobile_takeover"
      previousSize?: { cols: number; rows: number }
      acquiredAt: number
      expiresAt?: number
      restoreOnRelease: boolean
    }
```

Release behavior:

- Explicit release restores the previous desktop size when available.
- Disconnect release must also restore previous size when `restoreOnRelease` is true.
- If no desktop size is known, fall back to the canonical mirror size or runtime default.
- Only the current size owner can resize the real PTY.

### 4. Per-Viewer Mirrors

Per-viewer mirrors can be explored, but they are not the primary recommendation.
They may work for line-oriented output, but full TUI output is generated for the real PTY size,
so cursor movement and alternate-screen rendering can diverge when the viewer uses different cols/rows.

Do not prioritize per-viewer mirror reflow before chat timeline and takeover.
It is useful for transcript/search/summary, not for faithful full-screen terminal rendering.

## Milestones

### M1: Strategy And Guardrails

- Land this strategy document.
- Keep raw mobile terminal in safe passive mode.
- Document test gates for passive viewing and takeover.
- Do not add another font-squeeze workaround as the default.

### M2: Stabilize Raw Terminal

- Keep mobile from resizing desktop PTY by default.
- Preserve input echo and cursor alignment.
- Preserve touch scrollback and Ctrl/Esc/Tab helper actions.
- Keep raw terminal accessible from each agent.

### M3: Conversation Timeline Prototype

- Build the default mobile Chat view beside an explicit Raw terminal mode.
- Render verified user turns, Agent replies, compact tool activity, delivery state, and image attachments.
- Add cursor paging, Provider-driven working state, queue/force behavior, and local draft/undelivered handling.
- Remove Agent-list terminal connection preload; open terminal sockets only in Raw terminal.

### M4: Attachment UX

- Show uploaded images as visible cards in the conversation timeline.
- Keep native CLI paste as best effort.
- Fall back to Runtime-bound Workspace-relative Artifact references without exposing transport file ids, attachment-registry internals, absolute local paths, or base64 to the Provider.

### M5: Mobile Takeover Prototype

- Add explicit takeover start/stop actions.
- Persist and restore desktop terminal size.
- Surface takeover state on desktop and mobile.
- Add second confirmation because takeover affects the real PTY.

### M6: Verification And UAT

- Add automated coverage for passive mobile terminal, transcript events, attachments, and takeover.
- Add Playwright mobile viewport checks.
- Run LAN real-device UAT before considering the experience complete.

## Proposed Team Split

### Mobile

- Build `MobileAgentChat` and `MobileAgentComposer`.
- Keep raw terminal behind a mode switch.
- Design attachment cards and local echo states.
- Ensure the 390px mobile viewport remains readable.

### Desktop Adapter

- Keep desktop terminal as the canonical active viewer by default.
- Add desktop UI indication when mobile takeover is active.
- Preserve and restore desktop terminal size around takeover.
- Ensure portal parking and hidden slots do not emit accidental resize.

### Backend

- Add terminal size ownership to `terminal-stream-hub`.
- Extend `terminal-protocol` and `terminal-client` for takeover request/release.
- Add transcript/event stream support.
- Ensure passive viewers never call `store.resizeAgentRun`.

### Test And Safety

- Add protocol tests for passive resize, takeover grant, release, disconnect restore, and owner-only resize.
- Add mobile route tests for chat timeline, raw terminal mode, and dangerous action confirmation.
- Add Playwright viewport checks for iPhone/Android dimensions.
- Add token/path/base64 leakage checks for mobile files and images.

## Test And Safety Matrix

From the tester report, the implementation must cover:

- Long output: 5,000-character lines, JSON, URLs, and stack traces.
- TUI output: spinner/thinking output, alternate screen, repaint-heavy tools.
- Input: Chinese IME, emoji, backspace, Ctrl+C, Esc, Tab, Enter, arrow keys.
- Sync: desktop and mobile viewing the same run without accidental resize.
- Actions: terminal input, start, stop, restart, and stale run recovery.
- Session continuity: exact active-session binding, zero-input save, already-durable stop, confirmed recovery checkpoint, timeout/PTY-loss preservation, and force-stop warning.
- Files: png/jpg/jpeg/webp, 10MB image limit, 100MB exchange file limit.
- Security: no CLI agent token in mobile DOM, action payloads, localStorage, logs, or terminal input.
- Network: UI cookie, Host/Origin guard, LAN access, offline/reconnect behavior.

## Acceptance Criteria

The goal is not complete until all of these are true:

- A phone user can operate an agent primarily through a readable conversation UI.
- Raw terminal mode remains available and accurate.
- Mobile normal viewing does not resize or damage the desktop PTY.
- There is a designed path for exact mobile terminal layout, either through takeover or an equivalent proven mechanism.
- Image upload is usable from mobile and does not leak base64, absolute local paths, attachment-registry internals, or tokens into the CLI prompt; a validated Workspace-relative Artifact reference is allowed.
- Real-device mobile UAT passes for reading, typing, scrolling, uploading images, stopping/restarting, and reconnecting.
- Automated tests cover the protocol and UI regressions most likely to break the above behavior.

## Resolved Conversation Decisions

- Chat is the default mobile Agent view; Raw terminal remains an explicit alternate view.
- Codex and Claude Code native sessions are the only first-release conversation sources.
- PTY output is never heuristically promoted into conversation turns.
- Chat does not preconnect, restore, or take over a terminal.
- Provider history predating Yive observation is not scanned or backfilled.
- The complete accepted design and rollout plan lives in [`CHAT_VIEW_PLAN.md`](./CHAT_VIEW_PLAN.md).
