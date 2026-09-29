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
