# Changelog

## Unreleased

- Fix Windows / Linux desktop Console conversation sending and approval decisions: the Console issued `PUT` while Host Core only serves `POST`, so every send since 0.31.0 failed with `route.unknown`. macOS Console was not affected.
- Stop failing whole direct model-API turns on unreadable tool arguments: accept object-typed and empty arguments from relays, hand malformed JSON back to the model as a tool error so it can re-issue the call, and report `max_tokens` truncation of tool arguments as the actual cause instead of "模型返回了无法读取的工具参数".

## 0.31.3

- Preserve unreadable or structurally invalid Host state and stop startup instead of replacing it with an empty identity.
- Check state before installation switches releases; failed checks cannot trigger rollback into an older reader.
- Explain state-read failures in desktop Consoles and retain retry after repair.
- See [installation and upgrade details](docs/releases/0.31.3.md).

## 0.31.2

- Accept valid native archive versions in encrypted backups while retaining envelope validation.
- Unify Windows restarts through instance-scoped stop and cleanup.
- Bound container readiness requests and distinguish unavailable service from unavailable runtime.
- Admit desktop initiative routes and propagate Windows firewall creation failures.
- See [installation and upgrade details](docs/releases/0.31.2.md).

## 0.31.1

- Give the signed macOS Console its own checked-in high-resolution Aru Host icon, bundle it explicitly, and declare the productivity-app identity in the application metadata.
- Include the paired private-network sender admission published after 0.31.0; desktop Host protocol remains `stub-0.30` and Windows remains an unsigned preview.
- See [installation and upgrade details](docs/releases/0.31.1.md).

## Sender utility update · 2026-09-12

- Allow the standalone wake sender to submit encrypted events to paired LAN/Tailscale HTTP endpoints; retain HTTPS and redirect rejection.
- Verify a real local HTTP submission. Desktop packages remain 0.31.0; phone-side admission requires an updated phone client.

## 0.31.0

- Add an explicitly unsigned Windows x64 preview with current-user installation, DPAPI credentials, pairing, and lifecycle verification.
- Separate phone project/page identities from computer model execution.
- Add optional container onboarding and verified Node/Python/Shell setup to desktop Consoles.
- Explain container-only status semantics and preserve old fixed-file Host payload compatibility.
- Keep protocol `stub-0.30`; see [installation and upgrade details](docs/releases/0.31.0.md).

## 0.30.3

- Fix missing collaborator avatars in the packaged macOS app by resolving its bundled resources correctly.
- Verify all 36 preset avatars and localization with the SwiftPM resource fallback unavailable before signing the app.
- Host protocol remains `stub-0.30`; no iPhone/TestFlight update is required for this desktop fix.

## 0.30.2

- Retain a no-runtime compatibility payload for the short-lived 0.30.0 fixed-file-list VPS installer, while keeping the real attachment owner in the conversation payload understood by 0.29 installers.

## 0.30.1

- Keep the conversation attachment owner inside the existing conversation payload so a VPS running the 0.29 installer can upgrade directly without omitting a newly introduced runtime module.

## 0.30.0

- Add authenticated, conversation-scoped attachment upload and download for computer collaborators, with durable byte storage, integrity checks, bounded message binding, and old-client text summaries.
- Let Codex receive managed image and audio inputs plus immutable workspace file paths; direct API profiles admit only the native attachment types their provider protocol can represent.
- Let computer collaborators explicitly attach a regular workspace file to their reply, while paired phones can import photos or files, remove pending uploads, send attachment-only messages, preview returned attachments, and share them.
- Include the attachment owner in every macOS, Linux desktop, and VPS Host Core payload and verify installer/package contents so published bundles cannot omit the runtime module.

## 0.29.5

- Move External Wake Bridge APNs authority out of user-operated Hosts: each Host now receives only an anonymous route id and route-scoped wake token, while the official minimal relay alone keeps the APNs provider key and device token.
- Make Host-to-relay wake requests content-free and idempotent through an opaque HMAC request identity; encrypted event bodies remain only in the user Host mailbox until the phone fetches and decrypts them.
- Migrate unreleased direct-APNs bridge registrations once, advertise the v2 registration contract in the Host manifest, and keep relay failures retryable without replaying or duplicating the encrypted event.

## 0.29.4

- Add the encrypted external wake bridge used by collaborator-owned Aru triggers, with endpoint-scoped fetch and submit credentials, idempotent ciphertext admission, bounded retention, and phone-side decryption.
- Add the v2 reference sender so external services can seal and submit event text without choosing a collaborator, conversation, or system role.
- Include the bridge in macOS, Linux desktop, and VPS Host Core payloads and verify both the server route and sender contract in CI.

## 0.29.3

- Advertise the exact provider protocols accepted by durable conversation-turn relay so phones can decide whether Host can own a turn before submitting it.
- Accept native Claude, ChatGPT Codex, and Kimi subscription routes in addition to the existing OpenAI-compatible and Anthropic Messages routes without flattening their protocol identities.

## 0.29.2

- Let a phone-owned collaborator publish a bounded, read-only execution replica to Host so scheduled proactive turns can finish while the phone sleeps; the phone remains authoritative and imports each stable delivery idempotently or branches when its conversation head has moved.
- Deliver completed replica replies through the existing per-device APNs route without turning Host into a second phone-chat database.
- Preserve provider reasoning summaries in the computer-collaborator event ledger without persisting raw private reasoning.
- Make macOS Host upgrades wait for the previous LaunchAgent to stop and remove the artificial plugin-runtime startup timeout that could temporarily disable a healthy runtime.

## 0.29.1

- Recover computer collaborators when Codex becomes available after Host startup, while keeping passive driver status reads free of executable probes.
- Replace private-style test fixture identities with neutral examples.

## 0.29.0

- Add Host-owned one-shot and recurring initiative rules, owner-bound collaborator tools, Mac/Linux Console controls, and completed-turn APNs delivery to separately registered paired phones.
- Add Host-owned page projects that can start empty or clone a `github.com` repository into one managed checkout, expose Git state to clients, save immutable `.tar.gz` artifact checkpoints, and publish the selected build directory to the phone as a separate action.
- Keep checkpoint, phone publication, and Git push as three explicit boundaries: checkpoints exclude `.git`, phone releases are immutable surface bundles, and Host does not push repository commits on the user's behalf.
- Extend the ordinary Chinese guide and operator reference for multiple paired phones, proactive messages, notification readiness, GitHub page projects, artifacts, and source-versus-stable-release status.
- Scope Console refresh publication to the owning surface, so one background or local mutation no longer invalidates every unrelated Host view.

## 0.28.1

- Add the ordinary-user Debian/Ubuntu desktop distribution for `x64` and `arm64`, with an Electron Borrowed Light Console and matching embedded Host Core.
- Install Host Core as a versioned current-user `systemd --user` service on first launch, preserve durable data on upgrade/ordinary uninstall, and keep a healthy previous-release rollback target.
- Store Console and provider credentials through Linux Secret Service with no plaintext fallback.
- Verify source, dependency audit, installer preservation, package metadata/content, and matching-architecture `apt install` before a combined Mac/Linux release is published.

## 0.28.0

- Add the ordinary-user macOS distribution: universal Aru Host app, embedded matching Host Core, Developer ID signing, Apple notarization, stapling, Gatekeeper verification, and `.dmg` release metadata.
- Install or upgrade the embedded Host Core automatically in the current user account while preserving durable collaborators, conversations, pages, permissions, and settings.
- Check the stable GitHub release channel from the app and offer the matching notarized `.dmg` when an update is available.
- Publish the complete current Host Console resources, collaborator surfaces, tests, and reproducible release workflow.

## 0.28.0-preview.1

- Publish Host Core as a standalone repository for current Aru TestFlight clients.
- Include macOS LaunchAgent and Linux systemd installers with hash-verified release bundles.
- Include paired-device trust, encrypted backup vault, MCP gateway, plugin workshop, isolated workspaces, persistent jobs and verified artifacts.
- Include computer-hosted collaborators with Codex and direct model API drivers, durable conversations, approvals, cognition, and versioned phone pages.
- Include the native macOS Host Console source and tests. A notarized binary distribution is not part of this preview.
