# Mobile Remote Control Test Plan

## 目标

这份计划用于建立移动远程控制的测试与安全基线，覆盖移动端入口、mobile controller、Relay、文件交换、危险操作确认、断线重连，以及后续端到端验收。

移动远程控制会把本机 yive runtime 的真实 PTY、team action、workspace 状态和文件传输暴露到手机端或 Relay 通道。测试必须证明：

- 手机端只能控制已授权的 desktop yive。
- Relay 只做认证、路由、在线状态和临时文件传输，不直接运行 Agent、不读取 workspace、不接触真实 PTY。
- CLI agent token、yive UI token、mobile session token、Relay token 彼此隔离。
- 高风险动作具备鉴权、确认和重放防护。
- 断线重连不会造成重复执行或状态漂移。

## 测试入口

| 层级 | 入口 | 当前建议 |
| --- | --- | --- |
| 移动端 PWA | `web/src/mobile/*`, `/mobile` | `tests/web/mobile-route.test.tsx` |
| mobile controller | `GET /api/mobile/snapshot`, mobile action routes, `/ws/mobile/events` | `tests/server/mobile-snapshot.test.ts`, `tests/server/mobile-actions.test.ts` |
| Relay | `src/relay/*` | `tests/relay/*.test.ts`, `tests/web/relay-api.test.ts` |
| 文件交换 | runtime/Relay file exchange API | `tests/server/file-exchange.test.ts`, `tests/unit/smoke-file-exchange-relay.test.ts` |
| 危险操作确认 | mobile UI + server-side action | `tests/web/confirm-dialog.test.tsx`, `tests/server/mobile-actions.test.ts` |
| 断线重连 | mobile PWA, Relay WS, desktop connector | `tests/web/mobile-route.test.tsx`, `tests/web/relay-api.test.ts`, `tests/relay/relay-server.test.ts` |

## 真机手动回归清单

建议在每次移动端 App 化分页改造后，用真实手机验证以下步骤：

1. 热点访问：电脑启动 yive runtime 和 web dev server，手机连接同一热点或局域网，通过电脑局域网 IP 打开 `/mobile`，确认不会跳回桌面首页，刷新后仍进入移动端。
2. 页面结构：在 390px 左右手机宽度下确认底部 Tab 固定可触达；看板页只显示状态摘要和入口，不需要长滚动查找 Agent、通知或文件功能。
3. Tab 切换：依次切换“看板 / Agent / 通知 / 文件”，确认 `aria-current` 对应当前页，切换后页面内容不残留上一个 Tab 的长列表。
4. Agent 详情：进入 Agent 列表，点击运行中的 Agent 进入终端详情，再点击返回，确认回到 Agent Tab 且列表状态未丢失。
5. 终端输入：在 Agent 详情中点击辅助键或输入命令，确认电脑端对应 PTY 收到输入；不在详情页时不能误触发终端输入。
6. 危险停止：点击“停止”后必须先出现二次确认；取消不停止，确认才停止；请求中不得包含 `HIVE_AGENT_TOKEN`、`x-hive-agent-token` 或 `agent_token`。
7. 文件上传：文件 Tab 上传 `.md`、`.mp4`、`.png`、`.jpg`、`.jpeg`、`.webp` 成功；危险文件或超限文件被本地或 API 拒绝；列表只提供下载/删除，不自动预览或执行文件内容。
8. 文件清空隔离：点击清空只清理临时文件交换区，工作区真实文件仍存在；下载不存在文件返回 404。
9. 离线状态：关闭 runtime 或断开网络后，移动端显示离线/错误状态，不出现可误触的停止、上传或审批动作。

## 聊天式 CLI 真机回归清单

用于手机端 Agent 详情和 mobile actions 验收：

1. 手机键盘：进入运行中的 Agent 详情，点击 CLI 输入框，确认手机键盘弹出后输入框、发送按钮和辅助键仍可触达，页面不会被键盘遮挡到无法发送。
2. 命令输入：输入普通命令并点击发送，电脑端真实 PTY 收到带回车的输入；发送后输入框清空。
3. 空输入：输入空格或不输入内容直接点击发送，不得向 PTY 发送任何内容。
4. 辅助键：分别点击 `Ctrl+C`、`Enter`、方向键等辅助键，确认只向当前详情页的 run 发送对应控制字符；返回 Agent 列表后不能误触发终端输入。
5. 长输出：运行会产生长输出的命令，确认终端区域可滚动、输入框仍固定在可操作位置。
6. 二次确认：点击“停止”必须出现确认框；取消不触发 stop，确认才触发；restart 同样需要明确确认或可审计动作。
7. 断线重连：发送命令前后断开 Wi-Fi 或关闭 runtime，UI 应显示离线/失败，不应缓存并在恢复后重复执行旧输入或旧 stop。
8. mobile actions API：用 DevTools 或代理检查 `/api/mobile/actions` 的 `terminal_input`、`start_run`、`stop_run`、`restart_run` 请求，必须带 UI session，响应和请求都不得包含 `HIVE_AGENT_TOKEN`、`x-hive-agent-token` 或 `agent_token`。

## 局域网真机联调清单

LAN 模式必须只在可信局域网或个人热点内开启：

1. 查询电脑 IP：Windows 运行 `ipconfig`，记录当前 Wi-Fi/以太网 IPv4 地址，例如 `192.168.1.x`；确认不是 VPN、Docker、虚拟网卡地址。
2. 诊断手机入口：先运行 `yive mobile lan`，确认候选 `http://<电脑IPv4>:5180/mobile`，如果提示只监听 localhost，再按输出的 next commands 用 `0.0.0.0` 启动 LAN 预览。
3. 启动 LAN 预览：电脑端使用 `HIVE_RUNTIME_HOST=0.0.0.0 HIVE_DEV_LAN=1 pnpm dev:runtime`，web dev server 如需手机直连也绑定到局域网地址或 `0.0.0.0`。
4. 手机访问：手机连接同一 Wi-Fi 或热点，打开 `http://<电脑IPv4>:<端口>/mobile`；确认能初始化 UI session、进入移动端页面，并显示合理连接状态。
5. 换网验证：手机切到蜂窝网络或另一个 Wi-Fi 后重新访问，应无法连接；不要为了联调放开公网端口。
6. Windows 防火墙：如果手机无法访问，检查 Windows Defender 防火墙入站规则，仅允许 Node/yive 在“专用网络”放行；联调后撤销或关闭规则。
7. HTTP/API 检查：在手机浏览器或电脑上用同一 LAN URL 检查 `/api/ui/session`、`/api/mobile/snapshot`、`/api/mobile/files`；未带 UI cookie 时控制 API 应返回 403，带 cookie 后才返回数据。
8. WS 检查：打开 Agent 详情和任务页，确认终端输入 WS、任务 WS 在 LAN 地址下连接正常；断网/切网后 UI 应显示离线或失败，不应静默继续显示可控状态。
9. 文件交换：在手机文件 Tab 上传允许类型，拒绝危险文件和超限文件；下载不存在文件返回 404；清空只影响临时交换区。
10. 危险动作与 token：执行 Stop 二次确认流程，抓取 DevTools/代理日志时确认请求不包含 `HIVE_AGENT_TOKEN`、`x-hive-agent-token` 或 `agent_token`。
11. 收尾：联调结束后关闭 runtime，取消 `HIVE_DEV_LAN=1`，确认手机不再能访问本机 yive。

## 测试矩阵

### 1. 移动端 `/mobile`

| 场景 | 验证点 | 失败条件 | 当前覆盖 |
| --- | --- | --- | --- |
| 路由隔离 | `/mobile` 渲染 phone-first shell，不影响桌面 `/` | 桌面入口被替换或 `/mobile` 空白 | `tests/web/mobile-route.test.tsx` |
| UI session 初始化 | 先调用 `/api/ui/session`，再加载 `/api/workspaces` | 未初始化 session 就读取 runtime 数据 | `tests/web/mobile-route.test.tsx` |
| stale UI token | workspace 请求收到 `UI endpoint requires valid UI token` 后刷新 session 并重试一次 | 直接失败或无限重试 | `tests/web/mobile-route.test.tsx` |
| 错误态 | session 或 workspace 加载失败时显示 Offline/error | 沉默失败、白屏、误报 Runtime online | `tests/web/mobile-route.test.tsx` |
| 空 workspace | 显示可行动的空状态 | 空数组导致崩溃、假数据或只提示“请选择” | `tests/web/mobile-route.test.tsx` |
| 移动可读性 | 窄屏无横向溢出，关键状态可见，底部 Tab 可切换 | 文本重叠、按钮过小、需要缩放或依赖长滚动 | `tests/web/mobile-route.test.tsx` 覆盖分页入口；后续 Playwright/截图补充 |

### 2. mobile controller

| 场景 | 验证点 | 失败条件 | 当前覆盖 |
| --- | --- | --- | --- |
| snapshot payload | 返回 workspace、orchestrator、workers、runs、dispatch summary、recent messages | 字段缺失、camelCase/snake_case 边界不稳定 | `tests/server/mobile-snapshot.test.ts` |
| mobile auth | mobile API 使用独立 mobile session token，并暂时兼容 UI cookie 以保留本地开发路径 | 复用 CLI agent token 或匿名请求即可控制 | `tests/server/mobile-snapshot.test.ts`, `tests/server/mobile-actions.test.ts`, `tests/server/file-exchange.test.ts` |
| cross-workspace isolation | mobile access context 必须经过统一 workspace access 检查；正式设备 token 后续绑定 workspace/desktop | token A 可访问 workspace B | `tests/server/mobile-access-context.test.ts` 覆盖 workspace scope 检查；`tests/server/mobile-actions.test.ts` 覆盖 run 不能跨 workspace；正式设备 token 绑定后继续补端到端 |
| team action wrapper | send/note/report/status/cancel 经 runtime 内部能力执行 | 绕过 team operation、Note 安全边界或状态不一致 | `tests/server/mobile-actions.test.ts` 覆盖 server wrapper；`tests/web/mobile-runtime-client.test.ts` 和 `tests/web/mobile-route.test.tsx` 覆盖本地/Relay runtime client 与 UI 的 `team_send`、`team_note`、`team_status`、`team_report` 和需要 confirmation nonce 的 `team_cancel`；`tests/relay/relay-server.test.ts` 覆盖 `team_note` 转发与旧 `force` 字段拒绝 |
| terminal action wrapper | terminal input/resize/stop 复用现有 run/PTY 能力 | mobile controller 直接操作 PTY 私有实现 | `tests/server/mobile-actions.test.ts`, `tests/server/terminal-ws.test.ts` |
| saved session safe stop | 已持久化会话零注入停止；未提交尾部要求显式恢复点；超时、PTY 丢失或会话变化时保留运行 | 保存时注入内容、未确认即发送恢复点、验证失败仍停止或误报成功 | `tests/unit/agent-safe-stop.test.ts`, `tests/server/app.test.ts`, `tests/server/mobile-actions.test.ts`, `tests/web/agent-safe-stop-dialog.test.tsx`, `tests/web/mobile-agent-safe-stop.test.tsx`, `tests/web/mobile-route.test.tsx` |
| local request guard | 不为移动访问放宽本地保护；LAN 只在 `HIVE_DEV_LAN=1` 时允许私网 Host/Origin/remote address | 非本地 Host/Origin 可访问本地 runtime 控制接口 | `tests/unit/local-request-guard.test.ts`, `tests/server/app.test.ts`, `tests/server/mobile-snapshot.test.ts`, `tests/server/terminal-ws.test.ts` |

### 3. Relay

| 场景 | 验证点 | 失败条件 | 当前覆盖 |
| --- | --- | --- | --- |
| health | Relay 可启动并返回 health，包含协议版本、连接数、启动时间和运行时长 | 进程启动失败、health 不稳定或诊断字段缺失 | `tests/relay/relay-server.test.ts`, `tests/web/relay-api.test.ts`, `tests/cli/hive-cli.test.ts` |
| pairing claim body | `/pairings/claim` 拒绝畸形 JSON 和过大 body | 匿名公网入口被大请求拖垮或返回 500 | `tests/relay/relay-server.test.ts` |
| device id bounds | HTTP claim 和 WS upgrade 拒绝空/控制字符/过长 device id | 超长 id 进入 store、设备列表或 UI | `tests/relay/pairing-store.test.ts`, `tests/relay/relay-server.test.ts` |
| desktop/mobile pairing | desktop 和 mobile 都必须完成配对；生产 Relay 开启 desktop binding 时，CLI 不生成未绑定的手机配对链接，带 `--desktop-id` 的主链接必须直接绑定目标电脑 | 未配对即可建立控制通道，或生成认领后无法控制任何电脑的坏链接 | `tests/relay/relay-server.test.ts`, `tests/cli/hive-cli.test.ts` |
| token validation | WS/HTTP token 缺失、错误、撤销后拒绝 | 失效 token 仍可用 | `tests/relay/pairing-store.test.ts`, `tests/relay/relay-server.test.ts`, `tests/web/relay-api.test.ts` |
| binding route | mobile 只能向已绑定 desktop 转发 | mobile 可指定任意 desktop id | `tests/relay/relay-server.test.ts` |
| envelope validation | 校验 `request_id`, `channel`, `from`, `to`, `payload` | 缺字段、未知 channel 仍被转发 | `tests/relay/relay-server.test.ts` |
| no runtime access | Relay 不读取 workspace、不运行 Agent、不接触 PTY | Relay 依赖本地 workspace 路径或 PTY API | 架构约束；后续补静态/集成审计 |
| HTTPS/WSS policy | 正式公网 Relay smoke 默认要求 HTTPS/WSS；临时 IP/HTTP 测试必须显式加 `--allow-http-only` | 公网 HTTP/WS 被当成正式可发布状态 | `tests/web/relay-api.test.ts` 覆盖 URL 归一化和 PWA 提示；`tests/unit/smoke-relay.test.ts` 覆盖公网 HTTP 拦截和临时例外；`tests/unit/smoke-relay-all.test.ts` 覆盖总 smoke 透传 |

### 4. WebSocket

| 场景 | 验证点 | 失败条件 | 当前覆盖 |
| --- | --- | --- | --- |
| local terminal WS | 现有 terminal IO/control 支持输出、输入、resize、exit | 输出/输入丢失或 control 不生效 | `tests/server/terminal-ws.test.ts` |
| Host/Origin guard | 非本地 Host/Origin 拒绝 | attacker origin 可升级 WS | 现有 server WS 测试 |
| mobile events WS | mobile snapshot/update/event stream | 未授权 mobile 可订阅 | `tests/server/mobile-snapshot.test.ts` 覆盖 auth、local guard、connect/reconnect snapshot 和 runtime changes 后 fresh snapshot broadcast |
| Relay routing WS | desktop/mobile 双 outbound 长连接 | 断线后状态不清或路由错发 | `tests/relay/relay-server.test.ts`, `tests/web/relay-api.test.ts` |
| duplicate request | 相同 `request_id` 不重复执行危险动作 | 重连重放导致重复 stop/cancel/input | `tests/server/mobile-actions.test.ts` |

### 5. 文件交换

| 场景 | 验证点 | 失败条件 | 当前覆盖 |
| --- | --- | --- | --- |
| allowed types | 只允许当前策略内类型 | 任意扩展名可上传 | `tests/server/file-exchange.test.ts`, `tests/web/mobile-route.test.tsx` |
| size limit | 超过大小限制拒绝；经 Relay 上传失败时只返回安全错误，不回显 base64、token 或本地路径 | 超限文件写入临时区，或失败响应泄露敏感内容 | `tests/server/file-exchange.test.ts`, `tests/relay/relay-server.test.ts` |
| Content-Length | 明确 Content-Length 超限时提前拒绝 | 仍读完整 body | `tests/server/file-exchange.test.ts` |
| streaming limit | 无 Content-Length 或伪造长度时按流式累计限制；base64 解码前按扩展名估算大小并提前拒绝 | 绕过限制 | `tests/server/file-exchange.test.ts` |
| MIME/extension consistency | 图片、PDF、ZIP、MP4 按扩展名校验内容签名；文本类文件按扩展名白名单处理 | 可伪装危险文件 | `tests/server/file-exchange.test.ts` |
| temporary storage | 文件自动过期，过期后列表清理、下载返回 404 | Relay 变长期网盘 | `tests/server/file-exchange.test.ts` |
| review result | approve/reject/needs changes 回传 desktop yive | 审核结果丢失或跨文件串单 | `tests/server/mobile-actions.test.ts`, `tests/web/mobile-runtime-client.test.ts`, `tests/web/mobile-route.test.tsx` |

### 6. 危险操作确认

危险操作包括：

- terminal input
- stop run
- cancel Dispatch
- file upload/download/approve/reject
- retry / continue / dispatch

| 场景 | 验证点 | 失败条件 | 当前覆盖 |
| --- | --- | --- | --- |
| UI confirm | confirm 调用 action，cancel/Escape 不调用 action，danger 样式可见 | 取消也执行操作 | `tests/web/confirm-dialog.test.tsx`, `tests/web/mobile-route.test.tsx` |
| safe stop escalation | 默认先检查且不发送消息；恢复点和强制停止分别显式确认；强制停止展示未提交尾部可能永久丢失 | 普通停止静默注入恢复点、一次点击直接强停、检查中提前隐藏终端 | `tests/web/agent-safe-stop-dialog.test.tsx`, `tests/web/mobile-agent-safe-stop.test.tsx`, `tests/web/mobile-route.test.tsx` |
| confirmation nonce | 高风险请求需要一次性确认 nonce | 缺 nonce 或重复 nonce 仍执行 | `tests/server/mobile-actions.test.ts`, `tests/server/mobile-transcript.test.ts` |
| action auth | 高风险动作需要 mobile/UI token、绑定目标和确认 nonce；正式账号体系还需要补每台 desktop/workspace 的独立权限 | 未绑定 mobile 可 stop/input | `tests/server/mobile-actions.test.ts`, `tests/server/mobile-transcript.test.ts`；设备/账号级权限后续补充 |
| stale confirmation | 过期确认被拒绝 | 长时间后仍可执行旧操作 | `tests/server/mobile-actions.test.ts` |
| audit event | 危险操作记录 request id、actor、target、结果，且 transcript 不泄露 confirmation nonce | 无法追踪误触或重放 | `tests/server/mobile-transcript.test.ts`, `tests/web/mobile-route.test.tsx` |

### 7. 断线重连

| 场景 | 验证点 | 失败条件 | 当前覆盖 |
| --- | --- | --- | --- |
| runtime offline UI | Retry 探测 `/api/version`，自动重连成功后 reload | offline 后白屏或不会恢复 | `tests/web/runtime-offline-page.test.tsx` |
| mobile route load failure | `/mobile` 显示 Offline/error，不伪造在线 | session/workspace 失败仍显示 Runtime online | `tests/web/mobile-route.test.tsx` |
| mobile WS reconnect | WS 断开后退避重连并重新订阅 snapshot；本地 mobile events socket 和 Relay mobile socket 重新打开后都重置退避，避免弱网恢复后下一次断线等待过长 | 重连后没有状态、多重订阅，或恢复后仍按长退避等待 | `tests/server/mobile-snapshot.test.ts`, `tests/web/mobile-events-client.test.ts`, `tests/web/relay-api.test.ts`, `tests/web/mobile-route.test.tsx` |
| desktop disconnect | desktop 掉线时 mobile 收到明确错误 | mobile 继续显示可控状态 | `tests/relay/relay-server.test.ts` |
| Relay disconnect | Relay 断线后 desktop/mobile 状态收敛 | 两边状态永久不一致 | `tests/relay/relay-server.test.ts` 覆盖 desktop reconnect 和断开清理；`tests/web/relay-api.test.ts` 覆盖 pending request 断开后的恢复；`tests/web/mobile-route.test.tsx` 覆盖事件流断开、重连提示、重新订阅、收到新 snapshot 后恢复 |
| offline actions | 离线期间命令明确失败或进入可见队列 | 静默丢失或恢复后重复执行 | `tests/web/mobile-route.test.tsx`, `tests/server/mobile-actions.test.ts` |

## 当前建议执行命令

轻量回归：

```bash
pnpm exec vitest run tests/web/mobile-route.test.tsx tests/web/confirm-dialog.test.tsx tests/web/runtime-offline-page.test.tsx --no-file-parallelism --maxWorkers=1 --testTimeout=60000 --hookTimeout=60000
```

Windows 本地基线：

```bash
pnpm test:windows
```

提交前完整检查：

```bash
pnpm check
pnpm build
pnpm test
```

## M3/M5 Terminal UX Test Gates

Automated coverage that should stay green:

Contract source: `requirements/mobile-remote-control/TERMINAL_CONTRACT.md`.
Any change to mobile terminal ownership, takeover, input, Relay routing, mobile
actions, or mobile file exchange must keep that contract and this test plan in
sync.

- M3 current mobile agent detail: `tests/web/mobile-route.test.tsx` verifies the Agent detail surface opens from `/mobile`, creates `TerminalView` with `propagateResize=false`, hides the global dashboard chrome, keeps terminal controls fixed, keeps auxiliary keys collapsed by default, sends terminal input through `/api/mobile/actions`, and does not expose `HIVE_AGENT_TOKEN`, `x-hive-agent-token`, or `agent_token`.
- M3 image handling: `tests/web/mobile-route.test.tsx` verifies native image paste first and Artifact fallback; request payloads and DOM must not leak `local_path`, uploaded base64, dangerous clipboard paths, attachment-registry internals, or Agent tokens. `tests/server/mobile-actions.test.ts` verifies Artifact contract v2 negotiation, preserves caller-authored terminal text even when it mentions generic security terms, binds upload handles to validated Workspace-relative Artifacts, and rejects unversioned attachment actions before PTY input. Relay image handling is covered by `tests/relay/relay-server.test.ts`, `tests/web/relay-api.test.ts`, and `tests/unit/smoke-file-exchange-relay.test.ts`, including `--verify-image-paste` for upload -> local Runtime Artifact binding.
- M3 Team interruption actions: `tests/server/mobile-actions.test.ts`, `tests/web/mobile-runtime-client.test.ts`, and `tests/web/mobile-route.test.tsx` verify `team_cancel` and `team_replace` use one-time confirmation nonces, retain stable action IDs for equivalent retries, preserve explicit busy-turn interruption, and cross both local and Relay client paths without exposing Provider Session IDs.
- M5 passive viewer safety: `tests/server/terminal-ws.test.ts` verifies `passive=1` viewers receive the desktop canonical restore size and that passive resize messages do not call `store.resizeAgentRun`.
- M5 takeover protocol: `tests/server/terminal-ws.test.ts` verifies `mode=takeover` plus `takeover_request` grants resize ownership, blocks desktop resize while mobile owns the size, `takeover_release` restores the previous desktop size, and takeover heartbeat lease expiry restores the desktop if a mobile owner goes stale.
- Relay local runtime failure handling: `tests/web/relay-api.test.ts` verifies desktop-origin `local_runtime_error` responses are accepted for the matching mobile request, and `tests/web/mobile-route.test.tsx` verifies the phone explains that the target desktop is online but its local yive runtime request failed.
- Relay request reconnect handling: `tests/web/relay-api.test.ts` verifies a pending request interrupted by a closed Relay socket does not poison future requests, and `tests/web/mobile-route.test.tsx` verifies the phone can retry an interrupted Relay workspace load through a fresh socket.
- Relay mobile events recovery: `tests/web/relay-api.test.ts` verifies resubscribe after Relay socket reconnect and local event proxy close; `tests/web/mobile-route.test.tsx` verifies the phone shows reconnect status and clears stale warnings after a fresh snapshot.
- Relay local auth boundary: `tests/relay/relay-server.test.ts` verifies the desktop connector uses `hive_mobile_token` for local `/api/mobile/*` and `/ws/mobile/events`, while keeping `hive_ui_token` for desktop UI routes and terminal proxy sockets.

Automation still required before M3/M5 are complete:

- M3 chat-first UI: follow `requirements/mobile-remote-control/CHAT_VIEW_PLAN.md`. Add tests for default Chat view, no terminal sockets from Agent list or Chat, explicit Raw terminal connection, immediate takeover release/socket close on return to Chat, 30-item cursor paging, scroll preservation, safe Markdown, image submissions, stale/unsupported/stopped states, and device-local default-view preference.
- Provider conversation projection: add Codex and Claude Code fixture tests for recording boundaries, no historical backfill, verified user/assistant turns, working/tool state, partial trailing JSONL, compaction filtering, interactive session changes, source failure/staleness, incremental checkpoints, and exclusion of terminal output, hidden reasoning, system prompts, tokens, and absolute paths.
- Chat submission lifecycle: add integration coverage for UUID idempotency, `Ctrl+U` plus whole-message delivery, delivered/confirmed reconciliation, three-item queue capacity, forced out-of-order delivery, edit/cancel before delivery, pause after Runtime restart/Agent stop/session switch, explicit migration, lost acknowledgement, manual retry, and no automatic send after reconnect.
- M5 takeover hardening: add protocol tests for desktop/mobile visible owner state and second confirmation before enabling phone takeover.

如果完整 server/PTY 测试在 Windows 上失败，需要区分产品失败和环境限制。已知风险包括 `/bin/bash` 不存在，以及 `node-pty` 在 Windows 上可能输出 `AttachConsole failed` 清理噪音。

## 后续必须补的集成测试

1. `tests/relay/pairing-store.test.ts`：配对、绑定、撤销 token、跨设备拒绝。
2. `tests/relay/ws-router.test.ts`：desktop/mobile WS token 校验、binding route、envelope schema、未知 channel 拒绝。
3. `tests/relay/reconnect.test.ts`：desktop/mobile/Relay 任一方断线后的在线状态、重连订阅、request_id 去重。
4. `tests/relay/temp-file-store.test.ts`：Relay 转发层继续补 `.md`/`.mp4`、大小边界、Content-Length 与 streaming 双重限制、过期清理的端到端覆盖；本地 runtime 文件交换覆盖见 `tests/server/file-exchange.test.ts`。
5. `tests/server/mobile-controller.test.ts`：snapshot 字段稳定性、cross-workspace 隔离、mobile token 与 UI/CLI token 隔离。
6. `tests/server/mobile-actions.test.ts`：terminal input、stop run、team cancel、file approval 的鉴权、确认 nonce、审计。
7. Playwright/mobile viewport：`/mobile` 看板、终端、通知、文件交换在手机尺寸下无重叠、可滚动、可触控。
