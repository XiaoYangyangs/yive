# Yive Relay 部署速查

这套部署方式的目标是：服务器只运行 Relay 和手机网页/PWA，本地电脑继续运行真正的 Yive runtime、PTY、Agent、工作区和 API Key。

## 1. 服务器准备

Ubuntu 22.04 / 2C2G 可以先跑 Relay。服务器需要：

- Node.js 22+
- pnpm
- git
- nginx，可选但建议使用
- 80/443 或 4020 端口放行

生产目录约定：

```bash
/opt/yive-runtime      # 代码仓库
/etc/yive/relay.env   # Relay 配置和 admin token
/var/lib/yive          # 配对数据和部署状态
```

## 2. 首次安装 Relay

```bash
sudo mkdir -p /opt
sudo git clone <your-yive-repo-url> /opt/yive-runtime
cd /opt/yive-runtime
sudo corepack enable
sudo corepack prepare pnpm@latest --activate
sudo pnpm install --frozen-lockfile
sudo pnpm build
sudo bash deploy/install-relay-service.sh
```

编辑配置：

```bash
sudo nano /etc/yive/relay.env
```

至少改掉 admin token：

```bash
YIVE_RELAY_PORT=4020
YIVE_RELAY_HOST=0.0.0.0
YIVE_RELAY_ADMIN_TOKEN=<strong-admin-token>
YIVE_RELAY_PAIRING_STORE=/var/lib/yive/relay-pairings.json
YIVE_RELAY_STATIC_DIR=/opt/yive-runtime/web/dist
YIVE_RELAY_HEARTBEAT_INTERVAL_MS=30000
YIVE_RELAY_HEARTBEAT_TIMEOUT_MS=75000
YIVE_RELAY_REQUIRE_DESKTOP_BINDING=1
YIVE_RELAY_PUBLIC_URL=http://<server-ip>:4020
```

`/etc/yive/relay.env` 需要让 `yive` 服务用户可读：

```bash
sudo chown root:yive /etc/yive/relay.env
sudo chmod 640 /etc/yive/relay.env
```

检查并启动：

```bash
sudo -u yive env YIVE_RELAY_APP_DIR=/opt/yive-runtime YIVE_RELAY_ENV_FILE=/etc/yive/relay.env bash /opt/yive-runtime/deploy/check-relay-config.sh
sudo systemctl start yive-relay
systemctl status yive-relay --no-pager
```

如果检查提示 `relay.env contains Windows CRLF line endings`，说明配置文件是从 Windows 复制过去的换行格式。先修复换行，再重新检查：

```bash
sudo sed -i 's/\r$//' /etc/yive/relay.env
sudo -u yive env YIVE_RELAY_APP_DIR=/opt/yive-runtime YIVE_RELAY_ENV_FILE=/etc/yive/relay.env bash /opt/yive-runtime/deploy/check-relay-config.sh
```

## 3. 暂时用 IP 访问

如果还没有 HTTPS，可以先直接用端口：

```text
http://<server-ip>:4020/mobile?relay=1
```

用 smoke test 验证：

```bash
node deploy/smoke-relay.mjs --server http://<server-ip>:4020 --token "<strong-admin-token>"
```

`YIVE_RELAY_HOST=0.0.0.0` 用于云服务器公网监听；如果只在本机测试，可以保持默认 `127.0.0.1`。

`YIVE_RELAY_REQUIRE_DESKTOP_BINDING=1` 是公网生产默认值：手机设备 token 必须绑定到创建配对链接时指定的 `desktop-id`，不能拿未绑定 token 随意连接其他电脑。`deploy/check-relay-config.sh` 和 `deploy/smoke-relay.mjs` 会把缺失这个生产约束视为部署失败。

`YIVE_RELAY_PUBLIC_URL` 用于部署和回滚后的自动公网 smoke。配置后，`deploy/deploy-relay.sh` 和 `deploy/rollback-relay.sh` 会在 systemd 重启成功后自动运行 `deploy/smoke-relay.mjs`，确认 `/health`、PWA 静态资源、持久化配对库和桌面绑定严格模式都符合生产要求。`deploy/smoke-relay.mjs` 还会检查 `/health.deployment.public_url_configured`；如果这个值不是 `true`，说明新 Relay 进程没有读到 `YIVE_RELAY_PUBLIC_URL`，需要检查 `/etc/yive/relay.env` 后重新 `sudo systemctl restart yive-relay`。

## 4. 配 Nginx

IP / HTTP：

```bash
sudo bash deploy/install-nginx-relay-site.sh _ http
sudo systemctl reload nginx
```

域名 / HTTPS：

```bash
sudo LETSENCRYPT_EMAIL=<your-email> bash deploy/enable-relay-https.sh relay.example.com <server-ip>
```

HTTPS 需要域名 DNS、备案/可访问状态、证书都准备好。没有 HTTPS 时，先用 IP + 端口测试 Relay 主链路。
如果检查里看到 `HTTP Relay health failed: /health returned 403, server=Beaver`，说明请求还没到 Yive/Nginx，通常是云厂商接入层拦截；在国内服务器上优先确认 ICP 备案、域名绑定和控制台放行状态。

域名切换前后可以用脚本检查 DNS、HTTP/HTTPS Relay、PWA 安装资源和 Service Worker 更新策略：

```bash
pnpm smoke:relay-domain -- --domain relay.example.com --server-ip <server-ip>
```

如果要测试 Android/TWA 外壳，还需要把 Android Digital Asset Links 写进静态目录，并用域名检查脚本验证：

```bash
pnpm mobile:android:fingerprint -- --keystore android-twa/release.jks --alias yive
pnpm mobile:android:assetlinks -- --out-dir web/dist --android-package com.example.yive --android-sha256 <release-cert-sha256>
pnpm mobile:android:twa -- --domain https://relay.example.com --static-dir web/dist --out-dir android-twa --android-package com.example.yive --android-sha256 <release-cert-sha256>
pnpm mobile:android:verify -- --domain https://relay.example.com --static-dir web/dist --twa-dir android-twa --android-package com.example.yive --android-sha256 <release-cert-sha256>
pnpm mobile:android:check -- --domain https://relay.example.com --static-dir web/dist --out-dir android-twa --android-package com.example.yive --android-sha256 <release-cert-sha256> --check-domain
pnpm smoke:relay-domain -- --domain relay.example.com --server-ip <server-ip> --android-package com.example.yive --android-sha256 <release-cert-sha256>
```

`android-twa/` 目录会自动生成 `.gitignore`，默认忽略 `.jks` / `.keystore`、`keystore.properties`、`local.properties`、APK/AAB 等本地签名和构建产物。正式签名文件只保存在本机或 CI secret 中，不要提交到仓库。
`pnpm mobile:android:verify` 是本地离线检查：它确认 `web/dist/manifest.webmanifest`、`web/dist/sw.js`、`.well-known/assetlinks.json` 和 `android-twa/twa-package.json` 互相匹配，适合在真正调用 Bubblewrap 打包 APK/AAB 前先跑。
`pnpm mobile:android:check` 会先生成/刷新 `assetlinks.json` 和 `android-twa/`，再跑本地离线验证；加 `--check-domain` 时还会继续检查线上域名、PWA 和 Android Asset Links。
`android-twa/` 还会生成 `install-twa.sh` / `install-twa.ps1` 和 `verify-device.sh` / `verify-device.ps1`；`bubblewrap build` 后连接开启 USB 调试的 Android 手机，先运行安装脚本 `adb install -r` 并启动 `com.example.yive` 测试包，再运行 `verify-device` 脚本确认设备已连接、包已安装，并能打开 `https://relay.example.com/mobile?relay=1`。
打包前可以在 `android-twa/` 目录运行 `check-release.sh` 或 `check-release.ps1`，它会复用 `pnpm smoke:relay-domain` 检查域名、PWA manifest 和 Android Asset Links；如果目录不在仓库根目录下，先设置 `YIVE_REPO_DIR`。

也可以让 CLI 一次性生成公网 Relay、终端、文件交换和 Android/TWA 的安全验收清单：

```bash
yive relay checklist --server https://relay.example.com --desktop-id desktop-windows --android-package com.example.yive --android-sha256 <release-cert-sha256>
```

如果只是临时 IP / HTTP 测试，可以允许没有 HTTPS：

```bash
pnpm smoke:relay-domain -- --domain <server-ip> --server-ip <server-ip> --allow-http-only
```

## 5. 本地电脑连接 Relay

在本地电脑的 Yive 仓库里创建配置：

```powershell
copy deploy\windows-desktop-relay.env.example "$env:USERPROFILE\.config\yive\desktop-relay.env"
notepad "$env:USERPROFILE\.config\yive\desktop-relay.env"
```

填写：

```text
YIVE_RELAY_SERVER=http://<server-ip>:4020
YIVE_RELAY_TOKEN=<strong-admin-token>
YIVE_RELAY_DEVICE_ID=desktop-windows
YIVE_RELAY_RUNTIME_URL=http://127.0.0.1:3001
YIVE_RELAY_MANAGE_RUNTIME=0
```

检查：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\run-windows-desktop-relay.ps1 -Check
yive connect status --server http://<server-ip>:4020 --token "<strong-admin-token>" --device-id desktop-windows --runtime http://127.0.0.1:3001
```

`-Check` 用来验证配置、Relay 地址、token 和本地 runtime；`yive connect status` 是只读运行态诊断，不会启动长连接，用来确认本地 runtime 在线、Relay 可达、`desktop-windows` 是否已经被 Relay 看到，以及是否有手机指向这台电脑。

临时运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\run-windows-desktop-relay.ps1
```

默认情况下，这个脚本只连接已经运行的本地 Yive runtime，不会再启动一个新的 3001 进程。只有你希望它负责启动和重启本地 runtime 时，才把 `YIVE_RELAY_MANAGE_RUNTIME=1` 或启动时加 `-ManageRuntime`。

安装为开机自动启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-windows-desktop-relay-task.ps1 -RunNow
```

默认 `auto` 模式会先尝试 Windows 计划任务；如果当前 PowerShell 没有权限注册计划任务，会自动退回到当前用户 Startup 文件夹。也可以显式指定：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-windows-desktop-relay-task.ps1 -InstallMode startup-folder -RunNow
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install-windows-desktop-relay-task.ps1 -InstallMode scheduled-task -RunNow
```

## 6. 手机配对

在本地或服务器代码目录运行：

```bash
yive relay pair --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows
```

手机打开输出的 `Direct desktop URL`。这个链接只带短期配对 token，不会把长期 admin token 放进手机 URL。

## 7. 更新服务器

正常更新：

```bash
cd /opt/yive-runtime
sudo bash deploy/deploy-relay.sh main
pnpm smoke:relay-all -- --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows
pnpm smoke:relay-all -- --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows --require-live-update
pnpm smoke:relay-all -- --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows --verify-terminal-output
pnpm smoke:relay-all -- --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows --workspace-id <workspace-id> --workspace-file README.md
pnpm smoke:relay-all -- --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows --json
node deploy/smoke-relay.mjs --server http://<server-ip>:4020 --token "<strong-admin-token>"
pnpm smoke:relay-file-exchange -- --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows
pnpm smoke:relay-file-exchange -- --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows --workspace-id <workspace-id> --workspace-file README.md
pnpm smoke:relay-file-exchange -- --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows --workspace-id <workspace-id> --run-id <run-id> --verify-image-paste
pnpm smoke:relay-mobile-events -- --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows
pnpm smoke:relay-mobile-events -- --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows --require-live-update
pnpm smoke:relay-terminal -- --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows
pnpm smoke:relay-terminal -- --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows --verify-terminal-output
pnpm smoke:relay-terminal -- --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows --open-only --stream io
```

`smoke-terminal-relay.mjs` validates terminal takeover, takeover heartbeat, release/restore, the terminal relay socket path, and optional terminal input. `--verify-terminal-output` sends a cross-platform sentinel command and waits until the phone transcript sees the expected terminal output, so it verifies the full path: phone input -> local desktop runtime -> Agent PTY -> phone transcript. `--terminal-input "<command>" --expect-output "<text>"` can be used for a custom command; add `--no-terminal-enter` only when you need a raw forwarding check.

`pnpm smoke:relay-all -- --json` 会输出适合自动化和手机诊断页使用的结构化报告。失败时先看顶层 `next_commands`，再看失败步骤里的 `next_action` 和 `repair_commands`；这些命令会用 `<admin-token>`、`<admin-or-device-token>` 等占位符，不会回显真实 token。

失败回滚：

```bash
cd /opt/yive-runtime
sudo bash deploy/rollback-relay.sh
```

## 8. 常用诊断

建议按这个顺序排查公网链路：

1. 在本地电脑跑 `yive connect status`，确认本地 runtime 和 desktop 注册状态。
2. 在任意能访问服务器的机器跑 `yive relay doctor`，确认 Relay、token、设备列表和 PWA 静态资源。
3. 在服务器或本地代码目录跑 `pnpm smoke:relay-all`，确认手机事件、文件交换和终端闭环。

```bash
yive connect status --server http://<server-ip>:4020 --token "<strong-admin-token>" --device-id desktop-windows --runtime http://127.0.0.1:3001
yive relay status --server http://<server-ip>:4020 --token "<strong-admin-token>"
yive relay doctor --server http://<server-ip>:4020 --token "<strong-admin-token>"
yive relay doctor --server https://relay.example.com --token "<strong-admin-token>" --android-package com.example.yive --android-sha256 <release-cert-sha256>
pnpm smoke:relay-all -- --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows
pnpm smoke:relay-all -- --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows --max-stale-ms 30000
pnpm smoke:relay-all -- --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows --max-stale-ms 30000 --verify-terminal-output
pnpm smoke:relay-all -- --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows --json
node deploy/smoke-relay.mjs --server http://<server-ip>:4020 --token "<strong-admin-token>"
pnpm smoke:relay-file-exchange -- --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows
pnpm smoke:relay-file-exchange -- --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows --workspace-id <workspace-id> --run-id <run-id> --verify-image-paste
pnpm smoke:relay-mobile-events -- --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows --max-stale-ms 30000
pnpm smoke:relay-terminal -- --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows
pnpm smoke:relay-terminal -- --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows --verify-terminal-output
pnpm smoke:relay-terminal -- --server http://<server-ip>:4020 --token "<strong-admin-token>" --desktop-id desktop-windows --open-only --stream io
```

`pnpm smoke:relay-all -- --json` 失败时会给出下一步修复命令：

- `next_commands`：当前最应该复制执行的诊断或复验命令。
- `steps[].next_action`：失败原因的人类可读解释。
- `steps[].repair_commands`：针对失败步骤的修复/复验命令。

如果 `/health.pairing_store.admin_token_default` 是 `true`，说明还在用开发默认 token，不能当正式部署使用。
如果 `/health.deployment.public_url_configured` 不是 `true`，说明当前 Relay 进程没有加载公网验收地址；部署脚本的自动公网 smoke 会失败，先修复 `/etc/yive/relay.env` 里的 `YIVE_RELAY_PUBLIC_URL` 并重启服务。
