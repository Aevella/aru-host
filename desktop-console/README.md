# Aru Host Console for Desktop

This is the ordinary-user desktop Console for Debian/Ubuntu and Windows. It
renders and sends intents to the existing Host Core; it is not a second server
or durable state owner. One renderer, one route allowlist, one version source
— operating-system differences are confined to the platform adapters.

## Responsibility boundaries

- `src/main.mjs` owns the platform-neutral Electron process lifecycle, secure
  Console pairing, fixed IPC, downloads, and stable update discovery.
- `src/platform/linux.mjs` and `src/platform/windows.mjs` own each OS's
  background service control, installer invocation, credential outlet,
  pairing-output source, firewall state, and release-asset selection.
  `src/platform/index.mjs` selects exactly one; unsupported platforms fail
  loudly.
- `src/runtime.mjs` owns the method/path allowlist and release-asset naming.
- `src/preload.cjs` exposes the narrow renderer bridge. The renderer has no
  Node integration, arbitrary network client, shell, or Host private-file
  access.
- `src/renderer.mjs` and `styles.css` own the Borrowed Light desktop
  projection, localized copy, loading/empty/error states (including the
  Windows firewall recovery state), and explicit user intents.
- `../install-linux-desktop.sh` owns Linux user-service installation, release
  slots, health rollback, and durable-data preservation;
  `../install-windows.ps1` owns the same boundary on Windows through a
  per-user Scheduled Task and junction release slots.

Console credentials never have a plaintext fallback. Linux stores them through
Linux Secret Service (GNOME Keyring or KWallet must be available in the
desktop session); Windows stores them as DPAPI (CurrentUser) ciphertext files
under `%LOCALAPPDATA%\AruHost\secrets`.

## Development

```bash
npm ci
npm audit
npm test
npm run pack:dir
```

Build and verify release packages from the parent directory:

```bash
../package-linux-desktop.sh --version 0.31.0 --arch x64 --output-dir ../dist
../package-windows-desktop.sh --version 0.31.0 --arch x64 --output-dir ../dist
```

The release workflow repeats source tests, dependency audit, current-user
installer preservation, package-content inspection, and matching-architecture
installation (Ubuntu `apt install`; Windows installer lifecycle smoke on a
Windows runner) before publishing any desktop architecture. The Windows
channel ships as a checksum-verified unsigned preview by decision; the
electron-builder signing environment stays wired for the day that changes.
See `docs/server/WINDOWS-HOST-DISTRIBUTION.md`.
