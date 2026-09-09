# Legacy runtime migration evidence

The explicit `src/migration` Module separates read-only conversion preview from
metadata publication. Normal commands must never invoke migration implicitly.
The filesystem Adapter owns reads, lock acquisition, exact backups, and
publication. Pure conversion consumes validated recorded state and registry
values. It never reads today's Project config to infer deployment policy.

## Contract and preservation

`readLegacyState(root)` reads the v1 runtime journal, optional earlier registry,
and any per-Project deployment inventories. Invalid or incomplete schemas throw a
structured error with a source path, without exposing source contents. Registration
conflicts, missing materialized Branch/Commit identity, mismatched recorded
provider/path selections, and missing/cyclic dependencies produce explicit
preview blockers. A blocked preview has no publishable state.

`migrateLegacyState(root, { expectedRevision, recoveredSources? })` requires the reviewed source revision and an absent new runtime state file. It acquires
an exclusive migration lock and the legacy writer's directory lock, saves exact
source bytes under a content-revision backup, rechecks source revisions, and
publishes prepared JSON with an exclusive hard-link operation. A concurrently
created `runtime/state.json` is never overwritten. Original files remain byte for
byte intact. Accepted legacy receipts never become invented completed Activity
entries; the original history remains in source files and backups.

The migration writes a separate `runtime/legacy-adoption.json` manifest whose
status is `requires-adoption`. It names legacy launchd labels and Caddy markers;
this is an adoption plan, not evidence that new providers control old jobs.
Migration never starts, stops, signals, reloads, relabels, deletes Project data,
or rewrites user configuration. Legacy direct-process handles were not durable;
those require verified absence or an explicit supervised cutover. Current source
ownership also needs cutover review before claiming independent Git ownership.

## Function-design ledger

| Function | Caller-controlled inputs and prerequisites | Results, effects, failures, and ownership |
|---|---|---|
| `readSource` | State root, exact file path, required/optional policy | Reads source bytes and metadata; only optional ENOENT is absence. Adapter owns LEGACY_READ errors. |
| `parseSource` | Complete source bytes and pure Zod validator | Materialized validated value or LEGACY_CORRUPT; no writes and no source contents in errors. |
| `loadSources` | Explicit state root | Reads only recognized runtime/registry metadata files; validates every present inventory before conversion. Filesystem permission failures remain errors. |
| `readLegacyState` | Explicit root | Owns source acquisition; delegates deterministic conversion; returns paths/revisions/counts and conversion/adoption results, never raw source bytes. |
| `assertAbsent` | Exact publication path | Reads filesystem existence; EEXIST and permission failures cannot become authorization to overwrite. |
| `migrateLegacyState` | Explicit root; no new-format state; complete legacy evidence; no concurrent legacy writer | Owns locks, filesystem snapshot backups, UUID temporary file, fsync, exclusive publication, and cleanup. Returns actual state/backup/manifest paths. Cooperating writers serialize; source revision recheck protects additional legacy sources. |

Pure helpers derive deterministic IDs/revisions, reconcile registration evidence,
convert complete recorded plans, order dependencies, and describe adoption work.
They have no ambient environment, clock, filesystem, or provider dependency.
Schema/caller validation supplies the invariants their bodies require.

## Verification

Eleven tests and 40 assertions pass in `tests/migration.test.ts`: read-only
conversion, exact backups and retained originals, absent-only publication,
missing deployed Commit, malformed valid JSON, conflicting registrations and provider selections, current-registration warnings, explicit source provenance, stale reviewed revision, rejected empty execution evidence,
legacy writer lock, concurrent migration, adoption preview despite a blocker,
and conflicting recorded provider selections. No TypeScript diagnostics occur
under `src/migration` in the current full-project compiler output.

A read-only preview of the actual Host found seven recorded registrations, three
materialized Target records, 49 legacy events, 12 accepted receipts, and no
recorded managed failures. Pantry live lacks its recorded Branch/Commit fields, so the default preview blocks publication. The explicit recovery described in [source evidence](2026-09-09-legacy-source-evidence.md) is accepted only after matching the latest completed legacy execution and exact Git worktree materialization operation. Supplying that evidence yields no blockers, while stale core, Pantry, and rig-env-check current registrations remain preserved with warnings. Recovery provenance is written into the adoption manifest and original journal bytes remain unchanged. No real Host migration or runtime/provider mutation was performed by this work.
