# #101 Explicit Preview destruction

## Authority and scope

Issue #101 and authoritative user decision comment 5608397151 authorize Preview
`down --destroy` to delete its owned data/log/source history after verified stop.
The flag is confirmation; no additional prompt or `--yes` is introduced. Ordinary
down preserves data. All executable validation used isolated temporary RIG_ROOTs;
no real deployment/runtime data was purged.

## Interface comparison

Before: runtime passed inventory publication into lifecycle.retire, which stopped
processes and transactionally retired routes/artifacts. Data stayed orphaned.

Considered adding recursive deletion inside lifecycle.retire. Rejected: its
rollback contract may restart the prior Target after publication failure, which
is invalid once data removal has partially succeeded; ordinary Preview-cap
retirement also shares that function and was not authorized to destroy data.

Chosen: runtime inspects ownership, persists stopped destructionPending intent,
retires reversible effects, asks RuntimeFiles to destroy the owned Preview root,
then removes inventory. inspectPreviewDeletion and destroyPreview share the same
filesystem validation; the latter rechecks after shutdown hooks. This keeps
filesystem ownership in its adapter and irreversible ordering in the runtime.
Existing lifecycle.retire remains unchanged. It receives stopped intent so its
failure rollback cannot restart the Preview. Pending destruction prevents up,
restart, deploy, automatic replacement, reconciliation and daemon uninstall from
losing the retry handle. Doctor reports the pending action. Down remains usable
for explicit process/effect recovery and never clears destruction intent.

## Function contracts and direct-callee trust

| Functions | Inputs and ownership | Results, mutation and effects | Failures, prerequisites and trust |
|---|---|---|---|
| createRuntime.execute destroy branch | RuntimeDependencies, validated command, selected Target and inventory snapshots; mutation queue owns writes | Persist stopped destructionPending record; retire process/route/artifact state; remove owned bytes then inventory; activity/diagnostic outcome | Ownership inspect must pass before retirement; lifecycle retirement must verify stop before deletion. Existing retirement and store contracts tested at lifecycle/application/E2E seams. Any failure leaves inventory until the final removal succeeds. Removal itself cannot be rolled back. |
| createRuntime.reconcile and prepare-uninstall branch | Passed dependencies and persisted inventory | Skip pending deletion during reconciliation; reject uninstall until explicit completion | Avoid automatic recovery that could recreate partially deleted bytes; existing recovery behavior retained. |
| doctor | Project, Target records, dependencies | Adds failed destruction-pending check and explicit retry guidance | Read-only, existing observation/config effects unchanged; public runtime command test verifies output. |
| inspectPreviewDeletion, destroyPreview | Borrowed root/Target/Project+Target inventory under runtime queue | Filesystem reads; destroy removes only canonical owned root; no mutation of input snapshot | DESTROY_OWNERSHIP on invalid identity/path, aliases, overlaps, mounts, unreadable paths; DESTROY_CLEANUP on partial rm failure. Missing owned bytes are retryable. Node filesystem effects live in this adapter. |
| deletionRoot, inspectDeletionRoot | Same scoped inventory request | Materialized canonical physical deletion path; reads metadata and inventory references, never deletes | Canonical data/log/revisions required; duplicate Target IDs rejected; all ancestors below trusted root are real directories on its device; other Target paths including recovery/prepared storage and repository paths may not overlap physically. Underlying fs errors become tagged ownership errors. |
| maybeStat, physicalPath, verifyTree | Explicit paths; device; error factory for recursive inspection | Read-only fs metadata, resolve existing aliases with absent suffixes, check all directory descendants | Only ENOENT means absence; other errors propagate to deletionRoot. No directory symlink traversal; differing devices reject. Public tests cover missing paths, aliases and permission errors. Mount injection was not performed. |
| within, overlaps, recordPaths, local segment/reject callbacks | Strings or borrowed Target record; no ambient state | Pure booleans/materialized path list/tagged error; no input mutation | Root/child/equality disjointness is covered through public ownership cases. They allocate local values; no callbacks retained. |
| destroyFixture and regression bodies | Test fixture dependencies and new mkdtemp root | Create only run-owned fixtures; public runtime/CLI calls; sentinel bytes; cleanup | Existing fixture adapter controls unrelated deployment mechanisms. FileStateStore reopen establishes persistence. CLI test runs production composition and actual run-owned process shutdown. |

The filesystem adapter trusts Node rm's documented symlink-unlink behavior; the
external shared-directory sentinel verifies it through the public runtime seam.
It does not provide an OS sandbox against a separate hostile writer racing the
filesystem after validation. Rig's serialized authority and verified stopped
managed processes are the ownership/concurrency prerequisites. Historical roots
with noncanonical paths require manual policy resolution rather than guessed
ownership. Unrelated Host history/prepared metadata is outside this root deletion.

## Public TDD evidence

Seams authorized by the task: runtime.command, FileStateStore persistence,
TargetLifecycle public behavior, and CLI through isolated rigFixture.

First run needed frozen dependency installation. The actual red run then failed
at the data sentinel assertion: after explicit destroy `exists()` was true,
expected false (one failed test, three assertions). The first green slice removed
data, logs and source sentinels (one passing test, five assertions).

Additional coverage verifies ordinary down preservation; other Target and
external Persistent bytes; symlink destinations; ancestor symlinks; overlapping
storage; escaped data roots; duplicate identities; uncertain retirement; partial
cleanup followed by daemon recreation; blocked restart/deploy; pending doctor
report; final inventory publication failure; idempotent missing-byte retries; and
real filesystem EACCES cleanup failure followed by repaired-permission retry.
The public CLI regression performs down, up and explicit destroy against an
actual isolated managed process and verifies database/source removal.

Final focused validation: 90 tests passed, 525 assertions, across runtime
application, runtime lifecycle, CLI and deployment E2E files. Strict
`bunx tsc --noEmit` and `git diff --check` passed. Evidence output:
`/tmp/rig-issue101-focused.log`. Parent owns full suite, build/help gates,
independent reviews and merge.
