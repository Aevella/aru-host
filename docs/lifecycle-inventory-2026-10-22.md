# Host lifecycle inventory — 2026-10-22

Scope: owner-level inventory of installation, connection, execution, delivery,
storage and artifact lifecycle entrypoints at v0.37.0 (`ac7caed`), followed by
scoped repairs. This is not exhaustive OS fault injection or installed-device
acceptance. No storage migration, release or automatic production upgrade.

## Inventory

| Flow | Authority / entry | Recovery and isolation | Disposition |
| --- | --- | --- | --- |
| Desktop bootstrap/start/restart | `desktop-console/src/installation-lifecycle.mjs`; platform installers | One coalesced activation, installed files AND service registration, state admission, live identity/version verification | Consolidated in this change; unreadable receipts are not absence |
| Windows activation | `install-windows.ps1` | Registration/start/probe share the existing rollback outlet; no completed receipt after first-install registration failure | Repaired; real Windows fixture added |
| macOS/Linux activation | platform installers | Service command failures exit activation immediately; recovery reports verified versus failed restoration | Repaired; source-function fault tests plus isolated installer smokes |
| VPS upgrades and rollback | `install.sh`, control scripts | State/format admission precedes switch; compatible previous release preserved | Existing; installer/legacy-upgrade tests retained |
| Console pairing and route selection | platform credential outlets, `host-request`, connection address owner | Rejected grant re-pairs; read errors remain errors; candidate route checked against same Host without credentials | Existing; connection/startup tests retained |
| Provider/APNs credentials | provider secret/profile owners, notification owner | Async OS IO, bounded negative cache, scoped revision guards; manifest consumes observations | Existing; credential/nonblocking tests retained |
| Driver start and cancellation | Codex/Claude/direct drivers, conversation `turn-execution` | Initialized transport required; per-attempt cancellation; outstanding effects remain occupied until confirmed | Existing; startup/cancellation tests retained; real provider acceptance separate |
| Phone turn relay | `src/conversation-relay/` | Execution independent of notifications; cancelled admission cannot execute later; partial bytes retained; failed final publication retries storage only; ACK persists before removal | Repaired; no claim that this proves a particular phone finalization report |
| Proactive rules | initiative owner plus conversation execution evidence | Lost settlement reconciled by matching attempt; other rules continue; no blind replay of external effects | Existing; initiative failure-exit tests retained |
| Mobile execution replicas | replica scheduler + record store | Frozen transaction replay in process; same delivery identity; known unstarted admission executes once; uncertain orphan not replayed | Existing; storage/restart/isolation tests retained |
| External wake mailbox | `wake-bridge`, phone receiver | Endpoint-scoped admission, cursor paging, ACK and rejection; notification independent | Existing; mailbox is not a background model executor; phone execution opportunity remains device-specific |
| Workspace jobs | `workspace-jobs` | Control processes no longer block HTTP; stale-container cleanup verified before restart/retry; failed cleanup closes only its job | Repaired; job output and container control remain separate; no guarantee engine always obeys stop |
| Container readiness | `container-readiness`, runtime verifier | One attempt with finally release; explicit recheck after environment repair | Existing; Linux service namespace/cgroup configuration still requires target-system proof |
| OCI/source plugins | plugin supervisor + workshop/source runtime | Async bounded container outlet; per-plugin mutation admission; failed stop/data deletion retains installation; rollback distinguishes selection from verified start | Repaired OCI control; source workshop remains its existing owner |
| Attachments | attachment metadata + chunk transfer | Disk pieces are resume receipt; integrity repair, delete/late-write isolation, scoped finalize | Existing; chunk and attachment tests retained |
| Backups/artifacts | snapshot/reference/vault owners | Publish only verified content; journal recovery; deletion tombstones; referenced chunks retained | Existing; snapshot fault tests and HTTP smoke retained |
| Projects and surfaces | project/surface owners | Revision-checked publication; async archive/Git work; immutable checkpoints distinct from publication | Existing; project async tests retained |
| Core state | `state-store` | Atomic primary + admitted last-good revision; malformed state never becomes empty installation | Existing; verified backup/manual repair required for corrupt canonical data, not generic auto-reset |

## Structural changes

Installation has one Console coordinator, not a second installation database.
Bootstrap and service actions use the same admission/activation/verification path.
Platform service inspection errors do not authorize replacement. Windows task
inspection checks the expected instance command before repair. The platform
installer still owns activation and rollback.

Relay execution owns admission and final state. Notification callbacks receive
immutable snapshots and cannot hold execution or cleanup open. Pending state
publication uses the existing turn identity and retries only state writes; it never
reissues a provider request. Retained partial response files survive reconstruction
and remain readable until acknowledgement. A process dying between response-file
rename and state publication is still an interrupted execution, not proof of success.

Plugin runtime commands use asynchronous child processes, with control deadlines
(120 seconds; image pull 15 minutes). These are command/control exits, not model
budgets. A timed-out command does not establish rollback or successful deletion.
Per-plugin admission releases in `finally`; unrelated plugins and HTTP requests are
not blocked by its subprocess. A failed deletion preserves the installed owner.
Workspace container control similarly yields; startup cleanup failure becomes an
explicit retryable job failure instead of silently rerunning beside an old container.

## Verification

Local Node baseline after the runtime changes: 231 tests, 229 passed, 2
platform skips. Additional activation/job regression cases pass. HTTP smoke
includes real local server routing, plugin install/enable/upgrade/rollback/uninstall,
source workshop, jobs, backup and restart. Linux/macOS/VPS installer smokes use
isolated roots; they do not prove real system service registration on every OS.
The Windows CI fixture now injects registration denial before first successful
installation and checks recovery. CI and customer-device results are recorded
separately in the parent repository.

No production data, model requests, push delivery or customer notifications were
used in these tests. No new global lifecycle registry or generic effect replay.
