# Plan: rig v2 runtime authority deepening

> Source PRD: GitHub issue #31
> Source issue set: GitHub issues #32 through #47

## Architectural Decisions

Durable decisions that apply across this stage:

- **Deploy intent is pure**: deploy intent classifies a requested deploy as
  `live` or generated, with optional version and rollback metadata. It does not
  materialize deployments, enforce caps, write inventory, reserve ports, emit
  receipts, or start processes.
- **Runtime authority**: `rigd` is the only module that mutates lifecycle and
  deploy runtime state.
- **Replacement policy**: home config owns the machine default generated
  deployment cap and replacement policy. Project config may later override it.
  `rigd` enforces the policy because replacement mutates runtime state.
- **Runtime journal**: accepted receipts, runtime events, health summaries,
  provider observations, deployment snapshots, port reservations, desired
  deployment state, and managed process failures are recorded through an
  internal `rigd` journal module.
- **Read models**: project lists, deployment rows, health snapshots, and log
  windows are derived from runtime journal evidence so CLI and web views agree.
- **Preflight gate**: preflight is the safety gate before lifecycle or deploy
  actions mutate runtime state. Doctor reports the same evidence for humans.
- **Runtime plan**: v2 config resolution should produce a v2 runtime plan using
  deployments, lanes, managed components, installed components, roots, proxy
  config, provider selections, hooks, env, health, and dependencies. V1-shaped
  runtime data is temporary migration code only.
- **Provider contracts and adapters**: provider contracts stay small. Each
  concrete provider adapter lives in its own focused module.
- **V1 deletion posture**: v1 remains in the repo only until cutover. Do not
  deepen v1-shaped interfaces unless they buy a short migration step.

---

## Phase 21: Make Deploy Intent Side-Effect-Free

**GitHub issue**: #32

**Type**: AFK

**Blocked by**: None

**User stories**: 1, 2, 3, 4, 6, 7

### What To Build

Make deploy intent a pure classification path for CLI and git-push deploy
requests. It should decide whether a ref targets live or a generated
deployment, but it must not materialize deployments, enforce generated
deployment caps, write inventory, reserve ports, emit receipts, or start
processes.

### Acceptance Criteria

- [ ] Deploy intent creation does not materialize generated deployments.
- [ ] Deploy intent creation does not enforce generated deployment caps.
- [ ] Deploy intent creation does not write deployment inventory or runtime
      state.
- [ ] CLI deploy still emits a useful deploy intent before `rigd` accepts the
      deploy action.
- [ ] Tests prove deploy intent is classification-only.

---

## Phase 22: Route Generated Deploy Replacement Through Rigd

**GitHub issue**: #33

**Type**: AFK

**Blocked by**: #32

**User stories**: 2, 3, 4, 5, 6, 7

### What To Build

Make `rigd` the only place that enforces generated deployment replacement
policy. CLI and control-plane generated deploys should route through the same
`rigd` action path for cap checks, oldest replacement, materialization,
receipts, and runtime evidence.

### Acceptance Criteria

- [ ] Generated deployment cap enforcement happens inside `rigd`.
- [ ] Reject policy returns a tagged structured error before materialization.
- [ ] Oldest replacement policy destroys the selected generated deployment
      through `rigd`-owned runtime mutation.
- [ ] CLI and control-plane generated deploys produce consistent receipts,
      inventory, health, and logs.
- [ ] Tests prove one generated deploy request produces one materialization
      path.

---

## Phase 23: Add Rigd Runtime Journal For Action Evidence

**GitHub issue**: #34

**Type**: AFK

**Blocked by**: #32

**User stories**: 8, 9, 10, 11, 12, 13, 14, 15

### What To Build

Add an internal runtime journal module behind `rigd` for recording runtime
evidence. `rigd` should record receipts, runtime events, health summaries,
provider observations, deployment snapshots, port reservations, desired
deployment state, and managed process failures through journal calls instead of
hand-assembling those writes inline.

### Acceptance Criteria

- [x] `rigd` records action receipts through the runtime journal.
- [x] `rigd` records runtime events through the runtime journal.
- [x] `rigd` records health summaries and provider observations through the
      runtime journal.
- [x] `rigd` records deployment snapshots and port reservations through the
      runtime journal.
- [x] `rigd` records desired deployment state and managed process failures
      through the runtime journal.
- [x] Existing persisted state remains readable.
- [x] Tests cover journal recording without requiring full lifecycle execution.

---

## Phase 24: Derive Read Models From Runtime Journal

**GitHub issue**: #35

**Type**: AFK

**Blocked by**: #34

**User stories**: 16, 17, 18

### What To Build

Move project list, deployment row, health snapshot, and log window derivation
behind read models backed by runtime journal evidence. CLI and
web/control-plane read paths should consume the same read-model output.

### Acceptance Criteria

- [ ] Project list read models derive from persisted runtime evidence.
- [ ] Deployment row read models derive from persisted runtime evidence.
- [ ] Health snapshot read models derive from persisted runtime evidence.
- [ ] Log windows derive from persisted runtime events and support existing
      filters.
- [ ] CLI and web/control-plane read paths use the same read-model output.
- [ ] Tests cover empty state, multiple projects, generated deployments, stale
      health, provider observations, and log filtering without full runtime
      execution.

---

## Phase 25: Make Preflight Block Unsafe Runtime Actions

**GitHub issue**: #36

**Type**: AFK

**Blocked by**: #32

**User stories**: 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30

### What To Build

Replace the no-op action preflight path with a real preflight module that
derives safety evidence for lifecycle and deploy actions. `rigd` must run
preflight before runtime mutation, and doctor should report the same evidence
instead of owning separate safety logic.

### Acceptance Criteria

- [ ] Lifecycle actions run preflight before runtime mutation.
- [ ] Deploy actions run preflight before checkout, materialization, process
      restart, proxy update, or cutover.
- [ ] Preflight can report dependency, binary, env, hook, health ownership,
      port, provider, and stale-state evidence.
- [ ] Preflight failures return tagged structured errors with actionable hints.
- [ ] Doctor reports the same preflight evidence used by `rigd`.
- [ ] Tests prove failed preflight prevents runtime execution and avoids
      partial inventory mutation where applicable.

---

## Phase 26: Introduce V2 Runtime Plan For One Lifecycle Path

**GitHub issue**: #37

**Type**: AFK

**Blocked by**: #32

**User stories**: 31, 32, 33, 34, 35

### What To Build

Make v2 config resolution produce a first-class runtime plan for one local/live
lifecycle path. The runtime plan should use Rig 2 concepts directly:
deployment, lane, roots, providers, proxy config, managed components, installed
components, hooks, env, health, ports, and dependencies.

### Acceptance Criteria

- [ ] Config resolution returns a v2 runtime plan for at least one lifecycle
      path.
- [ ] Managed components are represented without v1 `server` terminology.
- [ ] Installed components are represented without v1 `bin` terminology.
- [ ] Runtime execution can consume the runtime plan for one local/live
      lifecycle path.
- [ ] V1-shaped output is clearly isolated as temporary migration code.
- [ ] Tests assert runtime-plan behavior directly.

---

## Phase 27: Extend Runtime Plan Through Deploy And Preflight Paths

**GitHub issue**: #38

**Type**: AFK

**Blocked by**: #36, #37

**User stories**: 31, 32, 33, 34, 35

### What To Build

Move deploy execution and preflight evidence toward v2 runtime-plan inputs. The
deploy path and preflight path should consume the runtime plan rather than
depending on v1-shaped `Environment` or `RigConfig` data as their primary
interface.

### Acceptance Criteria

- [ ] Deploy execution can consume the v2 runtime plan for at least one
      complete path.
- [ ] Preflight can consume the v2 runtime plan for at least one complete check
      path.
- [ ] Managed and installed component behavior remains externally compatible.
- [ ] V1-shaped output remains isolated as temporary migration code only where
      still needed.
- [ ] Tests cover runtime-plan deploy and preflight behavior directly.

---

## Phase 28: Extract Process Supervisor Contract And Stub Adapter

**GitHub issue**: #39

**Type**: AFK

**Blocked by**: #37

**User stories**: 36, 37, 38, 39

### What To Build

Create the provider adapter file layout by extracting the process supervisor
contract and stub process supervisor adapter into focused modules. Composition
should still support the stub provider profile and contract tests should prove
the adapter satisfies the same interface.

### Acceptance Criteria

- [ ] Process supervisor contract is small and separate from concrete adapter
      implementation.
- [ ] Stub process supervisor adapter lives in a focused module.
- [ ] Stub provider profile composition still works.
- [ ] Existing process supervisor contract behavior remains externally
      compatible.
- [ ] Tests prove the stub adapter satisfies the process supervisor contract.

---

## Phase 29: Extract Rigd Process Supervisor Adapter

**GitHub issue**: #40

**Type**: AFK

**Blocked by**: #39

**User stories**: 36, 37, 38, 39

### What To Build

Move `rigd` process supervision into a focused provider adapter module.
Preserve subprocess startup, restart, stop, output capture, exit watcher, and
managed process failure behavior behind the process supervisor contract.

### Acceptance Criteria

- [ ] `rigd` process supervisor implementation lives in a focused adapter
      module.
- [ ] Startup, restart, stop, output capture, and exit watcher behavior remain
      externally compatible.
- [ ] Managed process exit handling still records failures through `rigd`.
- [ ] Default provider composition still selects `rigd` supervision where
      configured.
- [ ] Tests cover quick exits, later exits, output capture, and restart
      behavior through the contract.

---

## Phase 30: Extract Launchd Process Supervisor Adapter

**GitHub issue**: #41

**Type**: AFK

**Blocked by**: #39

**User stories**: 36, 37, 38, 39

### What To Build

Move launchd process supervision into a focused provider adapter module.
Preserve v2 label isolation, plist rendering, launchctl bootstrap/bootout
behavior, log paths, and error reporting behind the process supervisor
contract.

### Acceptance Criteria

- [ ] Launchd process supervisor implementation lives in a focused adapter
      module.
- [ ] Plist rendering preserves v2 namespace and label isolation.
- [ ] Bootstrap and bootout behavior remains externally compatible.
- [ ] Launchd errors remain tagged and actionable.
- [ ] Tests cover install/remove behavior and provider selection through the
      contract.

---

## Phase 31: Extract Caddy Proxy Router Adapter

**GitHub issue**: #42

**Type**: AFK

**Blocked by**: #38

**User stories**: 36, 37, 38, 39

### What To Build

Move Caddy proxy routing into a focused provider adapter module. Preserve
v2-managed block parsing, v1 marker compatibility where still needed during
migration, route upsert/remove behavior, backup behavior, reload
configuration, and tagged errors.

### Acceptance Criteria

- [ ] Caddy proxy router implementation lives in a focused adapter module.
- [ ] V2-managed block parsing and rendering remain externally compatible.
- [ ] Route upsert and remove preserve non-rig Caddyfile content.
- [ ] Backup and reload behavior remain externally compatible.
- [ ] Tests cover upsert, remove, v1 marker migration behavior, conflict
      handling, backup, and reload errors.

---

## Phase 32: Extract Git SCM And Worktree Adapters

**GitHub issue**: #43

**Type**: AFK

**Blocked by**: #38

**User stories**: 36, 37, 38, 39

### What To Build

Move local git SCM and git worktree materialization into focused provider
adapter modules. Preserve source repo resolution, fetch/ref verification,
worktree materialization, worktree removal, missing-worktree handling, and
tagged errors.

### Acceptance Criteria

- [ ] Local git SCM implementation lives in a focused adapter module.
- [ ] Git worktree materializer implementation lives in a focused adapter
      module.
- [ ] Source repo resolution remains externally compatible.
- [ ] Fetch, ref verification, materialize, and remove behavior remain
      externally compatible.
- [ ] Tests cover successful checkout/materialization, missing refs, missing
      source repo, and remove idempotence.

---

## Phase 33: Extract Native Health And Lifecycle Hook Adapters

**GitHub issue**: #44

**Type**: AFK

**Blocked by**: #38

**User stories**: 36, 37, 38, 39

### What To Build

Move native health checking and shell lifecycle hook execution into focused
provider adapter modules. Preserve HTTP health checks, command health checks,
timeouts, hook working directory behavior, output capture, and tagged errors.

### Acceptance Criteria

- [ ] Native health checker implementation lives in a focused adapter module.
- [ ] Shell lifecycle hook implementation lives in a focused adapter module.
- [ ] HTTP and command health behavior remains externally compatible.
- [ ] Timeout and failed-command errors remain tagged and actionable.
- [ ] Tests cover healthy/unhealthy HTTP, command success/failure, timeout, and
      hook failure behavior through provider contracts.

---

## Phase 34: Extract Package Manager Adapter

**GitHub issue**: #45

**Type**: AFK

**Blocked by**: #38

**User stories**: 36, 37, 38, 39

### What To Build

Move package manager install behavior into a focused provider adapter module.
Preserve build execution, entrypoint validation, command shims, script shims,
binary copying, install naming, bin root handling, and tagged errors.

### Acceptance Criteria

- [ ] Package manager provider implementation lives in a focused adapter
      module.
- [ ] Build and install behavior remains externally compatible.
- [ ] Entrypoint workspace containment checks remain enforced.
- [ ] Command, script, and binary install paths remain externally compatible.
- [ ] Tests cover build success/failure, command entrypoints, file entrypoints,
      binary copying, and unsafe path rejection.

---

## Phase 35: Extract Event Transport And Remaining Stub Adapters

**GitHub issue**: #46

**Type**: AFK

**Blocked by**: #38

**User stories**: 36, 37, 38, 39

### What To Build

Move structured event transport and remaining stub provider behavior into
focused adapter modules. Preserve JSONL event writes, stub operation strings,
provider profile behavior, and test-safe composition.

### Acceptance Criteria

- [ ] Structured event transport implementation lives in a focused adapter
      module.
- [ ] Remaining stub adapters live in focused modules.
- [ ] JSONL event write behavior remains externally compatible.
- [ ] Stub provider operation strings remain externally compatible where tests
      depend on them.
- [ ] Stub and isolated provider profile composition remains test-safe.

---

## Phase 36: Trim Provider Contracts To Interfaces And Composition

**GitHub issue**: #47

**Type**: AFK

**Blocked by**: #40, #41, #42, #43, #44, #45, #46

**User stories**: 36, 37, 38, 39

### What To Build

After concrete provider adapters are extracted, reduce the provider contracts
module to small provider family interfaces, shared metadata, registry
reporting, and composition glue. Adapter implementations should live in focused
modules.

### Acceptance Criteria

- [ ] Provider contract modules contain small interfaces and shared metadata,
      not concrete adapter implementations.
- [ ] Provider composition selects extracted adapters for default, stub, and
      isolated profiles.
- [ ] Default, stub, isolated, and first-party adapters satisfy the same
      provider contracts.
- [ ] Provider contract tests continue to prove swappability across provider
      profiles.
- [ ] The large provider contract module is reduced to contract and composition
      responsibilities.
