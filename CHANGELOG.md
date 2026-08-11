# Changelog

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
