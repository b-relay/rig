# TypeScript rewrite milestone evidence

Work is on `feat/typescript-runtime`; the requested delivery is one PR.
The implementation remains in progress. No existing host deployment has been
changed. Tests use temporary roots and unique provider-owned resources.

## Interface decisions

Compared a long-lived daemon owning direct children with a coordinator relying
exclusively on launchd. Selected the first as the runtime authority, with both
child and launchd supervision behind the same capability interface. A detached
capture worker preserves application output across daemon crashes; durable
leases identify processes by PID and immutable birth time. launchd remains an
adapter and does not change runtime semantics.

Compared retaining the v1 snapshot as the write model with a new normalized
snapshot plus explicit compatibility cutover. Selected a separate validated
v2 file. Legacy bytes, acceptance receipts, source metadata and provider
ownership markers remain untouched until an explicit, backed-up cutover.
Unknown historical source identity cannot become a fabricated Commit.

The narrow public seams are config documents and pure Target resolution;
serialized runtime operations; observed status; supervised process identity;
independent Git source preparation; installed artifacts; route ownership;
terminal output; diagnostic evidence. Core runtime does not select tools.

## Foundation review

Independent reviewer found uninstall could remove credentials when daemon
reachability was uncertain, trusted a malformed inventory, and raced new
mutations. Replaced that path with validated serialized prepare-uninstall and
a draining state, with compensation if the stop request fails. Status observes
process presence separately from authenticated reachability.

Reviewer also found incomplete persisted-plan validation, startup resource
leaks, and racing stale-lease reclamation. Added complete discriminated plan
validation and identity checks, an exclusive acquisition guard, startup cleanup,
and retained evidence on failed shutdown. Corrupt JSON and structurally corrupt
valid JSON both fail closed without modifying bytes.

## Provider review

Independent review reproduced and resolved four material defects:

- Git mirrors inherited alternates from shared clones. `--dissociate` now owns
  the objects; the regression deletes both donor and borrower repositories.
- Mutable process command text broke ownership after shell exec. Identity now
  uses immutable process birth evidence.
- Capture workers exited during restart backoff or reset restart budgets through
  launchd. Capture owns bounded retries and communicates pending restart state.
- Wrapper spawn was mistaken for application startup. An explicit startup
  handshake now confirms the actual child or returns its failure.

Provider validation includes real isolated Caddy route traffic and rollback,
launchd idempotency and child-group termination, daemon hard-exit recovery,
stdout/stderr retention, bounded crash retries, installed Bun source shims,
and preservation of the last good artifact on failed build.

## Runtime review and integration

An independent reviewer found that failed candidate rollback could overwrite
process ownership with the previous deployment plan. A durable recovery record
now retains both policies until activation or verified rollback finishes.
An uncertain transition refuses new starts; explicit down stops both recorded
providers before clearing recovery. A fault-injection test verifies the old plan
is never restored over a surviving candidate.

The first full CLI/daemon test verifies actual working-copy cwd, fresh configured
health, stable repeated up, stdout/stderr logs, refusal to uninstall active
Targets, cross-client down from outside the repo, released localhost port, and
preserved stopped inventory after daemon uninstall.

## Function contracts

- Config document functions own discovery, revision checks, syntax-tree editing,
  backups and atomic publication. Pure validation/resolution owns no I/O.
- Runtime operations own sequencing, desired policy, rollback and final receipts.
  Lifecycle consumes recorded plans; deploy is the path that replaces policy.
- Process adapters own launch/observe/stop and expose started versus unchanged.
  Rollback stops only resources newly started by the operation.
- Read models own one shared observation deadline and do not change desired state.
- CLI output consumes final domain reports. Diagnostics accept a closed set of
  metadata and return logging failure as data. Target output has a separate sink.
- Legacy conversion preserves historical uncertainty and emits an adoption
  manifest; it never claims ownership of existing jobs merely from their labels.

## Outstanding validation

Complete final
integration/compiled-binary checks, adversarial deployment tests, and independent
review, then establish live cutover evidence. Git helper packaging, registration,
Preview limits/destruction, and doctor/preflight implementations now exist;
their presence does not establish every acceptance condition or live readiness.
Tickets remain open until the implementation and acceptance evidence are ready
for the requested PR.

## Activity And Daemon Review

R8 previously omitted daemon administration and terminal crash Activity.
Administration now writes a separate private `runtime/admin-activity.jsonl`
journal only after observed install/uninstall/no-op results. Failed actions retain
safe codes and rethrow their original failure; journal failure cannot turn a
successful action into failure or fabricate a completed action. Runtime reads and
merges this history without writing its snapshot after daemon shutdown.

A bounded read-only process monitor records concrete terminal exit evidence for
desired-running Components. Persistent deterministic event identities include the
Target policy epoch, Component, and exit evidence. Restart backoff, uncertainty,
intentional stops, and missing processes without exit evidence do not become
invented crash history. The update rechecks current desired state and policy;
composition serializes monitoring against lifecycle and drains work on shutdown.

The activity/admin verification run passed 14 tests and 38 assertions, including
real isolated daemon install/uninstall and history readback after shutdown,
failed uninstall compensation, corrupt ownership, crash deduplication across
monitor recreation, a racing down, and a non-cooperating provider deadline.

## Configuration And Adoption Follow-Up Review

Provider profile names previously accepted `stub`/`isolated-e2e` while concrete
adapters executed real effects. Current user config accepts only `default`.
Historical state parsing preserves profile evidence; unsupported recorded plans
must be refused before lifecycle effects. Caddy command reload now requires an
explicit nonblank command, preventing an implicit default reload fallback.

Public config/editor/migration/adoption checks passed 40 tests and 165 assertions
after these fixes, and strict typechecking passed at that revision. The runnable
fullstack fixture now selects the supported default profile. No real Host config
was rewritten. Migration review additionally closed missing-manifest authorization
and completed-manifest provenance tampering: absence is fresh only without legacy
evidence, and completed evidence must preserve every original pending field.

## Documentation And Contract Audit

Current entry docs now point to the TypeScript module map and explicit release
gates. The prior Effect cutover report is preserved in
`docs/rig-cutover-readiness-pre-typescript.md` with an explicit historical label.
CONTEXT remains the accepted model, including interaction requirements rather
than a completion claim. The audit reported Target selection/init interaction
and legacy log readability gaps for implementation; neither is silently removed
from the product contract. No deleted `src/rig` link is used as current code proof.

The interaction follow-up now implements TTY Target selection and init/deploy
confirmations through injected terminal interaction and read-only daemon context
queries. Noninteractive missing-Target usage fails with guidance, omitted Preview
Branch uses the current Branch, and init uses the detected Production branch.
The parent implementation's focused verification passed 19 tests/169 assertions.
Legacy-log compatibility is covered by the following implementation review.

## Legacy Log Interface And Preservation Review

Compared two approaches: convert retained logs into the new format during
migration, or expose old/new formats through one read-only log adapter. Selected
the adapter because conversion would rewrite evidence and force guessed stream
or timestamp values. `adapters/target-log-reader.ts` owns format and cursor
policy; runtime and CLI consume the existing Target log interface.

Historical source inspection identified `<component>.launchd.log` as a combined
stdout/stderr file and `events.jsonl` as mixed runtime events. The reader labels
combined-file timestamp/stream `unknown`; it extracts only `component.log` events
with an actual `details.line`, preserving any recorded timestamp/stream. It never
renders unrelated event details as application output. Current `target.jsonl`
retains its structured fields. Unknown-time history is displayed before dated
history without claiming a reconstructed chronology.

Opaque cursors bind the Target/log root and carry per-file inode/device identity
and byte offsets. Text equality is never log identity. Each source reads at most
4 MiB per call; recent mode uses a tail window. Follow preserves each source's
append order and merges source heads by recorded time. Truncated/replaced files
or foreign cursors fail with guidance to start a fresh read. Incomplete final
lines wait for their newline, including UTF-8 fragments, instead of becoming
corrupt JSON errors or duplicate output. Complete malformed records fail visibly.

Contract ledger: `readTargetLogs(target, after, lines)` owns directory/file reads
and returns bounded entries plus a resumable cursor without writes. Its source
reader owns open/stat/read/close and preserves unconsumed trailing bytes. Pure
cursor/line validators consume explicit data, reject incompatible identities,
and preserve unknown evidence. Existing port allocation remains separate.

Five public log tests passed with 14 assertions: legacy/new evidence and byte
preservation, partial JSONL and repeated Unicode text, limited merged follow,
foreign/truncated/corrupt inputs, and bounded recent history. Strict typecheck
passed after adding the explicit unknown stream variant. This remains isolated
evidence; actual retained Host logs have not been read or modified by these tests.
The broader log/CLI/Target-effects verification passed 23 tests/193 assertions,
including an isolated real daemon controlled from separate CLI processes.

## Installed Artifact And Route Transactions

Independent review reproduced three material faults at the public Target effect,
lifecycle, and deployment seams: failed activation from a stopped previous Target
left candidate binaries/routes published; route-free deployments retained an old
route; and another Project could overwrite a shared executable while its original
owner still reported it installed. All three now have regression coverage.

Two transaction shapes were compared. A callback-scoped transaction would hide
setup/cleanup, but would make the lifecycle layer own runtime-state publication.
The selected explicit `checkpoint` / `commit` / `rollback` contract lets deployment
keep compensation available until its state publication succeeds. Ordinary `up`
uses the same transaction internally. Runtime controls stop ordering separately:
`STOP_HOOKS` means processes were verified stopped despite hook failures;
`STOP_INCOMPLETE` means process ownership is still uncertain. Recovery ignores only
the former and never restores binaries over processes it could not stop.

Checkpoints persist original executable bytes, file permissions, installation
receipts, destination ownership, and the exact owned route block. Restoration
checks current revisions and original backup digests before writing; unrelated
files/routes and external edits are preserved. Pending checkpoints survive daemon
recreation and require explicit stopped-Target recovery. A crash between a write
and recording its resulting digest fails closed as uncertain ownership rather
than guessing which bytes to overwrite. Committed checkpoint cleanup is retryable.

Installed destinations are reserved to a stable Target and Component. Existing
unowned executables and another Component's destinations are rejected before
installation. Status verifies ownership and published bytes. Explicit migration
can call `adoptInstalledArtifact(root, identity, expectedSha256)` only after
backing up and verifying those exact existing bytes. Preview retirement releases
only proven-owned installed executables and metadata; source, data, and logs stay
preserved. Unsupported historical provider profiles are refused before every
lifecycle effect, including checkpoint, recovery, and retirement.

Function contract ledger (the daemon remains the single serialized effect owner):

| Function boundary                                  | Inputs and outputs                                                                                      | Effects, prerequisites, and failure owner                                                                                                               | Callees and verification                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `createArtifactOwnership` / `inspect`              | State root and executable identity; current owner/digest or tagged conflict                             | Reads only owned-path metadata and bytes; validates regular files; caller chooses whether to install                                                    | Filesystem/hash/schema boundary; cross-owner, unmanaged, and external-edit tests                               |
| `publish` / `observe`                              | Explicit installation callback or observation identity; publication or owned/missing/unknown            | Publication writes destination ownership after installer success; observation never claims another owner's artifact                                     | Installer and atomic metadata writer; executable invocation and ownership regressions                          |
| `adoptInstalledArtifact`                           | Root, stable identity, expected digest; explicit ownership publication                                  | Migration-only write; existing bytes and owner must match; never auto-claims an unmanaged file                                                          | Digest and metadata boundaries; stale-digest and conflicting-owner tests                                       |
| `artifactRevision` / `optionalFile` / `atomicFile` | Explicit paths and bytes; digest, optional contents, or atomic publication                              | Filesystem adapters own ambient I/O; absence distinguished from invalid type; temporary files cleaned                                                   | Standard filesystem and SHA-256 APIs; integration coverage through installation/recovery                       |
| `createEffectTransactions` / `checkpoint`          | Root, ownership/router providers, Target identity, complete artifact destinations; explicit transaction | Validate all destinations before mutation; snapshot only owned paths; one active transaction per Target                                                 | Ownership and router checkpoint seams; durable recreation and conflict tests                                   |
| checkpoint `commit` / `rollback` / `restore`       | Captured durable journal or stable Target; terminal cleanup or restored effects                         | Commit records terminal phase; rollback verifies all current revisions/backups before writes; uncertain changes retain evidence                         | Atomic file/route restoration; external edit and interrupted activation tests                                  |
| `captureArtifact` / `captureRoute`                 | Target and paths changed by this effect owner; updated expected revisions                               | Persist compensation's expected-current evidence after mutation; rejects paths outside the checkpoint                                                   | File digest and read-only router checkpoint; same durable transaction tests                                    |
| router `checkpoint` / `restore`                    | Stable route key or saved/expected checkpoints; opaque snapshot or restored owned block                 | Read-only snapshot; serialized, validated restore checks expected current block and preserves unrelated text                                            | Existing Caddy validation/reload adapter; exact restoration, conflict, and real Caddy tests                    |
| lifecycle `checkpoint` / `up` / `restoreEffects`   | Recorded Target and optional outer checkpoint; actual outcome or tagged failure                         | Profile guard precedes effects; rollback stops newly started processes before restoring artifacts/routes                                                | Injected Target effects; mixed running/new process, failed startup, and profile tests                          |
| lifecycle `down` / `stopForTransition`             | Recorded Target; stopped/no-op or differentiated hook/process failure                                   | Every process attempted; transition may continue only after verified process stop                                                                       | Supervisor/hook boundaries; bad-hook recovery and actual-stop-failure tests                                    |
| lifecycle `retire` / adapter `retireArtifacts`     | Recorded Target; owned publication removed or compensated                                               | Checked retirement removes owned executables/metadata/routes only; preserves source/data/logs                                                           | Ownership/checkpoint adapters; Preview name reuse and preserved data test                                      |
| `activateDeployment` / `stopForRecovery`           | Candidate/previous recorded plans and explicit store/lifecycle providers; authoritative saved Target    | State publication remains inside compensation lifetime; initial store failure leaves healthy old processes untouched; rollback failure retains recovery | Lifecycle/store seams; stopped rollback, final store failure, and blocked recovery tests                       |
| adapter `install` / `route` / `removeRoute`        | Recorded Component/Target; published effect and transaction evidence                                    | Installation checks owner before build; route-free activation removes owned route; completed mutations update durable expected state                    | Installer/router transactions; binary execution, unrelated-route preservation, and route-free deployment tests |

Verification after these changes: 28 focused tests / 104 assertions passed, plus
strict scoped TypeScript checking. Real isolated Branch deployment, all-lanes
web/SQLite/installed-CLI lifecycle, and Caddy tests passed 7 tests / 162 assertions.
These tests include stopped logs, no-up/same-commit no-op, rename/repoint, and
persistent database identity/content. They do not constitute a live Host rollout.

## Final Public Requirement Review

Independent review reproduced four remaining contract failures before fixing
them through public runtime tests:

- Repointing through a symlink saved its lexical alias, while subsequent workspace
  discovery returned the canonical path and rejected the same Project. Repoint now
  consumes canonical Project discovery through the document capability before
  comparing and persisting identity/path ownership.
- Host-only doctor skipped pending legacy adoption and could report a healthy
  Host despite unknown runtime ownership. Shared Host checks now include adoption
  evidence for both Project and Host-only doctor paths.
- Invalid Project discovery suppressed independent Host diagnostics. The discovery
  failure is now another failed check alongside the available Host observations.
- Doctor ignored blocked deployment recovery and could report healthy matching
  configuration. Recovery now emits an explicit failed check, and uncertain
  Target Component ownership is not probed as an ordinary healthy deployment.

The four regressions were red before implementation. The focused run with the
existing runtime application tests passed 15 tests/38 assertions. Concurrent
transaction work was still changing lifecycle interfaces during typechecking;
there were no diagnostics in these changed modules, and final full validation
is owned by the root release run after agents finish.

Function contract changes: registration consumes canonical document identity
without filesystem APIs in runtime; Host diagnosis owns independent capability
and adoption observations; Project diagnosis retains current-policy checks but
does not equate a blocked transition with verified runtime health. All effects
in this review were isolated temporary fixtures. No live Host changes occurred.


## Final packaged release validation

After all independent review fixes, the final integrated release passed:

- `bun run typecheck`: no TypeScript errors.
- `bun test`: **186 passed, zero failed, 989 assertions across 40 files**.
- `bun run build`: compiled `rig`, `rigd`, and `git-remote-rig`.
- All three compiled help commands passed.
- A compiled-only isolated smoke passed **16 checks**, including daemon install,
  local lifecycle, HTTP health, stdout/stderr logs, real `git push` through the
  compiled remote helper, exact live Commit and independent source, shutdown,
  and retained inventory.
- Real migration rehearsal preserved old state bytes, database fixture bytes,
  source identity, legacy combined logs and new captured logs.
- Effect imports/dependencies and `console.log` are absent from source/tests.

Logs are `/private/tmp/rig-final-validation-{typecheck,tests,build,rig-help,rigd-help,git-helper-help,compiled-smoke}.log`.
The compiled smoke fixture was removed after verification. This checkpoint
contains no real Host mutation. Live rollout follows the separately recorded
backup and adoption plan. Slack connector discovery found no Slack tools, and
computer-use discovery reported no available browser; notification remains
unavailable rather than claimed sent.
