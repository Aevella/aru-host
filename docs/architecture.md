# Architecture boundary

Aru Host has three one-way responsibilities:

1. **Host Core** owns paired identities, computer-hosted collaborators, durable conversations, cognition, approvals, pages, jobs, plugins and artifacts.
2. **Agent drivers** adapt Codex or a user-selected model API into the Host turn and event contract. A driver session is a runtime receipt, never collaborator identity.
3. **Clients and Console** render authenticated projections and send intents. Closing a client does not move authority or delete Host state.

The iPhone remains authoritative for its local collaborators. A computer-hosted collaborator remains authoritative on the paired Host. The two roots can appear together in Aru without sharing a database or silently changing ownership.

Local Aru workspace data is not mirrored into a second live workspace. Remote jobs use Host-owned execution state and return text changes or hash-verified artifacts through explicit publication flows.

Third-party plugins are separate permissioned lifecycle units. The official `full` profile installs the Host substrate and implemented official capability bundles; it does not silently install or grant arbitrary third-party code.
