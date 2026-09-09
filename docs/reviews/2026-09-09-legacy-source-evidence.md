# Pantry legacy deployed source evidence

This investigation was read-only. No Project data, environment files, secrets,
Git metadata, runtime records, routes, or processes were changed.

## Surviving evidence

- Deployed workspace: `/Users/clay/.rig/workspaces/pantry/live`.
- Its `.git` file points to
  `/Users/clay/Projects/github/b-relay/pantry-v1/.git/worktrees/live`, which is
  absent. The original deployed Git worktree administration is broken.
- Surviving object repository: `/Users/clay/Projects/github/b-relay/pantry/.git`.
  Both historical Pantry deployment Commit objects remain available there.
- The latest Pantry `rigd.deploy.accepted` event in
  `/Users/clay/.rig/runtime/rigd-state.json` is dated
  `2026-05-20T03:56:08.750Z`. It records Branch `main`, Commit
  `a002d7b93bf132fc04bf523382f029bf1c2a4690`, Target `live`, source `cli`,
  `noUp: false`, and an actual execution result for Pantry/live/default.
- That execution result records both
  `scm:local-git:checkout:a002d7b93bf132fc04bf523382f029bf1c2a4690:a002d7b93bf132fc04bf523382f029bf1c2a4690`
  and
  `workspace-materializer:git-worktree:materialize:/Users/clay/.rig/workspaces/pantry/live:a002d7b93bf132fc04bf523382f029bf1c2a4690`.
  It also records installed CLI output, Convex/web launchd installation, successful
  HTTP 200 health checks for both, and the Pantry Caddy route.
- The preceding Pantry deploy event at `2026-05-20T03:47:10.264Z` records
  `bcf2b33b4704bec787b40cc1306ff45e20f34ec8`. It is superseded by the later event.
  No later Pantry deploy event exists in the journal. The July 26 event is
  `rigd.lifecycle.accepted`; its updated desired record has lost the source
  Branch and Commit fields.

The retained old runtime source emits `deployAccepted` only after
`deployExecution`, desired-deployment persistence, and successful replacement
handling (`src/rig/rigd.ts`, the deploy path ending at line 1331 at review time).
The event's embedded execution evidence is therefore more specific than an
acceptance-only receipt. Migration never treats a bare receipt or an event
without matching materialization evidence as a completed deployment.

## Independent workspace verification

`git cat-file -t` against the surviving repository identifies both historical
object IDs as commits. The investigation enumerated the latest Commit with
`git ls-tree -r -z`, then computed each eligible deployed file's Git blob hash
from its bytes (`SHA1("blob " + length + NUL + contents)`). It compared hashes
without printing source contents. Symlinks would be hashed as their link text,
without following their targets.

Result for `a002d7b93bf132fc04bf523382f029bf1c2a4690`:

- 113 tracked files match byte for byte.
- Zero changed tracked files.
- Zero missing tracked files.
- One sensitive/environment path excluded entirely from content inspection.

Sensitive filenames, credentials, environment values, and secret contents were
not printed. Obvious environment/secret/credential paths and private-key/database
extensions were excluded from the comparison.

This corroborates recovery of the missing recorded Branch `main` and Commit
`a002d7b93bf132fc04bf523382f029bf1c2a4690`. It does not claim that the missing Git
worktree administration has been restored, or that excluded/untracked files are
part of the Commit. The existing workspace and Persistent storage must remain
preserved during any subsequent source-ownership cutover.

## Recovery and registration limits

Recovery is explicit: a caller must supply the Project, Target, Branch, Commit,
and this provenance, plus the exact reviewed migration revision when publishing.
The migration checks the latest matching legacy execution's Project/Target/kind,
Branch, Commit, and git-worktree materialization operation. It stores recovery
provenance in the adoption manifest and retains original legacy bytes.

The old Pantry registration still names the absent `pantry-v1` repository.
The surviving current repository is registered separately as `pantry2`; this
investigation does not rename either identity or repoint either registration.
Those are separate explicit decisions. Missing current repositories or config
are migration warnings, while ambiguous identities remain blockers.

Known Rig backups were checked by scoped directory names. They contain old
binaries/registry and Persistent data, not recoverable Git worktree metadata.
`versions/pantry.json` contains 246 semantic-version bump records without Commit
fields. A scoped Trash directory listing was denied by the filesystem; a broad
Documents listing was stopped when it did not return. Neither was needed after
the journal-plus-object evidence was found.
