# Contributing

Please keep Host Core as the durable owner. Clients render state and send intents; plugins, jobs and artifacts keep their own permissioned lifecycle; the phone does not become a hidden second database for computer-hosted collaborators.

Before opening a pull request:

```bash
node --check aru-selfhost-stub.mjs
bash tests/http-smoke.sh
bash tests/installer-smoke.sh
node tests/apns-push-smoke.mjs
node tests/collaborator-initiative-smoke.mjs
node tests/collaborator-project-smoke.mjs
bash tests/macos-installer-smoke.sh
swift test --package-path macos-console
npm ci --prefix linux-console
npm audit --prefix linux-console
bash tests/linux-desktop-installer-smoke.sh
npm test --prefix linux-console
```

Do not commit credentials, real pairing links, private network addresses, user exports, crash dumps, build directories or signing material. Tests and documentation should use neutral example identities and `example.com` addresses.
