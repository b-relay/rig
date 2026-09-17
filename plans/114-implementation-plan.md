# Issue 114 implementation plan

Status: accepted product design; implementation queue prepared September 17, 2026. The [specification](114-config-spec.md) and [interview record](114-design-interview.md) are authoritative. No runtime changes or live migration are completed by this plan.

## Scope and delivery

Deliver the entire agreed #114 release, including recipe generation/version/diff, as one hard cutover. User-authored Project/Host config is YAML-only. Config roles are `working`, `stable`, `preview`; default display names are `local`, `live`, and generated Preview names. One Working copy and one Stable Target are supported, with configurable names. Multiple Stable Targets/independent Branch mappings and Service removal through patches remain deferred.

Implement in an isolated checkout/integration branch while the runtime contract is changing. Do not publish a half-converted runtime as a usable release, install it on the live Host, or introduce an indefinite dual-format compatibility reader. Child slices each demonstrate a complete behavior under isolated RIG_ROOT; after the final gate, publish the complete tested change to origin/main using the repository workflow. Draft/temporary branches do not change the existing live deploy remote.

Runtime interface changes must compare at least two materially different shapes and choose a small explicit contract. Put function-design ledgers, partial-progress/failure ownership and review evidence in run notes. Do not add a universal dependency bag or scatter those ledgers into application code. Existing recovery, ownership, safe-error, cancellation and bounded-observation safeguards are acceptance conditions, not cleanup candidates.

## Ticket graph

Ticket numbers below are local plan IDs until GitHub publication. Replace them with links on publication; native blocking edges are authoritative.

| ID | Complete behavior | Blocked by |
|---|---|---|
| T1 | Initialize and inspect strict YAML-only Project/Host config with working/stable roles and configurable Target names | None |
| T2 | Resolve a selected Target's public inputs, ports and process environment with safe provenance and conflict errors | T1 |
| T3 | Deploy/build/prepare/start a Service and install a Tool with durable build completion and no-up reuse | T2 |
| T4 | Enforce durable per-Service restart policy across exits, explicit commands and daemon recovery under both supervisors | T3 |
| T5 | Activate a dependency graph only after readiness and owned local-listener checks, then publish correct routes | T4 |
| T6 | Generate portable recipes and report/diff bundled recipe updates without rewriting user configuration | T2 |
| T7 | Convert old config/saved deployments using a reviewed manifest and rehearse data-preserving recovery | T5 |
| T8 | Pass the full-release behavior matrix and deliver an executable cutover/rollback runbook | T6, T7 |

```text
T1 -> T2 -> T3 -> T4 -> T5 -> T7 -> T8
       \-> T6 --------------------/
```

T6 can proceed independently of the runtime work once resolved-config contracts exist. T7 does not depend on recipe version tooling; T8 joins both paths. No ticket is blocked merely because another may touch nearby files. Coordinate overlapping edits in isolated worktrees; do not weaken genuine sequencing of runtime-plan and state contracts.

## Public acceptance demonstrations

1. Fresh isolated Project initialization writes rig.yaml; config read/edit shows working/stable roles, default local/live names and a renamed pair. Old Project/Host JSON is rejected without touching files. The three accepted examples parse and inspect; tool-only and headless Projects need no dummy Service/domain.
2. A selected Target resolves named ports and explicit ordinary application inputs. A controlled env-file conflict yields a safe nonzero result and names sources without values. Public substitutions, shell literals, service-specific data paths, file freshness and env precedence use the same contract as actual execution. Repository env files must be gitignored, unsafe permissions produce warnings, and missing-file guidance never recommends committing secrets.
3. A forced Deployment builds shared/entry units once; no-up builds without activating Services; later up/restart reuses results. Same completed source is unchanged. Unknown build completion requires explicit retry. Working copy Tool-only up rebuilds current declared Tool source. Known installed artifacts are checked without claiming generic shell-output verification. Production-branch push selects the configured Stable Target by role; Stable Tools remain unsuffixed and Working/Preview aliases use actual Target names.
4. Two sibling Services exercise different restart policies. Known/unknown exit, successful exit, signals, budget exhaustion, cancellation and daemon restart demonstrate that one Service's terminal state cannot revive or stop the other. Explicit resets and surviving-process adoption are observable; unknown is never silently treated as stopped-by-user.
5. A multi-port dependency graph, including an already-running prerequisite, validates readiness and local-only owned listeners before route publication. A failed start undoes only newly started processes. Automatic recovery follows the same readiness/routing contract; no public proxy access to an unverified replacement activation. The check is not advertised as continuous containment.
6. Recipe list/generate/rename/version notice/diff works through public CLI behavior against current-schema examples and customized user config. No network fetch or config overwrite is implicit.
7. Copied old metadata plus disposable data fixtures convert to new records with stable identities/roots and reviewed hook/env/timeout mappings. Old-format source commits are refused for new deploys. Unresolved ownership/recovery or an unmapped hook blocks the affected conversion; no invented build or exit evidence. Rehearsal never points to live daemon/jobs/routes.
8. The full source/build/help/test gate and matrix pass, all migration rehearsal artifacts are traceable, and the runbook names actual commands/checks/rollback inputs needed for a future concrete Host rollout. Tests and source publication do not constitute execution of that rollout.

## Migration sequencing

The normal runtime must not parse legacy Project/Host config after cutover. A one-time conversion path is separate from normal runtime discovery. Compare saved deployed policy to the converted candidate, not to current checkout policy; preserve source identity and ownership. Explicit timeout/env baselines and old role-file references must be mapped, including local.env/live.env to working/stable roles where applicable.

Use the old runtime to stop affected Targets with their old cleanup semantics before replacing records/daemon. During a runtime-wide state migration, coordinate the affected set as one reviewed maintenance operation. A per-Target downtime allowance does not authorize old and new daemons sharing mutable state. Preserve exact rollback binaries, configs, state, ownership, routes, Tool publication and application data paths; never restore a backup by deleting new application data without a separately valid data-recovery plan.

All live operation commands belong to the concrete rollout manifest/runbook produced after tested binaries exist. This planning task creates neither process changes nor a maintenance schedule.

## Required validation and review

Each implementer starts with one failing public-behavior regression, then the smallest complete behavior slice, then refactoring after green. Tests cross the real public interface with controlled adapters; do not replace behavior evidence with tests that mirror helpers. Use temporary RIG_ROOT and owned process fixtures. A single real-process smoke check supplements deterministic timing/identity tests where process behavior is material.

At major milestones run independent review for repository standards/function contracts and for the accepted #114 behavior. Resolve material findings before advancing the ticket. Final gate: relevant focused tests, full test suite, strict typecheck, both CLI/runtime builds and remote-helper build, all command help aliases, end-to-end examples, application portability demonstration, durable-recovery matrix, migration rehearsal and rollback evidence. Repeat broad validation only for subsequent material changes or unresolved failures.

The parent stays open until all child implementation acceptance criteria and release evidence are verified. A ticket closure must state what public behavior passed and any operational limitation. Do not report a live cutover merely because source was merged or a rehearsal succeeded.
