# Issue #78 — checkpoint preparation recovery

Scope: effect transaction filesystem adapter and existing restore/checkpoint
interfaces. No CLI command, runtime inventory migration, process, or router
contract change. Reviewed issue snapshot: `/tmp/rig-supervisor-20260909/issue-78.json`;
live `gh issue view` was unavailable in the sandbox. Supervisor owns independent
standards/spec review and final full-suite validation.

## Interface decision

Compared (1) publishing a preparing phase in the main journal before directory
creation/copying and (2) a separate durable preparation claim alongside the
checkpoint. Option 1 expands the rollback journal union and all journal consumers,
and still needs recovery of preexisting unjournaled directories. Option 2 keeps
pending/committed journal semantics stable and gives preparation one filesystem
owner. Chose option 2 with bounded preservation for pre-marker directories.

The existing caller remains `transactions.restore(target.id)`, followed by a new
checkpoint on retry. Successful proven cleanup returns void. A legacy backup-only
orphan is renamed intact to a unique sibling, then reports the tagged
`EFFECTS_PREPARATION_PRESERVED` error with `archivePath` and retry hint. This is an
intentional partial-progress result: the blocker was removed but retained evidence
needs to be reported. A repeat restore is safe. Unknown provenance is never
converted into authority to delete.

## Ownership and crash contract

One rigd serializes Target transactions. The adapter validates checkpoint parent,
Target directory, journal, claim and recognized children with lstat. Root aliases
are resolved for the claim's canonical location; symlinked children are rejected.
The hashed location selects a Target but alone proves no ownership.

A complete atomic claim binds version, Target ID and canonical directory before
mkdir/copy. The claim is retained until directory removal finishes. Interruption
before claim rename leaves a uniquely named temporary sibling that is retained
and cannot block the Target. Claim-only, empty-directory, partial-copy and
journal-temporary windows recover without writing active resources. Deleting
recognized files incrementally and removing the claim last makes interrupted
cleanup retryable. Valid journal publication transfers authority to rollback or
commit. Unknown files or corrupt/mismatched claims prevent cleanup even with a
committed journal. The protocol handles process interruption, not disk power-loss
fsync durability or hostile concurrent filesystem replacement.

Legacy no-claim, no-journal directories with only numbered regular backups (or
empty) are archived intact, never deleted. An unrelated numbered backup cannot be
distinguished from an old Rig backup, so archival retains every byte and reports
the location. Unknown names, nested paths, links and corrupt evidence remain in
place. Archives are outside subsequent checkpoint paths and never swept.

## Function contract ledger

| Functions | Inputs and outputs | Effects, prerequisites, failure and callees |
| --- | --- | --- |
| createEffectPreparation | Root and Target directory resolver; returns preparation capabilities | Adapter owns filesystem, UUID and realpath access. Caller supplies isolated root and serializes Target operations. No active resource/router writes. |
| claim, validateLayout | Target ID; parsed optional claim or void | Read-only lstat/readFile/readdir/realpath plus Zod parse. Expected absence differs from corrupt/foreign/linked evidence. Tagged ambiguity failure preserves files. Filesystem behavior verified through transaction tests. |
| begin | Target ID; void | Requires absent directory and claim. Atomic claim publication precedes mkdir. Partial progress persists for restore; atomicFile is inherited tested filesystem owner. |
| recover | Target ID; void or preserved-evidence/ambiguity error | Validates all children before any mutation. Owned cleanup is allowlisted, claim last; legacy path rename preserves bytes and reports archive path. Never calls router or touches active install paths. |
| release | Target ID; void | Only after journal directory removal; validates claim before removal. Failure leaves recoverable claim-only state. |
| load | Target ID; optional journal | Validates filesystem/claim and exact journal Target before returning. Missing journal remains distinct from malformed/foreign journal. |
| checkpoint, rollback, commit, restore | Existing Target/artifact inputs and checkpoint handle | Existing journal effects unchanged; preparation begin/recover/release now coordinate filesystem lifetime. Direct callers in target-effects.ts still use existing signatures. In-memory handles revalidate layout before destructive work. |
| invalid, stat, path closures | Error construction or exact path input; tagged error, optional stat, or path | stat propagates IO failures except ENOENT. Path closures retain supplied root/resolver; no mutation. Tested through public transaction boundary. |
| test fixture and cleanup | Temporary root and fixed Target identity; real adapter fixture | Real files and Caddy router with isolated no-op command boundary. Cleanup owns only test-created roots. |

No borrowed results or caller argument mutation are introduced. Empty directories,
absent claims/journals, partial backups, conflicting Target/path identity, invalid
file types, publication/cleanup boundaries and both success/error channels are
covered. Existing rollback tests cover active file and route compensation.

## TDD and verification

- Initial public regression: claimed no-journal partial backup, restore, retry.
  Red: retry failed with EFFECTS_RECOVERY because directory remained. Green:
  preparation claim recovery, active binary and route unchanged.
- Legacy orphan preservation regression covers the issue's original pre-marker
  on-disk shape, retained bytes, reported archive path and successful retry.
- Corrupt claim with committed journal: red showed checkpoint directory deleted
  before claim validation; green moves validation before cleanup.
- Unknown file beside committed journal: red resolved and deleted the file;
  green validates recognized regular children before journal cleanup.
- Crash-state and preservation controls exercise public transaction methods with
  real temporary files, including atomic claim and journal temporary files.
- Focused validation: `RIG_ROOT=<new temporary root> bun test
  tests/effect-preparation.test.ts tests/deployment-effects.test.ts`.
- Focused result: 36 tests pass, 144 assertions, zero failures.
- `bun run typecheck` passes with the existing checkout dependencies symlinked.
  Initial missing commander/yaml resolution was environmental, not a code failure.

No actual historical state, live launchd, Caddy service or deployment was touched.

## Independent-review cleanup

The independent standards review of `d08b3108` passed with optional P3 feedback:
centralize directory removal followed by preparation-claim release. The narrow
follow-up introduces `removeCheckpoint(targetId, { allowMissingDirectory })` as
the single owner of that ordering. Its inputs retain each caller's existing
missing-directory policy; its void/error result leaves propagation versus deferred
cleanup with those callers. It owns only the existing rm and preparation.release
effects, relies on their previously documented validation and serialization, and
leaves active-map mutation at the callers. If directory removal fails, the claim
is not released. If release fails, the claim-only state remains recoverable.
No public contract or preservation behavior changes. The existing 36 preparation
and deployment-effect tests plus strict typechecking remain the validation seams.
