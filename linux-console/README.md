# Aru Host Console for Linux

This is the ordinary-user Debian/Ubuntu desktop Console. It renders and sends
intents to the existing Host Core; it is not a second server or durable state
owner.

## Responsibility boundaries

- `src/main.mjs` owns Electron process lifecycle, local Host installation,
  secure Console pairing, fixed IPC, downloads, and stable update discovery.
- `src/runtime.mjs` owns the method/path allowlist and release-asset naming.
- `src/preload.mjs` exposes the narrow renderer bridge. The renderer has no
  Node integration, arbitrary network client, shell, or Host private-file
  access.
- `src/renderer.mjs` and `styles.css` own the Borrowed Light desktop projection,
  localized copy, loading/empty/error states, and explicit user intents.
- `../install-linux-desktop.sh` owns user-service installation, release slots,
  health rollback, and durable-data preservation.

Console credentials are stored through Linux Secret Service. A compatible
Secret Service such as GNOME Keyring or KWallet must be available in the
desktop session; there is no plaintext fallback.

## Development

```bash
npm ci
npm audit
npm test
npm run pack:dir
```

Build and verify a release package from the parent directory:

```bash
../package-linux-desktop.sh --version 0.28.1 --arch x64 --output-dir ../dist
```

The release workflow repeats source tests, dependency audit, current-user
installer preservation, package-content inspection, and matching-architecture
`apt install` on Ubuntu before publishing either Linux architecture.
