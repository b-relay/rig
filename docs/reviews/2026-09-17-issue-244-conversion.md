# Issue #244 run notes — converting a root of the retired runtime

Branch `feat/issue-244-conversion`, PR against `feat/issue-114-config-cutover`.
No runtime was installed and no live daemon, job, route or data was touched. Every
test runs under a temporary `RIG_ROOT`; the rehearsal starts its own `rigd` there
and never connects to a socket outside it. No live migration was performed.

## What changed

- **The new runtime refuses an old root.** `STATE_VERSION` is 4. A state file at
  version 2 or 3 (what the last runtime before the cutover wrote) fails with
  `STATE_UNCONVERTED` and names the cutover; before this, the new runtime read a
  v3 root silently and would have started saved plans whose hooks and Commit env
  files it ignores. The one exception is `rigd uninstall`: this `rigd` started
  nothing on a root it cannot read, so it drains and leaves.
- **`src/conversion/`**, run as `bun run cutover <inventory|preview|apply|rollback>`
  from a source checkout. It is not part of `rig` or `rigd`, and nothing in
  `src/runtime`, `src/cli` or `src/config` imports it: the runtime has no reader
  for the old state or the old Project schema.
  - `legacy-state.ts`, `legacy-project.ts`: strict Zod readers for the old
    formats. An unknown saved field is `unsupported_mapping`, not dropped.
  - `plan.ts` `convertTarget(legacy, review)`: pure. One saved Target in, the
    version-4 record, its mapping and its blockers out.
  - `project-yaml.ts` `projectCandidate(config, review, envRoot)`: pure. The
    closest `rig.yaml`, validated as the text the operator would commit, plus
    notes for everything with no equivalent.
  - `inventory.ts` `readConversion(root, review, deps)`: the only reader of the
    root. Safe key metadata only: paths, sizes, digests, names. Env files are
    never opened.
  - `apply.ts`: `previewConversion`, `applyConversion`, `rollbackConversion`.
  - `command.ts`, `src/cutover.ts`: argument parsing and the effect owner.
- **A converted Target that cannot be reproduced says so.**
  `target.conversion.needsDeploy` lists why (a hook became a build that never ran
  as one, a hook was replaced, its env file is inside the checked-out Commit).
  `rig up` refuses with `CONVERSION_NEEDS_DEPLOY`; a successful deploy replaces
  the record and the marker with it. No build success, exit record or
  preparation is written by the conversion.
- Guide section "Configuration cutover"; CONTEXT.md term "Configuration
  conversion".

## Decisions

**How the runtime tells an old root from its own.** A, chosen: bump the state
version. B, rejected: a marker file written by the converter. A marker is absent
on exactly the roots that need refusing, so the check would have to be "no
marker and targets exist", which a fresh root that was used once also matches.
The version is already the store's compatibility gate and needs no new file.

**Where the converter lives.** A, chosen: a separate source-run entry
(`bun run cutover`). B, rejected: a `rigd`/`rig` subcommand. The ticket requires
normal discovery to stay free of the old reader, and ADR 0001 says no `rigd`
command produces the migration manifest. A shipped subcommand would also put
the old schemas in the compiled binaries for good.

**How "cannot start as saved" is recorded.** A, chosen: a dedicated
`conversion.needsDeploy` reason list. B, rejected: reuse `deploymentIncomplete`.
That flag means a deploy of this runtime was interrupted and drives recovery;
reusing it would make recovery code act on a Target it never touched and would
show the operator the wrong cause.

**Host `config.json`.** A, chosen: candidate only. It blocks (`host_config`)
and the preview carries the `config.yaml` text. B, first built, rejected:
convert it during apply. CONTEXT.md and ADR 0001 say config migration is manual
and Rig never rewrites a config. Candidate-only also makes `runtime/state.json`
the single existing file apply changes, which is what makes the interruption
argument short: before the rename the root is refused, after it the conversion
is complete.

**Hooks.** Each hook of each saved Target needs its own entry in the review
(`as: build` or `as: replaced, by: …`). Only a managed Component's `preStart`
can become a build. A Project-level hook ran once per Target, not where a
Service build runs, so marking it a build is `unsupported_hook_mapping`. There
is no compatibility layer that runs hooks.

**Revision.** sha256 over the converter version, the review, the state bytes,
the Tool owner records and each Project config. Liveness is deliberately not in
it (a blocker, not an identity), so stopping a daemon does not invalidate a
review. Apply checks it three times: before the lock, under the lock, and
immediately before publication.

## Function-design ledger (entries that produced a finding)

| Function | Finding | Resolution |
| --- | --- | --- |
| `readConversion` | pid liveness and the clock were ambient | `ConversionDeps { pidAlive, now }`, acquired in `src/cutover.ts` |
| `applyConversion` | interruption was untestable through the signature | optional `checkpoint(step)` in deps; tests throw from it |
| `applyConversion` | first draft wrote Host config, two files to restore | reduced to one changed file (see decision above) |
| `rollbackConversion` | trusted the manifest's list of changes | restores `runtime/state.json` only, verified against the manifest digest; the backup directory is input, not authority |
| `projectCandidate` | validated the object, not the emitted text | parses the YAML it returns |
| `assertSupportedVersion` | first draft refused every version below 4 as unconverted | only 2 and 3; version 1 stays `STATE_CORRUPT` as before |
| `prepare-uninstall` | read state unconditionally, so an unconverted root could not be uninstalled | catches `STATE_UNCONVERTED` only |

## Evidence

- Legacy shapes were captured from a root written by origin/main `28ccaed`
  (the last JSON-configuration runtime) in a temporary directory, and the
  fixture `tests/support/legacy-root.ts` reproduces them: two Projects, v3
  state, hooks, a Commit env file, a published Tool.
- `tests/conversion.test.ts` (rehearsal, real `rigd` under a temp root): new
  runtime refuses the root; preview with the daemon up blocks on
  `daemon_running` only; preview is read-only; apply; backup equals the
  original bytes; `plain` starts from its saved plan; deploying its old-format
  Commit fails with guidance; `demo` refuses to start until the candidate
  `rig.yaml` is committed and deployed, then serves the env-file value from
  `<RIG_ROOT>/env`; rollback restores the state bytes with data sentinels
  intact; an unmapped hook blocks.
- `tests/conversion-apply.test.ts`: blocker matrix with a blocked apply
  changing nothing; `CONVERSION_CHANGED`/`CONVERSION_REVISION`; repeatability
  (apply twice, rollback, same revision, apply again, same bytes); interrupted
  apply is still `STATE_UNCONVERTED`, names its backup, and can be rolled back
  or finished; Host `config.json` blocks with a candidate; rollback refusals;
  no env-file value in preview, report or backup.
- `tests/conversion-plan.test.ts`: the pure mapping and the command surface.
- Old-format Commit refusal was already covered by
  `tests/config-examples-e2e.test.ts` and is exercised again in the rehearsal.

## Known limits

- A pid reused by an unrelated process is a false `daemon_running` or
  `live_process` blocker. The guide says to check and remove the stale record.
- A launchd-mode old daemon is detected through `daemon/owner.json` only; the
  runbook (#245) must make "uninstall with the old version" an explicit step.
- `installTimeout` has no field in `rig.yaml`; the candidate notes it.
- Postgres/Convex data directories are not relocated. The candidate notes point
  at `rig recipe generate` and the existing directory.
- `bin/` and daemon logs are not backed up (large, and not changed).
- Inherited debt, out of scope: the lifecycle hook execution code of the
  runtime still exists for plans that can no longer contain hooks.

## Handoff to #245

The release gate can run `bun test tests/conversion*.test.ts` as the isolated
rehearsal. The runbook needs: stop and uninstall with the old version, back up
the root independently, `cutover preview`, review, move Host `config.json` by
hand, `apply`, install the new `rigd`, `rig status`, commit candidates, deploy
the `needs-deploy` Targets, and the rollback path with its limit (Deployments
made after conversion are unknown to the restored state).
