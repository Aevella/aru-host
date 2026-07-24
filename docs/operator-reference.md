# Aru Self-Hosted Node

Linux deployment and source implementation of Aru's user-owned capability node.
The HTTP process has zero package dependencies and requires Node >= 18.
Workspace execution uses rootless Podman in production so model code never runs
as a raw host process.

For the ordinary Mac-and-iPhone setup flow, read the friendly
[`Aru Host 使用小手册`](getting-started.zh-Hans.md). The rest of this
document is the engineering and operator reference.

The official-install boundary and complete plugin/job/artifact workspace target
are summarized in [`architecture.md`](architecture.md).
In particular, `full` means all implemented official capability bundles, not
automatic installation or permission grants for arbitrary third-party plugins.

Shape authority is the Swift side: manifest mirrors `SelfHostedServerManifest`,
pairing payload mirrors `SelfHostedPairingEnvelope.parse`, vault responses
mirror `SelfHostedVaultRuntime`'s upload / inventory / delete runtime calls, and
inventory metadata mirrors `SelfHostedBackupVaultPackageMetadata` (28 fields,
archive facts echoed verbatim from the uploaded package header — the server never
fabricates archive facts).

## One-command installation

For a Debian/Ubuntu VPS with a public DNS record already pointing at it:

```bash
curl -fsSL https://raw.githubusercontent.com/Aevella/aru-host/main/install.sh \
  | sudo bash -s -- --domain aru.example.com
```

The installer creates a non-login `aru-selfhost` service user, prepares
rootless Podman and the current runtime images, installs a versioned release
under `/opt/aru-selfhost`, stores non-secret configuration in
`/etc/aru-selfhost`, keeps durable encrypted packages under
`/var/lib/aru-selfhost`, and configures Caddy for HTTPS. It never installs an SSH
key or passes an Aru device credential into a workspace container.

RPM-family hosts with `dnf`, including OpenCloudOS, RHEL-compatible systems,
and Fedora, use the same service, rootless Podman, release, and durable-data
layout. When the host already owns HTTPS through Nginx or another reverse
proxy, keep that proxy in place and give the installer the final public origin:

```bash
sudo ./install.sh \
  --base-url https://aru.example.com \
  --transport-kind public-https \
  --port 8788 \
  --skip-caddy \
  --source-dir .
```

The external proxy must forward that origin to the selected loopback port.
`--domain` remains the installer-owned Caddy path for apt-based hosts; dnf
hosts fail closed instead of replacing an existing proxy stack.

Hosts that cannot reach Docker Hub may set `--node-image`, `--python-image`,
and `--shell-image` to an operator-chosen registry mirror. These choices are
persisted across upgrades. Production operators should pin mirror references to
the upstream manifest digest instead of trusting a moving tag.

For a private Tailscale node, keep TLS/reverse proxy outside the installer:

```bash
sudo ./install.sh \
  --base-url http://100.64.0.10:8787 \
  --transport-kind tailscale \
  --source-dir .
```

`--profile full` is the only supported profile today and is persisted across
upgrades. It means “install every capability bundle that this node version has
actually implemented and can pass its runtime preflight.” Today that is the
encrypted backup vault, authenticated MCP tool gateway, durable isolated
workspace/job runtime, artifact vault, plugin substrate, and the first
computer-owned collaborator/agent-driver control plane. Future OCR, media, scheduled-event,
or provider bundles may join `full` only when their endpoint, owner, health
check, and client contract exist; the profile is not a license to advertise
placeholder capabilities.

Operations after installation:

```bash
sudo /usr/local/bin/aru-selfhost pairing
sudo /usr/local/bin/aru-selfhost doctor
sudo /usr/local/bin/aru-selfhost status
sudo /usr/local/bin/aru-selfhost logs
sudo /usr/local/bin/aru-selfhost upgrade
sudo /usr/local/bin/aru-selfhost rollback
sudo /usr/local/bin/aru-selfhost uninstall
```

Uninstall preserves `/var/lib/aru-selfhost` by default. Only
`sudo /usr/local/bin/aru-selfhost uninstall --purge-data` removes durable server data. Upgrades
write a new release, retain the prior release as the rollback target, reuse the
same data directory and node identity, restart the service, and verify the
local manifest before returning success.

Release maintainers build the hash-verified installer payload with:

```bash
./package-release.sh /tmp/aru-selfhost-linux.tar.gz
```

The resulting tarball and `.sha256` file can be published as matching release
assets and installed with `--bundle-url`.

## Run from source for local development

```bash
node aru-selfhost-stub.mjs --port 8787
```

Boot prints the manifest URL plus a single-use pairing payload (JSON and
`aru://pair?...` forms, 10 minute TTL). Use `--pairing-token <fixed>` for
deterministic dev flows.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /.well-known/aru.json` | none | capability manifest |
| `POST /aru/v1/pair` | bootstrap token | exchange one-time token for device credential |
| `GET /aru/v1/diagnostics` | optional | layered status; reports auth layer result |
| `GET/PUT /aru/v1/node-settings` | Bearer | read or revision-safely rename the host-owned node identity |
| `GET /aru/v1/node-workspaces` | Bearer | list the Host-managed default workspace and explicit external grants |
| `POST /aru/v1/node-workspaces` | loopback | authorize an external computer folder |
| `DELETE /aru/v1/node-workspaces/:id` | loopback | revoke an external grant; the managed default is protected |
| `/aru/v1/node-workspaces/:id/files` and `/file` | Bearer | list or read/write UTF-8 text inside one known workspace |
| `/aru/v1/node-workspaces/:id/directory`, `/move`, and `/path` | Bearer | create, move, or delete contained paths |
| `POST /aru/v1/backups` | Bearer | stream a v2 binary encrypted package |
| `GET /aru/v1/backups` | Bearer | inventory (`{packages:[{remotePackageId, metadata, uploadedAt}]}`) |
| `GET/PUT /aru/v1/backups/settings` | Bearer | read or revision-safely edit the Host-enforced retention rule |
| `GET /aru/v1/backups/:id` | Bearer | download package bytes |
| `DELETE /aru/v1/backups/:id` | Bearer | delete a remote package after explicit user confirmation |
| `GET /aru/v1/devices` | Bearer | list paired devices |
| `POST /aru/v1/devices/revoke` | Bearer | revoke a device |
| `POST /aru/v1/jobs` | Bearer | submit a durable workspace job; same run id plus same snapshot is idempotent |
| `GET /aru/v1/jobs` | Bearer | list durable jobs and terminal result handles |
| `GET /aru/v1/jobs/:id` | Bearer | inspect current job state, evidence, and result |
| `GET /aru/v1/jobs/:id/events` | Bearer | read ordered state events for reconnect |
| `POST /aru/v1/jobs/:id/cancel` | Bearer | explicitly cancel a queued or running job |
| `POST /aru/v1/jobs/:id/retry` | Bearer | create a new job linked to a failed/cancelled predecessor |
| `GET /aru/v1/artifacts` | Bearer | list live workspace artifacts and immutable metadata |
| `GET /aru/v1/artifacts/:id` | Bearer | download artifact bytes with integrity headers |
| `DELETE /aru/v1/artifacts/:id` | Bearer | explicitly tombstone a remote artifact |
| `POST /aru/v1/mcp` | Bearer | Streamable HTTP MCP initialize, tool catalog, and tool calls |
| `GET /aru/v1/agent-drivers` | Bearer | inspect the fixed Codex / Claude Code adapter probes |
| `POST /aru/v1/agent-drivers/refresh` | Bearer | rerun bounded local driver version probes |
| `GET/POST /aru/v1/hosted-collaborators` | Bearer | list or create computer-authoritative collaborator roots |
| `GET/PUT /aru/v1/hosted-collaborators/:id` | Bearer | read or update one hosted root and selected driver |
| `GET/POST /aru/v1/hosted-collaborators/:id/initiative` | Bearer | list or create durable one-shot/recurring proactive rules |
| `PUT .../initiative/rules/:ruleId`, `POST .../initiative/rules/:ruleId/archive`, `/restore`, `/run` | Bearer | revision-safely edit, archive, restore, or explicitly run one rule |
| `GET/POST /aru/v1/hosted-collaborators/:id/projects` | Bearer | list or create Host-workspace page projects, optionally by cloning GitHub |
| `GET/PUT /aru/v1/hosted-collaborators/:id/projects/:projectId` | Bearer | inspect or revision-safely rename a project and its phone entry path |
| `POST .../projects/:projectId/checkpoint`, `/publish`, `/archive`, `/restore` | Bearer | save immutable artifact checkpoints, explicitly publish the phone surface, or change visibility |
| `GET/POST /aru/v1/hosted-collaborators/:id/conversations` | Bearer | list or create Host-authoritative computer conversations |
| `GET .../conversations/:conversationId` | Bearer | read durable messages, turn state, and approval state |
| `GET .../conversations/:conversationId/events?after=<cursor>` | Bearer | read ordered replica events after a Host cursor |
| `POST .../conversations/:conversationId/messages` | Bearer | idempotently enqueue a user message and lazily start the fixed driver |
| `POST .../approvals/:approvalId` and `.../turns/:turnId/cancel` | Bearer | resolve a persisted approval or interrupt an active turn |
| `GET/POST /aru/v1/hosted-collaborators/:id/surfaces` | Bearer | list or directly publish a persistent Host-owned web surface |
| `GET/PUT /aru/v1/hosted-collaborators/:id/surfaces/:surfaceId` | Bearer | read the active source/state/history or publish a new immutable version |
| `PUT /aru/v1/hosted-collaborators/:id/surfaces/:surfaceId/state` | Bearer | revision-safely persist phone interaction state on the Host |
| `GET/POST /aru/v1/hosted-collaborators/:id/surfaces/:surfaceId/events` | Bearer | read or append typed phone interaction events |
| `POST .../surfaces/:surfaceId/rollback`, `/archive`, `/restore` | Bearer | restore an earlier source as a new version or change visibility |
| `GET/PUT/DELETE /aru/v1/push-devices/current` | Bearer | inspect, register, or remove the requesting paired phone's APNs route |

The fixed MCP catalog exposes node identity read/rename, backup inventory,
revision-safe backup retention read/update, device inspection, durable job
inventory/status/events/cancel/retry, artifact inventory/deletion, and plugin
inventory/status/install/enable/disable/upgrade/rollback/uninstall. Mutation
annotations feed Aru's existing per-tool Ask Every Time / Always Allow policy.
The gateway does not accept arbitrary host paths or raw host shell commands,
and it does not duplicate workspace submission: native `runWorkspace` owns the
local snapshot, remote submission, and conflict-checked publication chain.
Artifact download and verified import remain native actions because only the
phone owns the target `AssetStore`.

`node-settings` is durable Host state rather than an edit to installer-owned
`node.env`. The first implemented setting is the user-visible node name. A
write must carry the revision returned by the preceding read, so two paired
clients cannot silently overwrite one another. The updated name immediately
feeds the manifest, MCP status, diagnostics, and Host Console without changing
the node address, server id, or any paired credential. The paired-device
inventory identifies the requesting device so the Host Console can protect its
own live credential while still revoking other devices.

Supported computer nodes create one Host-managed default workspace at boot.
The macOS `home` instance uses `~/Aru Workspace`; other named instances use
`~/Aru Workspaces/<instance>`, and a source run defaults under its private data
directory unless `--managed-workspace-root` is supplied. The root must be a
real directory owned by the Host user and is created mode 0700. It cannot be
revoked. External folders remain explicit loopback grants, and every file
operation stays inside one inventory workspace through relative-path,
realpath, and symlink containment. The default is the model's safe destination
when the user asks it to create or organize files without naming another path.

Pairing grant response shape consumed by `SelfHostedPairingRuntime`:
`{schema: "aru.selfhost.pairing-grant.v1", serverId, deviceId,
credentialSecret, credentialScope, issuedAt, expiresAt, rotationPolicy,
nextRotationAt, bootstrapTokenConsumedAt}`. Native writes `credentialSecret` to
the Keychain writer port and stores only the resulting credential ref plus
receipt metadata in SQLite.

## Collaborator host and agent drivers

`collaborator-host.mjs` owns this control plane instead of
adding another responsibility to the HTTP shell. It persists hosted
collaborator identity, revision, computer authority, and selected built-in
driver in the node's existing private state file. Driver discovery executes
only fixed `codex --version` and `claude --version` probes with a short timeout;
the HTTP boundary cannot supply a command or shell fragment, and no agent auth
material is read or stored. On macOS the fixed probe also checks the Codex app
bundle and standard user/Homebrew command locations because a LaunchAgent does
not inherit the user's interactive-shell PATH; those internal candidate paths
are not returned by the API.

Computer-hosted Codex turns are a real Host execution boundary. The ordinary
user installs Aru Host and signs in to Codex once through the Codex app; Aru
discovers the fixed app/CLI location and lazily starts its localhost-only
app-server when the first hosted message arrives. The user never configures a
socket, device credential, MCP JSON, or shell command. `collaborator-conversations.mjs`
owns the atomic conversation/message/event ledger, active-turn state machine,
idempotent message acceptance, approval records, replica cursors, managed
workspace, tool admission, restart interruption, and result projection.
`codex-app-server-driver.mjs` adapts only runtime thread/turn ids and callbacks;
Codex history is never the Host's durable truth. If its thread cannot resume or
the collaborator tool configuration changes, the replacement thread receives
the completed Host transcript before continuing. Command, file, permission,
and mutating Host-tool approvals remain visible after a client reconnect;
consecutive prompts cannot fall through a modal gap, and a session grant avoids
repeating the same Host-tool prompt until Host restart.

Every hosted root also owns a revisioned cognition ledger in
`collaborator-cognition.mjs`: a collaborator-specific system prompt, confirmed
memories, long-term references, archive state, and one visible instruction
environment choice. New roots default to `isolated`. `inheritCodex` explicitly
adds the computer's global Codex instructions for users who want an existing
Codex utility agent. The app-server itself always starts with AGENTS discovery
disabled, so an isolated collaborator cannot silently inherit another root's
identity. Updating cognition invalidates the runtime thread fingerprint; the
replacement thread receives the durable Host transcript and the new cognition.
Host Console and paired phones edit this same ledger, and owner-bound cognition
tools let the collaborator update only its own records without an id parameter.

`collaborator-initiative.mjs` owns proactive timing separately from conversation
execution. It persists the due attempt before asking
`collaborator-conversations.mjs` to create or reuse the target conversation and
run a normal Host turn tagged with the rule id. A one-shot rule disables after
that attempt is claimed; a recurring rule advances to its next due time. Host
restart records an interrupted attempt as failed instead of silently replaying
it. `apns-push.mjs` is downstream of durable conversation settlement: it sends
only completed initiative turns whose rule requested phone notification, never
an in-progress seed or a manually sent message. Each paired device owns its own
registration, and revocation removes its delivery eligibility.

The same initiative owner publishes four current-root tools to hosted
conversations: `aru_collaborator_initiative_read`, `create`, `update`, and
`archive`. Their schemas contain no `collaboratorId`; `collaborator-host.mjs`
injects the executing root and rejects forged ownership again at dispatch.
Create and reschedule accept relative whole minutes, with
`recurrenceMinutes: 0` meaning one time, then return the complete revisioned
initiative snapshot. There is deliberately no self `run-now` tool: a model that
is already speaking should continue in that turn rather than recursively start
another conversation turn. Roots in explicit selected-tool mode receive these
tools only after the user adds them to that durable admission list.

`collaborator-projects.mjs` owns durable page-project identity and the binding
between one managed collaborator workspace, its optional Git checkout, its
artifact checkpoints, and one published phone surface. A GitHub URL is cloned
by the Host into a new workspace directory; phone and Console read branch,
commit, dirty, upstream, ahead, and behind state from that single checkout.
`aru_collaborator_project_inventory`, `create`, `checkpoint`, and `publish` are
current-root tools with no `collaboratorId`. Checkpoint excludes `.git`, rejects
symlinks, and publishes an immutable tar.gz through the artifact vault without
changing the active phone page. Publish is the separate explicit action that
freezes the same workspace into the linked immutable surface release. Neither
operation pushes Git commits or creates a second phone-side clone.

Hosted collaborator surfaces remain a separate implemented execution boundary.
`collaborator-surfaces.mjs` owns the durable release ledger, immutable versions,
revisioned JSON state, typed phone interaction events, archive state, and atomic
per-surface files. Tiny pages can still publish one complete document through
`aru_collaborator_surface_publish`. Substantial pages live as ordinary
multi-file projects in the collaborator's managed workspace and publish their
built directory through `aru_collaborator_surface_publish_project`;
`collaborator-surface-bundles.mjs` copies that build into immutable Host storage,
hashes every path, and serves the exact bundle to paired clients. There is no
draft/install gate. Host Console edits inline pages and inspects multi-file
project manifests, isolated previews, version history, rollback, archive, and
restore without flattening a project back into one HTML field. The phone
validates the manifest and bytes, executes the bundle in a non-persistent
WKWebView, allows only release-local resources while external network is
blocked, then returns state and typed events to the Host. It cannot edit source
or roll versions back, so a phone-local collaborator and a computer collaborator
never share authority.

There are two ordinary authoring routes. In Host Console, open Computer
Collaborators, choose the hosted collaborator, create a page, edit its complete
HTML document, check Preview, and publish; the page then appears under that
computer collaborator on every paired phone. From a computer collaborator, ask
it to create or revise the phone page. It writes the normal project in its
managed workspace and publishes the build through
`aru_collaborator_surface_publish_project`; small self-contained pages may use
`aru_collaborator_surface_publish`. The studio's refresh action pulls those
model-authored releases back into the directory and preview without closing the
window. Every later publish creates another immutable version;
Versions can restore an earlier source and Phone State shows the Host-owned
interaction state returned by devices.

The conversation event ledger is also projected to paired phones. While a
computer collaborator is working, the phone polls only new cursor events and
renders a compact expandable activity strip for command execution, workspace
file changes, dynamic or Host tool calls, confirmation waits, completion, and
failure. These are real driver and Host events, not synthetic progress; paths
are reduced to collaborator-workspace-relative names before leaving the Host.

The driver inventory reports `execution.enabled=true` only when the fixed Codex
probe is ready. Each Codex hosted root then reports `turnExecution=true`; an
absent/logged-out/unhealthy Codex remains an explicit recovery state instead of
silently queueing forever. Claude Code still has discovery metadata but no turn
adapter and therefore remains non-executable. A phone-local collaborator and a
computer-hosted collaborator are separate roots; authority does not move per
message. Root updates require `expectedRevision`, so two paired clients cannot
silently overwrite each other.

Each hosted root also owns `aru.selfhost.collaborator-tool-access.v1`. The
default is `all`, including tools exposed by plugins installed later; an
explicit `selected` mode stores named MCP tools without deleting selections
that are temporarily absent from the live catalog. This is the durable
admission policy enforced by the active turn runner before dynamic tools are
advertised or executed.

## Workspace runtime

When Docker or Podman is available, the manifest enables `workspace-runtime`
and `job-runtime` with `node`, `python`, and `shell`. Native submits
`aru.selfhost.workspace-run.v1` to `POST /aru/v1/jobs`: one run id, runtime,
entry path or temporary code, JSON input, and the current text-file snapshot.
The service persists the immutable input and its hash before execution, then
exposes `queued`, `preparing`, `running`, `succeeded`, `failed`, `cancelled`, or `timed_out`
state through authenticated status and event routes. A repeated run id is
accepted only for the identical snapshot. Retry creates a new linked job.
Official fresh nodes default to a visible 24-hour maximum through authenticated
`GET/PUT /aru/v1/jobs/policy`; users may choose custom hours or explicit
unlimited. Submission freezes that policy into the job. Queue time is excluded.

The server's terminal `aru.selfhost.workspace-result.v1` contains exit code,
stdout/stderr, the final text-file snapshot, and immutable handles for binary
artifacts. Native stores a reconnect receipt plus the original file ids, paths,
timestamps, and contents, then publishes accepted text changes through the same
atomic conflict check. Merely stopping native observation leaves the VPS job
running; only the explicit cancel route requests process termination. On service
restart, stale named containers are stopped, unexpired jobs resume from their
immutable input with the original start/deadline, and expired jobs become
`timed_out`; none are rewritten as success. The disposable VPS checkout is
execution state, never a second durable Aru workspace. Known binary output types
and non-UTF-8 files are moved into content-addressed artifact storage rather
than being base64-encoded into JSON.

Each run uses a fresh container with no network, a read-only container root,
all Linux capabilities dropped, `no-new-privileges`, a non-root uid, bounded
process/memory/CPU resources, and only its disposable `/workspace` bind mount
writable. Symbolic links and non-UTF-8 result files are rejected. The runtime
images and safety boundaries are operator-configurable:

```bash
node aru-selfhost-stub.mjs \
  --container-runtime docker \
  --node-image node:22-alpine \
  --python-image python:3.13-alpine \
  --shell-image alpine:3.22 \
  --container-memory 1g \
  --container-cpus 2
```

If neither Docker nor Podman is installed, pairing and backup vault remain
available but the manifest truthfully marks `workspace-runtime` disabled.
Existing artifacts remain available through `artifact-vault`. A Node 22+
runtime can still provide the permissioned source-plugin workshop; OCI plugins
remain disabled without a container runtime.

## MCP gateway

The manifest advertises `mcp-gateway` with Streamable HTTP transport and
`paired-node-device-credential` authentication. Aru materializes it into the
ordinary MCP server registry, then reads the paired device credential from
Keychain only while constructing an HTTP request. Credential material is never
copied into the MCP server row, portable MCP JSON, tool catalog, or evidence.

The reference gateway exposes the fixed node workbench: node/device
inspection, encrypted backup inventory, shared retention read/update and explicit deletion, durable job
inspection/cancel/retry, artifact inventory/deletion, plugin lifecycle, and
source-workshop guide/validate/publish operations. Enabled source plugins add
their own prefixed tools to the same catalog; publishing always leaves a plugin
disabled until a separate explicit enable call.
`aru_backup_settings` and `aru_backup_settings_update` delegate to the same
revisioned Host owner as the REST settings route. `aru_backup_delete` delegates
to the same package owner as the authenticated
REST delete route; it removes only the selected encrypted remote package and is
marked destructive so ordinary Aru MCP confirmation policy applies. The model
never receives the backup passphrase, archive plaintext, device credential, or
a restore-to-phone capability. Additional node-owned tools belong in this same
MCP registry rather than a second VPS-specific tool path.

Source plugins are JavaScript ESM modules exporting `tools` and
`callTool(name, arguments, context)`. The runtime stores source by SHA-256 and
runs each validation/call in a fresh permissioned Node process or the pinned
Node container. Host files, child processes, devices, credentials, runtime
sockets, and undeclared network are unavailable. `--plugin-call-timeout-seconds`
defaults visibly to 3600; set it to `0` for unlimited. Every generated tool is
marked destructive/open-world at the gateway regardless of plugin metadata, so
the authored code cannot weaken Aru's confirmation policy.

## Discipline

- Device credentials stored as SHA-256 hashes only; bootstrap token is
  single-use with 10 minute TTL; constant-time comparisons.
- Uploads stream to an app-owned temporary file while SHA-256 is calculated,
  then validate the bounded v2 header and chunk framing before storage; the
  default package budget is 2048 MiB and
  operators can set `--max-package-mb 0` for no configured size ceiling.
- Package deletion removes the server-side encrypted package and inventory row
  only; native Aru keeps any already-downloaded staging package, preview, or
  restore record on the device that created it.
- No secrets logged after the initial pairing printout.
- Workspace input contains no device credential. The credential is consumed by
  the HTTP boundary before a sanitized snapshot enters the container.
- Public deployment goes behind Caddy (HTTPS); manifest then declares a
  `public-https` transport profile instead of `lan`. Same file, two postures.

## Deploy behind Caddy

```
aru.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Run with `--base-url https://aru.example.com --transport-kind public-https
--node-kind vps` so the manifest advertises the HTTPS transport.
