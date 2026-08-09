# ADR 0001: Mobile Terminal Ownership

## Status

Accepted.

## Context

Yive terminals are real local PTY sessions. Desktop terminal quality depends on fitting the real PTY to the desktop panel. Mobile screens need different dimensions, but blindly resizing the real PTY from a phone can break the desktop session and make later debugging misleading.

Recent mobile terminal work exposed the same class of regression repeatedly: display, scroll, input, ownership, and Relay behavior were adjusted in one layer while the broken state sometimes lived in another layer.

Browser lifecycle throttling exposed a separate execution risk: when xterm acknowledged output only after rendering it, a frozen or discarded viewer could exceed flow-control thresholds and pause the Runtime-owned PTY. That made Agent execution depend on whether a user was looking at a browser tab.

## Decision

Terminal size and input authority are explicit ownership concepts.

- The desktop viewer owns the desktop terminal size by default.
- Passive viewers may observe output but must not resize the real PTY.
- Mobile takeover may resize the real PTY only after a takeover flow grants ownership.
- Only the current size owner may send real PTY resize operations.
- When another viewer owns the terminal, the current viewer should not show a misleading live viewing mode. Show an ownership overlay and a reclaim action instead.
- Takeover release, disconnect, or lease expiry should restore the previous desktop size when possible.
- Viewer output flow control is per viewer. A viewer that exceeds its WebSocket, acknowledgement, or deferred-restore budget is disconnected and resynchronizes through a bounded restore.
- Viewer backpressure, visibility, freezing, discard, and disconnect must never pause or resume the Runtime-owned terminal run. Explicit execution pause and resume are separate Runtime controls.
- Mobile terminal bugs must be diagnosed from the runtime/PTY state outward: PTY, desktop terminal, terminal WebSocket, mobile terminal, then Relay.

## Consequences

- Mobile raw terminal can be accurate in takeover mode, but takeover affects the real session and must be visible.
- Passive mobile viewing is safer, but it cannot promise phone-native reflow for full-screen TUI output.
- A slow viewer may reconnect and see a bounded current snapshot rather than every live increment it missed. Healthy viewers and the Agent continue without waiting for it.
- Tests must cover owner-only resize, takeover grant/release, viewer-isolated backpressure, bounded reconnect restore, hidden viewer behavior, and mobile input controls.
- Any alternative model, such as per-viewer terminal mirrors, needs a new ADR before replacing ownership semantics.
