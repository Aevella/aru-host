# Aru Host

Aru Host 是 Aru 的用户自有能力节点。它把电脑或 VPS 变成一台可由 iPhone 配对、查看和使用的 Host，同时让电脑协作者的身份、对话、页面、记忆、工具权限和运行状态留在用户自己的机器上。

当前版本是 **TestFlight companion preview**，Host 协议版本为 `stub-0.28`。它与当前 Aru TestFlight 版本配套可用，但还不是面向完全非开发者的 Mac 双击安装包。

## 现在能做什么

- iPhone 扫码配对 Mac、家用电脑或 VPS；
- 在手机与 Mac Console 里继续同一位电脑协作者的同一段对话；
- 使用 Codex 登录态或用户自己的 OpenAI-compatible / Anthropic API；
- 管理协作者提示词、记忆、工具权限和连续工具回合上限；
- 让协作者创建、修改、发布和回滚自己的持久化手机页面；
- 提供 MCP 工具网关、插件工作坊、授权文件夹、持久作业和制品仓；
- 保存加密备份包，并从任一已配对设备查看真实状态。

Host 是电脑协作者的唯一数据真相；手机只保存配对凭证与可见投影。手机本地协作者与电脑协作者不会互相串库。

## Mac：给 TestFlight 用户的最快路径

需要 macOS 26 与 Node.js 22 或 Homebrew。安装器会把 Host Core 安装为当前用户的 LaunchAgent：

```bash
curl -fsSL https://raw.githubusercontent.com/Aevella/aru-host/main/install-macos.sh | bash
```

安装完成后生成新的十分钟单次配对链接：

```bash
"$HOME/Library/Application Support/Aru Self-Hosted/bin/aru-selfhost" pairing
```

在 iPhone 打开 **Aru → 自托管节点 → ＋ → 扫码连接**。完整的第一次入住流程见 [中文使用小手册](docs/getting-started.zh-Hans.md)。

电脑协作者的创建、驱动选择和工具权限目前由 `macos-console` 管理。Console 源码与测试都在本仓库中；公开的 Developer ID 签名、公证和自动更新安装包仍在准备，因此普通用户暂时需要开发者协助构建 Console。Host Core 与手机端配对本身不依赖 Xcode。

## Linux / VPS

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

`build-local-app.sh` 要求稳定的 Apple Development 或 Developer ID 签名身份，避免每次重建都让 Keychain 把 Console 当成一款新应用。

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
bash tests/macos-installer-smoke.sh
swift test --package-path macos-console
```

本项目使用 [Apache License 2.0](LICENSE)。Aru iOS 客户端不在这个仓库中。
