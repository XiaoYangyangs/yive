# Hive Overview For Mobile Parity

This document summarizes the current Hive product surface and internal
architecture so the mobile app can aim for feature parity with the existing
desktop experience.

## 1. Product Surface

### Core promise

- Hive is a local-first coordination layer for real CLI agents.
- Orchestrator and workers are real terminal processes on the user machine.
- Hive does not replace the CLI agents; it manages the shell around them.

### Desktop experience today

- Workspace sidebar for switching between local projects
- Main workspace canvas with orchestrator and worker cards
- Real terminal panels backed by PTY
- Dispatch list and Runtime-owned team state
- Notifications and toast system
- Workspace creation, deletion, and folder picker flow
- Demo mode for first-run preview without real agents
- PWA install support for Chromium browsers

### Agent model

- Exactly one Orchestrator per workspace
- Zero or more flat Workers
- Worker responsibility defined only by the active Dispatch
- Managed Agent Providers are Claude Code and Codex; ordinary Workspace Shells remain separate

### Dispatch model

- Dispatch, report, cancel, and status are first-class team actions
- Project backlog remains in the user's external issue tracker
- Pending Dispatch count is tracked per Worker

### Terminal model

- Every agent run is a real PTY process
- Terminal output is streamed through WebSocket
- Terminal input is written back to the PTY
- Terminal control includes resize, stop, restore, and output acknowledgements

### Workspace model

- Each workspace maps to a local project directory
- Hive stores runtime metadata in SQLite
- Default data dir is `~/.config/hive`
- UI can browse folders, select a path, and open workspaces

## 2. Runtime Architecture

### Entry points

- `src/cli/hive.ts`: main runtime CLI
- `src/cli/team.ts`: injected team protocol inside managed agent shells
- `web/src/app.tsx`: web UI entry

### Server layer

Important modules:

- `src/server/app.ts`
- `src/server/routes.ts`
- `src/server/runtime-store.ts`
- `src/server/workspace-store.ts`
- `src/server/team-operations.ts`
- `src/server/terminal-stream-hub.ts`
- `src/server/terminal-ws-server.ts`
- `src/server/local-request-guard.ts`
- `src/server/ui-auth.ts`
- `src/server/agent-manager.ts`

### Data flow

```text
Browser UI
  -> HTTP / WebSocket
Hive runtime
  -> SQLite + PTY lifecycle + Dispatch delivery
  -> real CLI agents
```

### API families

- Workspaces
- Team actions
- Runtime runs
- Dispatch ledger
- File browser / picker
- Settings
- Version info
- UI session / auth

### Shared client modules

- `web/src/api.ts`
- `web/src/useWorkspaceWorkers.ts`
- `web/src/terminal/terminal-client.ts`
- `web/src/notifications/*`
- `web/src/sidebar/*`
- `web/src/worker/*`
- `web/src/workspace/*`

## 3. Current Desktop Feature Inventory

### Workspaces

- List workspaces
- Create workspace
- Delete workspace
- Switch active workspace
- Select workspace folder

### Workers

- Add worker
- Rename worker
- Delete worker
- View worker identity, Provider, and status
- View queued Dispatch count
- Highlight worker

### Orchestrator

- Orchestrator auto-start flow
- Orchestrator pane
- Orchestrator terminal run handling
- User input to orchestrator shell

### Terminal

- Open terminal tabs
- View multiple runs
- Start / stop / restart agent runs
- Stream PTY output
- Preserve live run state

### Notifications

- Toasts
- Workspace notifications
- Update available toast
- Offline runtime page

### PWA

- Web manifest
- Service worker
- Installable Chromium app
- Offline/reload behavior

### Demo / onboarding

- First-run wizard
- Demo workspace view
- Demo banner

### Agent identity

- Orchestrator-or-Worker identity
- Role-free Worker creation and presentation

### File / workspace tools

- Folder picker
- File browser
- Open workspace route
- Workspace path validation

## 4. Constraints To Preserve

- Keep local-first behavior
- Keep real PTY execution on the desktop machine
- Keep CLI agent token private to the runtime
- Keep local request guard intact for real runtime traffic
- Preserve existing desktop UI behavior
- Preserve team protocol semantics

## 5. Mobile Parity Target

The mobile app should aim to cover the same working surface in a touch-friendly
form:

- workspace list and switching
- orchestrator and worker status
- agent terminal access
- dispatches
- notifications and approvals
- file exchange
- runtime status / offline state

Not every desktop pixel or interaction needs to copy 1:1, but the available
functions should remain equivalent unless explicitly excluded.
