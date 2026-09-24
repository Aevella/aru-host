# Host recovery work — 2026-09-25

Status: local implementation and focused verification complete; not a published release.

The previous VPS upgrade replayed the saved source ref/bundle rather than resolving
an update. Release reporting depended on a sidecar that the VPS installer did not
install. Headless Linux only had the desktop Secret Service path. These are three
separate owners: update selection, installed release identity and provider-secret
storage. They are not repaired by changing the phone's version label.

The phone previously retained each trigger's creation address without durable Host
identity. New-trigger address preference did not migrate old records. A shared
background error appeared inside the creation form, making an old trigger failure
look like a new creation failure. Recovery now belongs to the trigger/paired Host
and preserves existing event identities. Unknown attribution asks for reconnection;
no URL-only guess transfers credentials to another Host.

Lessons: finish producer and consumer together; test a released old shape; distinguish
identity from route; ensure one failed object does not label another; preserve
accepted events when removing their ingress; report unavailable information as
unknown. These are scoped principles in architecture.md, not a mandate to retain
all legacy branches or to require reconnection for every upgrade.

Evidence: 10 tests passed across headless-secret-store, upgrade-selection,
release-identity-recovery and legacy-installer-upgrade. These cover released 0.31.4
installer compatibility, release identity, retained service keys, missing-key refusal,
configuration rollback after a failed install, failed release lookup, one-time
explicit update targets and credential reset. Provider-profile, wake-bridge,
wake-send, Windows secret-store contract and installer smokes passed. Shell syntax
and `node tools/build-runtime.mjs --check` passed.

The Windows secret-store smoke here is an injected contract test on macOS, not a
physical Windows run. Windows installer changes still need Windows execution;
VPS systemd and real-device acceptance are distinct from local smoke tests. No
public release, installed Host, relay or user data was changed.
