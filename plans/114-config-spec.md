# Issue 114: consolidated configuration design

Status: **accepted design, September 17, 2026**. The user accepted Q20–Q25 and specified config role keys `working` and `stable`, with display names defaulting to `local` and `live`. The grilling frontier is closed. The design is implemented in source and passed the release gate (#245) with an isolated rehearsal; no live Host has been cut over. Three accepted settings are not runnable in this build: `services.<name>.workdir` and a per-Service `supervisor` parse but are refused at planning as `unsupported_setting`, and the Host-wide `supervisor` default has no key in the Host config (see "Not yet runnable" in the guide). See the [implementation plan](114-implementation-plan.md) and the [rollout runbook](../docs/rig-114-rollout.md).

This document is the consolidated specification for [issue 114](https://github.com/b-relay/rig/issues/114). It supersedes conflicting historical draft wording. The [interview record](114-design-interview.md) and [ADRs](../docs/adr/) preserve the accepted decisions and explicit deferrals.

## Accepted scope

- YAML-only hard cutover for Project and Host config; internal records can remain JSON.
- Services, Tools, or both; at least one entry across the two maps.
- Configurable Target names and generated Previews; independent per-Stable-Target Branch mappings are deferred.
- Settings patches remain; removing/omitting inherited Services is deferred.
- Project shared build and Service/Tool-specific builds; successful deployment builds are reused. Explicit local starts/restarts build current source; automatic restart does not build.
- Saved deployed policy drives deployed restarts; env-file contents are freshly loaded.
- Secrets never enter Rig interpolation or persisted resolved commands. Conflicting command/public-env versus file-env values are rejected without disclosing secrets.
- Durable Service exit evidence; unknown exit requires manual start even under `always`. `no` never automatically revives an exited Service, but explicit starts work.
- Dependencies gate startup only. Failed startup undoes newly started processes, not previously running processes or stored data.
- Check owned listeners for local-only binding during each activation, including automatic recovery, before reporting successful activation or exposing the activation through its route. This is not continuous containment or a guarantee that startup itself never briefly binds an unsafe address.
- Keep existing owned data locations during migration; planned downtime is acceptable, with backups and rollback.
- All recipe features in #114 ship together: generation, version notices and diff.
- Applications consume arguments, env variables and paths they define. Rig expressions exist in deployment configuration; no application requires Rig-specific APIs or conventions.

## Final decisions

| ID | Design question | Accepted decision |
|---|---|---|
| Q20 | How many Stable Targets in this release, and how are they named? | One Working copy and one Stable Target with configurable names, plus generated Previews. Use role-keyed patches below. Multiple Stable Targets and their independent Branch policies remain future work. |
| Q21 | Which input wins when several scopes/files provide the same environment name? | Public Project values, then public Service values, then Project files, then Service files. Later files win within a scope; optional target-class files follow all.env. Thus operator files beat committed defaults. Apply the approved command-conflict check to run, build and shell readiness commands, including indirect references. |
| Q22 | What exactly counts as an already-completed build? | Deployment + explicit build-unit identity. Shared build first, then Service builds in dependency order, then Tool builds in deterministic name order. Same completed deploy is a no-op; force creates a fresh Deployment/build. Never rebuild silently on startup because outputs vanished. Unknown completion requires explicit force/retry. |
| Q23 | When do known exits restart, and when does the retry counter reset? | always retries known exits; on-failure retries known unsuccessful exits/signals; no does not retry. Keep the existing bounded five attempts per rolling minute with exponential delays. Persist the budget and attempt identity; exhausted budgets and unknown outcomes need explicit start. A new Deployment or explicit stopped-Service start/restart begins a new activation. |
| Q24 | How does the YAML/state cutover treat saved deployments and old commits? | An explicit reviewed migration maps existing identities, saved plans, ports, data locations and known evidence into the new records. Do not substitute current checkout config or fabricate receipts. Reject newly deploying old-format commits with conversion guidance. Preserve old binaries/config/state for rollback. |
| Q25 | What happens to existing hooks that do more than build? | No silent deletion or automatic conversion of arbitrary hooks into builds. Classify every hook; portable application scripts/lifecycle behavior replace non-build hooks. Block affected migration until its replacement is reviewed. Do not add a permanent legacy-hook compatibility system. |

The sections below define the accepted contracts. Detailed mechanics that realize these choices belong in implementation tickets and interface reviews.

## Q20: Target declaration and selection

Compare two shapes:

| Shape | Benefit | Cost |
|---|---|---|
| Named map: targets.dev.kind: working | Config keys equal displayed Target names | Requires a kind discriminator/cardinality validation and suggests arbitrary Target counts that are not in this release |
| Role-keyed patches with name metadata | One Working copy, one Stable Target and one Preview template are visible; changing a name does not move the patch | Must distinguish fixed role keys from user-facing names |

The selected shape is role-keyed. Omitted roles use defaults; the Preview entry is a template, not one named Target.

```yaml
production_branch: main
targets:
  working:
    name: dev
    services:
      api:
        env: {LOG_LEVEL: debug}
  stable:
    name: production
    services:
      api:
        env: {LOG_LEVEL: info}
  preview:
    domain: ${rig.target}.preview.example.com
```

- Defaults: Working copy name `local`, Stable name `live`. Production branch resolution preserves the existing chain: Project `production_branch`, then Host `deploy.productionBranch`, then `main`.
- The fixed config keys `working`, `stable`, `preview` denote roles. `name` is metadata for working/stable, excluded from the merged Project `name`. Preview names remain generated from Branch identity using the existing collision-safe naming policy.
- `rig up dev` selects the Working copy. `rig deploy production` selects the Stable Target. `rig deploy preview <branch>` retains explicit Preview selection.
- Pushes of the Production branch deploy the one configured Stable Target; other pushed branches create/update Previews. Renaming a Target does not change this Branch rule.
- Names are unique, validated, and cannot use the reserved Preview selector. Match state by stable identity, not by a renamed label. A proposed name change that cannot be mapped unambiguously requires an explicit migration; never silently create a second data root.
- Settings patches merge maps and replace lists/scalars. They can override existing Service/Tool settings, env, env_file, supervisor, domain, proxy and shared build. They cannot change Project identity, Production branch, Target role, the set of Services/Tools, or recursively contain targets. Null is not a Service deletion operator.
- Validate the final patched model, including references, dependency cycles and pinned port conflicts. Unknown keys fail with a field path.
- The Stable Target owns the unsuffixed Tool name. Local and Preview Tools receive `<tool>-<actual-target-name>`. Default Stable hostname remains the Project domain, independent of the chosen Target name; Preview hostname defaults to `<generated-name>.<project-domain>`; local has no hostname unless patched.

## Top-level and entry fields

| Field | Meaning |
|---|---|
| name | Required Project identity; existing identity rules continue |
| description | Optional human Project description |
| production_branch | Project-wide source Branch for the Stable Target; if omitted use Host deploy.productionBranch, then main |
| domain | Optional Stable hostname; other role defaults derive as above |
| supervisor | Host default, overridden by Project and then Service; rigd or launchd |
| build | Optional shared shell build command; runs once before per-entry builds |
| build_timeout | Shared/default build duration budget; default 10m, overridden per Service/Tool build |
| env / env_file | Public input map / explicit env-file path or ordered path list |
| services / tools | Maps of named entries; either may be absent/empty, but not both |
| proxy | Optional path-prefix to declared port reference map |
| targets | Role-keyed metadata and settings patches described above |

Service fields: `run` (required foreground shell command), optional `build` and `build_timeout`, `ports` (named auto/pinned ports), `ready` (HTTP URL or shell command), `ready_timeout` (default 30s), `depends_on` (Service names), `restart` (always/on-failure/no; default always), `supervisor`, `workdir` (workspace by default), `env` and `env_file`.

Tool fields: optional `build` and `build_timeout`, required `bin` executable path. A Tool build uses the Project build environment and workspace. Service-specific environment/data references cannot be used in a Project or Tool build. Build budgets are positive finite durations; timeout terminates the owned build process/group conservatively and records failure/cleanup uncertainty rather than completion. Explicit old install/build budgets map to the corresponding new build_timeout; a hook budget is mapped only after the hook's semantics are classified. Do not discard an override because an example omits it.

Examples describe application interfaces assumed for illustration; these sample application programs are not included in Rig. See [single Service](examples/114-service.rig.yaml), [Tool-only](examples/114-tool.rig.yaml), and [multiple Services and a Tool](examples/114-multi.rig.yaml).

## Q21: Values, environment and command evaluation

Evaluation order:

1. Read one YAML Project document from the selected source: Working copy for local, prepared Commit for a deployed Target. Validate YAML/schema and Target metadata.
2. Apply the chosen role patch; validate the resulting graph. Preserve the selected role/name separately from merged Project identity.
3. Reuse/allocate named ports and determine recorded workspace/data paths and hostname. This produces public Rig-generated values, not environment-file secrets.
4. Resolve public config references recursively; reject missing paths, collections where a scalar is needed, references into targets, invalid context and cycles. Retain provenance for indirect references used in commands.
5. At the relevant build/start/check invocation, load only its applicable environment files; compose the final process environment in the order below. Check public command-reference conflicts before executing.
6. Run ordinary commands with explicit cwd/env and bounded execution where appropriate. Persist public resolved plans and file references, not file contents/secrets.

Environment precedence, lowest to highest:

| Order | Source |
|---|---|
| 1 | Public Project env |
| 2 | Public Service env, for Service invocations |
| 3 | Explicit Project env_file files, in listed order |
| 4 | Optional `~/.rig/env/<project>/all.env`, then `<working|stable|preview>.env` |
| 5 | Explicit Service env_file files, in listed order |
| 6 | Optional `~/.rig/env/<project>/<service>/all.env`, then `<working|stable|preview>.env` |

The file names use Target role, not a configurable display name. Migration must preserve existing secret sources through explicit references or reviewed file mapping; do not silently drop old `local.env` or `live.env` sources when adopting `working.env` and `stable.env`. The default CLI names remain local/live; they are not the env-file role names. Services never implicitly read sibling Service files. Listed files are required; convention files are optional. Files inside the repository must be ignored by Git. Keep permissions warnings and safe diagnostics from the original proposal.

This deliberately resolves the original draft's contradiction between “Service wins” and “a machine file beats committed values”: committed Service defaults do not override operator file values. Beneath the six layers is a controlled execution baseline: the operator's configured executable PATH, operator HOME, owned temporary TMPDIR, and LANG/LC_ALL/LC_CTYPE/TZ when supplied by the execution adapter. No other daemon-environment entries are implicitly copied. Explicit env/files may override baseline values. The adapter receives this baseline as an explicit capability input; pure config resolution does not read process.env. Migration inventories needed ambient setting names and requires explicit application mappings for anything outside this list, without recording secret values.

The approved conflict guard is applied to public env leaves referenced directly or transitively by `run`, `build`, or shell `ready` commands. If a file supplies a different final value for the corresponding environment name in that invocation, fail with the key and competing sources, never the values. Equal values are not a conflict. Merely coincidental identical strings are not provenance. Changes to fresh files are rechecked on restart; they do not invalidate a completed build and silently rerun it.

Public references may appear in commands, readiness URLs, env values, workdir, env_file paths and proxy values. `${rig.target}` is the sole hostname substitution exception. No interpolation in map keys, Project name or port declarations. Relative paths resolve against the relevant workspace; `~` in env_file paths resolves to the configured operator home. Host-dependent reads remain adapter capabilities, not hidden inputs to pure resolution.

Rig quotes command substitutions as literal data using the existing context-aware command interpolation policy; it does not reinterpret substituted strings as shell code. Ordinary `$VARIABLE` is shell syntax and is not a Rig reference. `$${VARIABLE}` escapes a braced shell reference past Rig as literal `${VARIABLE}`. Environment-file contents are plain env data, not shell scripts or recursively interpolated Rig config. An application receiving env data can still disclose it itself; Rig does not promise universal output redaction.

### Rig-generated values

| Value | Meaning |
|---|---|
| rig.target | Actual configured or generated Target name |
| rig.workspace | Selected Working copy or deployed revision workspace |
| rig.data | Recorded persistent directory for this Service in this Target; invalid in Project/Tool context |
| rig.host | Effective hostname when a hostname and proxy exist; otherwise empty |
| rig.url | Effective HTTPS proxy URL; without a hostname but with a root proxy mapping, the local URL of that root port; with no proxy, empty |

`rig.data` is not a required physical directory convention for applications. Retain existing valid data locations; newly created Service directories remain under Rig-owned Target storage. Applications receive those values only through explicit mappings such as `DATA_DIR: ${rig.data}` or a declared command argument.

## Q22: Build reuse and failure handling

Build units are the optional shared Project command plus each declared Service/Tool build. Do not infer sharing from command equality.

- A deployed build completion belongs to the immutable Deployment identity and build-unit identity. Its public policy/source provenance is recorded. No cross-Deployment or cross-Target cache is implied.
- Order: shared build; Service builds in dependency order; Tool builds in name order. This is preparation, not Service startup. A build must not implicitly start a database to satisfy `depends_on`; application scripts must make build-time needs explicit.
- Deploy, including `--no-up`, finishes preparation before claiming a prepared Deployment. Ordinary up/restart never builds a deployed Target.
- Same completed Branch/Commit deployment remains unchanged unless forced. Failed/incomplete attempts must report their phase and must not masquerade as a completed no-op.
- Record started/succeeded/failed-or-unknown build state durably. Previously completed units in the same retained Deployment can be reused; a new forced Deployment has its own build records. Do not claim exactly-once arbitrary shell side effects.
- Missing trustworthy completion evidence means manual retry. Use an explicit forced deployment as the conservative recovery path; show that action in the failure hint. No automatic daemon recovery reruns an unknown build.
- Check Tool bin paths and owned installed-artifact evidence Rig actually knows. Arbitrary managed shell commands do not declare all their output files, so do not claim comprehensive artifact verification. Missing Service executables report a normal startup failure and rebuilding guidance; no silent rebuild.
- Local is not an immutable Deployment. Explicit local up prepares missing Services and all local Tools; local restart prepares/cycles Services and prepares Tools. Run the shared build once if any selected build unit needs it, then only the selected entry builds once for that invocation. A Tool-only Project therefore rebuilds its declared local builds on each explicit up/restart, using current source; a Tool without a build may simply verify/publish its existing executable. An unchanged, already-running Service-only up has nothing to build. Automatic restarts reuse prepared local artifacts. Changed local policy uses current Working copy behavior and must not produce an unreported mixed-policy Target.

Example: a Deployment builds API and web, then web startup fails. Retrying activation of the retained prepared Deployment uses its completed builds; forcing a replacement creates a new Deployment and builds again.

## Q23: Runtime outcomes, readiness and activation

Persist evidence per Deployment/Service/process incarnation. A Target-wide desired flag is insufficient: one exited `restart: no` Service must not stop healthy siblings or be revived by reconciliation. A record describes intent, known observations and their identity; absence of a record is not proof of a successful exit, failed exit or operator stop.

| Observation | always | on-failure | no |
|---|---|---|---|
| Known successful exit | Retry within budget | Remain exited | Remain exited |
| Known failure/non-operator signal | Retry within budget | Retry within budget | Remain exited |
| Unknown terminal outcome | Require explicit start | Require explicit start | Require explicit start |
| Explicit stopped intent | Stay stopped | Stay stopped | Stay stopped |
| Verified surviving process | Adopt without duplicate launch | Adopt without duplicate launch | Adopt without duplicate launch |

Keep five automatic attempts per rolling 60 seconds, with delays starting at 100ms and doubling. A budget exhausted for that activation stays exhausted across daemon restarts; another explicit start/restart of the stopped Service or a new Deployment begins a new activation. A repeated up that leaves an existing running Service unchanged must not reset its budget. Deliberate stops cancel pending retries, and late callbacks cannot revive an old incarnation.

Validate prerequisites, prepare if required, start, check readiness, inspect owned listeners, then publish the ready route/outcome. Both supervisors must satisfy the same contract; implementing automatic restart purely inside an adapter without coordinating readiness/routing is insufficient. Existing routes must not make an unverified replacement activation publicly available during this sequence.

- Explicit `ready` wins, even for a Service with no declared ports. Otherwise require successful connections on every declared port. With neither ready nor ports, require verified process liveness; report running, not health-checked.
- `depends_on` means wait for a running/ready prerequisite on startup, including verifying an already-running prerequisite. A successfully exited `restart: no` Service is not a completed-job dependency; a general job workflow remains out of scope.
- If a prerequisite later fails, apply its own policy; do not cascade restarts to dependents.
- Undo newly started processes after a failed explicit startup attempt, preserve previously running processes and persistent data, and report any incomplete cleanup honestly. Replacement deployment recovery must retain the existing recovery/ownership safeguards rather than pretending database writes can be rolled back.

## Ports, routing and listener evidence

Keep named ports, explicit auto values, stable reuse until Target destruction, and pinned ports only for local/Stable roles. Conflicts fail with the owning Target. A free-port selection is not a reservation against arbitrary outside processes; report bind/readiness failure honestly.

Proxy values identify declared ports. Keep path-prefix semantics at a slash boundary, longest prefix first, unchanged upstream path, no wildcard keys, and require `/` when proxy is present. One effective hostname per Target; DNS/certificates remain operator concerns. Tools-only/headless Projects need no domain or proxy.

Listener inspection concerns freshly identified owned processes and their managed descendants. Permit loopback, including valid IPv6 loopback; reject externally bound listeners and fail on indeterminate ownership/inspection rather than reporting safe activation. Apply this on automatic recovery as well as explicit starts. A new observer interface must hide concrete OS inspection tools from orchestration.

The check proves what was observed at activation, not all future behavior, and cannot prevent a process from briefly listening while startup validation runs. Static known-bind-address validation remains useful, but do not equate an arbitrary occurrence of address text in a shell command with proof of a listener. A blanket substring ban would also reject innocent strings; the actual binding check supplies the runtime evidence.

## Q24–Q25: Hard cutover and existing deployments

Migration is explicit and reviewable; the normal runtime does not indefinitely read old Project/Host formats.

1. Inventory Project/Host documents, deployed snapshots, old hooks, explicit timeouts, provider selections, env-file references, ownership, process identities, ports, routes, installed Tools, recovery records and data paths. Read configs from the correct saved revision. Never copy secret values into the migration report.
2. Produce a conversion manifest and candidate YAML/new-version runtime records. Compare old/new commands, inputs, routes, names and paths. Preserve immutable identities and existing storage ownership. Do not substitute current checkout policy for a deployed snapshot.
3. Classify hooks individually: actual compilation can become build; repeatable initialization can live in a portable startup script; shutdown work needs application signal handling or an explicitly reviewed portable wrapper. Do not silently discard post-stop cleanup, merge commands with different execution frequency, or fabricate an equivalent replacement.
4. Block affected conversion for unmapped hooks/timeouts/provider behavior, ambiguous ownership, unresolved recovery or missing evidence. Fix the documented mapping rather than weakening the new runtime reader. Preserve useful verified old installation evidence where a strict mapping exists; never invent build success or terminal exit evidence.
5. Rehearse the conversion under an isolated root with copied metadata and disposable data fixtures. Audit backup completeness without exposing secrets. An isolated rehearsal must never connect to live daemon sockets or mutate live jobs/routes.
6. During the approved maintenance window, use the old runtime to stop affected Targets with their old cleanup policy, stop/drain the old daemon, take exact restorable backups, then apply the reviewed migration and install the new daemon. A runtime-wide schema change requires coordinating the affected Targets, not running old/new daemons against the same state.
7. Start only the Targets selected for activation in the manifest; retain stopped intent and require explicit handling for unknown outcomes. Verify routes, owned listeners, Tool aliases, logs, data paths and repeated down/destroy behavior. Record exactly what was and was not verified.
8. Roll back Rig binaries/config/state from the tested backup if required; do not erase application data as part of format rollback. Any application-level data migrations need their own reviewed reversal policy.

New deployments of historical commits containing only `rig.json` or the old schema fail with an actionable conversion message. They do not silently use checkout YAML. Existing deployed code can remain at its original Commit if its saved plan has a fully reviewed conversion; changed application scripts require an explicit new source revision. A mismatch blocks that Target's cutover rather than implicitly editing its immutable source.

Keep recipes as ordinary copied configuration. Generated metadata identifies recipe/name/version for comparison only; Rig never secretly replaces a customized block. Recipe update notices and diffs compare against bundled versions, report unrecognizable/customized provenance honestly, and do not rewrite user config or introduce an automatic network dependency.

## Acceptance and planned implementation slices

The [implementation plan](114-implementation-plan.md) expands these responsibilities into complete behavior slices and tracks their GitHub dependencies.

1. YAML-only Project/Host documents plus an end-to-end config inspection path for the three examples; documented fields, strict invalid-key errors, role names, patches, source revision selection and no deletion feature.
2. Pure public resolution with explicit inputs plus env-file execution composition: named ports, scoped paths, cycle/escape/quoting rules, transitive conflicts and safe provenance output.
3. One Service and one Tool through deploy/build/--no-up/up/restart: durable shared/per-entry build records, reuse, explicit unknown-build recovery and local build behavior.
4. Per-Service restart evidence and retry policy through both supervisors, including daemon restart, unknown exit, repeated down and cancellation of late callbacks.
5. Dependency readiness, multi-port inspection and route publication for initial/automatic activation, including rollback of only newly started processes.
6. Recipe generation/version/diff and complete help/documentation; application portability examples runnable with equivalent manually supplied inputs.
7. Explicit old-state/config conversion and rehearsal, verified ownership/data preservation, old-hook review, and rollback evidence; then the separately concrete live cutover procedure.

Each slice starts with a failing public-behavior regression, uses isolated RIG_ROOT, applies function-design to changed functions, compares materially different shapes before changing major provider interfaces, and receives the required independent reviews. Preserve the honesty-tree fixes and existing recovery safeguards. Final validation includes focused tests, full suite, strict typecheck, builds, CLI help and migration rehearsal; syntax-parsing examples alone is not evidence that the new runtime works.

## Decision coverage

All design branches have an accepted rule or an explicit deferral. Q20 fixes one Working copy/one Stable Target plus Previews; Q21 fixes value composition; Q22 fixes build behavior; Q23 fixes activation/retry behavior; Q24 fixes saved-state/old-Commit conversion; Q25 fixes hook replacement. Config role keys are working/stable/preview; default display names are local/live, with generated Preview names. No product question remains pending from this grilling session.
