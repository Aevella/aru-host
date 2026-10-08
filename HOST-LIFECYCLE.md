# Host lifecycle contract

This is the maintained engineering contract for Host installation, execution,
recovery and phone delivery. Read it before changing those boundaries. It defines
required semantics, not evidence that every existing path already satisfies them.

## Product intent

A Host keeps doing accepted work while its clients disconnect. Reopening a Console,
reconnecting a phone or restarting a process must not silently replace identity,
erase saved results or replay an external action. Recovery belongs to the owner of
the operation, rather than an assortment of client-side guesses.

## Responsibility and authority

| Owner | Durable facts and permitted transitions | Consumers |
| --- | --- | --- |
| Installation | instance identity, installation owner, selected release; prepare, verify, activate or preserve previous release | Console and service launcher |
| Execution | admitted attempt identity, execution evidence, terminal outcome; cancellation requests are distinct from confirmed stop | scheduler, conversation projection, drivers |
| Delivery | saved result identity and receipt acknowledgement; fetch and repeated acknowledgement are idempotent | phone sync and notification transport |
| Connection | authenticated Host identity and current route; an address is not identity | paired phone and Console |

A phone owns its rule configuration. The Host owns progress of each admitted
occurrence. Updating configuration must not reset consumed occurrences. An attempt
keeps its admitted configuration identity even when a later configuration arrives.
Revocation rejects late results under the old grant without harming unrelated work.

Drivers report evidence to execution owners. Clients submit intents and render
owner projections. A command existing, an installer exiting, or an interrupt being
acknowledged does not prove runtime readiness, successful activation or actual stop.
Shared helpers may implement storage or transport mechanics; do not add a global
mutable lifecycle manager or copy domain state into Console.

## Interruptions are ordinary transitions

Persist admission before starting external work. Persist a result before notifying
clients. A failed or delayed notification must not undo completion or hold up
scheduler finalization. A phone can fetch durable results after reconnecting.
Acknowledgement changes delivery state only; it is not execution success.

On restart, distinguish never admitted, admitted with unknown outcome, and durably
completed. Recover using the existing attempt identity and available execution
receipts. Do not automatically retry an uncertain external side effect. When the
external service supports idempotency, reuse its stable key; otherwise retain and
project uncertainty and provide an owner-specific reconciliation path. This contract
does not promise exactly-once execution across arbitrary external services.

An unreadable state file is not a fresh installation. Missing optional fields from
released schemas require explicit migration/default semantics; malformed existing
state must not be overwritten with an empty state. Upgrade preserves identity and
data, validates the candidate under the service identity, and keeps a recoverable
previous installation when activation fails. Internal migrations should converge;
external older clients require explicit versioned interoperability.

## Admission for future changes

For the responsibility actually changed, identify its entry point, durable owner,
unique mutation API, external side effect and consuming projections. Name the real
states and interruption boundaries, including how a late result is rejected. Do not
invent states for a pure presentation change. An owner change must update the
responsibility index and producer-to-consumer wiring in the same change.

Add focused fault-injection proof at relevant handoffs: before/after durable
admission, after effect but before receipt, after durable completion but before
notification/acknowledgement, during cancellation, or during release activation.
Reopen from disk rather than only reusing in-memory objects. Assert stable identity,
retained results, no inappropriate duplicate effect, and isolation of unrelated work.
Use released old fixtures for migration/upgrade proof when that boundary changes.
A happy-path test alone does not prove recovery.

## Source and release closure

Aevella/aru-host is the sole Host source authority. Aru pins an exact commit from
this repository; it does not maintain a second editable implementation. Update the
pin after verifying its source and protocol tests. Verify generated runtime and
installer payloads when changing module dependencies. Source, local tests, packaged payload, published
release and installed-device acceptance are separate claims.

## Implementation evidence and open work

2026-09-28: installation ownership is implemented in the macOS Console repair;
public Host has per-turn cancellation and Core readiness owners. These are scoped
source/test proofs, not universal platform acceptance.

Both source trees now isolate mobile delivery notification failure from durable
completion and finalize scheduling before waiting on notification. Focused tests
reopen saved state after notification failure and check stable delivery identity,
duplicate completion, repeated acknowledgement and a second restart.

2026-09-28 continuation: conversation recovery now exposes completed mobile-turn
receipts to the delivery owner before it clears in-flight markers. Recovery uses
source collaborator, epoch and delivery identity, writes the existing delivery shape
and does not call drivers or tools. Malformed recovery source files are errors, not
absence. The startup-only lookup is scoped to owners with pending deliveries.
Both trees include offline continuation and consumed-occurrence protection; public
Host daily scheduling and revocation behavior are preserved.

Focused restart fixtures cover the crash window after conversation completion but
before delivery settlement, wrong epoch/owner rejection and repeated restart without
duplicate delivery. This does not prove resumption of unfinished external actions.
Phone-visible recovery now includes a durable execution record independent of rule
configuration: running, completed, failed, or uncertain. Recovery preserves partial
text and failure evidence. The paired phone reads paged records by collaborator and
epoch in proactive settings and residence delegation, can expand saved content and
check status again. Missing older-Host support is unavailable, not an empty history.
A foreground session rejects late responses after replacement or dismissal. No
background polling or automatic replay is added.

Unknown external side effects have no generic driver reconciliation/idempotency API.
The phone explains this and asks the person to inspect actual results before starting
new work; a status refresh only reads Host evidence. Failed execution does not imply
rollback of prior side effects. Revocation and unrelated source differences are not
fully mirrored; no universal source parity or real-device acceptance is claimed.

Validation for this continuation: Aru 9 focused tests and public Host 11 focused
tests passed, plus both conversation smoke programs and generated-runtime checks.
No published package or installed Host was changed.

Execution-history verification: native Host 13 tests and public Host 15 tests passed;
phone projection 3 tests and runtime protocol 4 parameter cases passed. The Polaris
arm64 iOS Simulator build passed with CODE_SIGNING_ALLOWED=NO. Source and simulator
proof only; installed phones and published Host packages have not been exercised.


2026-09-29 review follow-up: mobile replica startup settlement failures are now
handled at the collaborator Host composition boundary. A failed recovery stops
that scheduler and logs the failure plus the restart requirement; unrelated Host
routes remain available. A filesystem rename-failure fixture proves containment
and recovery of the original durable result on the next successful startup.
Wake bridge validation now uses the injected HttpError class, so authenticated
invalid fields produce 400 with a field message, while bad authentication remains
401. These follow-up changes are source/test evidence, not a new VPS deployment.

Mobile execution and delivery bodies now live in records-v2 outside the scheduler
snapshot. Each save publishes a durable redo transaction before record/index and
scheduler writes; startup replays storage only, never models or tools. History body
reads are paged. Pending delivery and continuation indexes retain all undelivered
and unreflected receipts; no age/count-based deletion is introduced.

The first read migrates ledger.json into a staged record store, retaining its exact
bytes in ledger.v1.backup.json. A guard replaces ledger.json before activation so
old writers fail closed. Migration interruptions resume from the backup. Downgrading
to a pre-record-store Host requires explicit recovery planning: do not restore an
old snapshot over work admitted since migration. Tests cover interrupted activation,
post-journal and post-publication restart, acknowledgement, no replay and scoped
history. This remains source/local test evidence until a new release is installed.

Rollback admission: the Linux and macOS manual rollback commands check the target
replica storage version before replacing the running release when records-v2 exists.
A pre-record-store release is rejected without stopping the current instance.
Same-format rollback remains available. The old ledger backup is recovery evidence,
not a safe replacement for new executions admitted after migration. No automatic
lossless downgrade to the v1 ledger is claimed.

2026-09-30 connection settings: the revision-checked node settings owner now stores
additional Tailscale and public HTTPS origins. The public manifest retains its
primary route and projects the saved additional routes immediately. Rename-only
older clients preserve these routes; removal is explicit. Failed writes restore
the previous projection. Console gates editing on the advertised capability,
checks the public manifest identity without sending credentials, and saves using
the revision captured when the editor opened. A check from the Mac does not prove
phone reachability. This is manual address configuration, not automatic Tailscale
detection or reverse-proxy provisioning.

macOS upgrades retain the configured container executable, images and resource
settings when the engine is stopped or absent from the installer environment.
Fresh detection checks standard macOS CLI locations and saves an absolute path.
Core readiness remains the execution authority; Console distinguishes checking,
configured-but-unavailable, execution failure and an unconfigured environment.
Focused owner and real-process HTTP tests cover authenticated edits, conflict,
restart persistence, removal, validation and write failure; the spaced-path
installer fixture covers a missing engine with retained images and memory settings.
Console model tests and the local UI build passed. These changes are source/local
proof, not a newly published release or customer-device acceptance.

## Foreground conversation sync

The authenticated `/conversations/:id/sync` projection uses the existing atomic
ledger file identity as an opaque version token. An unchanged token returns before
reading/parsing the ledger; it never bypasses device/collaborator admission or
turns a missing file into an empty conversation. Changed pages carry metadata,
all currently pending approvals, affected message rows and up to 128 ordered
event positions. Text deltas advance the cursor but are projected as the current
changed message row, avoiding a second client text/event ledger. Clients drain
backlogs before caching the conditional version. Initial presentation contains
64 recent messages and recent current-turn activity, with the durable tail cursor.

`GET /messages?before=:messageId` loads the preceding 64 non-system messages,
using stable message identity rather than a changing array offset. Unknown
anchors fail explicitly. Each message includes its canonical ledger position;
arrival order and equal timestamps cannot reorder recovered replies. These are
transport/display batch sizes, not history retention or model context limits.
Mutation requests may opt into `?window=1` for a recent-message/pending-approval
response. The default complete projection and internal execution/recovery paths
retain their established semantics for installed clients.

The native foreground session owns only read projections, page cursors and
request admission. Dismissing observation cancels reads without cancelling Host
execution. Read failures preserve existing messages, history anchors and pending
approvals. Only explicit `404 route.unknown` admits interoperability with Hosts
predating sync; it is retried on the next foreground opening. Other 404s, 401s,
malformed pages and ledger failures remain errors. Retirement depends on the
installed Host upgrade floor; this branch is external-version interoperability.

Focused synthetic tests cover 5,000-message initial paging, 20 unchanged polls
without another ledger read, stable older anchors, backlog draining, terminal
updates of earlier turns, authentication before conditional reads, unreadable
and missing ledgers, native identity/page admission, stale revisions/cursors,
node removal and cancelled late reads. Conversation smoke and generated-runtime
checks cover the installed fixed-name payload. This is source/local test proof;
no release, deployed upgrade or phone interaction acceptance is implied. Whole
ledger writes remain owned by the existing persistence path; this sync change
is not a storage-format migration or measured thermal/battery acceptance.

## Incremental backup recovery points (2026-10-05)

`src/server/backup-snapshot-store.mjs` owns the random repository salt, per-device
durable draft, immutable encrypted chunks, published manifest references and deletion
tombstones. `backup-snapshot-routes.mjs` exposes paired-device transfer under
`/aru/v1/backups/snapshots`; manifest capability `incrementalVersion: 1` admits it.
Legacy inventory stays unchanged unless a Console requests `includeSnapshots=1`.
Retention and MCP inventory/deletion combine both owners without duplicating state.
Root byte size and logical content size are distinct; Console snapshot restoration
is handed to Aru, which has the password and verifies all dependencies.

Fault tests reopen disk state after reference, chunk, manifest and publication
writes; cover shared-reference deletion, damaged indexes, yielding commit cancellation,
deleted-root retries and exact replay. The local HTTP fixture proves first/incremental
transfer and lost receipts against native restore. Source tests are not evidence of
installed Host upgrade, Windows filesystem durability or real-phone background survival.

Snapshot draft reference writes are append-only and checksummed, with a durable
committed-length checkpoint. Recovery discards only unacknowledged tail bytes;
missing or damaged acknowledged bytes stop recovery/collection. Fault tests cover
both cases. Batch retain admission reads headers/sizes; publishing verifies each
complete ciphertext once before exposing the recovery point. The repository
advertises `batchRetain` and snapshot version 2; old v1 requests remain supported.


2026-10-08 turn-upload diagnostics: interrupted request bodies are classified as
`conversation_turn.upload_interrupted` before durable admission. Logs contain only
phase, received byte count and elapsed time, never partial context or credentials.
A focused interruption/retry fixture proves no admission/provider execution for the
partial upload and one execution after idempotent retry. This is source/local proof;
no installed Host or phone background-delivery acceptance is claimed.

2026-10-08 Console foreground sync follow-up (candidate branch): Electron Console
applies sync message rows by stable identity instead of issuing a second complete
conversation GET and replacing the page on each update. The composer stays mounted;
pending approvals have a dedicated projection and delegated intent handler. Backlog
pages drain before caching a conditional version, and pending cancellation remains
observed until the turn is terminal. Stale views and failed projection application
cannot advance the applied cursor. Initial opening and explicit send/cancel refresh
retain their existing complete-history behavior; this is not initial-history paging
or a ledger storage rewrite.

Local proof: 25 Console tests and 3 Host sync tests pass. A synthetic 5,000-row DOM
fixture verifies one changed row causes one text write, retains every row identity,
and preserves non-bottom scroll; repeated identical projection causes no text writes.
This is operation-count evidence, not real Electron frame-time, battery, installed
Windows/Linux acceptance, or published-package evidence.
