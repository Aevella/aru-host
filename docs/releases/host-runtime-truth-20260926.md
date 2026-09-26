# Host runtime truth repair — 2026-09-26

Local source change, not a published release. Baseline: Host `eb3b196` after v0.33.1.
The reported `stub-0.30` value is a protocol identifier, not proof of an old Core.

## Delivered boundaries

- Address policy is persisted by node settings; automatic LAN address is recomputed
  from current interfaces for advertisement/pairing. New Windows default is automatic.
  Old ambiguous receipts preserve fixed mode and can be changed in Console. Existing
  phone endpoints are not silently rewritten. Multiple active adapters still require
  real-machine acceptance; deterministic interface preference is not a route probe.
- Windows installer accepts upgrade only after the running release and retained
  identity match. Console checks live Core, repairs one responding same-receipt/wrong
  release installation, and displays releaseVersion rather than protocol version.
- Core verifies the selected engine and Node/Python/Shell execution in its own
  environment; checking/failure/ready are projected to Console and job admission.
  Core startup does not pull images. Explicit setup and verification retry are distinct.
- Per-turn execution owns abort, startup identity and outstanding tool receipts.
  Cancellation is available during tools, waits for actual stop, rejects late results,
  and exposes retry on unconfirmed stop. Codex acknowledgement without terminal event
  is tested as insufficient. Other conversations are not killed to stop one turn.
- Empty drivers explain API route setup or Codex installation/login. Phone consumes
  optional Host canCancel/cancellation state with old-Host interoperability.

## Local evidence

- `node --test --test-concurrency=1 tests/*.test.mjs`: 64 passed.
  Includes legacy fixed-file v0.31.4 installer upgrade, project async, address policy,
  Core readiness, cancellation while starting/tools, retries and late notifications.
- `node --test desktop-console/tests/*.test.mjs`: 21 passed.
- Generated runtime consistency and `git diff --check` passed.
- Codex driver, collaborator conversation, direct API and no-auth direct API smoke
  programs passed. Electron sandbox preload smoke: `ARU_DESKTOP_PRELOAD_SMOKE_OK`.
- Browser fixture: switched address policy and saved; empty driver guidance appeared
  both inline and on Create collaborator. Screenshot inspected. Favicon 404 only.
- Native `SelfHostedCollaboratorHostTests`: 9 passed, including cancellation state
  decoding and old-Host fallback.

A parallel broad Node run during competing builds had one existing relay test's
fixed-10ms timing assertion observe `accepted` rather than `running`; the serial
full run passes. That timing assertion was not weakened.

No Windows machine/PowerShell execution, physical network-switch proof, real Podman
service-account test, real Codex-account cancellation or phone-device acceptance
was performed here. Windows smoke assertions are updated for CI but are not local
Windows proof. No release tag, installer publication or installed-user upgrade was
performed.

Native simulator build passed with `xcodebuild -project Polaris.xcodeproj -scheme
Polaris -destination 'generic/platform=iOS Simulator' -derivedDataPath
/Volumes/AruBuildCache/Aru-HostRuntimeTruth-iOS-20260926 CODE_SIGNING_ALLOWED=NO
ONLY_ACTIVE_ARCH=YES ARCHS=arm64 build`. This proves compilation/linking for arm64
Simulator, not an installed-device interaction. The first generic dual-architecture
build was stopped to reduce contention with another task's independent build.
