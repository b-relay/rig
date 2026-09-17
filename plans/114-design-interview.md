# Issue 114 design interview

Source: [GitHub issue 114](https://github.com/b-relay/rig/issues/114). Round 1 was asked September 10, 2026 at `470a510`; answers arrived September 16 and source was refreshed at `5c5b57e`. This is a design interview, not an implementation or release-completion record.

## Settled decisions

| Question | User decision |
|---|---|
| Q1 Release scope | Deliver all #114 features together, including recipe generation, version notices and diff tooling. This does not require one implementation ticket or commit. |
| Q2 Targets | Configurable Target names, Stable Targets, and generated Previews. Fixed local/live names are not the intended model. Independent branch mappings for multiple Stable Targets are deferred because they do not exist today. Configurable names remain accepted; exact declaration and first-release Target cardinality remain open. |
| Q3 Project contents | Services, Tools, or both; require at least one across the two maps. |
| Q4 Environment | Make resolution order, winning source and shadowed names explicit. Reject a conflicting env-file override of a public value used in a command; name keys and sources without showing secret values. |
| Q5 Dependencies | Readiness is a startup gate. No cascading restarts merely because a dependency later fails. |
| Q6 Loopback | Approved: check owned listeners are bound locally at each activation, including automatic restarts, before reporting successful startup or publishing routes. This is not continuous enforcement of future application behavior. |
| Q7 Format | Project and Host user-authored config become YAML-only; machine-owned records may remain JSON. |
| Q8 Migration | A planned per-Target stop/start window is acceptable; preserve application data and prepare backups/rollback. No live cutover executed or scheduled. |
| Q9 Builds | Track successful build completion once per Deployment; do not rerun it as a pre-start hook. Build during materialization, including --no-up. Q13/Q14/Q18 settle shared build scope, interrupted completion and Working copy triggers below; detailed identity/order/no-op rules remain open. |
| Q10 Restart inputs | Deployed Targets use recorded deployment policy and refresh env-file contents on restart. Explicit Working copy starts/restarts build current source; automatic restarts reuse the result. |
| Q11 Exit evidence | Persist observed exit results; missing reliable evidence after a crash requires manual start. This also overrides always, as accepted in Q19. Never infer manual stop as the historical cause from missing evidence. |

Decision records: [YAML-only cutover](../docs/adr/0001-yaml-only-project-config-cutover.md), [automatic versus explicit starts](../docs/adr/0002-explicit-start-independent-of-restart-policy.md), [secret interpolation boundary](../docs/adr/0003-exclude-env-file-secrets-from-interpolation.md), [deployment-time builds](../docs/adr/0004-builds-belong-to-deployments.md), [application portability](../docs/adr/0005-services-use-platform-independent-inputs.md).

## Design tree

```text
114: explicit Project contract
|-- Application portability [settled: explicit ordinary inputs; ADR 0005]
|-- Release scope [settled: all proposed features together]
|   `-- Vertical slices, recipe version comparison and release gates [after contracts]
|-- Domain model
|   |-- Configurable names / Stable Targets / generated Previews [settled]
|   |-- Services and/or Tools [settled]
|   |-- Independent per-Stable-Target source branches [deferred]
|   |   `-- First-release cardinality, push routing, hostnames, tool aliases, target declaration [open]
|   |-- Removing inherited Services through Target patches [deferred Q15]
|   `-- Allowed patch fields and final graph validation [open; no Service-removal feature]
|-- Values and execution
|   |-- No secret interpolation; explain shadowing [settled]
|   |-- Reject command/env conflict [settled Q4]
|   |   `-- Full precedence, literals, shell expansion, paths, cycles, build-time env [open after Q4]
|   |-- Deployment-time build with successful completion record [settled]
|   |-- Shared build unit [settled Q13: explicit shared + per-Service/Tool]
|   |-- Interrupted build result [settled Q14: unknown requires explicit retry]
|   |-- Working copy build trigger [settled Q18: explicit start/restart]
|   |   `-- Build identity, missing artifacts, force/retry and build dependency ordering [after build rules]
|   `-- Saved deployed policy with freshly loaded env files [settled]
|-- Lifecycle
|   |-- restart:no leaves exited services stopped; explicit start permitted [settled]
|   |-- Save exit evidence; unknown result requires manual start [settled]
|   |-- Unknown-result fallback versus always [settled Q19: manual start]
|   |-- Startup-only dependencies [settled]
|   |-- Partial startup failure [settled Q17: undo newly started processes]
|   `-- Ready-check precedence, dependency completion, retries/backoff, new-deploy reset [after lifecycle rules]
|-- Exposure
|   |-- Activation-only loopback verification [settled Q6]
|   `-- Exact ownership scope, check failure behavior, routes/hostnames and headless URLs [after Q6 and Target model]
`-- Cutover
    |-- Project and Host YAML-only [settled]
    |-- Planned downtime [settled]
    |-- Preserve existing data roots versus relocate [settled Q16: preserve]
    `-- Conversion, service/Target renames, backup/rollback, old commits and shutdown-hook replacement [after data/model rules]
```

## Round 2 answers (September 16)

The user approved the recommendations, including Q6 after clarification. Q15 Service removal through Target patches is deferred after the user judged it useful for the future but unnecessary now. Q12 is also deferred because independent per-Stable-Target branch policies are not already supported.

| Question | Decision |
|---|---|
| Q4 | Reject conflicting command/environment values; show the competing keys/sources without secret values. |
| Q6 | Approved after explanation: inspect local bindings at activation, not continuous enforcement. |
| Q12 | Independent per-Stable-Target branch policies are not implemented and are deferred to future work. Preserve the existing single Production branch behavior. Configurable Target names were separately approved in Q2; do not silently retract that decision or assume the cardinality question is settled. |
| Q13 | Explicit Project shared build plus optional Service/Tool builds. Do not deduplicate commands by string equality. |
| Q14 | Unknown build completion requires an explicit retry; do not silently rerun or claim success. |
| Q15 | Deferred: omitting an inherited Service from an individual Target (such as worker: null) is useful future work, not part of #114 delivery. Do not add an equivalent disable/remove mechanism under another name. Overrides of settings remain in scope. |
| Q16 | Preserve existing owned data locations during format cutover. |
| Q17 | On partial startup failure stop processes newly started by that attempt, preserve previously running processes and persistent data, and report failure. |
| Q18 | Explicitly starting/restarting the Working copy builds current source; automatic restarts reuse the result. |
| Q19 | Missing reliable exit evidence requires manual start even with always; verified surviving processes remain running. |
| Portability | Rig-generated paths/ports are explicitly mapped to application-defined arguments or environment variables. Applications need no Rig SDK, variable names, expression parser or private directory-layout knowledge. Equivalent ordinary inputs must work on other platforms. |

## Clarifications and resulting decisions

- Q6: A listener is a process waiting for connections on an address/port, for example an API at 127.0.0.1:3000. A loopback binding accepts connections only from this machine; a wildcard binding can accept traffic on other interfaces subject to network/firewall rules. Proposed boundary: inspect owned listeners on activation before success/route publication, not a promise about all future listeners. Approved after this explanation.
- Q15: A worker is merely an example background Service (e.g. sending queued emails). Inheritance means a Target starts with the base Services and applies its patch. Proposed removal uses null to leave the worker out of that Target, not to delete its code/data; reject any remaining dependency/route referencing it. After this explanation the user deferred the feature; the null-removal proposal is not an accepted current requirement.
- Portability example: Rig resolves a generated data directory and maps it to the application's DATA_DIR or --data-dir. On another platform the operator supplies a different ordinary path through the same input; the application does not read or interpret rig.data.

## Branch capability check (September 16)

At 5c5b57e, one configured Production branch maps to live; other pushed branches map to Previews (src/runtime/application.ts:338-353). Config exposes one live lane (src/config/schema.ts:327-329), and runtime reads live.deployBranch with a Host fallback (src/runtime/targets.ts:69-77). An explicit live branch argument must still match that policy (src/runtime/targets.ts:78-86); it is not an independent per-Target branch mapping. Multiple separately branch-bound Stable Targets are future work under the user's conditional deferral.

## Refreshed source evidence (September 16)

- Installed-component receipts are written after build and publication, so a successful build followed by a crash before receipt can be rerun. Reuse checks policy, source, destination and digest (`src/adapters/target-effects.ts:497-558`). These receipts are not an exactly-once record for arbitrary shell effects.
- Complete same-Commit-and-Branch deploy returns unchanged (`src/runtime/application.ts:428-441`). Force creates a new revision workspace (`src/runtime/targets.ts:87-102`).
- --no-up still skips lifecycle preparation/builds (`src/runtime/deploy.ts:55-68`); deployment-time builds are a proposed change.
- Working copy up/restart now replans current config (`b961d10`); deployed config comes from the prepared source revision (`68d221f`). This supersedes the September 10 blanket saved-policy explanation.
- Reconciliation still starts desired-running Targets (`src/runtime/application.ts:721-727`). Target state has no durable per-Service terminal intent (`src/runtime/state-schema.ts:90-123`). Capture observations require fresh live-wrapper evidence (`src/providers/capture-observation.ts:48-81`). A journal can improve evidence but cannot record an exit after power has already disappeared.
- Existing dataRoot is retained during replanning (`src/runtime/targets.ts:63-64,102`), while Preview deletion checks the canonical owned layout (`src/adapters/preview-storage.ts:64-72`). SQLite/Convex persistence improved since the first round; format changes do not inherently require moving data.

## Round 3: concrete review draft (September 17)

The [consolidated spec](114-config-spec-draft.md) and [three complete YAML examples](examples/114-service.rig.yaml) now provide concrete proposed rules for all remaining branches. Their new schema is not implemented; the examples have only been checked for YAML syntax and basic internal consistency.

The current decision frontier is six packages, all **proposed, awaiting answers**:

| Question | Remaining choice |
|---|---|
| Q20 | One configurable Working copy and one configurable Stable Target plus generated Previews, or multiple Stable Targets now? The draft recommends one of each, role-keyed patches, and preserves Project -> Host -> main Production branch fallback. |
| Q21 | Exact env/file precedence and evaluation contract. Recommend public Project -> public Service -> Project files -> Service files, with explicit baseline/provenance, no ambient app secrets, and conflict checks across run/build/readiness commands. |
| Q22 | Build identity/order/artifact/retry details. Recommend per-Deployment build units, shared-first ordering, existing same-source no-op, force for new builds, no silent recovery rebuild, explicit local Service/Tool triggers, and build_timeout preserving existing budget overrides. |
| Q23 | Known-exit policy and activation lifecycle. Recommend existing bounded retries, durable budget/identity, explicit reset events, readiness/check ordering, and no completed-job dependency semantics. |
| Q24 | Conversion of saved deployments and old source commits. Recommend a reviewed migration manifest preserving exact identities/storage/policy/evidence, strict rejection of new deployments from old-format commits, isolated rehearsal and tested backups/rollback. |
| Q25 | Conversion of non-build lifecycle hooks. Recommend portable application scripts/signal handling, no silent discard/merge, and blocking affected migration until an equivalent replacement is reviewed. |

All previously accepted decisions stay closed. Rules dependent on the proposed one-Stable-Target shape are conditional on Q20; revise them if the user chooses multiple. If all packages are accepted, present the consolidated design for final shared-understanding confirmation before implementation. If a package changes, revisit its affected branch rather than restarting the interview.

An independent source/spec reviewer identified Tool-only local build triggers, Host branch fallback, timeout destination fields and an implicit execution environment as missing details. The draft now states those explicitly. Validation and review are evidence about the draft, not acceptance of its proposed product choices.

The session continues until the design frontier is exhausted and the user confirms shared understanding. This session updates design docs and #114 only; it does not implement or operate the runtime.
