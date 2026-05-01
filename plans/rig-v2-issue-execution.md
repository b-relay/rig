# Plan: rig v2 issue execution

> Source PRD: GitHub issue #2 and local `docs/PRD_V2.md`
> Source issue set: GitHub issues #3 through #22

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
- #16 depends on #7 and #10 and is complete.
- #17 depends on #11, #12, and #16 and is complete.
- #18 depends on #16 and is complete.
- #19 depends on #17 and #18 and is complete.
- #20 depends on #18 and #19 and is complete.
- #21 depends on #19 and is complete.
- #22 depends on #14, #20, and #21.

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

#16 Define v2 provider plugin contracts
  -> #17 Persist rigd runtime state and reconciliation journal
      -> #19 Expose web read models through rigd
          -> #20 Route web lifecycle and deploy actions through rigd
          -> #21 Add safe config edit workflow through rigd
              -> #22 Prepare rig2 to main rig cutover readiness
  -> #18 Add localhost-first control-plane interface
      -> #19 Expose web read models through rigd
      -> #20 Route web lifecycle and deploy actions through rigd
```

## Execution Waves

### Wave 0: Decision Gate

**Issue**: #3

Status: complete. The product decisions that would otherwise leak into schema, CLI, provider, and runtime authority work are recorded in `docs/DESIGN_V2.md`.

Resolved outputs:

- Cross-project selector is `--project <name>`.
- Outside a managed repo, repo-first project-scoped commands require `--project <name>`; global inventory must be explicit.
- Home-level rig config provides machine/user defaults such as production branch,
  generated deployment caps, replacement policy, and provider defaults. Project
  config remains the repo-local source for components and project-specific
  overrides, and can override home defaults.
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
- Transitional status of the smoke-only binary documented.

Current output: main binary provider composition is centralized behind selectable `default`, `stub`, and isolated E2E profiles; v2 also has an Effect v4 provider profile service. Full main-binary isolated E2E parity is now covered by #14.

#4 should update docs and onboarding after #15 has settled the real Effect stack wording:

- V2 vocabulary first.
- Legacy command forms marked transitional where useful.
- Onboarding steers lifecycle through rig.

Current output: README introduces the v2 vocabulary, Effect v4 / Effect Schema / Effect CLI direction, isolated state, provider profiles, and main-binary E2E direction before legacy v1 command docs.

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

#13 depends on #5 and #7, and should expand init once the config resolver and provider profiles exist.

Current output: `rig2 init --project <name> --path <path>` writes a valid lane-wired v2 config, `--provider-profile default|stub` is scriptable, and `--package-scripts` adds non-overwriting `rig:` scripts only when `package.json` already exists. `--uses sqlite,postgres,convex` scaffolds bundled component-plugin stubs without adding dependencies, ports, or Vite/Next-style app command presets. `--domain` and `--proxy` scaffold neutral project domain and lane proxy metadata without creating app components. Init also records a project-initialized event in isolated `rigd` state so `rig2 list` can discover the project. Runtime provider services now select SCM, workspace, proxy, health, hook, package-manager, and process-supervisor providers from the resolved deployment `providerProfile`, falling back to the machine default only when the deployment has no profile. A fake-project CLI flow now initializes from scratch, adds a `web` component through `rig2 config set`, and proves local `up`, live `deploy`, and generated `deploy --ref feature/test` are accepted under the isolated stub provider profile without setting a stub home config. The generated path also proves generated inventory, reserved component ports, and generated SQLite data paths under the isolated v2 state root. A Pantry-like fake app flow now proves a routed web component, SQLite component, and installed CLI component with `installName: "pantry"` can deploy live and generated targets through v2 without touching real Pantry.

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

Current output: deploy intent resolution now classifies git pushes to the configured main ref as `live` updates and other refs as generated deployment updates, materializing generated deployment inventory when config is available. `rig2 deploy` creates ref/target intents without requiring semver, `rig2 bump` emits optional version metadata with rollback tag anchors, and dirty/stale-release edge cases fail with structured v2 runtime errors.

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

Current output: `V2LifecycleLive` now delegates `up`, `down`, `logs`, and `status` to the rigd local API. The live `rig2` composition uses the rigd-backed lifecycle implementation, while older direct lifecycle assembly remains a compatibility testing seam rather than the runtime source of truth.

Exit condition:

- CLI and local API agree on runtime state.
- Direct command-assembled state is compatibility behavior, not the new source of truth.

### Wave 6: Reliability And Cleanup

**Issues**: #12, #14

#12 hardens deploy reliability and introduces `doctor`.

Current output: `V2Doctor` exposes deploy preflight, doctor reporting, and bounded reconstruction interfaces. The `rig2 doctor` command now emits PATH, binary/file, health, port, stale-state, and provider categories, while tests cover false-positive health ownership, actionable port conflicts, safe reconstruction plans, and structured unsafe reconstruction failures.

#14 retires the smoke-only binary once main-binary isolated E2E coverage is sufficient.

Current output: the compiled E2E command matrix, lifecycle, command-surface, and onboarding suites now build and execute the main `rig` binary with isolated `RIG_ROOT` plus safe provider composition. The `build:smoke` script and smoke-only entrypoint are removed, and docs no longer point users or contributors at a smoke-only architecture.

Exit condition:

- Preflight and doctor cover the failure modes called out in the PRD.
- Main binary E2E coverage replaces smoke-only architecture.

### Wave 7: Provider Contracts And Persistent Runtime Authority

**Issues**: #16, #17

#16 defines the explicit Effect v4 provider/plugin contracts for all external concerns before deeper `rigd` integration relies on them.

Current output: `V2ProviderRegistry` reports a shared plugin metadata shape for
first-party bundled providers and future external providers, with explicit
Effect service tags for each provider family. Default, stub, and isolated E2E
compositions satisfy the same provider families, and capability metadata is
visible through `rigd` health and `rig2 doctor`.

#17 makes `rigd` restart-safe by persisting runtime state, receipts, health summaries, port reservations, provider observations, and recovery evidence under the isolated v2 state root.

Current output: `V2RigdStateStore` persists runtime events, receipts, health
summaries, provider observations, deployment snapshots, and rigd-owned port
reservations under `runtime/rigd-state.json`. It also persists desired
deployment state for config-backed lifecycle and deploy writes. Restart tests
prove persisted logs, desired running records, and minimum reconstruction
evidence survive a fresh `rigd` layer; `rigd.start` reconciles desired-running
deployment records, while missing evidence fails with a tagged
unsafe-reconstruction error. `rigd.managedProcessExited` records managed
process crash evidence, restarts desired-running deployments while the retry
budget allows it, and marks repeated crashes failed instead of retrying
forever.

Recommended order:

1. #16 first, so `rigd` persistence records provider observations through stable interfaces.
2. #17 second, so control-plane read/action slices have durable state to expose.

Exit condition:

- V2 core code can swap provider compositions through interfaces.
- `rigd` can reconstruct safe minimum state after restart and fail explicitly when evidence is insufficient.

### Wave 8: Local Control Plane And Web Read Models

**Issues**: #18, #19

#18 adds the localhost-first control-plane interface, Tailscale-friendly access assumptions, optional tunnel-provider shape, token-pairing boundary for public internet exposure, heartbeat/event envelopes, and stub transport coverage.

Current output: `V2ControlPlane` composes local server, tunnel exposure, and
token-pairing auth services. It covers localhost-only, Tailscale DNS, and
public tunnel modes, reports runtime status through `rigd` health, and
serializes runtime events and receipts into plain JSON envelopes.

#19 exposes the web-facing read model for projects, deployments, health, and structured logs through `rigd`.

Current output: `rigd.webReadModel` returns project rows, deployment rows, and
health snapshots for `rigd`, deployments, components, and providers from
durable state. `rigd.webLogs` filters structured events by project, lane,
deployment, component, and line window. Control-plane read-model envelopes are
plain JSON.

Recommended order:

1. #18 can run after #16.
2. #19 should follow #17 and #18 so read models are both durable and serializable through the transport contract.

Exit condition:

- `rigd` can describe local control-plane server state, private Tailscale exposure, and optional tunnel/provider state while binding the default server to `127.0.0.1`.
- Project, deployment, health, and log read models are ready for the hosted UI contract.

### Wave 9: Web Actions And Config Editing

**Issues**: #20, #21

#20 routes web/control-plane lifecycle and deploy actions through the same `rigd` authority used by CLI commands.

Current output: `rigd` accepts control-plane lifecycle, live deploy, generated
deploy, and generated teardown actions. Accepted actions emit durable
receipts and structured events. Generated deploy actions materialize
deployment inventory before acceptance, generated teardown only accepts
generated targets, and provider/preflight validation is behind the
`V2RigdActionPreflight` interface.

#21 adds safe structured config editing through `rigd`, including schema validation, diff/preview, atomic apply, and rollback behavior.

Current output: `V2ConfigEditor` exposes read, preview, and apply interfaces
for structured v2 config patches. `rigd` returns editor-ready config with
field docs and revisions, previews schema-validated diffs without writing, and
applies validated edits atomically with backup/recovery information while
rejecting stale revisions. `rig2 config read`, `rig2 config set`, and
`rig2 config unset` expose that workflow through the CLI, with preview as the
default and `--apply` required for writes.

Exit condition:

- Web-originated lifecycle and deploy actions produce the same receipts, logs, health, and inventory effects as CLI actions.
- Config edits are validated and recoverable instead of arbitrary file writes.

### Wave 10: Main Binary Cutover Readiness

**Issue**: #22

#22 is the HITL readiness gate for replacing the current `rig` CLI with the isolated `rig2` CLI once v2 is ready.

Current HITL output: the cutover model is replacement, not gradual routing.
`rig2` remains isolated while incomplete; when it is good enough, it is renamed
or built as `rig` as the new CLI. `docs/rig-v2-cutover-readiness.md` records
the replacement readiness criteria, validation, rollback, and remaining gaps.
`docs/rig2-guide.md` gives the user-facing usage guide and v1/v2 differences.
Follow-up issues #23 through #26 are filed for the remaining implementation
slices.

Exit condition:

- Replacement readiness, provider safety, validation steps, rollback docs, and remaining follow-up issues are explicit before renaming `rig2` to `rig`.

## Recommended Next Move

Provider-execution foundation from #25 is in place: config-backed
`rigd` lifecycle, deploy, and generated-destroy actions now resolve deployment
records and execute through the v2 runtime executor provider interface before
receipts/logs persist. The direct `rig2` CLI config-loading slice is also in
place for repo-inferred commands and explicit `--config` paths; lifecycle,
status, and deploy calls pass the validated config into the rigd/provider path.
The provider-method boundary is now in place: process supervisor, workspace,
SCM, package manager, health, proxy, and event transport services expose
runtime operation methods, and `V2RuntimeExecutorLive` calls them in order for
lifecycle, deploy, and generated teardown. Lane config now also resolves
`providers.processSupervisor`, defaulting to core `rigd` while allowing the
bundled `launchd` plugin and future external process-supervisor providers to
use the same selection shape. Runtime execution now emits component-scoped
events through the event-transport provider, and `rigd` persists them into the
same log stream used by CLI and web filters. The `structured-log-file` event
transport now appends deployment-scoped JSONL under each v2 deployment log
root. The `native-health` provider now performs real HTTP and command checks
and returns tagged runtime failures for unhealthy, unreachable, or non-zero
checks. The `package-json-scripts` provider now runs installed-component build
commands from the deployment workspace, installs executables into the
v2-managed bin root, and reports tagged failures.
Process-supervisor providers can now return stdout/stderr lines that are
persisted through component log events, and the core `rigd` process supervisor
now runs managed component commands while returning stdout/stderr output for log
ingestion. `V2HomeConfigStore` now reads and writes schema-validated home
config under the v2 state root, and deploy intent resolution uses project
`live.deployBranch` before home `deploy.productionBranch` before `main`.
Generated deployment caps from home config are enforced during deploy-intent
materialization and `rigd` generated deploy actions with `reject` and `oldest`
replacement policies. #27 is complete for launchd process-supervisor
execution, #28 is complete for `caddy` proxy routing, #29 is complete for
`local-git` ref preparation, and #30 is complete for `git-worktree` workspace
materialization. The bundled Caddy provider now adopts existing same-domain
site blocks instead of appending ambiguous duplicates, renders portable
reverse-proxy-only blocks by default, accepts home-config-style Caddyfile path
and per-site extra config, and can run an explicitly configured reload command
after route writes.
Config-backed lifecycle and deploy actions now persist desired running/stopped
deployment state, and `rigd.start` reconciles desired-running records through
the runtime executor after process restart.
`rigd.managedProcessExited` now records crash evidence, restarts while the
retry budget allows it, and marks repeated crashes failed. The core `rigd`
process-supervisor provider now wires concrete child-process exits into that
policy entrypoint, and status output includes desired deployment state plus
recent managed-service failure evidence.

After the provider-adapter follow-ups, #23 can prepare the final `rig2` to
`rig` replacement build path. #24 is complete for the CLI config-edit surface.

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

## Suggested Second Milestone

Milestone name: `v2 control plane runway`

Scope:

- #16 Define v2 provider plugin contracts.
- #17 Persist rigd runtime state and reconciliation journal.
- #18 Add localhost-first control-plane interface.
- #19 Expose web read models through rigd.
- #20 Route web lifecycle and deploy actions through rigd.
- #21 Add safe config edit workflow through rigd.
- #22 Prepare rig2 to main rig cutover readiness.

Why this milestone:

- It turns the MVP `rigd` into a durable runtime authority.
- It keeps external systems behind interfaces before transport and web-facing behavior expand.
- It creates the local contracts the hosted control plane can consume later.
- It preserves a deliberate HITL replacement decision before `rig2` becomes the main `rig` binary.
