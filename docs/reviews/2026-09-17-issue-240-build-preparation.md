# Issue #240 run notes — durable build preparation

Branch `feat/issue-240-build-preparation`, for the #114 integration branch
`feat/issue-114-config-cutover`. Nothing here was installed or run against a
live daemon; every test uses an isolated `RIG_ROOT`.

## What changed

- `src/config/types.ts`, `src/config/resolve.ts`: a plan carries
  `builds: BuildUnit[]` (`{id, component?, command, timeout, commandInputs?}`):
  the shared unit `shared`, then `service:<name>` in dependency order, then
  `tool:<name>` by name. Units are never merged by command text. The shared and
  Service `build` settings are no longer `unsupported_setting`. `build` and
  `buildTimeout` left `InstalledComponent`, so a build has one owner.
  `build_timeout` resolves as the unit's own, else the top-level one, else 10m.
- `src/runtime/lifecycle.ts`: `TargetEffects.build(unit, target)` is new and
  `effects.install` only publishes. `TargetLifecycle.prepare` takes the unit
  selection and a journal: it installs dependencies and brackets every command
  with `journal.started` / `journal.finished`. `up` calls `assertPrepared` for
  deployed Targets and never builds, so reconcile never builds either.
- `src/runtime/preparation.ts` (new): `prepareTarget` owns the durable journal.
  Outcomes live on `TargetRecord.preparation {deployment, units}` keyed by
  workspace path (the Deployment) and unit id, each with
  `{state, policy, commit?, startedAt, finishedAt?}`. `policy` is a digest of
  the unit's command, budget, public env, env-file _paths_ and workspace;
  env-file values never enter it.
- `src/runtime/deploy.ts`: every deploy, `--no-up` included, prepares the
  candidate before the previous Deployment is stopped; a failed build does not
  bounce the running Deployment (`transitioned`). Recovery restores the
  previous Deployment's preparation with its plan.
- `src/runtime/application.ts`: a plain deploy of the recorded Commit/Branch is
  refused while a unit's outcome is unknown. Working copy `up` prepares
  `"stopped"` work, `restart` prepares `"all"`. A planned Working copy whose
  `rig.yaml` revision changed gets a drift warning naming `rig restart`.
  Replanning the Working copy retires executables only the old plan named.
- `src/adapters/target-effects.ts`: Tool alias is `<tool>` on the Stable Target
  and `<tool>-<target name>` elsewhere (the Working copy default moved from
  `-dev` to `-local`).

## Decisions

- **Unknown is a read-time fact.** A unit recorded `started` and never finished
  is unknown to every later operation; no code path rewrites it. `up`,
  `restart` and a plain same-source deploy reject `BUILD_UNKNOWN`; a failed or
  missing unit rejects `PREPARATION_INCOMPLETE`. Both hints name
  `rig deploy <target> --force`. A forced deploy (or a new Commit) is planned
  into a new workspace, which is a fresh scope by construction.
- **Uncertainty outlives a rollback.** When a replacement attempt is rolled
  back (in the operation, or by `down` after a crash), the restored record
  keeps `uncertainBuild {branch, commit, unit}`. A plain deploy of that source
  is refused as `BUILD_UNKNOWN`; force, another Commit, or any completed
  deployment clears it, since a completed record is planned fresh.
- **A failed preparation changes nothing.** Candidate and previous share
  process keys, so rollback stops and restarts processes only once the
  transition began (`transitioned`); before that it only rolls the checkpoint
  back and re-saves the previous record.
- **Working copy replan is one transaction.** Retiring superseded executables
  and saving the new plan happen under one effect checkpoint, rolled back when
  either fails.
- **A success that cannot be recorded is `BUILD_UNKNOWN`** with the store
  failure as its cause. A failed build whose `failed` record also cannot be
  written keeps both causes (`retainFailureCauses`).
- **`--no-up` publishes no Tool.** Publication stays in `up` under its own
  checkpoint, which keeps the existing guarantee that `--no-up` cannot certify
  the old installed binary as the new source's. Builds are done; the later
  `up` only publishes and starts.
- **Working copy selection.** `up` runs the units of Services that are not
  running plus every Tool's unit, shared first when any such work exists, and
  nothing when every Service runs and there is no Tool. Working copy outcomes
  are journaled too but never gate `up`: explicit commands rebuild current
  source.
- **Missing outputs.** Rig does not verify arbitrary Service build outputs. A
  vanished output is an ordinary start failure; the guide names
  `deploy --force`. Tool executables keep the existing artifact evidence.
- **State version stays 3**, consistent with #239; `preparation`,
  `configRevision` and `plan.builds` are optional additions. #244 owns
  migration.
- Service `workdir` stays unsupported; not this ticket.

## Function-design ledger (findings only)

- `TargetLifecycle.prepare`: outside effects are the shell commands and the
  journal. The journal is a passed provider because the caller (the runtime
  command) owns persistence; its failures are part of the contract above.
- `prepareTarget`: mutates the passed record in place (stated), and reverts the
  in-memory unit when the store refuses, so memory never claims more than disk.
- `effects.install` lost a hidden effect (running a build); `installationPolicyKey`
  no longer includes `build`.
- `assertBuildsKnown` is exported for the one caller outside the lifecycle
  (the same-source deploy check); `assertPrepared` stays private.
- Inherited debt, not touched: `application.ts` command body length.

## Evidence

- First regression, `tests/build-preparation-e2e.test.ts`: failed with deploy
  exit 1 (`unsupported_setting` on the shared build), then passed: `--no-up`
  runs `shared, service:web, tool:counted` once with the Target stopped; `up`
  and `restart` add only `run:web`; a second deploy is `unchanged`; `--force`
  runs all three units again.
- Same file, second test: a real `git push rig main` deploys the Stable Target
  named `prod` with the plain `counted` command; a broken uncommitted checkout
  config does not affect `restart prod`; a rotated env-file value reaches the
  restarted Service with no build; `up devbox` publishes `counted-devbox`; a
  changed `rig.yaml` yields the drift warning and `restart devbox` clears it.
- `tests/build-preparation.test.ts` (real effects, fake supervisor, failing
  store): dependency-graph `--no-up` order with nothing running and no route;
  failed build leaves the running previous Deployment untouched and retains
  succeeded units; timeout; unrecordable success is unknown, is not rerun, and
  only a new workspace clears it; recovery restores the previous preparation;
  Working copy selection; policy digest excludes env-file values.
- `tests/runtime-application.test.ts`: plain same-source deploy refused as
  `BUILD_UNKNOWN`, force deploys a fresh scope.
- `tests/config.test.ts`: unit order, timeouts, quoting, per-role plans.
- `tests/target-effects.test.ts`: `build` failure/timeout details, publish-only
  `install`, alias naming.

## Handoff

- #241: consume `preparation.units[*].state` (`started` = unknown) rather than
  assuming success; `up` already refuses. Supervisor env persistence remains
  yours.
- #242: multi-Service build _ordering_ is done here; activation ordering,
  routes and listeners are yours. `prepare` starts no Service.
- #244: migrated plans carry no `builds` and no `preparation`; deployed records
  were already built, so `assertPrepared` passes them. Migration still emits
  `envFile`.

## Review (Codex, gpt-6-astra high)

Round 1 required three changes, all made: unknown-build evidence was lost when
a replacement rolled back; a failed preparation stopped and restarted the
previous Deployment through the shared process keys; the Working copy replan
retired executables outside a checkpoint. Tests now assert zero supervisor
transitions on a failed preparation, the retained `uncertainBuild`, and the
replan rollback.
