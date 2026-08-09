# Yive

<p align="center">
  <img src="./assets/logo.png" width="120" alt="Yive logo" />
</p>

[English](./README.en.md) | 中文

Yive 是一个本地优先的浏览器工作台，让 Codex 与 Claude Code 以真实、受管的
PTY Agent 协作。每个 Workspace 包含一个 Orchestrator 和任意数量的扁平
Worker；Orchestrator 通过 Yive 的持久化 Team 协议分派工作，所有 Agent 都在
你的本机运行。

> Yive 按 Business Source License 1.1 提供源码，并将在
> [LICENSE.BSL](./LICENSE.BSL) 标明的变更日期转换为 Apache-2.0。Yive 是 Hive
> 的独立衍生项目，不是原项目的官方或受认可发行版。

## 当前产品模型

- 每个 Workspace 一个 Orchestrator，零个或多个扁平 Worker。
- 原生受管 Provider 仅支持 Codex 与 Claude Code。
- 使用真实 PTY 进程、终端历史、原生 Provider Session，以及明确的停止、崩溃和恢复状态。
- Runtime 持有 Dispatch：每个 Worker 最多一个活跃 Dispatch，并提供持久队列、安全边界投递、Note、替换、取消、状态更新和带结果的 Report。
- 分别跟踪进程、会话活动、活跃 Dispatch 与队列状态，避免使用含义模糊的单一状态。
- 提供按角色渐进展示的 `team help` 与有边界的 `team context`。
- 移动端默认使用基于已验证 Provider 对话的 Chat，并保留 Terminal 作为直接 PTY 后备入口。
- 可选的自托管 Relay、通知、双向文件交换，以及安全的产物引用和 Agent 工具。

Yive 不附带模型访问、Provider 凭据、多用户认证、沙箱或托管云服务。受管 Agent
继承启动 Yive 的操作系统用户权限；模型、推理和认证偏好仍由原生 Codex 或
Claude Code 配置决定。Workspace Shell 仅用于普通终端工作，不属于受管 Agent，
也不参与 Team 协调。

## 平台支持

- Node.js 22.13+（22.x），或 Node.js 24.x。
- 从源码开发需要 pnpm 10 或更高版本。
- Windows、macOS 与 Linux；原生 PTY 能力取决于平台支持。
- Codex、Claude Code 或两者均可，但必须安装在启动 Yive 的 `PATH` 中并完成认证。

Yive 使用 `node-pty`、`better-sqlite3` 等原生包。没有匹配预编译二进制的平台可能
还需要本机编译工具。

## 快速开始

从源码启动：

```bash
pnpm install --frozen-lockfile
pnpm build
node dist/src/cli/hive.js --port 4010
```

打开终端输出的本地 URL。Runtime 默认只监听 localhost。

开发模式：

```bash
pnpm dev
```

这会在 `127.0.0.1:4010` 启动 Runtime，并在 `127.0.0.1:5180` 启动 Vite 前端。
桌面端、移动端、Relay、通知与文件交换的详细配置见
[中文用户指南](./docs/user-guide.zh-CN.md)或[英文用户指南](./docs/user-guide.en.md)。

## 首次使用

1. 添加一个可信的本地 Workspace。
2. 为 Orchestrator 选择 Codex 或 Claude Code 并启动。
3. 添加 Worker；默认继承 Orchestrator 的 Provider，也可显式选择另一种受支持 Provider。
4. 向 Orchestrator 提交目标。它可用 `team context` 查看状态，用 `team send` 分派工作。
5. Worker 用 `team status` 报告进度，用 `team report` 提交最终成功或失败结果。

Runtime 将协调状态持久化到 SQLite；Workspace 内的任务文件不是事实来源。

## 架构

```text
桌面或移动浏览器
        |
        | HTTP + WebSocket
        v
Yive Runtime
  SQLite 协调状态
  Provider Session 跟踪
  PTY 生命周期与恢复
        |
        +-- Orchestrator（Codex 或 Claude）
        +-- Worker（Codex 或 Claude）
        +-- Workspace Shell（非 Agent）

可选远程路径：
移动浏览器 <-> 自托管 Relay <-> 桌面 Yive Runtime
```

`team` 与 `yive agent` 命令会注入受管 Session。它们使用短期、限定范围的
Runtime 凭据；除非另行暴露，否则不是通用全局命令。

## 移动端与 Relay

移动界面位于 `/mobile`。Chat 默认显示已验证的 Provider 对话，Terminal 模式则
用于直接检查和控制 PTY。

远程访问需要由你自行运行 Relay。公开示例仅使用
`https://relay.example.com` 等中性占位值；本仓库不运营该端点。不要把桌面
Runtime 端口直接暴露到互联网。

## 常用命令

```bash
pnpm check
pnpm build
pnpm test
pnpm test:windows
pnpm release:dry
```

公开发布前请遵循[中文发布检查清单](./docs/release-checklist.zh-CN.md)或
[英文发布检查清单](./docs/release-checklist.en.md)。

## 安全模型

Runtime 元数据默认位于 `~/.config/yive`，也可通过 `$HIVE_DATA_DIR` 指定。Yive
是本地开发工具，不是安全边界：

- 只打开可信 Workspace。
- 将受管 Agent 与 Workspace Shell 视为能够以当前用户权限执行命令。
- 分别保护 UI、Agent、Mobile 与 Relay 凭据。
- 不要公开终端日志、本机 Workspace 路径、Runtime 数据库或移动端签名产物。
- 处理敏感项目之前请阅读 [SECURITY.md](./SECURITY.md)。

## 包状态与许可证

仓库支持用 `pnpm pack:check` 与 `pnpm pack:smoke` 验证 npm 包。在明确发布匹配的
npm 版本之前，建议使用上述源码流程。

开发与测试要求见 [CONTRIBUTING.md](./CONTRIBUTING.md)。Yive 1.4.0 及后续版本按
Business Source License 1.1 授权，详见 [LICENSE.BSL](./LICENSE.BSL)。
[LICENSE](./LICENSE) 仅保留其所覆盖历史版本的 Apache-2.0 条款。原始工作归属
Shaokun Tu（tt-a1i）及贡献者；Yive 的准备工作与后续修改归属 XiaoYangyangs。
上游 Hive 名称、Logo 与视觉标识受 [TRADEMARK.md](./TRADEMARK.md) 约束。
