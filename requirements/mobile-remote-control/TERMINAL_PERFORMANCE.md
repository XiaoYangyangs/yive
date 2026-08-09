# Mobile Terminal Performance Requirements

This document captures the current requirement for making the mobile Agent terminal feel faster when first opened and when restoring terminal history. It complements `TERMINAL_CONTRACT.md`; it does not change terminal ownership rules.

## Problem

Opening an Agent terminal on mobile can feel slow even when the Agent is already running. The slow path is not the Agent list itself; it is terminal attach and restore:

- the mobile UI loads xterm and its addons;
- the client opens terminal IO and control WebSockets;
- the runtime builds a restore snapshot from the terminal run output;
- the phone writes the restore snapshot into xterm before the terminal feels usable.

The most visible symptom is a black or pending terminal frame before recent CLI output appears. Long-running Agents with large output histories make this worse.

## Goals

- Make the first mobile terminal open feel fast enough that the user sees a responsive terminal frame quickly.
- Make terminal restore bounded by recent useful history instead of full run history.
- Keep live output delivery correct while restore is pending.
- Preserve mobile input, scrollback, resize, takeover, and ownership behavior from `TERMINAL_CONTRACT.md`.
- Keep desktop terminal behavior unchanged.

## Non-Goals

- Do not implement full infinite scrollback in this slice.
- Do not make Relay parse or store terminal output.
- Do not move CLI agents or PTYs onto the phone.
- Do not remove the ability for the runtime to retain complete live run output for other server-side uses.

## Requirement 1: Bounded Initial Restore

Mobile terminal restore should default to a bounded restore window rather than full `liveRun.output`.

Initial target:

- restore at most the most recent 50 lines; and
- restore at most the most recent 80 KB of text after line trimming.

The exact constants may be adjusted by implementation evidence, but the intent is fixed: initial mobile terminal restore is a recent-output view, not a complete-history replay.

The restore response should still report enough metadata for debugging, such as restored output size or total output size when already available, without exposing secrets.

## Requirement 2: Preload Terminal Assets

The mobile Agent surface should start preloading xterm-related JavaScript before the user opens a terminal detail page.

Preload should begin after the mobile app knows that an active workspace has at least one terminal-capable Agent or terminal run. It should be best-effort:

- failure to preload must not block the Agent list;
- preload should not start terminal WebSockets;
- preload should not start or resize any PTY;
- preload should only warm client-side code needed to create the terminal UI.

## Acceptance Criteria

- Opening a mobile Agent terminal with a large output history restores only the configured recent restore window.
- Live output that arrives during restore is buffered until the restore write completes, then flushed in order.
- Mobile terminal scrollback remains usable after restore.
- Space, Backspace, Enter, Esc, Tab, arrows, Ctrl+C, and Chinese IME input behavior are not regressed.
- Takeover and passive viewer ownership behavior remain unchanged.
- Desktop terminal restore and desktop terminal sizing are unchanged.
- xterm preload can be tested without opening a terminal WebSocket.

## Verification

Required checks for the implementation slice:

```bash
pnpm check
pnpm exec vitest run tests/web/terminal-view.test.tsx tests/web/mobile-route.test.tsx tests/server/terminal-ws.test.ts --no-file-parallelism --maxWorkers=1 --testTimeout=60000
```

Implementation should add or update focused tests for:

- bounded mobile restore from a large `liveRun.output`;
- live output buffering during restore;
- xterm preload being triggered from the mobile Agent surface without opening terminal sockets.

## Deferred Work

Full-history browsing and "load more history" are intentionally deferred. This slice should first make the common terminal entry path fast by restoring only the recent window. If users later need older terminal history from the phone, add it as a separate feature with its own UI, protocol, and tests.
