# Architecture boundary

Aru Host has three one-way responsibilities:

1. **Host Core** owns paired identities, computer-hosted collaborators, durable conversations, cognition, approvals, proactive rules, page projects, pages, jobs, plugins and artifacts.
2. **Agent drivers** adapt Codex or a user-selected model API into the Host turn and event contract. A driver session is a runtime receipt, never collaborator identity.
3. **Clients and Console** render authenticated projections and send intents. Closing a client does not move authority or delete Host state.

The iPhone remains authoritative for its local collaborators. A computer-hosted collaborator remains authoritative on the paired Host. The two roots can appear together in Aru without sharing a database or silently changing ownership. A phone-owned collaborator may publish a bounded, epoch-scoped, read-only execution replica for Host proactive turns; stable delivery ids return the result to the phone, while append-versus-branch is decided against the phone-supplied conversation head.

Local Aru workspace data is not mirrored into a second live workspace. Remote jobs use Host-owned execution state and return text changes or hash-verified artifacts through explicit publication flows.

Proactive scheduling is separate from conversation execution: a due rule persists its attempt first and then opens a normal Host turn. APNs delivery is downstream of a durably completed proactive turn, and each paired phone owns a separate registration that stops being eligible when the device is revoked.

External wake is a separate encrypted mailbox, not Host conversation ownership. Each phone-created trigger owns endpoint-scoped fetch and submit credentials; Host admits bounded idempotent ciphertext, uses APNs only as a wake hint, and deletes settled rows after the phone decrypts and commits the event to its own SQLite truth. The sender bundle cannot choose a collaborator, conversation, or system role.

A page project binds one Host-managed collaborator workspace to an optional Git checkout, immutable artifact checkpoints, and at most one published phone surface. Phone and Console inspect the same checkout. Saving a checkpoint, publishing a phone release, and pushing Git commits are deliberately separate actions; none creates a second phone-side repository.

Third-party plugins are separate permissioned lifecycle units. The official `full` profile installs the Host substrate and implemented official capability bundles; it does not silently install or grant arbitrary third-party code.
