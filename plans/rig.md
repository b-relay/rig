# Plan: rig

> Source PRD: `docs/PRD.md`
> Status: historical execution record. The replacement runway is complete and
> current product guidance lives in `README.md`, `DESIGN.md`,
> `docs/PRD.md`, and `docs/rig-guide.md`.

## Architectural Decisions

Durable decisions that apply across all phases:

- **Product reference**: Dokploy is a useful reference for product feel: simple deployment wrapper, polished interface, practical defaults, broad deployment features. `rig` follows that product ambition without using Docker or containers as the runtime substrate.
- **Primary model**: projects contain shared `components`; components run in `local`, `live`, or generated `deployments`.
- **Config scope model**: project config owns repo-specific components and overrides; home config owns machine/user defaults such as production branch defaults, generated deployment caps, replacement policy, and provider defaults. Project config can override home defaults.
- **Component modes**: `managed` is a supervised long-running runtime; `installed` is an executable build/install surface.
- **Dependency semantics**: dependencies are only for managed component startup and shutdown ordering. They do not imply restart propagation, runtime cascade behavior, or tool prerequisite modeling.
- **Deployment model**: git push is the primary deployment path. The configured production branch updates `live`; all other pushed refs create or update generated deployments. Semver and tags are optional metadata and rollback anchors, not required for routine deploys.
- **Runtime authority**: `rigd` owns deployment inventory, process supervision, logs, health state, port allocation, deploy actions, provider coordination, and state reconciliation.
- **Effect stack**: rig targets Effect v4 for backend logic, Effect Schema for config and argument validation, and Effect CLI for command parsing/help. Legacy Zod and hand-written parser code are migration scaffolding only.
- **Provider model**: external concerns stay behind interfaces and are selected at composition time. Stub providers are first-class provider choices.
- **Parallel rig runway**: v1 `rig` remains the production manager for always-on apps such as `pantry` until explicit cutover. Rig gets a separate dev binary or entrypoint, isolated state root, and namespaced runtime/provider state.
- **Testing model**: the main `rig` binary is testable under isolated state with safe provider composition.
- **Migration model**: existing v1 behavior remains supported while rig docs, config resolution, CLI, provider composition, `rigd`, and deploy flows land incrementally.
- **Targeting model**: repo-first commands infer the project only inside a managed repo; cross-project operations use `--project <name>` and path-based lifecycle targeting is rejected.
- **Runtime safety model**: `rigd` owns port reservations, simultaneous same-port runtime conflicts fail during preflight, and health checks must prove rig-owned runtime state rather than arbitrary port success.
- **Inspection model**: explicit status for undeployed runtime targets fails, and aggregate runtime logs include `managed` components only.

---

## Phase 1: Resolve Rig Operating Decisions

**GitHub issue**: #3

**User stories**: 4, 5, 30, 35, 37, 59, 60

### What To Build

Create the decision record that closes the open product questions needed before implementation locks in command behavior, generated deployment behavior, health validation, and log semantics.

### Acceptance Criteria

- [x] The cross-project selector flag is decided.
- [x] Behavior outside a managed repo is specified for repo-first commands.
- [x] Path-based targeting is either accepted or explicitly rejected.
- [x] Same-port `local` and `live` runtime behavior is specified.
- [x] Health validation ownership expectations are specified.
- [x] Explicit status for undeployed versions is specified.
- [x] Installed-component aggregate log behavior is specified.

---

## Phase 2: Migrate The Rig Foundation To Effect V4

**GitHub issue**: #15

**User stories**: 53, 59, 61, 62, 63, 64, 65, 66, 67

### What To Build

Create the rig technical foundation around Effect v4, Effect Schema, and Effect CLI. Establish the separate rig dev binary or entrypoint, isolated state root, runtime namespaces, package versions, compatibility expectations, migration boundaries, and a small representative path that proves schemas, CLI parsing, services, layers, and tagged errors all work together before broader rig implementation depends on them.

### Acceptance Criteria

- [x] The project targets Effect v4 for rig backend logic.
- [x] If Effect v4 is still prerelease, the implementation pins an explicit beta and documents the stable upgrade path.
- [x] `docs/effect-v4-help-notes.md` is consulted before Effect v4 work and kept updated with verified APIs, migration details, Bun integration patterns, package constraints, and useful source links.
- [x] A separate rig dev binary or entrypoint existed while rig was incomplete.
- [x] Rig uses an isolated state root by default or requires explicit isolated state during early development.
- [x] Rig launchd labels, workspaces, logs, proxy entries, ports, and runtime metadata cannot collide with v1 defaults.
- [x] V1 `rig` can keep managing production apps such as `pantry` while rig is tested.
- [x] A representative Effect Schema replaces equivalent Zod validation for a rig path.
- [x] A representative Effect CLI command replaces equivalent hand-written parsing for a rig path.
- [x] Structured errors, logger output, services, and layers still compose through Effect.
- [x] Legacy v1 Zod and hand-parser code remains only as migration scaffolding.

---

## Phase 3: Align Docs And Onboarding With Rig Vocabulary

**GitHub issue**: #4

**User stories**: 7, 47, 48, 49, 55, 56, 57, 58, 59, 60

### What To Build

Update user-facing docs, help text, onboarding guidance, and setup examples so contributors and users see `components`, `managed`, `installed`, `local`, `live`, and `deployments` as the target model while legacy behavior remains available during migration.

### Acceptance Criteria

- [x] Docs introduce the rig vocabulary before legacy environment terminology.
- [x] Docs describe rig as targeting Effect v4 for backend logic.
- [x] Docs describe Effect Schema replacing Zod for rig validation.
- [x] Docs describe Effect CLI replacing hand-written parser code for rig command parsing/help.
- [x] Onboarding examples avoid teaching unmanaged long-running package-manager commands as the normal workflow.
- [x] Help output identifies legacy command shapes as transitional where appropriate.
- [x] The Dokploy-but-non-Docker product context remains visible in planning docs.
- [x] Existing docs and onboarding tests pass.

---

## Phase 4: Introduce The Rig Config Resolver

**GitHub issue**: #5

**User stories**: 8, 9, 10, 11, 12, 13, 14, 15, 16, 24, 53, 59

### What To Build

Add a rig config path that can parse shared components, component modes, lane overrides, interpolation values, and dependency rules, then resolve a lane into the runtime shape existing lifecycle code can consume during migration.

### Acceptance Criteria

- [x] Rig configs validate shared components and lane overrides using Effect Schema.
- [x] Every new schema field has clear documentation.
- [x] Invalid mode-specific fields fail with structured errors and hints.
- [x] Interpolation values resolve for lane, workspace, deployment, subdomain, branch slug, and assigned ports.
- [x] Dependencies are accepted only for managed components.
- [x] A resolved rig lane can drive existing lifecycle behavior without duplicating component definitions.
- [x] V1 config behavior remains covered and compatible.

---

## Phase 5: Add Repo-First CLI And Lifecycle Aliases

**GitHub issue**: #6

**User stories**: 1, 2, 3, 4, 5, 6, 7, 15, 16, 59

### What To Build

Introduce the repo-first command surface around `up`, `down`, `logs`, `status`, and explicit cross-project selection with Effect CLI, initially mapping to existing lifecycle behavior through the rig lane resolver where possible.

### Acceptance Criteria

- [x] Commands infer the current project from a managed repo.
- [x] Cross-project operations require the chosen explicit selector.
- [x] `up`, `down`, `logs`, and `status` support `local` and `live` terminology.
- [x] `down --destroy` is reserved for generated deployment teardown semantics.
- [x] Legacy command forms continue to work during migration.
- [x] Every new or changed subcommand supports `--help` and `-h` through Effect CLI.
- [x] Parse failures still map to tagged rig errors and structured logger output.

---

## Phase 6: Make Provider Profiles First-Class

**GitHub issue**: #7

**User stories**: 50, 51, 52, 53, 54, 59

### What To Build

Add explicit provider/profile selection so the main `rig` binary can compose default providers or stub providers under isolated state without relying on a separate smoke-only entrypoint.

### Acceptance Criteria

- [x] Default provider composition remains launchd, Caddy, local git, and native process/runtime providers.
- [x] Stub provider composition is selectable for tests and isolated runs.
- [x] Provider selection is visible in config or execution context as appropriate.
- [x] Main-binary E2E tests can run with isolated state and stub providers.
- [x] Rig provider composition uses Effect v4 services/layers.
- [x] The separate smoke-only binary is documented as transitional after parity begins.

---

## Phase 7: Materialize Generated Deployments

**GitHub issue**: #8

**User stories**: 17, 18, 19, 20, 21, 22, 23, 24, 34, 59

### What To Build

Implement generated deployment inventory and materialization from the `deployments` template, including branch/named deployment identity, isolated workspace/log/runtime state, generated subdomains, and automatic port assignment.

### Acceptance Criteria

- [x] A generated deployment can be created from a branch or explicit deployment name.
- [x] Generated deployments receive isolated workspace, logs, runtime state, and assigned ports.
- [x] Generated subdomains default from branch slugs and can be overridden.
- [x] Deployment inventory can list `local`, `live`, and generated deployments consistently.
- [x] Destroying a generated deployment removes its rig-managed state without affecting `local` or `live`.

---

## Phase 8: Add Git-Push Deployment Flow

**GitHub issue**: #9

**User stories**: 25, 26, 27, 28, 29, 30, 59

### What To Build

Introduce the deploy intent model that turns git pushes and CLI deploy requests into `live` updates or generated deployment updates, while keeping semver bumps and tags as optional metadata.

### Acceptance Criteria

- [x] Pushes to the configured main ref update `live`.
- [x] Pushes to other refs create or update generated deployments.
- [x] CLI deploy can target refs and lanes without requiring semver.
- [x] `bump` manages optional version metadata.
- [x] Tags remain available as rollback anchors.
- [x] Dirty and stale-release edge cases fail with structured errors where required by the decision record.

---

## Phase 9: Ship A Rigd MVP

**GitHub issue**: #10

**User stories**: 33, 38, 39, 40, 41, 42, 43, 44, 45, 46

### What To Build

Introduce `rigd` as a local runtime authority with a minimal local API for inventory, health, logs, lifecycle actions, deploy actions, and provider coordination. Keep the first slice local-first while preserving the outbound web-control-plane direction.

### Acceptance Criteria

- [x] `rigd` can start and report its own health locally.
- [x] `rigd` exposes project and deployment inventory.
- [x] `rigd` exposes structured log and health state.
- [x] `rigd` can accept lifecycle and deploy actions through the local API.
- [x] CLI commands can use `rigd` for at least one complete lifecycle/status path.
- [x] The outbound control-plane contract is documented even if the hosted side is not implemented here.

---

## Phase 10: Move Lifecycle, Logs, And Status Behind Rigd

**GitHub issue**: #11

**User stories**: 31, 32, 33, 38, 39, 40, 42, 43, 44, 45

### What To Build

Move the main runtime-facing command paths so lifecycle, logs, status, health, and process supervision use `rigd` as the source of truth rather than independently reassembling state.

### Acceptance Criteria

- [x] `up` and `down` use `rigd` for managed runtime lifecycle.
- [x] `status` reads deployment, health, and process state from `rigd`.
- [x] `logs` reads structured logs from `rigd`.
- [x] Process-group-aware supervision is preserved or improved.
- [x] CLI and local API views of runtime state agree.
- [x] Legacy direct-command paths are either compatibility wrappers or explicitly deprecated.

---

## Phase 11: Harden Deploy Reliability And Doctor

**GitHub issue**: #12

**User stories**: 31, 32, 35, 36, 37, 59

### What To Build

Add preflight, process-aware health validation, cutover safety, recovery behavior, and `doctor` checks around the rig deployment model and `rigd` state.

### Acceptance Criteria

- [x] Deploy preflight verifies dependencies, binaries, env, hooks, health checks, and port reservations before cutover.
- [x] Health checks cannot pass by accidentally observing another process.
- [x] Port conflicts report actionable process ownership details where available.
- [x] `doctor` reports PATH, binary/file, health, port, stale state, and provider issues.
- [x] Safe reconstruction paths are covered by tests.
- [x] Unsafe reconstruction fails with clear structured errors instead of guessing.

---

## Phase 12: Expand Init And Package-Manager Integration

**GitHub issue**: #13

**User stories**: 47, 48, 49, 56, 57, 58

### What To Build

Make `rig init` a full non-interactive setup tool for rig config, provider/profile selection, lane wiring, and optional package-manager integration.

### Acceptance Criteria

- [x] `rig init` can scaffold a valid rig config.
- [x] Provider/profile selection is explicit and scriptable.
- [x] Lane wiring is generated for `local`, `live`, and `deployments`.
- [x] Optional package-manager integration can add `rig:` scripts.
- [x] Conventional package scripts are not overwritten by default.
- [x] Non-JavaScript projects are unaffected unless they opt in.

---

## Phase 13: Retire Rig-Smoke

**GitHub issue**: #14

**User stories**: 50, 51, 52, 59

### What To Build

Remove the need for the separate smoke-only binary once main-binary E2E coverage with isolated state and stub providers reaches parity.

### Acceptance Criteria

- [x] Main-binary E2E coverage matches or exceeds the smoke binary coverage.
- [x] Tests run safely under isolated state without touching real launchd, Caddy, or user rig state.
- [x] The smoke binary is removed or reduced to a temporary thin wrapper according to the decision record.
- [x] Build scripts and docs no longer teach smoke-only behavior as the target architecture.

---

## Stage 2 Continuation

The next issue batch is planned in [`plans/rig-stage-2.md`](./rig-stage-2.md).

Stage 2 covers:

- #16 Define rig provider plugin contracts. Complete: `RigProviderRegistry`
  now reports shared first-party/external plugin metadata for default, stub,
  and isolated E2E compositions.
- #17 Persist rigd runtime state and reconciliation journal. Complete:
  `RigdStateStore` persists events, receipts, health summaries, provider
  observations, deployment snapshots, rigd-owned port reservations, and desired
  deployment state. `rigd.start` reconciles desired-running deployment records
  after process restart. `rigd.managedProcessExited` records crash evidence,
  restarts desired-running deployments while the retry budget allows it, and
  marks repeated crashes failed.
- #18 Add localhost-first control-plane interface. Complete: `RigControlPlane`
  now reports localhost-only, Tailscale DNS, public tunnel, token-pairing, and
  envelope serialization contracts through interfaces.
- #19 Expose web read models through rigd. Complete: `rigd.webReadModel` and
  `rigd.webLogs` expose project, deployment, health, and filtered log read
  models through plain control-plane envelopes.
- #20 Route web lifecycle and deploy actions through rigd. Complete:
  `rigd` accepts control-plane lifecycle, live deploy, generated deploy, and
  generated teardown actions through the same durable receipt/event state used
  by CLI-visible runtime behavior.
- #21 Add safe config edit workflow through rigd. Complete:
  `rigd.configRead`, `rigd.configPreview`, and `rigd.configApply` expose
  structured, schema-validated, revision-checked config editing with atomic
  writes and backup recovery information.
- #24 Expose rigd config editing through rig CLI or control-plane transport.
  Complete: `rig config read`, `rig config set`, and `rig config unset`
  provide project config read, preview-by-default patching, and explicit
  `--apply` writes through the same revision-checked `rigd` config editor.
- #22 Prepare rig to main rig cutover readiness. Complete: the AFK
  readiness audit and rig user guide are documented in
  `docs/rig-cutover-readiness.md` and `docs/rig-guide.md`; HITL decision
  was to remove v1 and promote rig as `rig` in a deliberate cutover commit
  rather than routing selected commands through v1.
- #25 Connect rig lifecycle and deploy actions to provider-backed execution.
  Complete: config-backed `rigd` lifecycle/deploy/destroy writes now execute
  through `RigRuntimeExecutor` before receipts/logs persist; repo-inferred and
  explicit `--config` CLI paths now load validated rig config through an
  interface and pass it into lifecycle, status, and deploy calls. Runtime
  provider family services now expose operation methods that the executor
  calls in order for lifecycle, deploy, and generated teardown. Runtime
  execution now emits component-scoped events through the event-transport
  provider, and `rigd` persists them into web/CLI log filters. The
  `structured-log-file` event transport now appends deployment-scoped JSONL
  under each rig deployment log root. The `native-health` provider now performs
  real HTTP and command checks and returns tagged runtime failures for
  unhealthy, unreachable, or non-zero checks. The `package-json-scripts`
  provider now runs installed-component build commands from the deployment
  workspace, installs executables into the rig-managed bin root, and reports
  tagged failures. Process-supervisor providers can now
  return stdout/stderr lines that are persisted through component log events,
  and the core `rigd` process supervisor now runs managed component commands
  while returning stdout/stderr output for log ingestion.
  `RigHomeConfigStore` now reads and writes schema-validated home config under
  the rig state root, and deploy intent resolution uses project
  `live.deployBranch` before home `deploy.productionBranch` before `main`.
  Generated deployment caps from home config are enforced during deploy-intent
  materialization and `rigd` generated deploy actions with `reject` and
  `oldest` replacement policies. #27 is complete for launchd
  process-supervisor execution, #28 is complete for `caddy` proxy routing,
  #29 is complete for `local-git` ref preparation, and #30 is complete for
  `git-worktree` workspace materialization. The bundled Caddy provider now
  adopts existing same-domain site blocks instead of appending ambiguous
  duplicates, renders portable reverse-proxy-only blocks by default, accepts
  home-config-style Caddyfile path and per-site extra config, and can run an
  explicitly configured reload command after route writes. Config-backed
  lifecycle and deploy actions now persist desired running/stopped deployment
  state, and `rigd.start` reconciles desired-running records through the
  runtime executor after process restart. `rigd.managedProcessExited` records
  crash evidence, restarts while the retry budget allows it, and marks repeated
  crashes failed. A later integration slice should wire concrete process
  watchers into that policy entrypoint.
