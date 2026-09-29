# Single Host source consolidation — 2026-09-29

Canonical repository: Aevella/aru-host. Integration starts at `605e856`, containing
all physical acceptance repairs. Aru integration source is read at `704919690`.
No live instance is changed by this source consolidation.

## Reconciliation decisions

Use exact shared historical blobs for three-way merges. Resolve behavior, not file
length. Public release behavior wins over older native copies for runtime readiness,
turn cancellation, LAN address resolution, Windows npm shims, daily schedules,
revocation, keyless profiles, API-key origin protection and fixed-list upgraders.
Native additions retained: async/coalesced driver probes, newest installed Codex and
package-manager discovery, message time context, provider diagnostic probes, local
operator CLI and a one-time import from the native encrypted Linux vault. Linux
uses the public sealed-file store as its canonical format. Import decrypts and verifies
each old profile before marking completion; original ciphertext and key remain as
recovery evidence. Existing canonical secrets win. Fresh installations create no second
vault. No live installation conversion was performed during this source work.

`mobile-collaborator-identities.mjs` remains the public re-export of the owner bundled
inside the pre-existing replica payload, preserving old fixed-list installer startup.
Native test-only personal names are not copied into the public fixtures. Native Mac
explicit-driver-refresh regression test is retained. Native Windows files without a
common blob are older versions or formatting changes; retain current public versions.
README contents are reconciled into the canonical entry rather than replacing the
public release instructions with native workspace-specific instructions.

Core tests: 89 pass, 1 platform skip; 42 Mac Console tests pass. Linux and macOS
installer smoke, HTTP/local-operator smoke, API/provider/replica/identity/conversation
and initiative smoke pass. This is source/local verification, not a distribution release.

## File audit

| File | Evidence |
| --- | --- |
| `README.md` | different; reviewed independently |
| `apns-push.mjs` | three-way base d507f39f66 |
| `aru-selfhost-stub.mjs` | three-way base d758312d54 |
| `aru-selfhost.service` | three-way base d53a0f45f8 |
| `aru-selfhostctl` | three-way base f4fe05876d |
| `aru-selfhostctl-linux` | three-way base 1f622d7cac |
| `aru-selfhostctl-macos` | three-way base 0e1d0fdd1b |
| `bundle-windows-desktop-host-core.mjs` | different; reviewed independently |
| `ci/windows-desktop.yml` | native-only; reviewed independently |
| `claude-code-driver.mjs` | three-way base 3e5a3cf192 |
| `codex-app-server-driver.mjs` | three-way base c07f0e94a8 |
| `collaborator-conversations.mjs` | three-way base 31f0518865 |
| `collaborator-host.mjs` | three-way base 6829fa8ebf |
| `collaborator-initiative.mjs` | three-way base 7dd3c55479 |
| `container-runtime-setup.mjs` | three-way base 20fe166e37 |
| `desktop-console/README.md` | different; reviewed independently |
| `desktop-console/package-lock.json` | different; reviewed independently |
| `desktop-console/package.json` | different; reviewed independently |
| `desktop-console/src/container-readiness.mjs` | three-way base f5463240ec |
| `desktop-console/src/container-setup.mjs` | three-way base c5825c1a63 |
| `desktop-console/src/main.mjs` | different; reviewed independently |
| `desktop-console/src/preload.cjs` | three-way base 9403858388 |
| `desktop-console/src/renderer.mjs` | different; reviewed independently |
| `desktop-console/src/runtime.mjs` | three-way base 341999533d |
| `desktop-console/tests/container-readiness.test.mjs` | three-way base 473d2522b9 |
| `desktop-console/tests/runtime.test.mjs` | three-way base 19de6c6dba |
| `desktop-console/tests/visual-fixture-bootstrap.mjs` | different; reviewed independently |
| `direct-api-driver.mjs` | three-way base 8cbf495a7c |
| `docs/architecture.md` | three-way base 215fad0153 |
| `install-macos.sh` | three-way base f8155bbc51 |
| `install-windows.ps1` | different; reviewed independently |
| `install.sh` | three-way base 6afc6577fd |
| `macos-console/Sources/AruHostConsole/L10n.swift` | three-way base 3147b710b2 |
| `macos-console/Sources/AruHostConsole/Models/HostConsoleModels.swift` | three-way base c678ca3f1f |
| `macos-console/Sources/AruHostConsole/Resources/en.lproj/Localizable.strings` | three-way base b125cf76f7 |
| `macos-console/Sources/AruHostConsole/Resources/zh-Hans.lproj/Localizable.strings` | three-way base 4eb24a61f0 |
| `macos-console/Tests/AruHostConsoleTests/HostConsoleModelsTests.swift` | different; reviewed independently |
| `macos-console/build-app.sh` | three-way base 3766a604f5 |
| `macos-console/build-local-app.sh` | three-way base 7a94b03167 |
| `mobile-collaborator-identities.mjs` | different; reviewed independently |
| `mobile-collaborator-replicas.mjs` | three-way base 83626eeb23 |
| `node-control.mjs` | three-way base f1b24127ed |
| `package-macos-release.sh` | three-way base a8ceb59bbd |
| `package-release.sh` | three-way base 89bc0b1ac1 |
| `package-windows-desktop.sh` | different; reviewed independently |
| `provider-cli.mjs` | native-only; reviewed independently |
| `provider-profiles.mjs` | three-way base 9ba6683d64 |
| `provider-secret-store.mjs` | three-way base 94aea3f61e |
| `run-node.ps1` | three-way base 848fb8ebd3 |
| `run-node.sh` | three-way base 87017e9314 |
| `src/conversations/collaborator-conversations.mjs` | three-way base 1db0f8e802 |
| `src/server/mcp-catalog.mjs` | three-way base 0523c59408 |
| `src/server/mcp-gateway.mjs` | three-way base 101d5972e4 |
| `src/server/server.mjs` | different; reviewed independently |
| `src/server/workspace-jobs.mjs` | three-way base 53a93e5a37 |
| `tests/apns-push-smoke.mjs` | different; reviewed independently |
| `tests/claude-code-command.test.mjs` | three-way base fdb443ccbb |
| `tests/codex-app-server-driver-smoke.mjs` | three-way base 5f9bedd38c |
| `tests/codex-executable-selection.test.mjs` | native-only; reviewed independently |
| `tests/collaborator-approval-policy.test.mjs` | three-way base 9e95fec94c |
| `tests/collaborator-cognition-smoke.mjs` | different; reviewed independently |
| `tests/collaborator-conversation-smoke.mjs` | three-way base 904b7c08f7 |
| `tests/collaborator-host-smoke.mjs` | three-way base 542a427aeb |
| `tests/collaborator-initiative-smoke.mjs` | different; reviewed independently |
| `tests/collaborator-profile.test.mjs` | three-way base 2e6536a020 |
| `tests/collaborator-replica-context.test.mjs` | native-only; reviewed independently |
| `tests/collaborator-startup.test.mjs` | three-way base 795b35947b |
| `tests/container-status-http.test.mjs` | three-way base bf6ca66645 |
| `tests/conversation-turn-relay.test.mjs` | three-way base e0c23c85ec |
| `tests/direct-api-driver-smoke.mjs` | three-way base 4508d83ee9 |
| `tests/fake-container-runtime.sh` | three-way base b28e824cdc |
| `tests/http-smoke.sh` | three-way base 98bd3a4760 |
| `tests/installer-smoke.sh` | three-way base e8145d8aa6 |
| `tests/legacy-installer-upgrade.test.mjs` | three-way base 857bbd52cc |
| `tests/local-operator-smoke.sh` | native-only; reviewed independently |
| `tests/macos-installer-smoke.sh` | three-way base ccd7b01d42 |
| `tests/mobile-collaborator-identity-smoke.mjs` | different; reviewed independently |
| `tests/mobile-collaborator-replicas.test.mjs` | different; reviewed independently |
| `tests/provider-cli-smoke.mjs` | native-only; reviewed independently |
| `tests/provider-profiles-smoke.mjs` | three-way base b4d084ac7e |
| `tests/windows-desktop-package-smoke.sh` | different; reviewed independently |
| `tests/windows-installer-smoke.ps1` | three-way base fcc0b43a7b |

## Closure

All runtime entrypoints now have a `src/` source and generated-file check. Aru uses
an exact Git submodule pin at the former `scripts/selfhost` path; native CI initializes
it. Fixed-file legacy startup was explicitly retested after preserving the identity
owner import from the replica payload.

Replica storage uses a redo-transaction record layout rather than rewriting all
execution and delivery bodies. Node 18 migration/recovery tests pass. A copy of the
real Mac acceptance instance's two executions and one delivery migrated with every
record identical and the exact legacy file preserved; the live instance was untouched.
Final Node suite: 102 pass, 1 platform skip. Mac Console: 42 pass. Linux/macOS installer,
HTTP/local operator, conversation, legacy payload, Linux packaging and a signed arm64
Mac app build pass. No production service or phone was upgraded by this consolidation.

Eight old clean worktrees were removed only after preserving archive refs and a local
Git bundle; their commits remain recoverable. The experimental whole-Host state branch
`codex/host-durable-state` at `22ec0ba` remains separate: it requires Node 22.13 and has
not been accepted as the runtime floor. The source-plugin permission repair `5163097`
was integrated and its five focused tests passed. Other older candidates' runtime,
platform and modularization changes are represented by the current public baseline;
their development/release-note commits remain archived rather than replayed as releases.
