<p align="center">
  <img src="docs/assets/aru-is-here.jpg" width="420" alt="Three fluffy creatures tucked into iridescent waves, captioned Aru is here.">
</p>

<h1 align="center">Aru Host</h1>

<p align="center">Aru lives on your iPhone. Aru Host lets it live on your own computer too.</p>

<p align="center">
  <a href="https://github.com/Aevella/aru-host/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/Aevella/aru-host?label=latest%20release"></a>
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
</p>

<p align="center">中文说明：<a href="README.md">README.md</a> · Handbook: <a href="docs/getting-started.zh-Hans.md">docs/getting-started.zh-Hans.md</a> (Chinese)</p>

Aru Host is the user-owned capability node for [Aru](#what-is-aru), an AI collaborator app for iPhone. It turns a Mac, a Windows or Linux desktop, or a Linux VPS into a Host that an iPhone can pair with, browse, and use, while a computer collaborator's identity, conversations, pages, memory, tool permissions, and runtime state stay on the user's own machine.

The current release is **0.31.4** with Host protocol `stub-0.30`. It ships an Apple-signed and notarized macOS package, `x64` / `arm64` packages for Debian/Ubuntu desktops, and an **unsigned Windows x64 preview**. Package contents and upgrade notes are in the [0.31.4 release notes](docs/releases/0.31.4.md) (Chinese).

## What is Aru

Aru is an iPhone app where collaborators (AI personas with their own prompt, memory, tools, and rooms) live on the device. The iOS client is not part of this repository. Aru Host is its computer-side companion: install it, scan a pairing QR code from the phone, and a *computer collaborator* can run on the computer with Codex or your own model API while the phone shows the same conversation.

Getting in takes three steps:

1. Install Aru Host for your platform (below).
2. On the computer, open Aru Host and choose **Connect phone**; on the iPhone open **Aru → Self-hosted nodes → ＋ → Scan to connect**.
3. Create a computer collaborator under **Computer collaborators → New collaborator**, then send the first message from either side.

Phone-local collaborators and computer collaborators never share a database. The Host is the single source of truth for computer collaborators; the phone keeps pairing credentials and a visible projection.

## What it can do today

- Pair an iPhone with a Mac, a home computer, or a VPS by scanning a QR code.
- Continue the same conversation with the same computer collaborator from the phone and from the Console.
- Exchange image, file, audio, and video attachments between the phone and a computer collaborator, and preview or share files the computer returns.
- Run turns with a signed-in Codex, or with your own OpenAI-compatible or Anthropic API.
- Manage collaborator prompts, memory, tool permissions, and the cap on consecutive tool rounds.
- Create one-shot or recurring proactive rules from the phone or the Console, with tools bound only to the collaborator that owns them.
- Push a completed proactive reply to every registered iPhone once the notification route is connected.
- Let a phone-local collaborator hand a bounded, read-only execution replica to the Host while the phone sleeps, and return the result to the original conversation or a branch.
- Accept end-to-end encrypted external trigger events from third-party services: the Host stores ciphertext and scoped wake tokens, the official minimal relay stores only an anonymous APNs route, and the iPhone decides which local collaborator receives the event after decrypting it.
- Let collaborators create, edit, publish, and roll back their own persistent phone pages.
- Create Host-owned page projects from GitHub, inspect Git status, keep immutable artifact checkpoints, and publish explicitly to the phone.
- Provide an MCP tool gateway, plugin workshop, authorized folders, durable jobs, and an artifact vault.
- Keep encrypted backups and show real status from any paired device.

## Install

| Platform | Package | Notes |
| --- | --- | --- |
| macOS 26+ | `aru-host-macos-<version>.dmg` from the [latest release](https://github.com/Aevella/aru-host/releases/latest) | Drag **Aru Host** into Applications. First launch installs Host Core as a per-user background service. No Xcode, Node.js, or Homebrew needed. |
| Windows 10/11 x64 (preview) | `aru-host-windows-<version>-x64.exe` plus its `.sha256` | Per-user install, credentials protected by DPAPI. Unsigned: expect a SmartScreen prompt. If the firewall blocks LAN pairing, the Console offers a one-click fix. |
| Debian/Ubuntu desktop | `aru-host-linux-<version>-x64.deb` or `-arm64.deb` | Install with the system package installer, then launch **Aru Host**. Console credentials use Secret Service. |
| Linux VPS | `curl -fsSL https://raw.githubusercontent.com/Aevella/aru-host/main/install.sh \| sudo bash -s -- --domain aru.example.com` | Debian/Ubuntu with a domain pointing at the VPS. Creates a service user, versioned releases, and Caddy HTTPS. |

Closing the Console window does not stop Host Core. Upgrades keep collaborators, conversations, pages, permissions, and settings.

**Windows: the phone reports `network request failed` after scanning.** Check in this order:

1. Click **Allow through firewall** on the Aru Host overview and approve the elevation. If the "firewall has not opened LAN access" pill stays, add the rule from an administrator PowerShell (use the port shown in the QR code):

   ```powershell
   New-NetFirewallRule -DisplayName "Aru Host (home)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8787 -Profile Private,Domain
   ```

2. The rule applies to Private and Domain network profiles. Open Settings → Network & Internet → the current Wi-Fi and switch the network profile from Public to Private; Windows treats new Wi-Fi networks as public by default.
3. For LAN pairing, keep the phone and computer on the same Wi-Fi. Temporarily pause a VPN or proxy only if it blocks LAN access; keep Tailscale connected when pairing over Tailscale. Allow Aru's Local Network permission on the iPhone (Settings → Aru → Local Network).
4. Open `http://<computer-ip>:<port>/.well-known/aru.json` in Safari on the phone. If JSON appears, the network path works; regenerate the QR code and pair again. If it does not, the cause is still in the steps above.

Run from source with nothing but Node.js:

```bash
node aru-selfhost-stub.mjs --port 8787
```

## Documentation

- [Handbook (Chinese)](docs/getting-started.zh-Hans.md): the first-time pairing flow with screenshots of each step.
- [Operator reference](docs/operator-reference.md): routes, capability bundles, the encrypted external wake mailbox, MCP gateway, and deployment behind your own reverse proxy.
- [Architecture boundary](docs/architecture.md): who owns what between Host Core, agent drivers, Console, and the phone.
- [Security policy](SECURITY.md): trust boundaries and how to report a vulnerability privately.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the checks to run before a pull request. Never commit credentials, real pairing links, private network addresses, exports, or signing material.

Aru Host is released under the [Apache License 2.0](LICENSE).
