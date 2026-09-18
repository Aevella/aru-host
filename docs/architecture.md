# Architecture boundary

Aru Host has three one-way responsibilities:

1. **Host Core** owns paired identities, computer-hosted collaborators, durable conversations, cognition, approvals, proactive rules, page projects, pages, jobs, plugins and artifacts.
2. **Agent drivers** adapt Codex or a user-selected model API into the Host turn and event contract. A driver session is a runtime receipt, never collaborator identity.
3. **Clients and Console** render authenticated projections and send intents. Closing a client does not move authority or delete Host state.

The iPhone remains authoritative for its local collaborators. A computer-hosted collaborator remains authoritative on the paired Host. The two roots can appear together in Aru without sharing a database or silently changing ownership. A phone-owned collaborator may publish a bounded, epoch-scoped, read-only execution replica for Host proactive turns; stable delivery ids return the result to the phone, while append-versus-branch is decided against the phone-supplied conversation head.

Local Aru workspace data is not mirrored into a second live workspace. Remote jobs use Host-owned execution state and return text changes or hash-verified artifacts through explicit publication flows.

Proactive scheduling is separate from conversation execution: a due rule persists its attempt first and then opens a normal Host turn. APNs delivery is downstream of a durably completed proactive turn, and each paired phone owns a separate registration that stops being eligible when the device is revoked.

External wake is a separate encrypted mailbox, not Host conversation ownership. Each phone-created trigger owns endpoint-scoped fetch and submit credentials; Host admits bounded idempotent ciphertext and receives only an anonymous route id plus a route-scoped wake token. The official minimal relay alone owns the APNs provider key and device-token address, receives no ciphertext or product target, and sends only a generic wake hint. Host deletes settled rows after the phone decrypts and commits the event to its own SQLite truth. The sender bundle cannot choose a collaborator, conversation, or system role.

A page project binds one Host-managed collaborator workspace to an optional Git checkout, immutable artifact checkpoints, and at most one published phone surface. Phone and Console inspect the same checkout. Saving a checkpoint, publishing a phone release, and pushing Git commits are deliberately separate actions; none creates a second phone-side repository.

Third-party plugins are separate permissioned lifecycle units. The official `full` profile installs the Host substrate and implemented official capability bundles; it does not silently install or grant arbitrary third-party code.

## Runtime source and installed payloads

The root `aru-selfhost-stub.mjs` and `conversation-turn-relay.mjs` are generated
runtime payloads. Edit `src/` and run `node tools/build-runtime.mjs`; CI checks
that checked-in payloads match their sources. Existing installed upgraders copy
fixed filenames, so these two deployed entrypoints must not gain new local
runtime dependencies. Source modules are assembled into those existing files,
not maintained as a second hand-written implementation.

| Source | Responsibility |
| --- | --- |
| `src/server/server.mjs` | Configuration, dependency assembly, pairing, authenticated routing and diagnostics |
| `src/server/state-store.mjs` | State admission, last-good backup and atomic writes |
| `src/server/backup-vault.mjs` | Encrypted backup upload validation, metadata, download and deletion |
| `src/server/artifact-vault.mjs` | Artifact publication, integrity and removal |
| `src/server/workspace-jobs.mjs` | Container job execution, deadlines, cancellation and restart recovery |
| `src/server/mcp-catalog.mjs` | Static tool schemas |
| `src/server/mcp-gateway.mjs` | MCP sessions, argument admission and dispatch to domain owners |
| `src/conversation-relay/` | Phone-owned turn routing, provider admission and raw response files |

Backup, artifact and job owners receive only their relevant state collections;
`state.json` keeps its existing format and one write authority. Persistence is
still synchronous and writes a complete snapshot: this restructuring is not a
storage migration or a claim of measured large-dataset performance.

Project Git and archive subprocesses are asynchronous. Checkpoint creation
rechecks the project's revision after awaiting compression and before publishing
an artifact; another request's archive or update cannot be overwritten by the
old attempt. The project remains the authority for its own revision.

The macOS Console's `HostConsoleConversations` and `HostConsoleSurfaces` own
surface-specific projections and mutation admission. The connection supplies
an authenticated byte-loading closure; credentials stay in the existing
connection owner. Clearing the connection invalidates outstanding feature
requests before their results can repopulate the new session.

A running relay GET is a snapshot, not necessarily a complete JSON document or
SSE event. The phone reconciles before acknowledging. Raw provider response
bytes remain preserved; neither this split nor packaging filters provider output.

Validation includes the actual v0.31.4 installer fixture with the new payload,
retained state and successful startup, ordinary installers, state recovery,
project concurrency and Console feature projection tests. New-installer tests
alone are not sufficient evidence for an installed-upgrader path.
