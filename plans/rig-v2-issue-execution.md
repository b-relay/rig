# Plan: rig v2 issue execution

> Source PRD: GitHub issue #2 and local `PRD_V2.md`
> Source issue set: GitHub issues #3 through #15

This plan converts the open v2 GitHub issues into an execution order. It is intentionally more operational than `plans/rig-v2.md`: it answers what to pick up next, what is blocked, and which issues should move together.

## Current Shape

- #2 is the parent PRD.
- #3 is the only unblocked implementation gate.
- #15 is the technical foundation and is blocked by #3.
- #5, #6, #7, and #4 all depend on #15 in some form.
- #8 depends on #5 and #7.
- #10 depends on #7 and #8.
- #11 depends on #10.
- #9 depends on #8.
- #12 depends on #8, #10, and #11.
- #13 depends on #5 and #7.
- #14 depends on #7 and #11.

## Dependency Graph

```text
#2 PRD
  -> #3 Resolve v2 operating decisions
      -> #15 Create isolated rig2 v2 foundation with Effect v4
          -> #5 Introduce v2 config resolver with Effect Schema
              -> #6 Add repo-first CLI and lifecycle aliases with Effect CLI
              -> #8 Materialize generated deployments
              -> #13 Expand init and package-manager integration
          -> #7 Make provider profiles first-class
              -> #8 Materialize generated deployments
              -> #10 Ship a rigd MVP
              -> #13 Expand init and package-manager integration
              -> #14 Retire rig-smoke
          -> #4 Align docs and onboarding with v2 vocabulary

#8 Materialize generated deployments
  -> #9 Add git-push deployment flow
  -> #10 Ship a rigd MVP
  -> #12 Harden deploy reliability and doctor

#10 Ship a rigd MVP
  -> #11 Move lifecycle, logs, and status behind rigd
      -> #12 Harden deploy reliability and doctor
      -> #14 Retire rig-smoke
```

## Execution Waves

### Wave 0: Decision Gate

**Issue**: #3

Status: complete. The product decisions that would otherwise leak into schema, CLI, provider, and runtime authority work are recorded in `DESIGN_V2.md`.

Resolved outputs:

- Cross-project selector is `--project <name>`.
- Outside a managed repo, repo-first project-scoped commands require `--project <name>`; global inventory must be explicit.
- Path-based lifecycle targeting is rejected.
- `local` and `live` cannot run concurrently when they need the same concrete port; `rigd` owns reservations.
- Health must prove rig-owned runtime state, not just arbitrary port success.
- Explicit runtime status for undeployed targets fails.
- Aggregate runtime logs include `managed` components only.

Exit condition:

- #3 can be closed or marked as accepted, and #15 can start without unresolved UX semantics.

### Wave 1: Technical Runway

**Issue**: #15

Build the isolated v2 foundation before adding feature surface. This is the first real implementation milestone.

Status: complete. `rig2`, isolated v2 paths, Effect v4 aliasing, representative Effect Schema validation, Effect CLI parsing, services/layers, and tagged errors are implemented and covered by focused tests.

Required outputs:

- Separate `rig2` or equivalent v2 entrypoint.
- Isolated v2 state root and namespaced runtime/provider state.
- Effect v4 package/version decision.
- One representative Effect Schema path.
- One representative Effect CLI command.
- Service/layer composition and tagged error path proven end to end.
- V1 binary remains safe for existing production use.

Exit condition:

- Future v2 issues have a stable place to put code and tests without mutating v1 runtime state.

### Wave 2: First Parallelizable Foundation

**Issues**: #5, #7, #4

After #15, three streams can proceed with limited overlap.

Status: in progress.

#5 should build the v2 config resolver:

- Components, modes, lanes, overrides, interpolation, and dependency validation.
- A resolved lane shape that can drive existing lifecycle behavior during migration.
- V1 config compatibility preserved.

Current output: v2 shared component schemas, lane override schemas, mode/dependency validation, interpolation, generated deployment values, provider profile selection in config, and v1-compatible lane resolution are implemented.

#7 should build provider profiles:

- Default provider composition.
- Stub provider composition.
- Main-binary isolated test execution path.
- Transitional status of `rig-smoke` documented.

Current output: main binary provider composition is centralized behind selectable `default`, `stub`, and transitional `smoke` profiles; v2 also has an Effect v4 provider profile service. Full main-binary isolated E2E parity remains open.

#4 should update docs and onboarding after #15 has settled the real Effect stack wording:

- V2 vocabulary first.
- Legacy command forms marked transitional where useful.
- Onboarding steers lifecycle through rig.

Current output: README introduces the v2 vocabulary, Effect v4 / Effect Schema / Effect CLI direction, isolated state, provider profiles, and `rig-smoke` transitional status before legacy v1 command docs.

Exit condition:

- V2 configs can resolve.
- V2 can select safe provider profiles.
- Docs match the architecture now being implemented.

### Wave 3: Repo-First UX And Generated Deployments

**Issues**: #6, #8, #13

#6 depends on #5 and #15, and should introduce repo-first command aliases through the v2 command path.

Current output: `rig2 up`, `rig2 down`, `rig2 logs`, and `rig2 status` are Effect CLI commands. They infer project identity from the current repo when `--project` is omitted, expose `local`/`live` lanes, reject `down --destroy` for local/live lanes, and delegate through a v2 lifecycle interface.

#8 depends on #5 and #7, and should materialize generated deployments from the `deployments` template.

Current output: generated deployment materialization now runs behind v2 deployment manager/store interfaces. Branch and named deployments resolve isolated workspace/log/runtime state, generated subdomains, deterministic assigned ports, persisted inventory, and generated-only teardown semantics.

#13 depends on #5 and #7, and should expand `rig init` once the config resolver and provider profiles exist.

Current output: `rig init` now has an opt-in v2 scaffold path. `--v2` writes a valid lane-wired v2 config, `--provider-profile default|stub` is scriptable, and `--package-scripts` adds non-overwriting `rig:` scripts only when `package.json` already exists.

Recommended order:

1. #6 first, if the goal is early human-visible UX.
2. #8 first, if the goal is deployment architecture.
3. #13 after enough of #5 and #7 exists to scaffold real v2 config.

Exit condition:

- A user can see the v2 command vocabulary.
- Generated deployment inventory has concrete state.
- Init can scaffold toward the new model instead of v1-only config.

### Wave 4: Deployment Flow And Runtime Authority

**Issues**: #9, #10

#9 can start after #8 and turns generated deployment inventory into deploy intent from git pushes and CLI deploy targets.

#10 depends on #7 and #8 and introduces the `rigd` MVP.

Current output: `rigd` now exists as an Effect v4 service/interface with an in-process MVP local API for health, inventory, logs, health state, lifecycle receipts, and deploy receipts. `rig2 rigd` starts and reports the local API, and `rig2 status` reads rigd health/inventory as the first CLI status path through the runtime authority.

Recommended order:

1. Build #10 before deepening runtime-facing command behavior.
2. Build #9 once generated deployment identity and materialization are stable.

Exit condition:

- `rigd` can report local health and inventory.
- At least one CLI lifecycle/status path can use `rigd`.
- Deploy intent can target `live` and generated deployments without requiring semver.

### Wave 5: Move Runtime Truth Behind Rigd

**Issue**: #11

Move lifecycle, logs, status, health, and process supervision behind `rigd`.

Exit condition:

- CLI and local API agree on runtime state.
- Direct command-assembled state is compatibility behavior, not the new source of truth.

### Wave 6: Reliability And Cleanup

**Issues**: #12, #14

#12 hardens deploy reliability and introduces `doctor`.

#14 retires or reduces `rig-smoke` once main-binary isolated E2E coverage is sufficient.

Exit condition:

- Preflight and doctor cover the failure modes called out in the PRD.
- Main binary E2E coverage replaces smoke-only architecture.

## Recommended Next Move

Pick up #15 immediately. That issue creates the isolated `rig2` / Effect v4 runway and unlocks the rest of the v2 queue.

## Suggested First Milestone

Milestone name: `v2 runway`

Scope:

- #3 Resolve v2 operating decisions.
- #15 Create isolated rig2 v2 foundation with Effect v4.
- #5 Introduce v2 config resolver with Effect Schema.
- #7 Make provider profiles first-class.
- #4 Align docs and onboarding with v2 vocabulary.

Why this milestone:

- It creates the isolated implementation path.
- It establishes the Effect v4 stack.
- It proves v2 config and provider composition before runtime-heavy work.
- It gives contributors docs that match the target architecture.

Do not include #8 or later in the first milestone unless #5 and #7 are already complete.
