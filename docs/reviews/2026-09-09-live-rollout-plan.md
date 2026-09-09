# Live Rig replacement plan and read-only evidence

Status: **historical preflight plan, executed with the reviewed production-resume
adjustments in [the rollout results](2026-09-09-live-rollout-results.md)**.
Inventory and unresolved statements below describe the pre-cutover checkpoint;
the results document is authoritative for final state.
The user authorized updating existing Rig projects after battle testing. This plan
preserves historical files and all unrelated processes/routes. It is not permission
to delete stale registrations or combine Pantry identities.

## Verified host inventory

Observed September 9, 2026. Recheck immediately before cutover. The actual user
launchd domain is **gui/502**. An initial probe against gui/501 was discarded.
Only names, paths, revisions, process identities and HTTP status codes were printed;
configuration environment values, tokens, database contents and secrets were not.

| Project registration | Current source | Configuration compatibility | Recorded Target |
| --- | --- | --- | --- |
| core | `/Users/clay/Projects/github/b-relay/core` | Incompatible pre-v1 document: missing `components`, unsupported `version`/`environments` | None |
| rig | `/Users/clay/Projects/github/b-relay/rig` | Valid; installed rig, rigd, git-remote-rig | live, desired running, old Commit `ac75ac482edcea25f7a670f5a9cabeffe340087a` |
| pantry | `/Users/clay/Projects/github/b-relay/pantry-v1` | Repository absent | live, desired running; source recovered below |
| rig-env-check | `/tmp/rig-env-check.ga8f5r` | Repository absent | None |
| supervisor | `/Users/clay/Projects/github/b-relay/supervisor` | Valid | local, desired stopped |
| pantry2 | `/Users/clay/Projects/github/b-relay/pantry` | Valid; identity is pantry2 | None |
| fletcher | `/Users/clay/Projects/github/b-relay/fletcher` | Valid | None |

The old Rig Target contains **two** installed Components (rig and rigd), not three.
The new source configuration adds git-remote-rig. Existing bin directory entries
are pantry, pantry-dev, rigd, rig, rig-dev; preserve all of them before replacement.
There is no host `config.yaml` or `config.json`, so the new reader resolves the
default provider profile and **manual** Caddy reload policy. The old daemon marker
is `~/.rig/daemon/rigd.json`; there is no new address/owner/install record.

| Legacy process owner | Current observation |
| --- | --- |
| `com.b-relay.rig.pantry.live.convex` | Loaded/running PID 43732; localhost:3290 listener; HTTP 200 |
| `com.b-relay.rig.pantry.live.web` | Loaded/running launchd PID 44090; descendant node PID 44215 listens localhost:3070; HTTP 200 |
| supervisor local direct process | Port 4317 has no listener; process command-name scan found no supervisor process. Direct-process ownership still requires explicit absence verification before finalization. |

Both Pantry plists have `KeepAlive: false` and WorkingDirectory
`/Users/clay/.rig/workspaces/pantry/live`. Preserve their exact bytes. The process
scan found Caddy PID 318 and no rigd process.

**Actual Pantry database location:** the running Convex process has
`/Users/clay/.local/share/pantry/prod/runtime/convex/prod/backend.sqlite3` open.
The generic recorded `~/.rig/data/pantry/live` directory does not exist. Backing up
only the recorded dataRoot would miss the live database. Preserve the entire
`/Users/clay/.local/share/pantry/prod` tree and take a consistent copy after the
old Convex job has stopped (including SQLite journals/WAL and file storage).
Preserve the old deployed workspace, environment files and untracked artifacts.

## Source and metadata proof

The read-only migration preview, with the explicitly recovered Pantry source, has
revision `b838cb3fd3a9ef5d3bac19d03d53b2f8119a73ffb36096c2a9c886993ce4b175`.
It reports **zero blocking issues**, seven registrations, three Targets, three
process adoption entries, two route adoption entries, 49 historical events and
12 historical receipts. Warnings identify core's incompatible config and the two
missing repositories. These warnings must remain visible after migration.

Exact source files:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `~/.rig/runtime/rigd-state.json` | 73354 | `0f37fb0b07791e965998553306204eb20920ae8ce8c051059be5f7c4ed862b9b` |
| `~/.rig/registry.json` | 498 | `14c8bd0e0ed6679dd9b809cdcde585208eed6659646c95dc143bb21d094e32ca` |

Pantry's recovered Branch is main, Commit
`a002d7b93bf132fc04bf523382f029bf1c2a4690`. The latest completed legacy execution
and 113 matching tracked workspace files corroborate it; one sensitive path was
excluded from comparison. See [source evidence](2026-09-09-legacy-source-evidence.md).
The old workspace `.git` references absent pantry-v1 worktree administration.
The surviving pantry repository contains the Commit object but belongs to the
separate pantry2 registration. Do not repoint pantry to that repository or rename
its configuration to satisfy migration.

## Caddy ownership requires an explicit cutover choice

The loaded `homebrew.mxcl.caddy` job uses **`/usr/local/etc/Caddyfile`**. That file
contains existing **unmarked** Pantry and code/supervisor site blocks and does
not import `~/.rig/proxy/Caddyfile`. Therefore updating Rig's proxy file alone
will not update active host routing. Keep the active system file untouched while
adopting Rig's own route metadata; unchanged application ports preserve existing
traffic. Do not claim active Caddy configuration is owned by Rig.

| File | SHA-256 | Relevant ownership |
| --- | --- | --- |
| `~/.rig/proxy/Caddyfile` | `d215fa6d5304b9b6c0bc71a3b0befbb2c06f6a6e4ff728be4df2dc512d31518e` | Pantry `# [rig:pantry:live:web]`; no supervisor marker |
| `~/.rig/caddy/Caddyfile` | `e16529d6c376a10ba106dad6a84ba5756a38a7e8b3dd61f127f1f93ff5e4b889` | Older dev/prod Pantry markers and trusted imports; preserve |
| `/usr/local/etc/Caddyfile` | `23e9a32f1dc4e0ac42f20cd083b1659e273b4cd68aa99802b025047754b308f2` | Active unmarked sites; preserve |

Pending adoption expects Pantry route key
`legacy-target-3f3c84944f37235eb7b8699e` and supervisor route key
`legacy-target-08f97011612f2d167ffcd036`. Explicitly record supervisor's absent
legacy marked block as removed; do not remove its unrelated active system site.
A later integration of managed routes into the system file is a distinct exact
proposal: retain every unrelated block/import, avoid duplicate hostnames, validate
the complete configuration and reload the complete system file. It cannot be
silently inferred from a marker in an inactive Rig proxy file.

## Ordered execution after release validation

1. **Freeze the tested release.** Commit the reviewed branch, record its exact
   Commit and build all three binaries from that immutable source. Preserve those
   release binaries in a versioned staging directory outside managed `~/.rig/bin`.
   Record binary digests and passing typecheck/test/build evidence. Open one PR;
   neither migration nor adoption requires merging it into main.
2. **Reinventory and take backups.** Create a dated private backup directory under
   `~/.rig/backups`, mode 0700. Copy exact registry/runtime/daemon records, all bin
   artifacts, all three Caddy files, both Pantry plists, and all affected Project
   config files with modes. Preserve source workspaces and environment files
   without printing them. Record a manifest of path, byte size and digest, never
   contents. Preserve existing backup directories. Plan the database's consistent
   stopped copy separately; a live recursive copy is not a verified DB backup.
3. **Prepare independently owned sources before stopping services.** Use the
   Git-source-store provider with a new destination and `--no-hardlinks` ownership.
   Verify Rig's new release Commit and Pantry's recovered Commit. Restore a
   distinct Pantry source checkout under `~/.rig/recovered-sources/pantry` from
   the surviving object repository, preserving the pantry identity and exact old
   application Commit; do not alter pantry2's source. Retain the old broken
   workspace and its excluded/untracked files. Confirm env-file references and
   persistent storage paths survive a new workspace before activation.
4. **Publish metadata migration once.** Re-run `readLegacyState(root,
   {recoveredSources:[...]})` and review current revision, then call
   `migrateLegacyState(root,{expectedRevision,recoveredSources})` with that exact
   revision. Recovery evidence must include the documented matching execution
   and byte verification. This writes new `runtime/state.json` and a pending
   `runtime/legacy-adoption.json`, preserves original bytes and creates exact
   backups. It does not transfer process, artifact or route ownership.
5. **Prevent Rig self-downgrade before enabling reconciliation.** The migrated
   Rig/live plan still points at the old Effect build. Do not finalize adoption
   and restart a daemon with that plan desired running: initial reconciliation
   would build/install the old rigd over the release. While no daemon owns the new
   state, perform an explicit, backed-up `FileStateStore.update` transition of
   only Rig/live desired state to stopped (retain old plan and Commit). Record
   this rollout transition in activity/run evidence. Later deploy the reviewed
   release Commit through the new daemon; do not falsify the old plan's source
   metadata. Launch the bootstrap daemon from immutable staging, so managed bin
   installation cannot replace the executable used for its restart.
6. **Establish artifact ownership.** For every legacy installed destination,
   compare exact bytes with its recorded artifact and use the reviewed adoption
   helper to create ownership evidence. Back up collisions and refuse unrelated
   destinations. Specifically include existing rig, rigd and pantry, and reserve
   the new git-remote-rig destination. Do not run a build against an unowned
   destination to make adoption appear successful.
7. **Cut over Pantry processes with the same ports and data.** Record current
   launchd/process observations, unload only the two exact gui/502 Pantry labels,
   verify parent and descendant listeners are gone, then take and verify the
   consistent backup of `~/.local/share/pantry/prod`. Start new owned provider
   jobs using recorded environment/health/storage policy and independent source.
   Verify localhost:3290/version and :3070, Target logs, persistence, and parent /
   descendant ownership. No app data reset or schema migration is authorized by
   this runtime rewrite. Preserve unloaded old plists for rollback.
8. **Adopt only Rig-marked routes and finalize.** Use the reviewed route adapter,
   exact marker keys, backup and validation. Record factual process/route evidence
   for each pending entry, including stopped supervisor absence. Call
   `finalizeLegacyAdoption(root,{expectedRevision,evidence})` using the pending
   manifest revision. The manifest validation checks complete, unique evidence
   and preserves its exact pending predecessor. Active system routing remains
   unchanged unless a separately reviewed integration is executed.
9. **Start the new daemon and upgrade Rig itself.** Start from the staged release;
   read back authenticated health and inventory. Rig/live remains stopped so it
   cannot replay the old build. Deploy the exact reviewed release Commit to Rig's
   Stable Target through the new CLI. Confirm the three installed artifacts and
   ownership receipts. After verification, replace the bootstrap daemon command
   with the reviewed permanent release path and restart once; verify no old
   Component build runs and state/receipts remain stable.
10. **Update source registrations/configs without losing identity.** With Pantry
    stopped when necessary, repoint only pantry to the independently restored
    pantry source; keep pantry2 separate. Convert core's pre-v1 config only after
    reviewing its actual environment-to-Target mappings and backing up its exact
    file; it has no recorded active Target to invent. Present valid supervisor,
    pantry2 and fletcher configs need no format conversion. Retain rig-env-check
    as a missing inactive registration. Do not automatically initialize/deploy
    projects that had no recorded running Target.
11. **Battle-test the real read/write boundaries and finalize evidence.** Confirm
    all seven registrations remain, Pantry HTTP health/data and existing route
    response, stopped supervisor, current Rig Commit, three binaries, independent
    Git workspaces, local bindings, meaningful doctor results, correlated activity,
    failure diagnostics and log capture. Restart daemon and repeat status; exercise
    idempotent up on Pantry only after valid ownership. Record failures honestly.
    Preserve all backups and old history. Send the single PR link in Slack after
    final checks; do not claim missing inactive projects were deployed.

## Rollback and unresolved conditions

Before process cutover, failures leave live services unchanged: keep the pending
adoption guard and stop the staged daemon. After process cutover, stop only new
owned Pantry jobs, verify ports released, restore the preserved old route file
if it changed, and bootstrap the two exact old plists against their retained
workspace and untouched application storage. Restore old bin artifacts only from
verified backups. Preserve new state, adoption evidence and failed-run logs rather
than deleting them; select the old runtime explicitly for rollback.

Blocking facts to resolve before claiming the entire live rollout complete:

- A reviewed artifact-adoption implementation and actual source relocation/env
  preservation proof are still required; pending metadata is not runtime ownership.
- Core's obsolete config requires a semantic conversion, not a filename rename.
- Missing rig-env-check source cannot be upgraded or tested without its contents;
  retain its inactive registration. Its recovery/location is the only inventory
  gap that inherently requires outside information if restoration is desired.
- Active Caddy integration is not implemented by the current Rig proxy file.
  Existing routes can be preserved without user input, but claiming Rig-managed
  active routing requires a concrete reviewed system-file integration.
- Pantry and pantry2 are distinct identities. Restoring pantry from its proven
  Commit avoids asking the absent user to choose a rename or destructive merge.

No full configs, environment values, tokens, secret filenames, database contents
or raw process arguments belong in this document or Slack.
