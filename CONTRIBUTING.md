# Contributing

Please keep Host Core as the durable owner. Clients render state and send intents; plugins, jobs and artifacts keep their own permissioned lifecycle; the phone does not become a hidden second database for computer-hosted collaborators.

Before opening a pull request:

```bash
node --check aru-selfhost-stub.mjs
bash tests/http-smoke.sh
bash tests/installer-smoke.sh
bash tests/macos-installer-smoke.sh
swift test --package-path macos-console
```

Do not commit credentials, real pairing links, private network addresses, user exports, crash dumps, build directories or signing material. Tests and documentation should use neutral example identities and `example.com` addresses.
