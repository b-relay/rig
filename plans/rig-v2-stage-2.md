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
- **Cutover safety**: `rig2` remains isolated until replacement readiness verifies provider safety, docs, validation, rollback behavior, and the final rename/build path.

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

- [x] `rigd` persists action receipts, runtime events, deployment state, and health summaries under the v2 state root.
- [x] Port reservations are owned by `rigd` and survive process restart where safe.
- [x] Reconciliation records provider observations and separates confirmed state from stale or missing evidence.
- [x] Restarting `rigd` reconstructs minimum operational state from persisted evidence and provider state where safe.
- [x] Unsafe reconstruction returns tagged structured errors with actionable hints.
- [x] Tests cover restart, stale state, missing evidence, and generated deployment inventory reconciliation.

### Current Output

`src/v2/rigd-state.ts` defines the `V2RigdStateStore` interface with file and
memory-backed layers. The live `rigd` path persists runtime events, accepted
action receipts, health summaries, provider observations, deployment snapshots,
rigd-owned port reservations, and desired deployment state to
`runtime/rigd-state.json`. Restart tests prove a fresh `rigd` layer can recover
persisted logs, reconstruct minimum state, and reconcile desired-running
deployment records on `rigd.start`, while missing evidence returns a tagged
unsafe-reconstruction error. `rigd.managedProcessExited` now records managed
process crash evidence, restarts desired-running deployments while the retry
budget allows it, and marks repeated crashes as failed instead of retrying
forever.

---

## Phase 16: Add Localhost-First Control-Plane Interface

**GitHub issue**: #18

**Type**: AFK

**Blocked by**: #16

**User stories**: 41, 53, 54, 59

### What To Build

Add the localhost-first control-plane boundary for `rigd`, including the local server contract, Tailscale-friendly access assumptions, optional tunnel-provider shape, token-pairing boundaries for public internet exposure, connection state, heartbeat/event envelopes, command envelopes, and stub transport coverage.

### Acceptance Criteria

- [x] Control-plane local server and optional tunnel exposure are interface/services with default and stub implementations.
- [x] The default contract binds to `127.0.0.1` and does not expose a public machine port.
- [x] Tailscale-only access can run without app-level auth when the network already provides access control.
- [x] Public internet exposure uses token-pairing auth behind an interface.
- [x] `rigd` can report local server status, exposure mode, last heartbeat, and last transport/tunnel error.
- [x] Runtime events and action receipts can be serialized into plain JSON control-plane message shapes.
- [x] Tests cover localhost-only, Tailscale-mode, token-pairing required, tunnel failure, and stub transport paths.

### Current Output

`src/v2/control-plane.ts` defines the localhost-first control-plane service,
local-server service, tunnel exposure service, and auth service. The default
composition reports a local server bound to `127.0.0.1` with no public machine
port, Tailscale DNS mode without app auth, and public tunnel mode with
token-pairing auth plus tunnel error reporting. Stub composition is available
for tests. `rigd` health now includes the control-plane runtime status, and
events/receipts serialize into plain JSON envelopes.

---

## Phase 17: Expose Web Read Models Through Rigd

**GitHub issue**: #19

**Type**: AFK

**Blocked by**: #17, #18

**User stories**: 42, 43, 44, 38, 40

### What To Build

Expose the read-side contract that the future web control plane needs from `rigd`: project list, deployment list, health snapshots, and structured log windows for `local`, `live`, and generated deployments.

### Acceptance Criteria

- [x] `rigd` exposes a project list read model suitable for the web control plane.
- [x] `rigd` exposes deployment rows for `local`, `live`, and generated deployments.
- [x] Health snapshots distinguish `rigd`, deployment, component, and provider status.
- [x] Structured logs are queryable by project, deployment/lane, component, and line window.
- [x] Read models serialize cleanly into plain JSON control-plane message shapes without leaking provider internals.
- [x] Tests cover empty state, multiple projects, generated deployments, stale health, and log filtering.

### Current Output

`rigd.webReadModel` reads durable state and returns web-ready project rows,
deployment rows, and health snapshots for `rigd`, deployments, components, and
providers. `rigd.webLogs` filters structured events by project, lane,
deployment, component, and line window. The control-plane service serializes
read models into plain JSON `read-model` envelopes for the future hosted UI.

---

## Phase 18: Route Web Lifecycle And Deploy Actions Through Rigd

**GitHub issue**: #20

**Type**: AFK

**Blocked by**: #18, #19

**User stories**: 45, 38, 39, 40

### What To Build

Add the write-side control-plane action contract for lifecycle actions, deploy actions, generated deployment teardown, and durable action receipts that match CLI-visible runtime state.

### Acceptance Criteria

- [x] `rigd` accepts lifecycle actions from the control-plane boundary and routes them through the same runtime authority path as CLI actions.
- [x] `rigd` accepts deploy actions from the control-plane boundary for `live` and generated deployments.
- [x] Generated deployment destroy actions are explicit and cannot target `local` or `live` accidentally.
- [x] Every accepted action returns a durable receipt and emits structured events/logs.
- [x] Invalid target, stale state, provider failure, and preflight failure cases return tagged structured errors.
- [x] Tests prove CLI and control-plane action paths produce consistent inventory, health, log, and receipt state.

### Current Output

`rigd` now exposes control-plane write methods for lifecycle, live deploy,
generated deploy, and generated teardown. Lifecycle actions share the same
receipt/event path as CLI lifecycle calls. Generated deploy actions
materialize inventory before accepting the action, generated teardown can only
target generated deployments, and accepted write actions persist receipts plus
structured events into `runtime/rigd-state.json`.

`src/v2/rigd-actions.ts` defines an injectable action preflight interface so
provider capability checks and deploy preflight checks stay behind an Effect
service boundary. Tests cover CLI/control-plane lifecycle parity, live and
generated deploy receipts, generated inventory updates, explicit destroy
target validation, stale generated teardown, provider failure, preflight
failure, filtered logs, read models, and control-plane receipt envelopes.

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

- [x] `rigd` exposes current config read output suitable for a web editor.
- [x] All v2 config fields are representable by the edit model, even if advanced UI controls land incrementally.
- [x] Proposed config edits are represented as structured patches rather than arbitrary string writes.
- [x] Every edit is validated with v2 Effect Schema before writing.
- [x] Diff/preview output identifies changed fields and user-facing schema documentation where useful.
- [x] Apply is atomic and leaves the previous config recoverable on write or validation failure.
- [x] Tests cover valid edits, invalid schema edits, concurrent/stale edit attempts, and rollback behavior.

### Current Output

`src/v2/config-editor.ts` defines the config editor interfaces for reading,
previewing, and applying v2 config edits through structured patch operations.
`rigd.configRead` returns editor-ready raw config, decoded config, revision,
and field docs. `rigd.configPreview` applies patches in memory, validates the
candidate config with the v2 Effect Schema, and returns field-doc-aware diffs
without writing. `rigd.configApply` repeats the same validation, rejects stale
revisions, writes atomically through the config file store, and reports the
backup path for recovery.

The patch model uses path arrays and `set`/`remove` operations, so every v2
config field can be represented without arbitrary text writes. Tests cover
valid preview/apply, invalid schema edits, stale concurrent edits, and write
failure recovery.

---

## Phase 20: Prepare Rig2 To Main Rig Cutover Readiness

**GitHub issue**: #22

**Type**: HITL

**Blocked by**: #14, #20, #21

**User stories**: 55, 59, 60, 63

### What To Build

Create the cutover readiness slice for replacing the current `rig` CLI with
the isolated `rig2` CLI when it is safe. The long-term goal is that v2 becomes
`rig`; `rig2` is temporary migration runway, not a permanent second product.

There are no external users to preserve compatibility for. The cutover is a
rename/build replacement, not gradual command routing through v1. The safety
requirement is to keep current machine state isolated until the replacement is
deliberate.

### Acceptance Criteria

- [x] A cutover readiness checklist exists in docs and maps final CLI areas to their v2 readiness status.
- [ ] Main-binary tests cover the replacement `rig` CLI under isolated state and safe provider composition.
- [x] Legacy v1 command behavior is not a long-term compatibility requirement; v1 remains available only until the deliberate replacement rename.
- [x] Provider/profile selection prevents accidental launchd, Caddy, or user-state mutation in tests.
- [x] Release/cutover docs explain how to validate, roll back, and keep production apps safe during migration.
- [x] The plan explicitly covers renaming/building `rig2` behavior as `rig` when v2 becomes default.
- [x] Remaining post-cutover gaps are filed as follow-up issues instead of hidden in the plan.

### Current AFK Output

`docs/rig-v2-cutover-readiness.md` records the replacement readiness matrix,
provider safety requirements, validation checklist, rollback checklist, rename
plan, and remaining gaps before v2 becomes the default `rig` behavior.
`docs/rig2-guide.md` gives a short user-facing guide for using `rig2` today
and understanding the differences from rig v1.

Remaining follow-up issues capture the final `rig2` to `rig` replacement path,
hosted control-plane transport for `rig.b-relay.com`, and provider adapter
parity for proxy routing, SCM checkout, and workspace materialization.
#24 is complete: `rig2 config read/set/unset` now expose the `rigd` config
read, preview, and apply workflow through a user-facing CLI.

Runtime routing from `rig` to v2 remains intentionally unchanged. The approved
direction is to keep `rig2` isolated until it is ready, then rename/build it as
`rig` as an entirely new CLI.

### Follow-Up Progress

- #25 complete: `src/v2/runtime-executor.ts` defines the v2 runtime
  executor interface. Config-backed `rigd` lifecycle, live deploy, generated
  deploy, and generated destroy actions now execute through that provider
  interface before durable receipts and logs are persisted. `rig2` now loads
  validated v2 config for repo-inferred and explicit `--config` command paths,
  then passes that config into lifecycle, status, and deploy calls. Runtime
  provider family services now expose operation methods that
  `V2RuntimeExecutorLive` invokes in order. Lane config now carries
  `providers.processSupervisor`, defaulting to core `rigd` while letting lanes
  select the bundled `launchd` process-supervisor plugin through the same
  interface shape future external providers will use. Runtime execution now
  emits component-scoped events through the event-transport provider, and
  `rigd` persists them into the same log stream used by CLI and web filters.
  The `structured-log-file` event transport now appends deployment-scoped JSONL
  under each v2 deployment log root. The `native-health` provider now performs
  real HTTP and command checks and returns tagged runtime failures for
  unhealthy, unreachable, or non-zero checks. The `package-json-scripts`
  provider now runs installed-component build commands from the deployment
  workspace, installs the resulting executable into the v2-managed bin root,
  and reports tagged failures. Process-supervisor providers can now
  return stdout/stderr lines that are persisted through component log events,
  and the core `rigd` process supervisor now runs managed component commands
  while returning stdout/stderr output for log ingestion. Generated deployment
  caps from home config are enforced during deploy-intent materialization and
  `rigd` generated deploy actions with `reject` and `oldest` replacement
  policies. Config-backed lifecycle and deploy actions now persist desired
  running/stopped deployment state, and `rigd.start` reconciles desired-running
  records through the runtime executor after process restart.
  `rigd.managedProcessExited` records crash evidence, restarts while the retry
  budget allows it, and marks repeated crashes failed. The core `rigd`
  process-supervisor provider reports real child-process exits into that policy
  entrypoint, and status output includes desired deployment state plus recent
  managed-service failure evidence. #27 is complete: the launchd
  process-supervisor provider installs
  v2-namespaced plists, bootstraps them with launchctl, removes them on down,
  and supports injected launchctl/home paths for isolated tests. #30 is
  complete: the `git-worktree` workspace materializer removes stale worktrees,
  materializes detached workspaces at deploy refs, removes generated
  workspaces during teardown, and receives source repo paths from loaded
  config. #29 is complete: `local-git` fetches origin refs, verifies deploy
  refs resolve to commits, and reports tagged runtime errors for fetch or
  ref-resolution failures. #28 is complete: `caddy` upserts and removes
  v2-namespaced Caddyfile routes from deployment domains to localhost
  component ports, adopts same-domain existing blocks to avoid duplicate
  ambiguous site definitions, renders portable reverse-proxy-only blocks by
  default, accepts home-config-style per-site extra config, and can run an
  explicitly configured reload command after writes.

### Future Plugin Preset Track

After the core provider-adapter parity work, add a separate product/design
track for ecosystem plugins and presets. The first useful set is:

- **Convex Local plugin**: manages a per-deployment Convex Local instance,
  database/data root, ports, and health checks for each `local`, `live`, or
  generated deployment.
- **Next.js plugin**: scaffolds common managed/installed components, build
  commands, health checks, and proxy defaults for Next.js apps without
  requiring users to hand-author the full v2 config.
- **Vite plugin**: scaffolds Vite dev/preview/build components, port/health
  defaults, and proxy wiring for local and generated deployments.
- **Postgres plugin**: adds a supervised localhost-bound database component
  with per-lane/per-deployment port and data-root tracking.
- **SQLite plugin**: adds per-lane/per-deployment database file path tracking.
  SQLite is a file-backed dependency rather than a supervised daemon, so the
  first plugin should not pretend it has a process to supervise.

These should not be hard-coded app presets in core. They should exercise the
same plugin/provider boundaries as first-party adapters, with the Convex Local
case treated as a component-owning environment plugin that can allocate and
persist per-deployment state.

Rig should own local service supervision plus the deployment metadata needed to
keep all parts of a website/service in one project lifecycle: assigned
localhost ports, data roots, generated subdomains, and base-domain-derived URLs.
Application environment variables, database users, schemas, migrations, and
connection strings remain developer-owned unless a later plugin explicitly adds
helpers.

The first implementation step is a deployment-level `dataRoot` interpolated as
`${dataRoot}`. It lives under isolated v2 state rather than the app repository:
`<stateRoot>/data/<project>/<lane>` for `local` and `live`, and
`<stateRoot>/data/<project>/deployments/<name>` for generated deployments. This
is enough for simple SQLite usage without introducing automatic environment
variable or connection-string management.

The first component-plugin shape is `uses`, not `type` or another `mode`.
`mode` stays reserved for raw Rig primitives such as `managed` and `installed`;
`uses` means the component is supplied by a bundled or future external plugin.
SQLite is file-backed:

```json
{
  "components": {
    "db": {
      "uses": "sqlite"
    },
    "api": {
      "mode": "managed",
      "command": "bun run api -- --sqlite ${db.path}",
      "dependsOn": ["db"]
    }
  }
}
```

The default SQLite path is `${dataRoot}/sqlite/<component>.sqlite`, so
`${db.path}` resolves to `${dataRoot}/sqlite/db.sqlite` for a component named
`db`. `rigd` prepares the parent directory on `up` and deploy before managed
processes start.

Postgres is process-backed:

```json
{
  "components": {
    "postgres": {
      "uses": "postgres"
    },
    "api": {
      "mode": "managed",
      "command": "bun run api -- --postgres ${postgres.port}",
      "dependsOn": ["postgres"]
    }
  }
}
```

Postgres defaults to `${dataRoot}/postgres/<component>` for its data directory,
exposes `${postgres.dataDir}` and `${postgres.port}`, and resolves to a managed
service bound to `127.0.0.1`. The default command runs `initdb` on first start
when `PG_VERSION` is missing, then runs `postgres -D <dataDir> -h 127.0.0.1 -p
<port>`. Rig does not create database users, schemas, migrations, or connection
strings. Lane overrides can still set `port`, `command`, `health`,
`readyTimeout`, and `dependsOn`.

Convex Local is process-backed:

```json
{
  "components": {
    "convex": {
      "uses": "convex"
    },
    "api": {
      "mode": "managed",
      "command": "bun run api -- --convex ${convex.url}",
      "dependsOn": ["convex"]
    }
  }
}
```

Convex resolves to a managed service using `bunx convex dev --local
--local-cloud-port <port> --local-site-port <sitePort>`, a health check at
`${convex.url}/instance_name`, and Convex's project-local state directory at
`${workspace}/.convex/local/default`. Rig exposes `${convex.url}`,
`${convex.siteUrl}`, `${convex.port}`, `${convex.sitePort}`, and
`${convex.stateDir}` for interpolation. Lane overrides can still set `port`,
`sitePort`, `command`, `health`, `readyTimeout`, and `dependsOn`.

Convex CLI 1.36.1 does not expose a supported data-directory flag for
`convex dev`; it stores local backend state under the workspace `.convex`
directory and passes sqlite/storage paths only to its internal backend binary.
Rig keeps that behavior instead of relying on unsupported backend flags.

`uses` components now resolve through a first-party component-plugin resolver
boundary. This is intentionally smaller than external plugin loading: core can
keep SQLite, Convex Local, and Postgres defaults behind one resolver interface
before the distribution/install story exists.

Caddy remains the first router provider for Rig v2. Traefik and Pangolin are
tracked as research references, not immediate defaults: Traefik is attractive
for Docker/provider-discovery systems, while Pangolin is an identity-aware
remote access/tunnel layer. Database plugins do not require remote access;
optional exposure can come later through a dedicated provider. Tailscale should
stay outside Rig as machine/network plumbing; users can point private DNS at
the machine and Rig only needs to serve the configured localhost-bound services
and domains.
