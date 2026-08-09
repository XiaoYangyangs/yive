# Yive 使用与配置指南

[English](./user-guide.en.md) | 中文

本文说明如何从源码启动 Yive、连接手机端、配置飞书通知、使用文件交换区，以及仓库内主要目录分别承担什么职责。

## 基本概念

Yive 是本地优先的多 Agent 工作台。桌面电脑运行真实的 Yive runtime、PTY、CLI Agent 和本地工作区；浏览器和手机端只是控制界面。

- Orchestrator：指挥官 Agent，负责拆解任务和分派工作。
- Worker：团队成员 Agent，执行指挥官分派的任务。
- Workspace：一个本地工程目录，其 Agent 会话与 Dispatch 状态由 Yive Runtime 持久化。
- Mobile UI：手机端控制界面，可查看工作区、进入 Agent 终端、接收通知、处理文件交换。
- Relay：可选的公网中继服务。远程手机访问时使用；本地局域网调试不一定需要。

## 环境要求

- Node.js 22.13+（22.x），或 Node.js 24.x。
- pnpm 10 或更新版本。
- 至少安装一个受支持的 Agent Provider：Claude Code 或 Codex。
- Agent CLI 必须已经在启动 Yive 的同一个 shell 环境中完成登录。

## 从源码启动

首次安装：

```bash
pnpm install
pnpm build
node dist/src/cli/hive.js --port 4010
```

开发模式：

```bash
pnpm dev
```

开发模式会启动：

- Runtime：`http://127.0.0.1:4010`
- Web UI：`http://127.0.0.1:5180`

打开浏览器中的地址后，添加 workspace，为 Orchestrator 选择 Provider，然后启动 Agent。

## 手机端使用

### 本地局域网方式

适合手机和电脑在同一个 Wi-Fi 下调试。

1. 在电脑上启动开发模式：

   ```bash
   pnpm dev
   ```

2. 打印手机可访问的局域网地址：

   ```bash
   yive mobile lan --port 5180
   ```

3. 在手机浏览器打开输出的 `/mobile` 地址。

如果手机打不开，检查：

- 手机和电脑是否在同一个局域网。
- 防火墙是否允许 Node/Vite 端口访问。
- 开发时是否需要让 runtime 监听局域网地址：

  ```bash
  HIVE_RUNTIME_HOST=0.0.0.0 HIVE_DEV_LAN=1 pnpm dev
  ```

### Relay 方式

适合手机不在同一局域网，或需要通过域名远程访问桌面 Yive。

Relay 只运行中继和手机静态页面；真实 Agent、PTY、workspace 和凭据仍留在桌面电脑。

服务器部署参考：[Relay deployment notes](../deploy/README.zh-CN.md)。

典型流程：

1. 在服务器配置 `/etc/yive/relay.env`：

   ```bash
   YIVE_RELAY_PORT=4020
   YIVE_RELAY_HOST=0.0.0.0
   YIVE_RELAY_ADMIN_TOKEN=<strong-admin-token>
   YIVE_RELAY_PAIRING_STORE=/var/lib/yive/relay-pairings.json
   YIVE_RELAY_STATIC_DIR=/opt/yive-runtime/web/dist
   YIVE_RELAY_REQUIRE_DESKTOP_BINDING=1
   YIVE_RELAY_PUBLIC_URL=https://relay.example.com
   ```

2. 构建并启动 Relay：

   ```bash
   pnpm install --frozen-lockfile
   pnpm build
   sudo bash deploy/install-relay-service.sh
   sudo systemctl start yive-relay
   ```

3. 桌面电脑连接 Relay：

   ```bash
   yive connect \
     --server https://relay.example.com \
     --token "<admin-or-device-token>" \
     --device-id desktop-windows \
     --runtime http://127.0.0.1:3001 \
     --require-runtime
   ```

4. 生成手机配对链接：

   ```bash
   yive relay pair \
     --server https://relay.example.com \
     --token "<admin-token>" \
     --desktop-id desktop-windows
   ```

5. 手机打开配对链接后进入 `/mobile?relay=1`。

不要把本地 runtime 端口直接暴露到公网。

## 保存会话与安全停止

桌面端和手机端的“保存当前会话绑定”会记住当前 Agent 真实使用的 Codex 或 Claude Code 会话。保存动作不会向终端发送任何文字，也不是保存终端画面；同一会话后续完成的对话会自然保留，下次启动时 Yive 会恢复这个会话的最新持久化状态。

停止已保存的会话时，Yive 默认先检查最新状态是否已经写入 CLI 的原生会话文件：

- 已持久化：不发送任何提示，直接停止。
- 尚未持久化：终端继续运行，并让你选择“创建恢复点并停止”或“强制停止”。
- 创建恢复点：会明确发送一条可见的最小消息，等待同一会话完成记录后再停止。
- 强制停止：需要再次确认，未提交的终端尾部可能永久丢失。

突然断电、系统崩溃或正在执行中的工具调用无法恢复成保存时的精确进程和终端画面；Yive 能恢复的是 Provider 已经持久化的 CLI 会话内容。

## 手机端通知

Agent 可以通过 Yive runtime 给手机 Notifications 页面发送通知：

```bash
yive mobile notify "Build done" --body "Open the Files tab to download demo.mp4"
```

带图片通知：

```bash
yive mobile notify "Preview ready" --body "Tap the image preview" --image dist/preview.png
```

注意：

- `--image` 必须是 workspace 内的相对路径。
- 支持 `.png`、`.jpg`、`.jpeg`、`.webp`。
- 图片上限为 10MB。
- 通知会先进入 Yive 手机端；如果配置了外部通知通道，会同时推送到对应渠道。

## 飞书通知

Yive 支持把 `yive mobile notify` 同步推送到飞书机器人。

### 文本通知

在启动 Yive runtime 的环境中配置：

```bash
YIVE_FEISHU_WEBHOOK_URL=<Feishu bot webhook URL>
```

如果飞书机器人启用了签名校验，再配置：

```bash
YIVE_FEISHU_WEBHOOK_SECRET=<Feishu bot signing secret>
```

PowerShell 示例：

```powershell
$env:YIVE_FEISHU_WEBHOOK_URL="<Feishu bot webhook URL>"
$env:YIVE_FEISHU_WEBHOOK_SECRET="<Feishu bot signing secret>"
pnpm dev
```

### 图片通知

图片通知要同时发送到飞书，需要飞书应用凭据：

```bash
YIVE_FEISHU_APP_ID=<Feishu app id>
YIVE_FEISHU_APP_SECRET=<Feishu app secret>
```

如果只配置 webhook，没有配置 app id 和 app secret，文本通知仍会成功；图片上传到飞书会被跳过或报告 `app_not_configured`。

修改这些环境变量后，需要重启 Yive runtime 才会生效。

## 文件交换区

手机端 Files 页面可以在电脑和手机之间交换文件。

Agent 或用户在 workspace 中发送文件到手机：

```bash
yive mobile send-file dist/demo.mp4
```

手机端上传图片或文件后，Agent 可根据手机端注入的提示读取对应文件。

限制：

- 支持类型：`.md`、`.mp4`、`.pdf`、`.zip`、`.log`、`.png`、`.jpg`、`.jpeg`、`.webp`
- 图片最大 10MB。
- 普通文件最大 100MB。
- 文件交换项默认保留 24 小时。
- 临时文件保存在系统临时目录下的 `hive-mobile-files`。
- 手机上传给 Agent 的附件索引写入 `<workspace>/.hive/mobile-attachments.json`。

## Agent 可用命令

Yive 只通过小型原生启动契约告知受管 Agent 的发现入口。完整命令语法和当前 Runtime 事实按需披露，普通用户消息不会反复追加 Yive 指导。

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

根 Help 会根据 Agent 身份只显示允许的命令。使用 `team <command> --help` 查询完整语法、状态影响、常见类型化错误和示例；使用 `team context` 刷新当前责任与团队状态。

只有 Orchestrator 可以创建 Worker。省略 `--provider` 时，Worker 继承 Orchestrator Provider。受管 Agent 仅支持 Codex 和 Claude Code；模型、推理强度和登录配置继续由 Provider CLI 自己管理。Workspace Shell 是独立的普通终端。

手机工具：

```bash
yive agent notify "Title" --body "Message"
yive agent notify "Preview ready" --body "Tap the image preview" --image dist/preview.png
yive agent send-file <relative-path>
```

## 工程路径说明

| 路径 | 用途 |
| --- | --- |
| `src/cli/` | `yive` 和 `team` CLI 入口、命令解析、移动端 CLI 工具 |
| `src/server/` | 本地 runtime、HTTP/WebSocket API、PTY 管理、通知、文件交换 |
| `src/relay/` | Relay server、桌面/手机 WebSocket 中继、配对和设备管理 |
| `src/shared/` | 前后端共享类型、Relay 协议、移动端事件类型 |
| `web/src/` | 桌面 Web UI |
| `web/src/mobile/` | 手机端 UI、手机终端、文件交换、Relay 连接 |
| `web/dist/` | 构建后的 Web 静态资源，Relay 部署时会使用 |
| `deploy/` | Relay、HTTPS、Android/TWA、smoke test 和 Windows supervisor 脚本 |
| `docs/` | 用户文档、维护文档、ADR 和工程说明 |
| `tests/` | Vitest 单元、CLI、Relay、移动端和集成测试 |
| `dist/` | TypeScript 构建产物 |
| `<workspace>/.hive/mobile-attachments.json` | 手机上传附件给 Agent 时的索引 |
| `~/.config/yive` 或 `$HIVE_DATA_DIR` | runtime 元数据、workspace/agent/run 状态 |

## 常用检查

```bash
pnpm check
pnpm exec vitest run tests/unit/protocol-file.test.ts tests/cli/team-help.test.ts tests/cli/hive-cli.test.ts --no-file-parallelism --maxWorkers=1 --testTimeout=60000 --hookTimeout=60000
pnpm build
pnpm pack:check
```

## 故障排查

- 手机打不开本地 `/mobile`：先运行 `yive mobile lan --port 5180`，确认手机和电脑在同一网络。
- 手机能打开但看不到 runtime：确认 runtime 正在运行，并检查端口、防火墙、Relay/本地模式是否一致。
- 飞书没有收到通知：确认环境变量是在 Yive runtime 启动前设置的，并查看 `yive mobile notify ... --json` 输出。
- 飞书图片没发出：确认已配置 `YIVE_FEISHU_APP_ID` 和 `YIVE_FEISHU_APP_SECRET`。
- Agent 找不到文件：确认使用的是 workspace 相对路径，不要使用本机绝对路径。
