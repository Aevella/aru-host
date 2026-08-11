# Aru Host

Aru Host 是 Aru 的用户自有能力节点。它把电脑或 VPS 变成一台可由 iPhone 配对、查看和使用的 Host，同时让电脑协作者的身份、对话、页面、记忆、工具权限和运行状态留在用户自己的机器上。

当前稳定版是 **0.29.2**，Host 协议版本为 `stub-0.29`。它与当前 Aru TestFlight 版本配套使用，并提供面向普通 Mac 用户的 Apple 签名、公证安装包，以及面向 Debian/Ubuntu 桌面用户的 `x64` / `arm64` 安装包。

## 现在能做什么

- iPhone 扫码配对 Mac、家用电脑或 VPS；
- 在手机与 Mac Console 里继续同一位电脑协作者的同一段对话；
- 使用 Codex 登录态或用户自己的 OpenAI-compatible / Anthropic API；
- 管理协作者提示词、记忆、工具权限和连续工具回合上限；
- 在手机或电脑 Console 管理一次性、重复的主动约定，并让协作者使用只绑定自己的主动工具；
- 在通知路线接通后，把已经生成完成的主动回复推送到每部已登记的 iPhone；
- 让手机协作者在手机休眠时把有界、只读的执行副本交给 Host 跑主动回合，再按稳定交付身份回到手机原对话或分支；
- 让协作者创建、修改、发布和回滚自己的持久化手机页面；
- 从 GitHub 建立一份 Host 持有的页面项目，查看 Git 状态、保存不可变产物检查点，并显式发布到手机；
- 提供 MCP 工具网关、插件工作坊、授权文件夹、持久作业和制品仓；
- 保存加密备份包，并从任一已配对设备查看真实状态。

Host 是电脑协作者的唯一数据真相；手机只保存配对凭证与可见投影。手机本地协作者与电脑协作者不会互相串库。

## Mac：普通用户安装

需要 macOS 26。打开 [最新版本页面](https://github.com/Aevella/aru-host/releases/latest)，下载 `aru-host-macos-<版本>.dmg`，把 **Aru Host** 拖进“应用程序”后打开即可。应用第一次启动时会自动安装同版本 Host Core，并把它作为当前用户的后台服务启动；不需要 Xcode、Node.js、Homebrew、终端命令或开发者证书。

升级新版应用时，Host Core 会随应用一起升级；协作者、对话、页面、授权和设置仍保留在原来的用户数据目录。Aru Host 会检查 GitHub 的稳定版本，有更新时提供对应 `.dmg` 下载入口。

源码安装器只保留给开发和运维场景。它会把 Host Core 安装为当前用户的 LaunchAgent：

```bash
curl -fsSL https://raw.githubusercontent.com/Aevella/aru-host/main/install-macos.sh | bash
```

命令行安装完成后生成新的十分钟单次配对链接：

```bash
"$HOME/Library/Application Support/Aru Self-Hosted/bin/aru-selfhost" pairing
```

在 iPhone 打开 **Aru → 自托管节点 → ＋ → 扫码连接**。完整的第一次入住流程见 [中文使用小手册](docs/getting-started.zh-Hans.md)。

电脑协作者的创建、驱动选择和工具权限由 Aru Host 管理。关闭应用窗口不会停止 Host Core；后台任务和手机配对仍由当前用户的 LaunchAgent 持续持有。

## Linux 桌面：普通用户安装

支持当前 Debian/Ubuntu 桌面系统。打开 [最新版本页面](https://github.com/Aevella/aru-host/releases/latest)，普通 Intel/AMD 电脑下载 `aru-host-linux-<版本>-x64.deb`，ARM 电脑下载 `aru-host-linux-<版本>-arm64.deb`，再用系统的软件安装器打开并安装。安装完成后，从应用列表打开 **Aru Host**；第一次启动会自动准备同版本 Host Core，并把它作为当前用户的 `systemd` 后台服务启动，不需要预先安装 Node.js、Docker 或手动配置终端。

Console 凭证只进入 Linux Secret Service；GNOME Keyring、KWallet 或其他兼容 Secret Service 需要在当前桌面会话中可用。关闭 Console 窗口不会停止 Host Core。升级新 `.deb` 不会替换协作者、对话、页面、权限和设置。

不再使用时，先在 Console 首页点 **设置 → 移除这台电脑的 Host**，让当前用户的后台服务和设置干净退出，再用系统的软件管理器卸载 Aru Host 应用。这个普通卸载流程会保留协作者、对话、页面和其他 Host 数据，今后重装仍可接回；只有开发/诊断用的 `aru-selfhost --instance home uninstall --purge-data` 会显式删除它们。

如果桌面没有图形化软件安装器，也可以在下载目录运行：

```bash
sudo apt install ./aru-host-linux-0.29.2-x64.deb
```

源码级当前用户安装器保留给开发和诊断：

```bash
./install-linux-desktop.sh
~/.local/bin/aru-selfhost pairing
```

## Linux VPS

Debian 或 Ubuntu，并且域名已经解析到 VPS 时：

```bash
curl -fsSL https://raw.githubusercontent.com/Aevella/aru-host/main/install.sh \
  | sudo bash -s -- --domain aru.example.com
```

安装器会创建独立服务用户、版本化发布目录、持久数据目录和 Caddy HTTPS 配置。工作区与源码插件使用 rootless Podman 隔离运行。

安装后的常用命令：

```bash
sudo aru-selfhost pairing
sudo aru-selfhost doctor
sudo aru-selfhost status
sudo aru-selfhost logs
sudo aru-selfhost upgrade
sudo aru-selfhost rollback
```

已有 Nginx、Tailscale 或其他反向代理时，请阅读 [运行与部署参考](docs/operator-reference.md)，不要让安装器覆盖现有网络入口。

## 从源码运行

Host Core 只依赖 Node.js 标准库：

```bash
node aru-selfhost-stub.mjs --port 8787
```

Mac Console：

```bash
cd macos-console
swift test
./build-local-app.sh
open '.build-local/Aru Host Console.app'
```

`build-local-app.sh` 要求稳定的 Apple Development 或 Developer ID 签名身份，避免每次重建都让 Keychain 把 Console 当成一款新应用。正式发行使用 `package-macos-distribution.sh` 完成 universal 构建、Developer ID 签名、公证、staple 和 Gatekeeper 验证。

Linux Console：

```bash
cd linux-console
npm ci
npm test
npm run pack:dir
```

正式 `.deb` 使用 `package-linux-desktop.sh` 生成并检查匹配 Host Core、桌面入口、依赖、SHA-256 和发行回执。

## 发布包

```bash
./package-release.sh dist/aru-host-linux.tar.gz
./package-macos-release.sh dist/aru-host-macos.tar.gz
```

两个脚本都会生成匹配的 `.sha256`。安装器通过 `--bundle-url` 安装发行包时会先验证校验值和归档白名单。

## 安全与贡献

配对令牌是十分钟单次令牌；设备凭证只保存 SHA-256 哈希；模型不会收到设备凭证、备份口令或未授权的电脑路径。插件、文件夹和产生副作用的工具仍然经过显式权限边界。细节见 [SECURITY.md](SECURITY.md) 与 [架构边界](docs/architecture.md)。

提交改动前请运行：

```bash
bash tests/http-smoke.sh
bash tests/installer-smoke.sh
node tests/apns-push-smoke.mjs
node tests/collaborator-initiative-smoke.mjs
node tests/collaborator-project-smoke.mjs
bash tests/macos-installer-smoke.sh
swift test --package-path macos-console
npm ci --prefix linux-console
npm audit --prefix linux-console --omit=dev
bash tests/linux-desktop-installer-smoke.sh
npm test --prefix linux-console
```

本项目使用 [Apache License 2.0](LICENSE)。Aru iOS 客户端不在这个仓库中。
