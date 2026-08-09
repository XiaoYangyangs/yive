# Mobile Remote Control for Yive

> This is an implementation-history and requirements note. For current user
> behavior, use the [English](../../docs/user-guide.en.md) or
> [Chinese](../../docs/user-guide.zh-CN.md) user guide. Accepted architecture
> decisions under [`docs/adr`](../../docs/adr/) supersede older proposals in
> this document.

Related reference:

- [HIVE_OVERVIEW.md](./HIVE_OVERVIEW.md)

## 目标

做一个手机端入口，用来远程查看和控制电脑端正在运行的 Hive。

## 原生 App 方向

后续如果做成原生 App，最低标准不是“能连上”，而是“手机端能看到和网页端一致的核心看板”。

### 最基本的看板能力

- 按 workspace 展示所有工作区
- 进入某个 workspace 后能看到其中每个 Agent
- 能看到每个 Agent 的当前状态
- 能看到每个 Agent 正在处理的任务或最近任务
- 能看到任务进度、回执、最近日志摘要
- 能区分 orchestrator 和 worker

### 体验要求

- 手机端必须可读，不依赖放大缩小
- 重要状态要一眼可见
- 列表刷新要快，状态变化要及时
- 不要求把桌面端所有细节完全照搬，但核心信息不能缺

### 额外必须支持的操作

- 手机端可以直接操作 Agent
- 手机端可以像电脑端一样直接和每一个 Agent 对话
- 手机端的对话能力要和当前 Hive 保持一致，像真实使用 CLI 一样
- 电脑端 Hive 现有的 CLI 能力，手机端都要支持
- 手机端要有文件交换区，用来接收电脑端产物并审核
- 手机端要有双向文件交换区，电脑端和手机端都可以互相传文件
- 手机端可以发起或确认关键动作
- 手机端可以对任务进行继续、停止、重试或分派
- 手机端可以接收并处理需要人工确认的消息

## 第一版范围

- 手机端查看 workspace 列表
- 手机端查看当前 workspace 的任务状态
- 手机端查看 worker / orchestrator 在线状态
- 手机端向 orchestrator 发送一条指令或任务
- 手机端与每个 Agent 直接对话
- 手机端对话体验与桌面端 Hive 一致
- 手机端查看最近日志或回执
- 手机端直接操作 Agent
- 手机端审核来自电脑端的文件产物
- 手机端处理通知和审批确认
- 手机端尽量用适合触屏的方式完成同样的操作

## 文件交换区

文件交换区用于把电脑端生成的文件产物送到手机端查看、审核、确认或退回。
它也用于手机端把文件回传给电脑端，双向传输，像 QQ 那样互相发文件。

### 需要支持的内容

- Markdown 文件
- MP4 视频文件
- 单文件大小上限 100MB

### 暂不支持的内容

- 文件历史记录
- 文件版本对比
- 手机端直接修改后回写文件

### 基本流程

1. 电脑端把产物发送到交换区。
2. 手机端收到待审核条目。
3. 手机端可以预览、评论、通过、退回或要求修改。
4. 审核结果回到电脑端 Hive。
5. 手机端也可以把参考文件发回电脑端。

### 设计边界

- 文件交换区只是临时文件传输通道。
- 主要改动仍然依靠手机端和 Agent 的对话完成。
- 手机端回传文件主要用于提供参考材料，不作为主编辑入口。

## 暂不做

- 多用户协作
- 云端托管
- 复杂权限体系
- 完整原生 App 体验

## 最小跑通测试

目标是先验证“手机能连上电脑端 Hive，并完成一次完整控制闭环”。

验收步骤：

1. 电脑端启动 Hive runtime。
2. 手机通过局域网访问 Hive。
3. 手机完成一次配对或登录。
4. 手机看到一个 workspace。
5. 手机发送一条任务给 orchestrator。
6. 电脑端 Hive 收到任务并可执行。
7. 手机能看到任务状态变化或回执。

验收结果：

- 手机端可稳定连接到电脑端 Hive
- 任务能从手机发出并到达电脑端
- 状态和回执能回到手机端显示

## 当前假设

- 先做网页版或 PWA 作为手机端入口
- 桌面端 Hive 继续承担核心 runtime
- 通信优先采用 HTTP + WebSocket

## 技术栈建议

### 电脑端

- 继续基于现有 Hive runtime
- 继续使用 Node.js + TypeScript
- 继续使用 SQLite 保存本地状态
- 继续使用 PTY 管理真实 CLI Agent
- 新增手机端访问所需的 API、WebSocket、配对认证和文件传输能力

### 手机端第一阶段

- 先做移动端 Web / PWA
- 继续使用 React + TypeScript + Vite
- 复用现有 Hive Web 的接口、状态模型和终端能力
- 目标是先跑通手机端看板、Agent 对话、通知审批和文件交换区

### 原生 App 阶段

- 推荐使用 React Native + Expo
- 原因是可以继续复用 TypeScript、React 组件思路、状态模型和接口类型
- iOS / Android 共用一套主要代码
- 原生能力主要用于推送通知、文件选择、文件分享、后台连接和系统级体验

### 通信层

- HTTP 用于列表、配置、配对、文件上传下载等请求
- WebSocket 用于 Agent 状态、任务状态、终端输出和实时通知
- 文件交换区使用 HTTP 上传下载，必要时支持分片或断点续传

### 终端能力

- 桌面端继续使用真实 PTY
- 手机端展示远程 PTY 输出
- 手机端输入通过 WebSocket 发回电脑端
- 手机端不直接运行 Agent，只控制电脑端已经运行的 Agent

### 第一版不优先采用

- Flutter：跨端能力强，但与现有 React / TypeScript 代码复用较少
- Swift / Kotlin 原生双端：体验最好，但开发和维护成本最高
- 云端托管 Hive runtime：会改变 Hive 本地优先模型，暂不作为第一阶段目标

## 自建中转服务器方案

如果手机端需要通过互联网远程控制电脑端 Hive，建议增加一层 Hive Relay Server。

### 基本原则

- Agent 仍然只运行在用户电脑端
- 电脑端 Hive runtime 仍然管理 PTY、任务、日志和文件
- 中转服务器只负责连接、认证、转发和临时文件传输
- 中转服务器不直接运行 Agent
- 中转服务器不长期保存 workspace 文件

### 连接方式

1. 电脑端 Hive 主动连接中转服务器，建立 WebSocket 长连接。
2. 手机 App 登录后连接同一个中转服务器。
3. 服务器根据设备绑定关系，把手机消息转发给对应电脑端 Hive。
4. 电脑端 Hive 执行操作后，把状态、日志、回执通过服务器转发回手机。

### 服务器需要承担的能力

- 用户登录
- 设备配对
- 电脑端在线状态
- 手机端在线状态
- WebSocket 消息转发
- Agent 终端输入输出转发
- 任务和通知转发
- 文件临时上传下载
- 推送通知触发

### 文件传输

- `.md` 和 `.mp4` 文件通过 HTTP 上传下载
- 单文件上限 100MB
- 文件只作为临时传输内容
- 不做历史记录
- 不做版本管理
- 可设置自动过期清理

### 推荐服务器技术栈

- Node.js + TypeScript
- Fastify 或 Hono 作为 HTTP API 框架
- ws 或 Socket.IO 作为 WebSocket 通道
- PostgreSQL 保存用户、设备、配对关系和会话信息
- Redis 保存在线状态、短期路由和临时 token
- S3 兼容对象存储保存临时文件，也可以第一版先用服务器本地磁盘

### 第一版最小实现

- 一个公网服务器
- 一个域名
- HTTPS
- 登录或配对 token
- 电脑端 Hive outbound WebSocket
- 手机端 App outbound WebSocket
- 手机发消息到电脑
- 电脑回传状态到手机
- 文件临时上传下载

### 当前可接受的 VPS 基线

- 2 vCPU
- 4GB 内存
- 50GB 系统盘
- 1 个公网 IPv4
- 公网带宽峰值约 200Mbps
- Linux 系统，优先 Ubuntu 22.04 或更新版本
- 地域可优先选择离主要用户近的区域，例如广州

该配置足够用于第一版 Relay Server、WebSocket 中转、设备配对和 100MB 以内的临时文件传输测试。

### Relay 后端第一阶段开发建议

第一阶段先做轻量 Relay 原型，避免过早引入完整云端基础设施。

建议新增目录：

- `src/relay/`
- `tests/relay/`

建议拆分模块：

- `src/relay/server.ts`：Relay 启动入口
- `src/relay/http-routes.ts`：HTTP API
- `src/relay/ws-router.ts`：WebSocket 接入
- `src/relay/relay-hub.ts`：desktop / mobile 连接路由
- `src/relay/protocol.ts`：Relay 消息 envelope 类型
- `src/relay/pairing-store.ts`：设备配对与 token
- `src/relay/temp-file-store.ts`：临时文件传输

第一阶段可先使用：

- Node.js + TypeScript
- `node:http`
- `ws`
- `crypto.randomUUID()`
- 内存 Map 保存开发期配对关系和连接状态
- 本地临时目录保存 `.md` / `.mp4` 文件

后续再评估：

- Fastify / Hono
- PostgreSQL
- Redis
- S3 兼容对象存储
- `jose` 等标准 token 方案

建议新增脚本：

- `dev:relay`
- `dev:runtime:relay`
- `test:relay`

建议本地开发端口：

- Hive runtime：`4010`
- Relay Server：`4020`

Relay WebSocket 第一版建议分两类连接：

- desktop：电脑端 Hive runtime 主动连接 Relay
- mobile：手机端 Web / PWA / App 主动连接 Relay

Relay 消息建议统一为 envelope：

```json
{
  "type": "message_type",
  "request_id": "optional-request-id",
  "from": "mobile-or-desktop-id",
  "to": "target-device-or-agent-id",
  "channel": "terminal-or-team-or-file",
  "payload": {}
}
```

需要优先复用现有类型和协议：

- workspace / agent 状态类型
- team send / report / cancel 请求体
- terminal WebSocket 协议

重要约束：

- Relay 不直接访问真实 PTY
- Relay 不直接运行 Agent
- Relay 不直接读取 workspace
- 真实执行仍由电脑端 Hive runtime 完成
- Relay 只做认证、转发、在线状态和临时文件传输

### 桌面端适配第一阶段开发建议

桌面端适配不应另起一套执行体系，应复用现有 Hive runtime 的 PTY、workspace、team 和 WebSocket 能力。

需要优先复用的现有模块：

- `src/server/agent-manager.ts`：真实 CLI Agent 的 PTY 创建、输入、resize、stop
- `src/server/pty-output-bus.ts`：PTY 输出订阅
- `src/server/runtime-store-helpers.ts`：run 输入、暂停、resize、恢复、停止
- `src/server/terminal-stream-hub.ts`：终端 IO/control WebSocket 逻辑
- `src/server/terminal-protocol.ts`：终端控制消息协议
- `src/server/workspace-store.ts`：workspace、worker、dispatch 状态
- `src/server/routes-workspaces.ts`：workspace 和 team 列表 API
- `src/server/routes-runtime.ts`：active run、run 输出、stop
- `src/server/routes-dispatches.ts`：dispatch 列表
- `src/server/routes-team.ts`：team send / report / status / cancel

建议新增桌面端适配层：

- mobile controller：向手机端提供统一快照和动作入口
- relay client：电脑端 Hive runtime 主动连接 Relay Server

建议第一阶段新增 API / WS：

- `GET /api/mobile/snapshot`
- `GET /api/mobile/workspaces`
- `/ws/mobile/events`

当前第一版已经实现：

- `GET /api/mobile/snapshot`：返回当前移动端 dashboard 快照。
- `/ws/mobile/events`：通过 UI cookie 鉴权，连接后立即发送 `mobile-snapshot`，定时发送 `mobile-heartbeat`，重连后重新发送最新 snapshot。

`/api/mobile/snapshot` 第一版应返回：

- workspace 列表
- 当前 workspace
- orchestrator 状态
- workers 状态
- active terminal runs
- pending dispatch summary
- 最近 report / status / log 摘要

终端能力建议：

- 手机端仍然绑定具体 `run_id`
- 输入走现有 terminal IO 通道或等价封装
- control 继续复用 resize / stop / output_ack / restore_complete
- Relay 只转发 terminal IO/control 消息，不直接操作 PTY

team 能力建议：

- 手机端发起的 send / report / status / cancel 需要进入 server-side action
- 不直接复用 CLI agent 的 `HIVE_AGENT_TOKEN`
- 手机端使用设备配对 token / mobile session token
- runtime 内部再调用现有 team operations

安全边界：

- 现有 UI cookie、CLI agent token、mobile token、relay token 需要分开
- mobile API / WS 需要独立鉴权
- 高风险动作如写入 PTY、stop run、cancel Dispatch、文件传输必须鉴权
- 不能为了远程访问直接放宽 `local-request-guard`

建议优先补测试：

- mobile user input 到 orchestrator PTY
- mobile / relay 触发 team send / report / status / cancel
- cross-workspace 隔离
- terminal IO / control 的 mobile 转发
- snapshot payload 的字段稳定性

### 移动端/PWA 第一阶段开发建议

第一阶段先在现有 Web 工程中增加移动端入口，建议使用 `/mobile`，避免一开始就单独维护另一套应用。

需要优先复用的现有能力：

- `web/src/api.ts`：workspace、worker、terminal run、Dispatch 等 API
- `web/src/terminal/terminal-client.ts`
- `web/src/terminal/useTerminalRun.ts`
- `web/src/terminal/TerminalView.tsx`
- worker status / role presentation / avatar 等现有 UI 表达
- toast / notification provider

建议新增移动端目录：

- `web/src/mobile/MobileApp.tsx`
- `web/src/mobile/MobileShell.tsx`
- `web/src/mobile/MobileWorkspacePicker.tsx`
- `web/src/mobile/MobileWorkspaceDashboard.tsx`
- `web/src/mobile/MobileAgentList.tsx`
- `web/src/mobile/MobileAgentTerminal.tsx`
- `web/src/mobile/MobileNotifications.tsx`
- `web/src/mobile/MobileFileExchange.tsx`
- `web/src/mobile/useMobileWorkspaceState.ts`

建议移动端信息架构：

- workspace 选择
- workspace 看板
- Agent 列表
- Agent 详情
- Agent 终端
- 通知 / 审批
- 文件交换区

终端体验建议：

- 继续复用 xterm 和现有 terminal WebSocket 协议
- 手机端为触屏增加辅助输入栏
- 辅助输入栏需要包含常用键，例如 Enter、Esc、Tab、Ctrl 组合、方向键、停止
- 移动端不应只做聊天框，必须保留真实 CLI 输出和输入能力

移动端开发里程碑建议：

- M1：`/mobile` 入口、移动端 shell、workspace picker
- M2：workspace dashboard、orchestrator / worker 状态、dispatch 摘要
- M3：Agent terminal，打通 xterm / WebSocket 输入输出
- M4：通知和审批确认
- M5：文件交换区，支持 `.md` / `.mp4`、100MB 限制、预览和传输状态

移动端开发风险：

- 当前 runtime 和 Vite 默认偏向 `127.0.0.1`，局域网调试需要重新处理 host、Origin、token 和 local request guard
- 文件交换区还没有现成 API，需要后端先提供协议
- 审批/通知的 schema 需要先定义，否则 UI 容易变成临时拼接
- xterm 在手机触屏上的输入、滚动、缩放和键盘体验需要单独验证

### 测试与安全第一阶段基线

移动远程控制会把原本只在本机使用的 Hive 能力暴露到手机端和中转通道，因此测试和安全需要从第一阶段开始进入开发范围。

配对与鉴权要求：

- desktop 和 mobile 都必须主动连接 Relay
- desktop / mobile 必须经过设备配对
- mobile 只能控制已绑定的 desktop
- token 必须可撤销
- Relay token、mobile session token、Hive UI token、CLI agent token 必须隔离
- 不允许把 CLI agent token 直接暴露给手机端

WebSocket 测试要求：

- desktop / mobile 连接 token 校验
- desktop 离线时 mobile 收到明确错误
- mobile 消息只能转发到已绑定 desktop
- envelope 必须校验 `request_id`、`channel`、`from`、`to`、`payload`
- terminal input、terminal control、Dispatch update、snapshot update 都需要覆盖
- 断线重连后不能重复执行危险操作

文件传输测试要求：

- 只允许 `.md` 和 `.mp4`
- 单文件最大 100MB
- 超过 100MB 必须拒绝
- MIME / 扩展名 / Content-Length 需要校验
- 临时文件必须自动过期
- 下载不存在或已过期文件应返回明确错误

危险操作确认要求：

- terminal input
- stop run
- cancel Dispatch
- file transfer
- approve / reject / needs changes

这些操作需要明确的鉴权和必要时二次确认，避免手机误触直接影响电脑端真实 CLI。

断线和恢复测试要求：

- Relay 断线
- desktop 断线
- mobile 断线
- WebSocket 重连
- 重连后的 snapshot 同步
- request_id 去重
- 离线期间消息的失败提示

Windows 开发注意项：

- 部分完整集成测试在 Windows 下可能受 `node-pty` / `AttachConsole failed` 影响
- 部分测试依赖 `/bin/bash`，Windows 环境下需要改用平台无关命令或跳过策略
- Windows 本地优先跑 `pnpm test:windows`

## 本地开发和移动端预览

在没有服务器、没有域名、没有真机的情况下，第一阶段可以完全在电脑上开发和预览。

### 当前已具备

- Node.js 22 或更新版本
- pnpm
- 已安装依赖
- GitHub 私有仓库
- 本地 Hive runtime
- 本地 Vite Web 开发服务器

### 启动方式

```bash
pnpm dev
```

该命令会同时启动：

- Hive runtime：`http://127.0.0.1:4010`
- Vite Web：`http://127.0.0.1:5180`

移动端第一阶段建议增加 `/mobile` 路由。开发时在电脑浏览器访问：

```text
http://127.0.0.1:5180/mobile
```

### 电脑上预览手机效果

使用 Chrome 或 Edge：

1. 打开 `http://127.0.0.1:5180/mobile`
2. 按 `F12` 打开 DevTools
3. 点击设备工具栏
4. 选择 iPhone / Android 尺寸
5. 用移动视口检查布局、滚动、按钮大小、终端显示和文件交换区

第一阶段主要验证：

- 手机看板是否可读
- workspace / Agent 切换是否顺手
- 终端输出是否能在窄屏显示
- 输入区是否适合触屏
- 通知和审批是否醒目
- 文件交换区是否容易操作

### 什么时候需要真机

以下能力进入开发后，需要上手机真机验证：

- xterm 在手机键盘下的输入体验
- 中文输入法、组合键、方向键、Esc、Tab、Ctrl 等辅助键
- PWA 添加到主屏幕
- 手机文件选择和分享
- 视频预览
- 局域网访问电脑端 Hive
- 后台连接
- 推送通知

### 局域网真机预览的后续要求

当前 runtime 和 Vite 都默认绑定 `127.0.0.1`，只适合电脑本机访问。

后续如果要让手机通过同一 Wi-Fi 访问电脑，需要增加开发模式配置：

- Vite 支持绑定 `0.0.0.0`
- Hive runtime 支持受控的局域网监听
- local request guard 支持开发期白名单
- 手机端使用配对 token 访问
- 不允许裸露无鉴权的 Hive 控制接口

### 安全要求

- 所有外网通信必须使用 HTTPS / WSS
- 电脑端和手机端都必须经过设备配对
- 每台电脑端 Hive 只接受已绑定手机的控制
- 终端输入、文件传输、停止任务等高风险操作需要鉴权
- 服务器保存的 token 必须可撤销
- 文件需要自动过期，避免服务器变成长期网盘

## 开发团队分工

当前开发团队统一使用 Codex 预设，并使用中文成员名。

### Orchestrator

- 负责需求收敛
- 负责拆分任务
- 负责合并各成员结论
- 负责控制不同成员不要同时修改同一模块

### Relay 后端工程师

- 当前成员名：中转后端
- 负责自建中转服务器
- 负责 HTTP API
- 负责 WebSocket 转发
- 负责设备配对、登录、token 和在线状态
- 负责临时文件上传下载

### Hive 桌面端适配工程师

- 当前成员名：桌面适配
- 负责改造电脑端 Hive runtime
- 负责让电脑端 Hive 主动连接 Relay Server
- 负责把手机端输入转发到真实 Agent PTY
- 负责把 Agent 输出、状态、任务和回执发回手机端

### 移动端/PWA 工程师

- 当前成员名：移动端
- 负责第一阶段手机 Web / PWA
- 负责移动端看板
- 负责 Agent 直接对话界面
- 负责通知审批界面
- 负责文件交换区界面

### 测试与安全审查工程师

- 当前成员名：测试安全
- 负责端到端验收场景
- 负责连接中断、重连、掉线、重复消息等异常场景
- 负责鉴权、设备绑定、文件大小限制和危险操作确认
- 负责后续回归测试清单
