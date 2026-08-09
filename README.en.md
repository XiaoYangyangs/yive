# Yive

<p align="center">
  <img src="./assets/logo.png" width="120" alt="Yive logo" />
</p>

English | [中文](./README.md)

Yive is a local-first browser workbench for coordinating Codex and Claude Code
as real, managed PTY agents. Each workspace has one Orchestrator and any number
of flat Workers; the Orchestrator delegates work through Yive's durable Team
protocol while every agent continues to run on your machine.

> Yive is source-available under the Business Source License 1.1 and converts
> to Apache-2.0 on the change date in [LICENSE.BSL](./LICENSE.BSL). It is an
> independent derivative of Hive, not an official or endorsed distribution of
> the original project.

## Current Product Model

- One Orchestrator and zero or more flat Workers per workspace.
- Native managed-provider support for Codex and Claude Code.
- Real PTY processes, terminal history, native provider sessions, and explicit
  stop, crash, and recovery state.
- Runtime-owned Dispatches with at most one active Dispatch per Worker, a
  durable queue, safe-boundary delivery, notes, replacement, cancellation,
  status updates, and outcome-aware reports.
- Independent process, conversation-activity, active-Dispatch, and queue state
  instead of one ambiguous aggregate status.
- Progressive, role-aware `team help` and bounded `team context`.
- A mobile-first Chat view backed by verified provider conversation turns, with
  raw Terminal access as a fallback.
- Optional self-hosted Relay access, notifications, bidirectional file
  exchange, safe artifact references, and agent tools.

Yive does not bundle model access, provider credentials, multi-user
authentication, sandboxing, or a hosted cloud service. Managed agents inherit
the permissions of the OS user who starts Yive. Provider model, reasoning, and
authentication preferences remain in the native Codex or Claude Code
configuration. Workspace Shells are ordinary terminals, not managed agents,
and do not participate in Team coordination.

## Platform Support

- Node.js 22.13+ (22.x), or Node.js 24.x.
- pnpm 10 or newer for source development.
- Windows, macOS, and Linux, subject to native PTY support.
- Codex, Claude Code, or both installed on the `PATH` and authenticated in the
  shell environment used to start Yive.

Yive uses native packages including `node-pty` and `better-sqlite3`. A platform
without matching prebuilt binaries may also need native build tools.

## Quick Start

Start from source:

```bash
pnpm install --frozen-lockfile
pnpm build
node dist/src/cli/hive.js --port 4010
```

Open the printed local URL. The runtime binds to localhost by default.

For development:

```bash
pnpm dev
```

This starts the runtime at `127.0.0.1:4010` and the Vite frontend at
`127.0.0.1:5180`. For detailed desktop, mobile, Relay, notification, and file
exchange setup, see the [English user guide](./docs/user-guide.en.md) or
[Chinese user guide](./docs/user-guide.zh-CN.md).

## First Run

1. Add a trusted local workspace.
2. Select Codex or Claude Code for the Orchestrator and start it.
3. Add Workers. Each Worker inherits the Orchestrator provider unless you
   explicitly select the other supported provider.
4. Give the Orchestrator an objective. It can inspect current state with
   `team context` and dispatch work with `team send`.
5. Workers use `team status` for progress and `team report` for a final success
   or failure outcome.

The Runtime persists coordination state in SQLite. A workspace-local task file
is not the source of truth.

## Architecture

```text
Desktop or mobile browser
        |
        | HTTP + WebSocket
        v
Yive Runtime
  SQLite coordination state
  provider session tracking
  PTY lifecycle and recovery
        |
        +-- Orchestrator (Codex or Claude)
        +-- Worker (Codex or Claude)
        +-- Workspace Shell (not an agent)

Optional remote path:
mobile browser <-> self-hosted Relay <-> desktop Yive Runtime
```

The `team` and `yive agent` commands are injected into managed sessions. They
use short-lived, scoped runtime credentials and are not general global commands
unless you expose them separately.

## Mobile And Relay

The mobile interface opens on `/mobile`. Chat is the default agent view and
shows verified provider turns; Terminal mode remains available for direct PTY
inspection and control.

Remote access requires a Relay server you operate. Public examples use neutral
placeholder values such as `https://relay.example.com`; this repository does
not operate that endpoint. Do not expose the desktop runtime port directly to
the internet.

## Useful Commands

```bash
pnpm check
pnpm build
pnpm test
pnpm test:windows
pnpm release:dry
```

Before a public update, follow the
[English release checklist](./docs/release-checklist.en.md) or
[Chinese release checklist](./docs/release-checklist.zh-CN.md).

## Safety Model

Runtime metadata defaults to `~/.config/yive`, or `$HIVE_DATA_DIR` when set.
Yive is a local development tool, not a security boundary:

- Open only trusted workspaces.
- Treat managed agents and workspace shells as able to run commands with your
  user permissions.
- Keep UI, agent, mobile, and Relay credentials private and separate.
- Do not publish terminal logs, workspace paths, runtime databases, or generated
  mobile signing artifacts.
- Review [SECURITY.md](./SECURITY.md) before using sensitive projects.

## Package Status And License

The repository supports package verification with `pnpm pack:check` and
`pnpm pack:smoke`. Until a matching npm release is explicitly published,
prefer the source workflow above.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development and test expectations.
Yive 1.4.0 and later are licensed under the Business Source License 1.1; see
[LICENSE.BSL](./LICENSE.BSL). [LICENSE](./LICENSE) preserves historical
Apache-2.0 terms only for versions covered by that file. Original work is
attributed to Shaokun Tu (tt-a1i) and contributors; Yive preparation and later
modifications are attributed to XiaoYangyangs. The upstream Hive name, logo,
and visual identity are covered by [TRADEMARK.md](./TRADEMARK.md).
