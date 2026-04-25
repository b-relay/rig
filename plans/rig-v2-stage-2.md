# Plan: rig v2 stage 2

> Source PRD: GitHub issue #2
> Source issue set: GitHub issues #16 through #22

## Architectural Decisions

Durable decisions that apply across this stage:

- **Provider boundary**: every external concern stays behind an Effect v4 service interface. First-party bundled plugins and future external plugins should use the same API; the difference is distribution, not abstraction.
- **Runtime authority**: `rigd` remains the owner of deployment inventory, receipts, logs, health, ports, provider observations, and reconciliation state.
- **Control-plane shape**: `rigd` is localhost-first on `127.0.0.1`, and the hosted web UI is `https://rig.b-relay.com`. Private remote access can be handled by Tailscale DNS routing to localhost; public internet exposure should be handled by a provider/plugin such as Cloudflare Tunnel.
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

Deepen the v2 provider model into explicit Effect v4 service interfaces for process supervision, proxy/routing, SCM, workspace/deployment materialization, logging/event transport, control-plane transport, health checking, package-manager integration, and optional tunnel/exposure providers.

### Acceptance Criteria

- [x] V2 provider families are represented as explicit interfaces/services, not concrete provider imports in core logic.
- [x] First-party bundled providers and future external providers use the same API shape.
- [x] Default, stub, and isolated E2E provider compositions satisfy the same provider contract surface.
- [x] Provider selection remains visible at config or execution boundaries where users and tests need to inspect it.
- [x] Provider capability metadata can be reported to `rigd` and `doctor`.
- [x] Tests prove v2 runtime code can swap provider compositions without changing command or core modules.
- [x] Existing v1 provider behavior remains compatible during migration.

### Current Output

`src/v2/provider-contracts.ts` defines explicit Effect service tags for each
provider family plus the v2 provider registry service and shared plugin
metadata shape for first-party and future external providers. Default, stub,
and isolated E2E reports cover process supervision,
proxy/routing, SCM, workspace materialization, event transport, localhost
control-plane transport, health checks, package-manager integration, and
tunnel/exposure. `rigd` health and `rig2 doctor` now report the selected
provider profile and capability metadata.

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

## Phase 16: Add Localhost-First Control-Plane Interface

**GitHub issue**: #18

**Type**: AFK

**Blocked by**: #16

**User stories**: 41, 53, 54, 59

### What To Build

Add the localhost-first control-plane boundary for `rigd`, including the local server contract, Tailscale-friendly access assumptions, optional tunnel-provider shape, token-pairing boundaries for public internet exposure, connection state, heartbeat/event envelopes, command envelopes, and stub transport coverage.

### Acceptance Criteria

- [ ] Control-plane local server and optional tunnel exposure are interface/services with default and stub implementations.
- [ ] The default contract binds to `127.0.0.1` and does not expose a public machine port.
- [ ] Tailscale-only access can run without app-level auth when the network already provides access control.
- [ ] Public internet exposure uses token-pairing auth behind an interface.
- [ ] `rigd` can report local server status, exposure mode, last heartbeat, and last transport/tunnel error.
- [ ] Runtime events and action receipts can be serialized into plain JSON control-plane message shapes.
- [ ] Tests cover localhost-only, Tailscale-mode, token-pairing required, tunnel failure, and stub transport paths.

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
- [ ] Read models serialize cleanly into plain JSON control-plane message shapes without leaking provider internals.
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

The target product behavior is that all v2 config fields can be edited through
the web UI eventually. Implementation can land in safe vertical slices, but the
interface should not assume only a tiny permanent subset of fields is editable.

### Acceptance Criteria

- [ ] `rigd` exposes current config read output suitable for a web editor.
- [ ] All v2 config fields are representable by the edit model, even if advanced UI controls land incrementally.
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

Create the cutover readiness slice for moving v2 behavior from the isolated `rig2` runway into the main `rig` binary when it is safe. The long-term goal is that v2 becomes `rig`; `rig2` is temporary migration runway, not a permanent second product.

This should not prematurely remove v1 compatibility.

### Acceptance Criteria

- [ ] A cutover readiness checklist exists in docs and maps each main command to its v2 equivalent or compatibility behavior.
- [ ] Main-binary tests cover the selected v2 paths under isolated state and safe provider composition.
- [ ] Legacy v1 command behavior remains available or has explicit deprecation messaging.
- [ ] Provider/profile selection prevents accidental launchd, Caddy, or user-state mutation in tests.
- [ ] Release/cutover docs explain how to validate, roll back, and keep production apps safe during migration.
- [ ] The plan explicitly covers renaming or routing `rig2` behavior into `rig` when v2 becomes default.
- [ ] Remaining post-cutover gaps are filed as follow-up issues instead of hidden in the plan.
