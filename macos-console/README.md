# Aru Host Console

The source deployment minimum is macOS 15 (Sequoia), for Apple Silicon and Intel.
Build with Xcode 26 / Swift 6.2 or newer so the guarded Liquid Glass branch can
compile; this build-tool requirement does not raise the runtime minimum. macOS 15
uses system material, with the same layout, tint and button feedback.
Published-package availability is tracked in [the changelog](../CHANGELOG.md).

This is the native macOS control surface for a locally installed Aru Host. It
does not read `state.json`, own collaborator truth, or keep the Host alive.
Instead it pairs as an ordinary local device, keeps that device credential in
macOS Keychain, renders authenticated Host inventories, and sends explicit
Host intents.

Opening the Console connects to the selected Host on the same Mac; it does not
authorize replacing an existing Core installation. If its dedicated Keychain credential is absent or has been revoked,
the Console asks the local control tool for a one-time bootstrap token, rotates
the unique `host-console` device credential, saves it in Keychain, and finishes
loading without exposing a pairing step. A rebuild must keep a stable code
signing identity; `build-local-app.sh` therefore rejects ad-hoc signing instead
of producing an app that asks for the login Keychain password after every
rebuild.

The console is the control surface for the complete backend package rather than
a collaborator-only app. Its eight destinations cover node/capability health,
encrypted backup inventory, a real authenticated MCP handshake and tool
catalog, complete source-plugin authoring and supervision, authorized computer
folders, durable workspace jobs and their user-owned time
budget, verified artifacts, and computer-authoritative collaborators. It can
create, validate, optionally save, directly apply, edit, enable/disable,
rollback, and uninstall source plugins; its MCP directory exposes search,
collaborator-owned automatic/custom admission, Host/plugin provenance, input
schemas, and safety annotations. The default automatic policy includes future
plugin tools, while the explicit custom editor is revisioned Host state rather
than a Console-only preference; plugin detail reflects the same collaborator
assignment. Direct apply
installs and enables in one confirmed operation, while drafts remain optional
visible editing checkpoints. It also changes the node job budget and creates a
hosted collaborator root through existing Host intents. Unsupported execution
ground stays visible with its real cause instead of becoming a fake switch.

Build and open a local development app:

```bash
./build-local-app.sh
open '.build-local/Aru Host Console.app'
```

The local bundle uses an available Apple Development identity for development
proof only. Real users must receive one prebuilt universal Developer ID signed
and notarized package containing a matching Host Core and Console; they do not
install signing certificates, run this build script, or manage Keychain access.
That official package is not shipped yet.

Local installation identity is shared by preparation, endpoint lookup, pairing,
and container setup. Discovery uses installed programs/configuration, not a
leftover data directory. A unique installation (including a named CLI instance)
is reused; multiple installations require one explicit choice, persisted in
`desktop-instance`. Retained `home/data` is restored only when no installed
service competes. No data is moved.

`install-macos.sh --install-owner desktop|independent` records ownership in
`config/install.env`; terminal invocations default to independent. Legacy
records with an App bundle HostCore source migrate to desktop ownership; other
legacy records migrate to independent ownership. Instance names and version
numbers alone never establish ownership.

Opening the Console installs Core only when none is installed. Existing Core is
checked with its own reader, then started without restarting an active process.
Protocol compatibility is checked through the existing manifest/capability
boundary. Independent installs are never replaced by the desktop app. Managed
installs offer an explicit update-and-restart action only for a newer bundled
version; unknown/newer installed versions are not overwritten. Missing managed
programs use an explicit repair-and-restart action, preserving data. The action
rechecks instance, owner and installed version before calling the installer.
Pairing uses the selected instance's own control tool, so a missing global CLI
wrapper is not a reason to reinstall Core.
