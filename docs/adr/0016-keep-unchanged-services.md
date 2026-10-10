---
status: proposed
---

# A deploy restarts only the Services it changed

## Problem

Every `rig deploy` of a new Commit stops every Service of the previous Deployment and starts every Service of the new one (`activateDeployment` in `src/runtime/deploy.ts`: prepare, then `down(previous)`, then `up(candidate)`). For Melody (`db` Postgres 18, `search` Typesense, `api`, `web`) that means:

- Postgres restarts, which end the sessions of running job runs. ADR 0013 keeps a run alive across a deploy, but the MusicBrainz mirror's database connection does not survive.
- Typesense reloads about 4.6M documents for several minutes, and search degrades meanwhile.
- A web-only change takes down all four.

The owner was offered Docker Compose's rule: a deploy restarts only the Services whose config or build changed. Compose can compare an image digest. Rig runs each Service from a fresh git checkout per Deployment (`<target>/revisions/<id>`), so the resolved command differs in its checkout path on every deploy. A Service may also run a file from the checkout, as Melody's `db` runs `./scripts/rig-postgres.sh`. This ADR turns Compose's rule into one Rig can apply correctly.

Most of what it needs exists already. Every Deployment of a Target supervises a Service under the same key (`<target id>:<service>`), and `lifecycle.up` leaves a Service it finds running alone. Keeping a Service therefore comes down to not stopping it.

## Decision

### The rule

A deploy keeps a Service running when all of these hold, and otherwise restarts it:

1. The Service is in both plans and its **definition** is unchanged (see below).
2. **None of the files it watches changed** between the Commit its process was started from and the new Commit. It watches the whole checkout unless its new `watch` setting says otherwise.
3. It is running the process Rig recorded for it (same incarnation), and is not unhealthy or waiting for a health restart.
4. Nothing it `depends_on` is restarted. Restarts spread to every dependent, transitively.
5. The deploy starts its Target. `--no-up` and `--force` keep nothing.

Services removed from the plan are stopped. New Services are started.

**Definition** means the Service as its plan records it, with the checkout path replaced by a placeholder. That covers `command`, `working_dir`, `environment` (after references are resolved, so it includes Project-level values, ports, `${rig.url}` and the like), its env files with their **contents**, `ports`, `depends_on`, `healthcheck`, `stop_timeout`, `restart` and its own `build`. It also covers the Project's shared `build` command. `watch` is not part of it. The setting says what to compare, and changing it changes nothing about the process.

A `healthcheck`-only edit therefore restarts the Service too. That is Compose's behaviour, and it is simpler to explain than a split between process inputs and Rig policy. `stop_timeout` is in any case built into the capture wrapper when the process is spawned.

### `watch`

`watch` is a new optional Service key. It lists git pathspecs (paths, directories or globs, `*` and `**`) relative to the workspace root, which is where `env_file` paths are relative to as well. Absolute paths, `~` and `..` are refused. Target patches may set it like any Service setting.

- Absent: the whole checkout. Any change to the tree restarts the Service, as every deploy does today.
- A list: only changes to matching tracked files count.
- `[]`: the Service reads nothing from the checkout.

The comparison is `git diff --quiet <from> <to> -- <pathspecs>` in the Project repository, behind a new capability on `DeploymentSources`: `changed({ repository, from, to, paths }) → boolean`. Deploy never fetches, and both Commits were materialized from the local repository. A diff that fails, for example on a Commit that was garbage-collected, counts as changed.

Melody would add two lines:

```yaml
db:
  watch: [scripts/rig-postgres.sh]
search:
  watch: [] # absolute binary, data under ${rig.data}
```

`api` and `web` keep the default, so they restart whenever the tree changes. The owner can narrow them later.

### Which checkout a kept Service runs in

A kept process keeps running in the checkout it was started in, because its working directory and open files are there. The new Deployment **adopts** it: its run record moves to the new Deployment, and a new `source` field on the run records where the process actually runs.

Every later start of that Service starts from the Target's current plan, which means the new checkout. That covers a crash restart, a health restart, `rig restart`, `rig up` after `rig down`, and a Host restart. This is correct because "unchanged" means equivalent. It also makes the Target converge: the old checkout is needed only while the old process lives.

The old checkout is **held** while any process that runs in it is or may be alive. That is either a job run in progress (ADR 0013) or a Service whose run's `source.checkout` names it and whose process is observed running under that run's incarnation, or cannot be observed. ADR 0013's mechanism is reused and generalized:

- `releaseUnreferencedRevisions` already skips the checkouts of plans, recovery plans and running job runs. It also skips held Service checkouts.
- ADR 0013's `jobCheckouts` list becomes `heldCheckouts`. The deploy's final write records each superseded checkout it could not release. The existing 30-second sweep, which runs under the Target's lease, observes the processes and gives back every checkout nothing holds. A failed removal is retried as it is for jobs.
- One difference from jobs: a job run's end is a recorded event, while a Service ends by crash, stop or restart. The sweep therefore observes the process rather than reading a record, and an observation that fails holds the checkout.

**Disk.** A Target holds at most one checkout per distinct Deployment in which a currently running Service or job run started, plus its current checkout. For Melody that is normally two: the current checkout and the one `db` and `search` started in. That second one stays held as long as they run. `rig restart stable` (or any later restart of those two) releases it. Status shows the Commit each kept Service runs from, so the cost is visible.

### Interactions

- **`rig restart`** still restarts every Service, unchanged. It is the explicit "move everything to the current Deployment" action, and it applies env-file edits without a deploy.
- **Health restarts and crash restarts** of a kept Service stop it and start it from the current plan (`lifecycle.stop` and `recover`, as today). Its restart budgets and `healthStretch` carry over, because a kept process had no explicit start.
- **Deploy-failure rollback** stops only the Services the candidate started, then starts the previous plan with `up(previous)`, which skips the running kept Services. The previous Target record, saved before anything was stopped, still holds the kept Services' original run records. A kept Service is never stopped by a failed deploy.
- **Dashboard rollback** is an ordinary deploy of an earlier Commit, so the rule applies. Rolling back `web` keeps `db`.
- **Dependency order.** Rig stops the restart set in reverse dependency order and starts it in order. Because restarts spread to dependents, no kept Service ever depends on a stopped one. `up` already checks that a running dependency passes its start check before a dependent starts against it. So a kept `db` under a changed `api` is checked and not restarted, and a changed `db` restarts `api` and `web`.
- **Env-file changes.** A new run field holds a keyed digest of the composed environment, files included (HMAC-SHA256 with a random key rigd keeps 0600 under `<RIG_ROOT>/auth/`). The digest is written when the process starts. The deploy composes the candidate's environment, with the checkout path normalized, and compares. Env values are never recorded, and the key keeps a guessable value from being brute-forced out of `state.json`. Edits to env files still take effect only at a start: on `rig restart`, or on a deploy, which now restarts just the Services whose environment changed.
- **Ports.** Unchanged. A Target's recorded ports are reused across deploys, so a kept Service keeps its port. Changing a pinned port is a definition change, and the old process is stopped before the new one binds. A new Service's port is chosen while the kept processes still listen, as it is today while the previous plan runs during the build.
- **Previews** follow the same rule per Preview. A new Preview has nothing to keep. A Preview destroy or replacement stops everything and deletes every held checkout with the Preview's root.
- **Routes and Tools.** A kept Service's route is never withheld, because `up` withholds only Services it finds stopped. The route map and Tools are republished from the new plan as today.
- **Builds (ADR 0004).** Every build unit still runs in the new checkout, including the build of a Service that will be kept. The new Deployment is complete, and any later start of that Service uses its build.
- **Status.** A kept Service shows the Commit its process runs from, for example `db  healthy  :5433  kept from 1a2b3c4`. Status JSON and the dashboard gain the same per-Service `commit`. Deploy output adds `kept db, search` to its one line, and the deploy history record (`DeploymentRecord`) gains `kept`.

### Failure modes

- **Build fails.** Nothing has been stopped, as today.
- **The decision cannot be made for a Service** (a git diff fails, an env file cannot be read, a process cannot be observed). That Service is restarted. If restarting it then fails, the ordinary rollback follows.
- **Failure partway through activation** (a stop, a start or a start check fails). Rollback stops what the candidate started and restarts the previous plan's restart set from the previous checkout. Kept Services were never touched. The `DEPLOY_ROLLBACK_BLOCKED` and `DEPLOY_RESTORE_FAILED` paths are unchanged.
- **rigd crashes or shuts down mid-deploy.** The kept set is written into the candidate's record (with `recovery: pending`) before the first stop, so the next rigd knows which processes belong to which plan. Recovery is unchanged: the pending transition is reported, and `rig down` settles it by stopping every Service, kept ones included. Held checkouts stay until the sweep sees their processes gone.
- **A kept Service crashes later.** Restart policy starts it from the current plan, and the old checkout is released within 30 seconds.
- **Someone deletes a held checkout by hand.** The kept process may fail. Its next start uses the current checkout.
- **Host restart.** Every process is gone. The stable Target starts from its current plan, and every held checkout is released.

### Records and migration

- `ServiceRun.deployment` now means the Deployment the run belongs to, which is the adopting one for a kept Service. `currentRun`, incarnation evidence and budgets work unchanged. The new optional `ServiceRun.source = { checkout, commit, definition, environment }` is written on every start.
- A run without `source` (any run started before this change) is never kept. **The first deploy after upgrading restarts everything once**, as today, and later deploys keep.
- `jobCheckouts` becomes `heldCheckouts`. If ADR 0013 has not shipped, this folds into its state version 6. Otherwise version 7 reads `jobCheckouts` as `heldCheckouts`.
- **No default changes for existing Projects.** Without `watch`, a Service restarts whenever the tree changes, which is every deploy of a different Commit except one whose tree is identical. Those deploys are now kept, which is correct by definition. The working Target is never deployed and is unaffected.

## Alternatives rejected

- **(a) A definition hash plus an inferred diff of the files a Service uses.** Rig cannot infer them. A `command` is shell, scripts read other files, and Melody's `api` reads half the monorepo through pnpm workspaces. Inferring wrongly keeps a stale Service. Falling back to the whole checkout gains nothing unless the user declares paths. The definition hash survives, as condition 1.
- **(b) A `deploy: keep` boolean, or watch paths alone without the definition hash.** A boolean cannot tell that `db`'s script changed, so it relies on the operator remembering on every deploy. Paths without the definition hash miss config edits and env-file rotations. Watch paths survive in combination, as condition 2.
- **(c) A declaration that a Service does not use the checkout** (for example, moving its working directory outside it). It does not help `db` unless the script leaves the repository, Rig still cannot enforce it (absolute paths, `${rig.workspace}`), and it is one more concept. `watch: []` says the same thing.
- **Restarting a kept Service later from its old checkout.** That would pin stale code until `rig restart` and hold the checkout forever. Converging on the current plan is safer.
- **Releasing the old checkout while a kept process runs in it** (for `watch: []` Services). Rig cannot prove that nothing has the checkout open. Disk is cheaper than a crash.

## Open questions for the owner

1. **Adopt this rule (definition unchanged and watched files unchanged, with the whole checkout as the default)?** Recommendation: yes. It is Compose's rule with "image" read as "the checkout files the Service declares", and existing Projects behave as today until they add `watch`.
2. **What should the key be called?** `watch` follows Dokploy, which the owner is leaving, and the owner's own phrasing. `context` echoes Compose's `build.context`. Compose's `develop.watch` means live sync, which `watch` could suggest. Recommendation: `watch`, with schema docs that say it only decides what a deploy restarts.
3. **Should a restart spread to dependents?** Compose leaves dependents running unless the long-form `depends_on` sets `restart: true`. Recommendation: always restart dependents for now. In Rig `depends_on` is a start gate, Melody's `api` runs its migrations at start, and dependents are usually cheap. An opt-out can come later.
4. **Should `--force` keep nothing?** Recommendation: yes. It exists to build a fresh Deployment, and a user forcing a rebuild expects the result to run. `rig restart` remains the other "everything" action.
5. **Detect env-file content changes with a keyed digest?** Recommendation: yes. Without it, a rotated `typesense.env` key would leave `search` running on the old key through a deploy, which is a stale Service. The alternative is to document "env edits need `rig restart`", as today.
6. **Should a deploy restart a running but unhealthy Service?** Recommendation: yes. A deploy restarts it today, and an explicit start is how Rig ends an unhealthy stretch.
7. **Should the Project's shared `build` command count in every Service's definition?** Recommendation: yes. It is conservative. For Melody it means `db` restarts in the rare deploy that edits the mirror's venv build line.
8. **Project-level `environment` (Melody's `PATH`, `DATABASE_URL`, `TYPESENSE_URL`) is part of every Service's definition, so editing it restarts `db`.** Recommendation: accept this. `PATH` really does choose Postgres' binaries, and variables used by one Service can move onto that Service.
9. **Add a per-Service restart (`rig restart stable --service api`)?** It would apply an env edit to one Service, or release a held checkout, without restarting `db`. Recommendation: not in this change; open an issue if wanted.

## Implementation slices

Each slice is verifiable on its own, with tests isolated under `RIG_ROOT`:

1. Record `source` (checkout, Commit, definition digest, keyed environment digest) on every start, with no behaviour change.
2. Held checkouts: generalize `jobCheckouts`, and add the live-process reference rule and the sweep.
3. A pure keep decision, taking the previous record, the candidate plan, observations, digests and `changed` answers and returning the kept set plus the restart set with reasons. Plus `DeploymentSources.changed`.
4. `activateDeployment` stops and rolls back only the restart set and adopts kept runs.
5. The `watch` schema, docs and `rig.schema.json`, plus status, deploy output and deploy history.

On acceptance, CONTEXT.md gains **Kept Service**, and its Redeploy entry ("the Target moves to that new materialized Deployment immediately") gains: kept Services belong to the new Deployment while their processes run from an earlier checkout.
