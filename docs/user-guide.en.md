# Yive User And Configuration Guide

English | [中文](./user-guide.zh-CN.md)

This guide explains how to start Yive from source, connect the mobile UI,
configure Feishu notifications, use the file exchange, and understand the main
repository paths.

## Core Concepts

Yive is a local-first workbench for multiple CLI agents. The desktop machine
runs the real Yive runtime, PTYs, CLI agents, and workspaces. The browser and
phone are control surfaces.

- Orchestrator: the lead agent that breaks down work and dispatches tasks.
- Worker: an agent that executes delegated tasks.
- Workspace: a local project directory whose agent runs and Dispatch state are
  persisted by the Yive Runtime.
- Mobile UI: the phone interface for workspaces, terminals, notifications, and
  file exchange.
- Relay: an optional public relay service for remote phone access. Local LAN
  testing can work without Relay.

## Requirements

- Node.js 22.13+ (22.x), or Node.js 24.x.
- pnpm 10 or newer.
- At least one supported Agent Provider: Claude Code or Codex.
- The agent CLI must already be installed and signed in from the same shell
  environment used to start Yive.

## Start From Source

First install and build:

```bash
pnpm install
pnpm build
node dist/src/cli/hive.js --port 4010
```

Development mode:

```bash
pnpm dev
```

Development mode starts:

- Runtime: `http://127.0.0.1:4010`
- Web UI: `http://127.0.0.1:5180`

Open the printed browser URL, add a workspace, choose an Orchestrator Provider,
and start the agent.

## Mobile UI

### Local LAN Mode

Use this when the phone and desktop are on the same Wi-Fi.

1. Start development mode on the desktop:

   ```bash
   pnpm dev
   ```

2. Print phone-accessible LAN URLs:

   ```bash
   yive mobile lan --port 5180
   ```

3. Open the printed `/mobile` URL on the phone.

If the phone cannot open it, check:

- The phone and desktop are on the same LAN.
- The firewall allows the Node/Vite ports.
- Development LAN mode may need the runtime to listen on the LAN interface:

  ```bash
  HIVE_RUNTIME_HOST=0.0.0.0 HIVE_DEV_LAN=1 pnpm dev
  ```

### Relay Mode

Use Relay when the phone is remote or should access Yive through a domain.

Relay hosts the mobile static app and forwards traffic. The real agents, PTYs,
workspaces, and credentials stay on the desktop machine.

See [Relay deployment notes](../deploy/README.zh-CN.md) for server setup.

Typical flow:

1. Configure `/etc/yive/relay.env` on the server:

   ```bash
   YIVE_RELAY_PORT=4020
   YIVE_RELAY_HOST=0.0.0.0
   YIVE_RELAY_ADMIN_TOKEN=<strong-admin-token>
   YIVE_RELAY_PAIRING_STORE=/var/lib/yive/relay-pairings.json
   YIVE_RELAY_STATIC_DIR=/opt/yive-runtime/web/dist
   YIVE_RELAY_REQUIRE_DESKTOP_BINDING=1
   YIVE_RELAY_PUBLIC_URL=https://relay.example.com
   ```

2. Build and start Relay:

   ```bash
   pnpm install --frozen-lockfile
   pnpm build
   sudo bash deploy/install-relay-service.sh
   sudo systemctl start yive-relay
   ```

3. Connect the desktop to Relay:

   ```bash
   yive connect \
     --server https://relay.example.com \
     --token "<admin-or-device-token>" \
     --device-id desktop-windows \
     --runtime http://127.0.0.1:3001 \
     --require-runtime
   ```

4. Create a phone pairing link:

   ```bash
   yive relay pair \
     --server https://relay.example.com \
     --token "<admin-token>" \
     --desktop-id desktop-windows
   ```

5. Open the pairing link on the phone and enter `/mobile?relay=1`.

Do not expose the local runtime port directly to the internet.

## Mobile Notifications

Agents can notify the phone through the Yive runtime:

```bash
yive mobile notify "Build done" --body "Open the Files tab to download demo.mp4"
```

With an image:

```bash
yive mobile notify "Preview ready" --body "Tap the image preview" --image dist/preview.png
```

Notes:

- `--image` must be a workspace-relative path.
- Supported image types: `.png`, `.jpg`, `.jpeg`, `.webp`.
- Image limit: 10MB.
- Notifications first appear in the Yive mobile UI. Configured external
  channels receive the same message.

## Feishu Notifications

Yive can forward `yive mobile notify` messages to a Feishu bot.

### Text Notifications

Set this in the environment that starts the Yive runtime:

```bash
YIVE_FEISHU_WEBHOOK_URL=<Feishu bot webhook URL>
```

If the bot enables signature verification, also set:

```bash
YIVE_FEISHU_WEBHOOK_SECRET=<Feishu bot signing secret>
```

PowerShell example:

```powershell
$env:YIVE_FEISHU_WEBHOOK_URL="<Feishu bot webhook URL>"
$env:YIVE_FEISHU_WEBHOOK_SECRET="<Feishu bot signing secret>"
pnpm dev
```

### Image Notifications

To forward image notifications to Feishu, also configure Feishu app
credentials:

```bash
YIVE_FEISHU_APP_ID=<Feishu app id>
YIVE_FEISHU_APP_SECRET=<Feishu app secret>
```

If only the webhook is configured, text notifications still work. Image upload
is skipped or reported as `app_not_configured`.

Restart the Yive runtime after changing these environment variables.

## File Exchange

The mobile Files page exchanges files between desktop and phone.

Send a workspace file to the phone:

```bash
yive mobile send-file dist/demo.mp4
```

When the phone uploads an image or file for an agent, Yive records the
attachment and injects a prompt so the agent can read it.

Limits:

- Supported extensions: `.md`, `.mp4`, `.pdf`, `.zip`, `.log`, `.png`, `.jpg`,
  `.jpeg`, `.webp`
- Image limit: 10MB.
- General file limit: 100MB.
- Exchange items expire after 24 hours.
- Temporary files are stored under `hive-mobile-files` in the OS temp
  directory.
- Phone-uploaded attachment metadata is written to
  `<workspace>/.hive/mobile-attachments.json`.

## Agent Commands

Yive gives managed Agents a small native startup contract. Full command syntax
and current Runtime facts are disclosed only when requested; normal user turns
do not receive repeated Yive guidance.

Team commands:

```bash
team --help
team context [--worker <worker-name> | --dispatch <dispatch-id>]
team list
team add <worker-name> [--provider codex|claude] [--start]
team send <worker-name> "<task>"
team note --dispatch <dispatch-id> "<text>" [--artifact <path>]
team cancel --dispatch <dispatch-id> "<reason>"
team report "<result>" [--artifact <path>]
team status "<current status>" [--artifact <path>]
```

Root Help is role-aware. Use `team <command> --help` for complete syntax,
effects, common typed errors, and an example; use `team context` to refresh
current responsibility and Team state.

Only the Orchestrator can create Workers. Without `--provider`, the Worker inherits the Orchestrator Provider. Managed Agents are limited to Codex and Claude Code; model, reasoning, and authentication settings remain in the native Provider CLI. The Workspace Shell is a separate ordinary terminal.

Mobile tools:

```bash
yive agent notify "Title" --body "Message"
yive agent notify "Preview ready" --body "Tap the image preview" --image dist/preview.png
yive agent send-file <relative-path>
```

## Repository Paths

| Path | Purpose |
| --- | --- |
| `src/cli/` | `yive` and `team` CLI entrypoints, command parsing, mobile CLI tools |
| `src/server/` | Local runtime, HTTP/WebSocket APIs, PTY management, notifications, file exchange |
| `src/relay/` | Relay server, desktop/mobile WebSocket routing, pairing, device management |
| `src/shared/` | Shared frontend/backend types, Relay protocol, mobile event types |
| `web/src/` | Desktop Web UI |
| `web/src/mobile/` | Mobile UI, mobile terminal, file exchange, Relay connection |
| `web/dist/` | Built static web assets used by Relay deployment |
| `deploy/` | Relay, HTTPS, Android/TWA, smoke test, and Windows supervisor scripts |
| `docs/` | User docs, maintenance docs, ADRs, engineering notes |
| `tests/` | Vitest unit, CLI, Relay, mobile, and integration tests |
| `dist/` | TypeScript build output |
| `<workspace>/.hive/mobile-attachments.json` | Phone-uploaded attachment registry for agents |
| `~/.config/yive` or `$HIVE_DATA_DIR` | Runtime metadata for workspaces, agents, and runs |

## Common Checks

```bash
pnpm check
pnpm exec vitest run tests/unit/protocol-file.test.ts tests/cli/team-help.test.ts tests/cli/hive-cli.test.ts --no-file-parallelism --maxWorkers=1 --testTimeout=60000 --hookTimeout=60000
pnpm build
pnpm pack:check
```

## Troubleshooting

- Phone cannot open local `/mobile`: run `yive mobile lan --port 5180` and
  confirm the phone and desktop share the same network.
- Phone opens but cannot see the runtime: confirm the runtime is running and
  the port, firewall, and local/Relay mode match.
- Feishu does not receive notifications: set the environment variables before
  starting the runtime and inspect `yive mobile notify ... --json`.
- Feishu image push fails: configure `YIVE_FEISHU_APP_ID` and
  `YIVE_FEISHU_APP_SECRET`.
- Agent cannot find a file: use a workspace-relative path, not a machine
  absolute path.
