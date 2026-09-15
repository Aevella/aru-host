<p align="center">
  <img src="docs/assets/aru-is-here.jpg" width="420" alt="虹彩的波浪里躲着三只毛茸茸的小家伙，画面下方写着 Aru is here.">
</p>

<h1 align="center">Aru Host</h1>

<p align="center">Aru 住在你的 iPhone 里。Aru Host 让它也住进你自己的电脑。</p>

<p align="center">
  <a href="https://github.com/Aevella/aru-host/releases/latest"><img alt="最新版本" src="https://img.shields.io/github/v/release/Aevella/aru-host?label=%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC"></a>
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
</p>

<p align="center">English: <a href="README.en.md">README.en.md</a></p>

Aru Host 是 Aru 的用户自有能力节点。它把电脑或 VPS 变成一台可由 iPhone 配对、查看和使用的 Host，同时让电脑协作者的身份、对话、页面、记忆、工具权限和运行状态留在用户自己的机器上。

当前版本是 **0.31.4**，Host 协议版本为 `stub-0.30`。它与当前 Aru TestFlight 版本配套使用，并提供面向普通 Mac 用户的 Apple 签名、公证安装包，面向 Debian/Ubuntu 桌面用户的 `x64` / `arm64` 安装包，以及 **Windows x64 预览版（未签名）**。

安装包、更新范围与升级说明见 [0.31.4 发布说明](docs/releases/0.31.4.md)。

## 第一次来？

Aru 是 iPhone 上的 AI 协作者应用，本仓库不包含它。Aru Host 是 Aru 的电脑端：装在自己的 Mac、Windows、Linux 电脑或 VPS 上，用 iPhone 扫码配对后，电脑协作者的身份、对话、页面、记忆、工具权限和运行状态都留在你自己的机器上，手机只是一扇随时能推开的窗。

接入只有三步：

1. 按下面对应平台的说明安装 Aru Host；
2. 在电脑的 Aru Host 首页点「连接手机」，iPhone 打开 **Aru → 自托管节点 → ＋ → 扫码连接**；
3. 在 **电脑协作者 → 新建协作者** 请一位协作者入住，从手机或电脑发出第一句话。

完整的图文流程见[中文使用小手册](docs/getting-started.zh-Hans.md)。要把自己的服务或设备接进来，接口与路由在[运行与部署参考](docs/operator-reference.md)。

## Windows：预览版安装

在 [最新版本页面](https://github.com/Aevella/aru-host/releases/latest) 下载 `aru-host-windows-0.31.4-x64.exe` 和同名 `.sha256` 校验文件，运行安装包。它按当前用户安装 Host；第一次启动会准备 Host Core，保存的凭据由 Windows DPAPI 保护。手机连接若被防火墙阻挡，Console 会提供配置入口。

此版本尚未代码签名，系统可能显示信誉提示。Windows 预览版不等同于 Mac 的签名公证状态；当前不提供 Windows arm64 包。升级直接运行新版安装包，不必先卸载。

**手机扫码后提示 `network request failed`，按这个顺序查：**

1. 在 Aru Host 首页点「放行防火墙」并通过管理员授权。如果之后仍显示「防火墙还没放行局域网访问」，以管理员身份打开 PowerShell 手动添加（端口换成二维码里的数字）：

   ```powershell
   New-NetFirewallRule -DisplayName "Aru Host (home)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8787 -Profile Private,Domain
   ```

2. 这条规则对「专用网络」和「域网络」生效。打开 设置 → 网络和 Internet → 当前 Wi-Fi，把网络配置文件从「公用网络」改成「专用网络」。Windows 默认把新连接的 Wi-Fi 当作公用网络。
3. 使用局域网配对时，手机和电脑连同一个 Wi-Fi；若 VPN 或代理阻断了局域网访问，可临时暂停后重试。使用 Tailscale 配对时保留 Tailscale 连接。iPhone 第一次访问时会询问「本地网络」权限，需要允许；已经拒绝过的在 设置 → Aru → 本地网络 里打开。
4. 用手机 Safari 直接打开 `http://电脑IP:端口/.well-known/aru.json`。能看到一段 JSON，网络就通了，回 Aru 重新生成二维码配对；打不开，问题仍在上面三步里。

## 可选：运行脚本和容器插件

普通文件、页面发布、配对和手机协作者身份不需要 Docker 或 Podman。只有隔离的 Node/Python/Shell 工作区任务和 OCI 插件需要容器。

桌面 Console 的总览与运行环境提供官方安装说明和“检测并启用”。安装并启动容器引擎后，Host 会下载镜像、验证实际运行和工作目录读写，再保存配置并重启服务。错误不会被当作安装完成。命令行用户可在更新当前安装器后运行 `aru-selfhost --instance home setup-runtime`（Windows 对应 `-Instance home setup-runtime`）。Linux VPS 的完整安装器原本就自动准备 Podman，无需桌面引导。

## 现在能做什么

- iPhone 扫码配对 Mac、家用电脑或 VPS；
- 在手机与 Mac Console 里继续同一位电脑协作者的同一段对话；
- 在手机和电脑协作者之间互传图片、文件、音频与视频附件，并在手机上预览或分享电脑返回的文件；
- 使用 Codex 登录态或用户自己的 OpenAI-compatible / Anthropic API；
- 管理协作者提示词、记忆、工具权限和连续工具回合上限；
- 在手机或电脑 Console 管理一次性、重复的主动约定，并让协作者使用只绑定自己的主动工具；
- 在通知路线接通后，把已经生成完成的主动回复推送到每部已登记的 iPhone；
- 让手机协作者在手机休眠时把有界、只读的执行副本交给 Host 跑主动回合，再按稳定交付身份回到手机原对话或分支；
- 接收第三方服务提交的端到端加密外部触发事件：Host 只保存密文与限权唤醒令牌，官方最小中继只保存匿名 APNs 地址，iPhone 解密后才决定进入哪位本地协作者；
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
sudo apt install ./aru-host-linux-0.31.4-x64.deb
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
cd desktop-console
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
node tests/wake-bridge-smoke.mjs
node tests/wake-send-smoke.mjs
node tests/collaborator-initiative-smoke.mjs
node tests/collaborator-project-smoke.mjs
bash tests/macos-installer-smoke.sh
swift test --package-path macos-console
npm ci --prefix desktop-console
npm audit --prefix desktop-console --omit=dev
bash tests/linux-desktop-installer-smoke.sh
npm test --prefix desktop-console
```

本项目使用 [Apache License 2.0](LICENSE)。Aru iOS 客户端不在这个仓库中。

开发源码与责任划分见 [架构说明](docs/architecture.md)；主服务与托管回复的模块化源码位于 `src/`，根目录对应文件为兼容已安装升级器的生成运行文件。
