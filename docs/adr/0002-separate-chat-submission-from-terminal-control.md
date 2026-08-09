# ADR 0002: Separate Chat Submission from Terminal Control

## Status

Accepted.

## Context

Mobile Chat is the default Agent view and does not render the PTY. Requiring terminal takeover for every message would couple conversational use to phone-sized terminal rendering, resize the real PTY unnecessarily, and interfere with the desktop terminal. Allowing the existing raw `terminal_input` action without ownership would instead blur auditable message delivery with unrestricted terminal control.

## Decision

Chat submission authority and terminal control authority are separate. A chat submission may atomically deliver one complete recorded message to the active CLI session through its real PTY without acquiring terminal ownership, changing PTY dimensions, or granting ongoing keystroke control. Raw terminal input, helper keys, TUI navigation, resize, and takeover remain governed by the terminal ownership contract. Chat submissions use a distinct protocol action and delivery lifecycle rather than masquerading as raw terminal input.

Immediately before writing a chat submission, the Runtime sends `Ctrl+U` to clear the CLI's current editable input line. This intentionally prevents mobile text from concatenating with an unsubmitted desktop draft; the desktop draft is discarded. Chat never sends `Ctrl+C` or another process-interruption command.

## Consequences

- The runtime must serialize, deduplicate, persist, and report delivery state for chat submissions independently from raw terminal input.
- Chat mode can operate while the desktop retains terminal display ownership.
- Busy conversations queue chat submissions by default. A user may explicitly force immediate delivery, but Chat never sends `Ctrl+C` or another terminal interruption command; the CLI Agent decides how to react to the delivered message.
- Each Agent conversation accepts at most three queued submissions. At capacity, Chat preserves the draft but rejects additional queue entries until an existing entry is delivered or cancelled.
- The user may force any queued submission, even when earlier entries remain. Chat confirms how many entries are being skipped; only the selected entry is delivered, while all remaining queued entries preserve their relative order.
- A submission without Runtime acceptance remains visibly undelivered and requires manual retry with the same identity; reconnecting never triggers automatic delivery.
- Runtime restart preserves accepted queued submissions but pauses them until the user confirms continued queuing, immediate delivery, or cancellation after active-session identity is re-established.
- Stopping an Agent pauses every undelivered submission bound to its session. Starting the Agent never resumes those submissions automatically; Chat waits for a newly verified active session and requires explicit cancellation or migration.
- Queued submissions leave the queue automatically only after the Provider session source verifies that the active turn completed. Terminal silence, elapsed time, and generic Agent status are insufficient; unknown activity remains queued unless the user forces delivery.
- Submissions may be edited or cancelled only before PTY delivery. Once written to the PTY, the conversational record is immutable; Chat offers no edit, withdrawal, or per-turn deletion that would hide an action the CLI already observed.
