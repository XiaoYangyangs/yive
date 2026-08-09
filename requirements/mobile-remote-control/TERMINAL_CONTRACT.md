# Mobile Terminal Contract

This contract is mandatory for changes touching mobile terminal control, terminal WebSockets, Relay routing, mobile actions, or mobile file exchange.

## Source Of Truth

- Real CLI agents run only in the desktop runtime.
- Mobile never starts a local agent process and never receives CLI agent tokens.
- The real PTY is the source of terminal truth. If the desktop terminal already shows bad rows, bad wrapping, or corrupted input, diagnose desktop/runtime state before changing mobile UI.
- Relay routes authenticated desktop/mobile traffic; Relay must not read workspaces, execute commands, or touch local PTYs.

## Terminal Ownership

- A passive viewer must never resize the real PTY.
- A takeover viewer may resize the real PTY only after ownership is granted by the runtime.
- Only the current owner may send real PTY resize messages.
- Takeover must be explicit, or intentionally entered only by a documented mobile terminal entry path.
- Release, disconnect, and ownership lease expiry must restore the previous desktop size when the runtime knows it.
- Desktop and mobile must make ownership state visible enough that the user can tell why input or resize is blocked.

## Chat And Terminal Separation

- Chat is the default mobile Agent view and must not mount xterm, open terminal IO/control WebSockets, request restore, acquire takeover, or resize the PTY.
- The Agent list must not preload terminal connections. Static xterm code assets may preload without opening a socket.
- Chat submission is a distinct, auditable whole-message action. It may write `Ctrl+U`, one complete message, and Enter to the active CLI session without terminal ownership, but it grants no raw keystroke, helper-key, TUI navigation, resize, or continuous input authority.
- Chat submission must never send `Ctrl+C` or another process-interruption command.
- Entering Raw terminal creates the terminal connection and follows the existing restore/takeover contract.
- Leaving Raw terminal for Chat must release takeover immediately, restore desktop ownership when possible, and close both terminal sockets.
- Chat conversation content comes only from Yive-owned submission records or verified Provider-native session records. Raw terminal output and silence are never evidence of a conversation turn or turn completion.

## Terminal Restore

- A takeover connection may be warmed before the phone opens the terminal, but preloading must not resize the PTY, request ownership, or replay output accumulated before the terminal view is ready.
- A warmed takeover connection must defer its automatic restore. After xterm knows the phone dimensions, the viewer requests a fresh restore with `restore_request`, including `cols`, `rows`, `scrollback`, and a unique `request_id`.
- The runtime returns the requested restore at the requested mirror dimensions and echoes `request_id`. Generating this viewer snapshot must not resize the real PTY or replace the desktop canonical mirror.
- Mobile takeover restores use a maximum requested scrollback window of 20 rows. Takeover is requested only after the matching restore has been written to xterm.

## Viewer-Independent Execution

- A Runtime-owned terminal run must continue executing independently of terminal viewer throughput, visibility, connection state, or browser lifecycle state.
- WebSocket buffering, unacknowledged output, and restore-time output are bounded per viewer. A viewer that exceeds its delivery budget is disconnected and must reconnect or request a bounded restore; its pending delivery state is discarded without pausing the PTY.
- A stalled viewer must not delay output delivery to another healthy viewer on the same terminal run.
- Reconnecting viewers must apply a bounded current restore before live output resumes, without replaying both the restored range and the same live increments.
- Terminal ownership grants only input and resize authority. Ownership does not let a viewer control Agent execution by consuming output slowly or failing to acknowledge it.
- Explicit user-requested pause and resume remain Runtime execution controls and must not be invoked by terminal viewer backpressure.

## Saved CLI Session And Safe Stop

- “保存当前会话绑定” binds the exact Provider-native CLI session verified for the active Agent PTY. It is not a terminal-screen snapshot or a historical point-in-time checkpoint.
- Saving a binding must not write terminal input, inject a prompt, create a synthetic turn, or stop the Agent. Later completed turns in the same CLI session remain part of that saved session automatically.
- Safe stop is the default stop path for a saved session. Yive first verifies that the same Codex or Claude Code session is at a Provider-native completed boundary and that its durable source is at least as new as the latest PTY input.
- A session that is already durable stops with zero prompt injection. An uncommitted tail keeps the PTY alive and requires an explicit user choice.
- “创建恢复点并停止” sends one visible, minimal prompt only after confirmation. Yive must wait for the same session to advance to a new completed boundary before stopping. Timeout, PTY loss, Provider failure, or session change leaves the run alive when possible and must not claim success.
- Force stop requires a separate data-loss acknowledgement. It never claims that an uncommitted terminal tail is recoverable.
- A sudden host/power loss and an in-flight tool call cannot be reconstructed as an exact process or terminal-screen snapshot. A saved CLI session resumes only Provider-durable conversation state.

## Other-Owner UI

- When this viewer does not own terminal size/input, do not show a misleading live viewing mode.
- Show a neutral/black ownership overlay with current owner state and a button to reclaim or take over when allowed.
- Reclaim actions must go through the same ownership protocol; do not locally flip UI state without runtime confirmation.

## Mobile Input And Scroll

- Normal terminal scrollback must remain scrollable on phone viewports.
- Mobile scrollback inertia is allowed only for normal terminal history and must remain a local viewer behavior; it must not send PTY input or resize the real PTY.
- Mobile scrollback inertia should be light: after touch release, deceleration should naturally stop within roughly 300-600ms rather than producing long-distance fling scrolling.
- Mobile terminal scroll frame-rate settings are per-device browser preferences. They must be stored locally on the phone and must not be synced to the runtime, workspace, Relay, or desktop UI. The available frame-rate preferences are Auto, 60fps, 90fps, and 120fps; Auto is the default.
- Mobile terminal settings are opened from the terminal page, not the workspace dashboard. The settings view should be full-screen on mobile and its Back action must return to the same agent terminal page.
- For terminal scroll frame-rate settings, Auto means no explicit frame-rate cap: scrollback inertia should follow the APK WebView/device `requestAnimationFrame` cadence. Manual 60fps, 90fps, and 120fps settings act as upper bounds on that frame cadence.
- A new touch must immediately cancel any in-progress scrollback inertia and hand control back to the user's drag.
- When a viewer is near the bottom of normal scrollback, new output should keep the terminal sticky to the latest output. When the user has intentionally scrolled into history, new output must not force the viewer back to bottom.
- Alternate-screen or TUI touch behavior must be deliberately tested before changing wheel/touch mapping.
- Alternate-screen or TUI touch inertia must not continue after touch release, because those gestures may map to real CLI input.
- Space, Backspace, Enter, Esc, Tab, arrows, Ctrl+C, and Chinese IME input are regression-sensitive and must be tested after terminal input changes.
- Empty input or whitespace-only composer submissions must not accidentally send commands unless the UI explicitly represents a helper key such as Space or Enter.

## Relay And Tokens

- Relay routes only authenticated envelopes and temporary file transfers.
- Relay must not expose `HIVE_AGENT_TOKEN`, `x-hive-agent-token`, `agent_token`, absolute local workspace paths, attachment-registry internals, or uploaded base64 in mobile DOM, logs, action payloads, or terminal input. A normalized Workspace-relative Artifact reference is the only path form allowed across these boundaries.
- Attachment-bearing `terminal_input` and `native_image_paste` actions declare `artifact_contract_version: 2`. The Runtime rejects older or absent contracts before binding or PTY input instead of returning the retired `registry_path` result shape.
- Under Artifact contract v2, Runtime-generated transport metadata never enters terminal input. Any caller-supplied terminal text is preserved byte-for-byte, and the Runtime appends only its structured Workspace-relative Artifact block.
- Desktop connector uses mobile/runtime-scoped tokens for `/api/mobile/*` and `/ws/mobile/events`; desktop UI tokens remain for desktop UI routes.
- Public Relay deployments must use HTTPS/WSS unless a command explicitly opts into temporary HTTP-only diagnostics.

## File Exchange

- File exchange is temporary transport, not workspace storage.
- Workspace files and bound attachments cross model, CLI, mobile, and Relay boundaries only as normalized Workspace-relative Artifact references; absolute resolution stays inside the Runtime.
- Dangerous files, oversized files, and content/extension mismatches must be rejected before they become available to the runtime.
- Download UI should expose progress when browser APIs make progress observable.
- Clearing file exchange must not delete real workspace files.

## Static Deployment

When deploying frontend assets to the runtime service path, verify the service user can read them.

Required deployment invariant for `/opt/yive-runtime/web/dist`:

```bash
chown -R yive:yive /opt/yive-runtime/web/dist
find /opt/yive-runtime/web/dist -type d -exec chmod 755 {} \;
find /opt/yive-runtime/web/dist -type f -exec chmod 644 {} \;
```

Public `/assets/*.js` and `/assets/*.css` must return `200 OK` after deployment.

## Required Test Gates

For code changes in the contracted areas, run:

```bash
pnpm check
pnpm exec vitest run tests/web/terminal-view.test.tsx tests/web/mobile-route.test.tsx tests/server/terminal-ws.test.ts tests/web/relay-api.test.ts --no-file-parallelism --maxWorkers=1 --testTimeout=60000
```

If the change touches server runtime, Relay, or file exchange behavior, also run the relevant focused server/Relay tests listed in `TEST_PLAN.md`.

For docs-only changes, `pnpm check` is enough when no code or config changed.

## Mobile Scrollback Inertia Acceptance

Mobile scrollback inertia is accepted when all of the following hold:

- In a normal terminal scrollback view, a quick upward or downward touch drag continues scrolling briefly after touch release and then stops naturally.
- Starting a new touch while inertia is active cancels the inertia immediately and the viewport follows the new drag.
- If the viewer is near the bottom of normal scrollback, new terminal output keeps the viewer sticky to the latest output.
- If the user has intentionally scrolled into history, new terminal output does not force the viewer back to bottom.
- In alternate-screen TUI views such as Claude/Codex full-screen interfaces, touch release must not continue sending scroll, arrow, PageUp, PageDown, or equivalent CLI input.
