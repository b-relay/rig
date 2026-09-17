# Issue #238 run notes — YAML-only config and configurable Target names

Branch `feat/issue-238-yaml-config`, merged into the #114 integration branch
`feat/issue-114-config-cutover`. Nothing here was installed or run against a
live daemon; every test uses an isolated `RIG_ROOT`.

## What changed

- `src/config/schema.ts` is the accepted #114 schema: `services` and/or
  `tools` (at least one entry across both), role keys `working`/`stable`/
  `preview` under `targets`, default names `local`/`live`, settings patches
  (maps merge, lists and scalars replace), `production_branch`, durations.
  Old-schema documents are refused as `legacy_config` naming the old keys.
- `src/config/documents.ts` is YAML-only. `rig.json` and Host `config.json`
  are refused as `legacy_format` and never read, alone or beside the YAML
  file. `rig init` with nothing to scaffold is refused as `empty_project`
  before Git or the filesystem is touched.
- `src/config/resolve.ts` is a bridge: the new schema resolves to the existing
  `TargetPlan`, so machine-owned state and every effect module are unchanged.
  Settings the current runtime cannot run are refused as `unsupported_setting`
  naming the path (list below) rather than dropped.
- Selection: the protocol `target` is a free string. `selectTarget`
  (`src/runtime/targets.ts`) maps it to a kind by the configured names, then
  by recorded names; `preview` is reserved. A Working copy or Stable Target
  is found by kind, so a rename keeps its id, data root, log root and ports.
  `status` uses the same rule. Errors: `TARGET_UNKNOWN`, `PREVIEW_NAME`,
  `TARGET_NAME`.
- CLI: one `rig deploy <target> [branch]`; init scaffolds with `--service
  --run --port --ready` and `--tool --bin --tool-build`. The Production
  confirmation follows the Stable Target's configured name.
- The repository's own `rig.json` became `rig.yaml` (three Tools).

## First regression

`tests/config-yaml-cutover-e2e.test.ts`: through the CLI and the authenticated
config HTTP boundary under an isolated root, initialize the single-Service
example, read it, preview a name and settings edit, apply it, and reject the
stale revision; asserts replies, exact document bytes, backup bytes, and no
write on refusal.

- Red (before the schema existed): `rig init --create-git` over the example
  exited 1 with `Invalid Project configuration. ... Fix components: must be a
  record; config: has no field named "production_branch", "services",
  "proxy", "targets".` — the old schema refusing the new document, the
  expected reason.
- Green: 1 pass, 14 expects.

One expectation accommodates a pre-existing editor behaviour: the YAML editor
re-emits an inline flow map `{http: auto}` as `{ http: auto }`. Also observed,
not changed: an edit moves a trailing comment on a bare mapping key
(`services: # note`) to the next line. Both keep the comment and the order;
neither is byte-exact for those two shapes.

## Function-design ledgers (findings only)

- `selectTarget(command, configured, recorded)`: plain path. Inputs are the
  selector, the configured names (absent when the config cannot be read) and
  the recorded kind/name pairs; result `{kind, name?}`. Three negative
  outcomes stay distinct because callers act on each: `TARGET_UNKNOWN` (the
  application swaps in the config failure when that is why the name is
  unknown), `PREVIEW_NAME` (new Previews only; a Preview recorded before the
  name was taken stays selectable so the `TARGET_NAME` hint's way through
  works), `TARGET_NAME` (raised in `planTarget`, where the planned config's
  name is known).
- `planTarget`: `kind` is now an input; the non-Preview name is an output of
  the config being planned (the committed config for a deploy), so a caller
  cannot pass a name that disagrees with the plan.
- `configuredNames` (application.ts) is the adapter that turns "read the
  checkout config" into `{names?, failure?}`; it owns the rule that an
  unreadable config never blocks stopping or inspecting a recorded Target.
- `projectStatus`: the config is read before selection so `status <name>`
  shares `selectTarget`; the warning order (ownership, then config) is kept.
- `scaffoldProjectConfig` is pure and runs before `ensureProjectGit`, so an
  invalid scaffold has no effects.
- `resolveTargetPlan`: a Preview resolved without `deploymentName` slugs its
  Branch. Every runtime caller passes the name; the default only keeps the
  function total for direct callers.
- `issuesError`: a custom issue message's final period is dropped before the
  hint adds its own.
- Inherited debt, not changed: `TargetPlan`/`PlanComponent` still declare
  `hooks`, `hookTimeout`, `installTimeout`, persistent/prepared component
  kinds, `sitePort` and `installName`; `branchSlug` and `subdomain` are copies
  of `deploymentName`. Effect modules still read them. #240–#242 replace the
  plan shape.

## Review findings from the test port that changed production code

1. `~` in `env_file` resolved under the workspace; now `unsupported_setting`
   until #239 owns env files.
2. A Preview without `deploymentName` used the raw Branch as a hostname
   label; now slugged.
3. An env key `__proto__` was dropped silently; now refused by name.
4. Every custom-issue hint ended in `..`.
5. A Preview whose name a later rename took could not be selected, so the
   `TARGET_NAME` hint ("destroy that Preview first") could not be followed.
6. `status <name>` matched recorded names only and returned an empty report
   for an unknown name; it now shares `selectTarget`.
7. A deploy refused for a Commit's legacy config named files inside rigd's
   revision checkout; the refusal now says the Commit carries retired
   configuration and that the way through is a new Commit.

## Independent review (Codex, gpt-6-astra, high effort, read-only)

Round 1 raised four findings, all fixed:

1. A swap-style rename (`working: dev`, `stable: local` while the Working
   copy is still recorded as `local`) let `rig down local` stop the Stable
   Target. `selectTarget` now rejects `TARGET_AMBIGUOUS`, and `planTarget`
   refuses any name another Target of the Project still holds.
2. `rig deploy <recorded Stable name>` skipped the Production confirmation,
   because the CLI compared against the configured name only. The
   `deployment-context` reply now carries `selected`, the role rigd's own
   selection rule gives the selector.
3. `up`/`restart` selected the Working copy from one read of the config and
   planned it from another. `checkoutConfig` reads once per action and the
   same document is planned.
4. `help` was a legal Target name that `rig deploy help` could never reach;
   it is now reserved in the schema.

## Remaining integration dependencies

- `unsupported_setting` until the owning ticket lands: shared and Service
  `build`, `workdir`, `restart` other than `always` (#240/#241); a Service
  supervisor that differs from the Project's (#241); zero or several ports on
  one Service, proxy prefixes other than `/` (#242); a list of env files and
  `~` env files (#239).
- References: only `${services.<s>.ports.<p>}` and `${rig.target|workspace|
  data|host|url}`; recursive and cross-value references are #239.
- The Host supervisor default is not in Host config yet; the bridge defaults
  to `rigd` (#241).
- The installed-Tool alias suffix is still `-dev` / `-<preview name>`
  (`src/runtime/target-effects.ts`); #240 moves it to Target names.
- `src/migration` still emits the old plan shape and a `rig.json`
  `configPath`; every current-config read failure is one warning
  (`invalid_current_config`). #244 owns migration.
- Env composition is unchanged and differs from the spec (#239): inline `env`
  beats env-file values, a Service `env_file` replaces the Project's instead
  of layering, the `~/.rig/env/<project>` convention files are not read, and
  the `$${VAR}` escape is not implemented.
- `plans/examples/114-multi.rig.yaml` parses and inspects but is not runnable
  by the bridge (`${services.db.env.PGHOST}`, builds, `~` env file, `/api`
  prefix). The example headers still say "not implemented yet"; #245 updates
  them.
- Effect-module hints still name retired fields (`installTimeout`,
  `hookTimeout`, `buildTimeout`, `installName`, `providers.processSupervisor`)
  in `src/adapters/target-effects.ts`, `artifact-ownership.ts` and
  `effect-transactions.ts`; they go with the plan-shape change in #240/#241.
- A bare `rig init` in a repository without `rig.yaml` is refused as
  `empty_project`; an interactive prompt for a first Service or Tool was not
  added.
- Pre-existing, not changed: a deploy refused while reading the Commit's
  config (legacy, invalid, or another Project's) leaves its prepared
  `revisions/<id>` checkout on disk with no Target recorded; ports are
  selected before the plan resolves, so an occupied pinned port is reported
  before an `unsupported_setting`; `plan.daemon.keepAlive` has no config
  surface (#241 owns restart).
- Recipes (#243) replace the removed `uses` plugins.

## Validation

- `bun test`: 687 pass, 0 fail across 71 files (one earlier sweep saw the
  known timing flake in `providers-process-timing.test.ts`; it passed on
  rerun and in the final run).
- `bun run typecheck`: clean. `bun run build`: clean.
- Public demo (`tests/config-examples-e2e.test.ts`, isolated root, no
  application processes): the Tool-only example initializes with bytes
  unchanged and reports `local`/`live` with no route; the multi example
  reports `dev`/`production`, `rig down live` is refused naming `dev,
  production or preview`; `rig.json`, old-schema YAML, malformed YAML and a
  Host `config.json` are refused without a write; the Host Production branch
  applies when the Project sets none; a Commit with legacy config is refused
  while the checkout's YAML is valid, and no Stable Target is recorded.
