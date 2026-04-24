# Plan: rig v2 stage 2

> Source PRD: GitHub issue #2
> Source issue set: GitHub issues #16 through #22

## Architectural Decisions

Durable decisions that apply across this stage:

- **Provider boundary**: every external concern stays behind an Effect v4 service interface. Core v2 and `rigd` code should consume provider contracts, not concrete provider modules.
- **Runtime authority**: `rigd` remains the owner of deployment inventory, receipts, logs, health, ports, provider observations, and reconciliation state.
- **Control-plane shape**: web integration is outbound-only from local `rigd` to `core.b-relay.com`; this repo defines local contracts, DTOs, and transport boundaries, not a separate hosted web app.
- **Read/write split**: web-facing read models and write actions are separate slices. Read models expose project, deployment, health, and log state. Write actions route lifecycle and deploy operations through the same `rigd` authority used by CLI commands.
- **Config editing**: web-facing config changes use structured patches validated by Effect Schema before atomic apply. Direct arbitrary file writes are not part of the control-plane contract.
- **Cutover safety**: v1 remains compatible until an explicit readiness gate verifies command parity, provider safety, docs, and rollback behavior.

---

## Phase 14: Define V2 Provider Plugin Contracts

**GitHub issue**: #16

**Type**: AFK

**Blocked by**: #7, #10

**User stories**: 39, 41, 53, 54, 59

### What To Build

Deepen the v2 provider model into explicit Effect v4 service interfaces for process supervision, proxy/routing, SCM, workspace/deployment materialization, logging/event transport, control-plane transport, health checking, and package-manager integration.

### Acceptance Criteria

- [ ] V2 provider families are represented as explicit interfaces/services, not concrete provider imports in core logic.
- [ ] Default and stub provider compositions satisfy the same provider contract surface.
- [ ] Provider selection remains visible at config or execution boundaries where users and tests need to inspect it.
- [ ] Provider capability metadata can be reported to `rigd` and `doctor`.
- [ ] Tests prove v2 runtime code can swap provider compositions without changing command or core modules.
- [ ] Existing v1 provider behavior remains compatible during migration.

---

## Phase 15: Persist Rigd Runtime State And Reconciliation Journal

**GitHub issue**: #17

**Type**: AFK

**Blocked by**: #11, #12, #16

**User stories**: 33, 34, 36, 37, 38, 39

### What To Build

Make `rigd` persist deployment inventory snapshots, action receipts, structured runtime events, health summaries, port reservations, provider reconciliation state, and bounded recovery evidence under the isolated v2 state root.

### Acceptance Criteria

- [ ] `rigd` persists action receipts, runtime events, deployment state, and health summaries under the v2 state root.
- [ ] Port reservations are owned by `rigd` and survive process restart where safe.
- [ ] Reconciliation records provider observations and separates confirmed state from stale or missing evidence.
- [ ] Restarting `rigd` reconstructs minimum operational state from persisted evidence and provider state where safe.
- [ ] Unsafe reconstruction returns tagged structured errors with actionable hints.
- [ ] Tests cover restart, stale state, missing evidence, and generated deployment inventory reconciliation.

---

## Phase 16: Add Outbound Control-Plane Transport Interface

**GitHub issue**: #18

**Type**: AFK

**Blocked by**: #16

**User stories**: 41, 53, 54, 59

### What To Build

Add the outbound-only transport boundary for `rigd` to connect to `core.b-relay.com`, including machine identity, token storage boundaries, connection state, heartbeat/event envelopes, command envelopes, and stub transport coverage.

### Acceptance Criteria

- [ ] Control-plane transport is an interface/service with default and stub implementations.
- [ ] The contract is outbound-only and does not require opening an inbound local port.
- [ ] Machine identity and token storage are modeled behind interfaces with structured errors.
- [ ] `rigd` can report connection status, last heartbeat, and last transport error.
- [ ] Runtime events and action receipts can be serialized into control-plane envelopes.
- [ ] Tests cover connected, disconnected, auth failure, retryable transport failure, and stub transport paths.

---

## Phase 17: Expose Web Read Models Through Rigd

**GitHub issue**: #19

**Type**: AFK

**Blocked by**: #17, #18

**User stories**: 42, 43, 44, 38, 40

### What To Build

Expose the read-side contract that the future web control plane needs from `rigd`: project list, deployment list, health snapshots, and structured log windows for `local`, `live`, and generated deployments.

### Acceptance Criteria

- [ ] `rigd` exposes a project list read model suitable for the web control plane.
- [ ] `rigd` exposes deployment rows for `local`, `live`, and generated deployments.
- [ ] Health snapshots distinguish `rigd`, deployment, component, and provider status.
- [ ] Structured logs are queryable by project, deployment/lane, component, and line window.
- [ ] Read models serialize cleanly into control-plane DTOs without leaking provider internals.
- [ ] Tests cover empty state, multiple projects, generated deployments, stale health, and log filtering.

---

## Phase 18: Route Web Lifecycle And Deploy Actions Through Rigd

**GitHub issue**: #20

**Type**: AFK

**Blocked by**: #18, #19

**User stories**: 45, 38, 39, 40

### What To Build

Add the write-side control-plane action contract for lifecycle actions, deploy actions, generated deployment teardown, and durable action receipts that match CLI-visible runtime state.

### Acceptance Criteria

- [ ] `rigd` accepts lifecycle actions from the control-plane boundary and routes them through the same runtime authority path as CLI actions.
- [ ] `rigd` accepts deploy actions from the control-plane boundary for `live` and generated deployments.
- [ ] Generated deployment destroy actions are explicit and cannot target `local` or `live` accidentally.
- [ ] Every accepted action returns a durable receipt and emits structured events/logs.
- [ ] Invalid target, stale state, provider failure, and preflight failure cases return tagged structured errors.
- [ ] Tests prove CLI and control-plane action paths produce consistent inventory, health, log, and receipt state.

---

## Phase 19: Add Safe Config Edit Workflow Through Rigd

**GitHub issue**: #21

**Type**: AFK

**Blocked by**: #19

**User stories**: 46, 53, 59, 62

### What To Build

Add the config edit workflow required by the future web control plane: read current v2 config, propose a structured patch, validate it through Effect Schema, preview the diff, apply it atomically, and report rollback/recovery information.

### Acceptance Criteria

- [ ] `rigd` exposes current config read output suitable for a web editor.
- [ ] Proposed config edits are represented as structured patches rather than arbitrary string writes.
- [ ] Every edit is validated with v2 Effect Schema before writing.
- [ ] Diff/preview output identifies changed fields and user-facing schema documentation where useful.
- [ ] Apply is atomic and leaves the previous config recoverable on write or validation failure.
- [ ] Tests cover valid edits, invalid schema edits, concurrent/stale edit attempts, and rollback behavior.

---

## Phase 20: Prepare Rig2 To Main Rig Cutover Readiness

**GitHub issue**: #22

**Type**: HITL

**Blocked by**: #14, #20, #21

**User stories**: 55, 59, 60, 63

### What To Build

Create the cutover readiness slice for moving v2 behavior from the isolated `rig2` runway toward the main `rig` binary when it is safe, without prematurely removing v1 compatibility.

### Acceptance Criteria

- [ ] A cutover readiness checklist exists in docs and maps each main command to its v2 equivalent or compatibility behavior.
- [ ] Main-binary tests cover the selected v2 paths under isolated state and safe provider composition.
- [ ] Legacy v1 command behavior remains available or has explicit deprecation messaging.
- [ ] Provider/profile selection prevents accidental launchd, Caddy, or user-state mutation in tests.
- [ ] Release/cutover docs explain how to validate, roll back, and keep production apps safe during migration.
- [ ] Remaining post-cutover gaps are filed as follow-up issues instead of hidden in the plan.
