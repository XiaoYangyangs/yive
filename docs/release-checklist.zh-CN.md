# Yive 发布检查清单

[English](./release-checklist.en.md) | 中文

这份清单用于每次把私有开发成果同步到公开源码仓库、准备公开仓库可见性，或发布 npm 包之前。目标是保证远端仓库可以独立 clone、独立构建，并且不包含私有路径、域名、密钥、运行状态或安装包。

## 1. 确认发布范围

- 确认这次变更适合进入公开源码仓库。
- 删除私有部署默认值、真实域名、真实服务器 IP、本机路径、设备名和临时调试文件。
- 不提交 APK、keystore、签名密码、runtime 数据库、终端日志、agent session 标识、工作区状态或依赖缓存。
- 用中性示例值替代真实配置，例如 `relay.example.com`、`203.0.113.10`、`<admin-token>`、`<webhook-url>`。

## 2. 检查本地仓库状态

```powershell
git status --short --branch
git log --oneline --decorate --max-count=5
```

确认：

- 当前分支是要发布的分支。
- 工作区没有无关改动。
- 提交历史看起来符合本次发布意图。

## 3. 安装与基础校验

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

如果只改文档，`pnpm build` 可以视情况跳过；如果改了 runtime、web、移动端、Relay、打包配置或发布文件，必须运行。

## 4. 聚焦测试

推荐的轻量发布前测试：

```powershell
pnpm exec vitest run tests/unit/protocol-file.test.ts tests/cli/team-help.test.ts tests/cli/hive-cli.test.ts --no-file-parallelism --maxWorkers=1 --testTimeout=60000 --hookTimeout=60000
```

如果改动涉及终端、workspace、worker、Relay、文件交换、通知或移动端，补跑对应测试文件。只有大范围重构或发布前最终确认时再跑完整 `pnpm test`。

## 5. 打包验证

```powershell
pnpm pack:check
pnpm pack:smoke
```

`pnpm pack:smoke` 依赖 `dist/`、`dist/bin/` 和 `web/dist/`，必须在成功运行
`pnpm build` 之后执行。如果只想快速查看源码包会包含哪些文件，可以单独运行
`pnpm pack:check`，但它不能替代 smoke 验证。

确认：

- npm 包能生成。
- 包内包含需要的 `dist/`、`web/dist/`、`assets/`、`deploy/` 和文档文件。
- 包内不包含 `node_modules/`、本地 runtime 数据、APK、keystore、临时验证目录或私有配置。

## 6. 本地启动 smoke

先确认端口未被占用，再用构建产物启动：

```powershell
$port = 4519
Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
node dist/src/cli/hive.js --port $port
```

打开：

```text
http://127.0.0.1:4519/
```

确认页面可以加载。验证结束后停止该进程，并确认端口释放：

```powershell
Get-NetTCPConnection -LocalPort 4519 -ErrorAction SilentlyContinue
```

## 7. 敏感信息扫描

把本机专用扫描正则放在一个不提交到仓库的文件中，例如：

```powershell
$env:YIVE_RELEASE_SCAN_PATTERN = "$env:USERPROFILE\.config\yive-release-scan-pattern.txt"
```

这个文件应覆盖：

- 本机用户名、私有目录名、私有工程名。
- 私有域名、服务器 IP、webhook 地址。
- 常见 token、API key、私钥、签名密码、keystore 名称。
- 不应公开的 runtime 数据库名、日志名和临时目录名。

工作区扫描：

```powershell
$pattern = Get-Content $env:YIVE_RELEASE_SCAN_PATTERN -Raw
rg -n --hidden --glob '!node_modules/**' --glob '!dist/**' --glob '!web/dist/**' --glob '!vendor/**' --glob '!.git/**' --regexp $pattern .
```

历史扫描：

```powershell
$pattern = Get-Content $env:YIVE_RELEASE_SCAN_PATTERN -Raw
$commits = git rev-list --all
git grep -n -I -E $pattern $commits -- . ':!vendor' ':!dist' ':!web/dist'
```

如果扫描命中真实问题：

- 只在工作区命中：修复文件后重新扫描。
- 已进入公开历史：不要直接发布；先重写公开分支为干净快照，再重新扫描。

## 8. 全新 clone 独立验证

在仓库外新建临时目录：

```powershell
$verifyRoot = Join-Path $env:TEMP "yive-release-verify"
if (Test-Path -LiteralPath $verifyRoot) {
  Remove-Item -LiteralPath $verifyRoot -Recurse -Force
}
git clone git@github.com:<owner>/yive.git $verifyRoot
cd $verifyRoot
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm pack:check
pnpm pack:smoke
```

私有仓库验证时，需要使用有权限的 SSH key 或 deploy key。不要把 deploy key 私钥提交到仓库。

## 9. 推送与 CI

```powershell
git push origin main
gh run list --repo <owner>/yive --limit 5
```

如果需要用专用 deploy key 推送：

```powershell
$env:GIT_SSH_COMMAND = "ssh -i `"$env:USERPROFILE\.ssh\<repo-deploy-key>`" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
git push git@github.com:<owner>/yive.git main
```

推送后确认：

- GitHub Actions 最新 run 是 `success`。
- 本地 `main` 与 `origin/main` 对齐。
- 远端仓库没有多余分支、tag 或旧 snapshot。

## 10. GitHub 仓库设置

公开或发布前检查：

- Visibility 是否符合当前阶段：private、internal 或 public。
- Issues、Security policy、README、LICENSE、NOTICE、TRADEMARK 是否正确。
- 默认分支是 `main`。
- Actions 权限和 deploy key 权限符合最小权限原则。
- 如果仓库要公开，先确认历史扫描在最终远端内容上通过。

## 11. 发布记录

发布完成后记录：

- 发布 commit。
- 执行过的检查命令。
- CI run 结果。
- 是否做过全新 clone 验证。
- 是否有跳过项，以及跳过原因。

建议把这份记录写入 release issue、PR 描述或维护日志，不要写入包含私有路径和私有配置的临时文件。
