# rig v2 — Redesign Spec

This document defines the target redesign for `rig`.

It is intentionally forward-looking. It describes where the product and architecture are going, not just what is implemented today.

For the currently shipped behavior, see [DESIGN.md](../DESIGN.md).

## Status

- `../DESIGN.md`: current/legacy implementation model
- `DESIGN_V2.md`: target redesign and migration contract

During the transition, contributors should treat this document as the source of truth for new architecture and UX decisions.

For practical rig2 usage during the transition, see
[`rig2-guide.md`](./rig2-guide.md). For the current replacement-readiness
audit, validation, rollback, and remaining HITL decisions, see
[`rig-v2-cutover-readiness.md`](./rig-v2-cutover-readiness.md).

## Migration Posture

V2 should be built as a parallel implementation path that can run next to the current v1 `rig`.

The current v1 binary can remain available while v2 is being developed and
tested, but there are no external users to preserve compatibility for. V2 is an
entirely new CLI model. When `rig2` is good enough, the cutover is a rename:
`rig2` becomes `rig`, rather than gradually routing selected v2 commands
through the old CLI.

The main safety requirement during development is not long-term v1
compatibility; it is avoiding accidental mutation of the maintainer's current
machine state until the replacement is ready.

Rules:

- keep the existing `rig` binary available until the replacement CLI is ready
- introduce a separate v2 dev binary or entrypoint, such as `rig2`, while v2 is incomplete
- use a separate v2 state root by default, such as `~/.rig-v2`, or require an explicit isolated `RIG_ROOT` during early work
- namespace v2 launchd labels, workspaces, logs, proxy entries, and runtime state so they cannot collide with v1
- do not let v2 manage current machine state until the replacement cutover is deliberate
- when v2 is ready, rename/build the `rig2` CLI as `rig` rather than adding a command-by-command compatibility gate
- copy or reuse proven v1 code patterns where useful, but do not force v2 through v1's env/service/release assumptions

Good candidates to reuse are provider interface ideas, structured logger shape, process-group handling, health checks, worktree mechanics, tagged error style, and behavior-focused tests.

Good candidates to replace are the `dev`/`prod` environment model, `server`/`bin` naming, semver-first deploy flow, hand-written CLI parsing, and Zod schemas.

## Product Goal

Make `rig` the simplest way for a human or AI agent to run, inspect, and deploy apps on a single machine.

The redesign optimizes for:
- one obvious workflow for long-running lifecycle
- much less config duplication
- safer, more reliable deploys
- first-class preview deployments
- one Effect-native backend stack
- plugin-driven architecture for portability and testing
- a local control plane that can feed the web UI at `rig.b-relay.com`

## Product Inspiration

Dokploy (sometimes written informally as Docploy in project notes) is an important product reference point for `rig` v2.

The inspiration is not a one-for-one copy. The useful idea is Dokploy's simplicity: a deployment wrapper with a friendly interface, practical defaults, and a feature set that makes self-hosting feel approachable.

`rig` aims for that same wrapper-style product feel, but without Docker or containers as the foundation. The design in this document stays centered on native local-machine process management, core `rigd` supervision, bundled launchd/Caddy/local git providers, provider plugins, and repo-first workflows.

Future contributors should understand this as product context: match the ease and polish of a Docker-first tool like Dokploy, while building the non-Docker architecture described here.

## Core Principles

1. `rig` is repo-first.
   Running inside a managed repo should not require a project name.

2. `rig` is lifecycle-first.
   Humans and AI agents should use `rig` for anything that starts, stops, supervises, deploys, or inspects long-running app state.

3. `rig` is plugin-driven.
   Every external concern remains behind an interface and can be swapped at composition time.

4. `rig` is git-push-first for deployments.
   Normal deploys should not require semver bumps or tags.

5. `rig` is local-control-plane-first.
   `rigd` is the runtime authority. CLI and web are clients.

6. `rig` is reconstructable.
   Persisted `.rig` state matters, but loss of that state should be survivable where possible.

7. `rig` v2 is Effect-native.
   Backend logic, schema validation, CLI parsing, services, layers, and structured errors should use the Effect ecosystem rather than a mix of Effect plus one-off parser/validator libraries.

## Operating Decisions

These decisions close the initial v2 product questions that affect command behavior, generated deployments, health checks, status, and logs.

### Cross-project targeting

The explicit cross-project selector is `--project <name>`.

Rules:

- repo-first commands infer the project only when run inside a registered managed repo
- outside a managed repo, project-scoped commands require `--project <name>`
- `--project` is intentionally long-form only for v2; no short alias is defined initially
- cross-project operations should never fall back to "first" or "last used" project state
- inventory commands that truly operate across projects must use an explicit flag such as `--all`

### Outside-repo behavior

When a repo-first command runs outside a managed repo and no explicit project is provided, it fails with a tagged argument error and a hint to either run from a managed repo or pass `--project <name>`.

This applies to lifecycle and deployment commands such as `up`, `down`, `logs`, `deploy`, and `bump`. `status` follows the same rule for project-scoped status; global status must be explicit, for example `rig status --all`.

### Path targeting

Path-based project targeting is rejected for lifecycle, logs, status, deploy, and bump commands.

`rig` operates on registered project identities. Paths may still appear in setup flows such as `rig init --path <path>` or provider/debug output, but a path is not a runtime selector. This keeps destructive or cross-project operations tied to a stable project name rather than an arbitrary filesystem location.

### Same-port local and live runtimes

`local` and `live` may declare the same concrete port, but they cannot run at the same time while requiring that same port.

`rigd` owns port reservations. Starting or deploying a lane must preflight required ports before cutover and fail with a structured conflict if another active rig deployment owns the port. Generated deployments should use assigned ports by default so branch previews can run concurrently without manual port management.

### Health ownership

Health checks must be tied to rig-owned runtime state, not just an arbitrary successful probe.

For managed components:

- HTTP health checks must target the component's assigned or reserved endpoint for that deployment
- the checked endpoint must belong to a currently supervised rig process or provider-owned runtime for that component
- command health checks run in the component workspace with the component environment and are attributed to that component
- a health check cannot pass solely because another process is listening on the expected port

This gives `doctor`, `status`, and deploy preflight a reliable way to detect false-positive health.

### Status for undeployed versions

Runtime status is about materialized deployments, not abstract release metadata.

If a command explicitly asks for a deployment, branch, lane instance, or version that has not been materialized, `status` fails with a tagged not-found style error and a hint to deploy or list available deployments. Listing commands may still show available metadata and deployment inventory, but explicit runtime inspection of an undeployed target does not silently synthesize a status row.

### Installed component logs

Aggregate runtime logs include `managed` components only.

`installed` components do not have long-running runtime logs by default. They can appear in status as installed/build surfaces, and build/install events may be visible through structured event history, but `rig logs` does not mix installed-component build output into runtime logs. If a user explicitly asks for logs for an installed component with no event log support, the command returns a tagged error with a hint that installed components do not produce runtime logs.

## Current vs Target

### Current model

- Top-level `environments.dev` and `environments.prod`
- Per-environment duplicated `services[]`
- `type: "server" | "bin"`
- Release/tag driven prod deploy flow
- File-oriented runtime state assembled directly by commands
- Main-binary E2E coverage now uses isolated state and safe provider composition

### Target model

- Top-level `components`
- `mode: "managed" | "installed"`
- One stable built lane: `live`
- One generated deployment template class: `deployments`
- One special working-copy lane: `local`
- Git-push-first deployment flow
- `rigd` as the single runtime authority
- Main `rig` binary testable under `RIG_ROOT` with stub plugins

## Terminology

### Project

A registered repo that contains a `rig.json`.

### Component

A single app/runtime/tool unit within a project. `components` replaces the old `services` collection.

### Component mode

Each component has a `mode`:

- `managed`
  Long-running supervised runtime. `rig` starts it, stops it, health-checks it, logs it, and may daemonize it.

- `installed`
  Installed executable surface. `rig` builds, shims, or installs it, but does not supervise it as a long-running runtime.

### Lanes

`rig` v2 uses three deployment/runtime lanes:

- `live`
  The stable built deployment lane.

- `deployments`
  The shared template/rules for generated built deployments, including branch-based ones.

- `local`
  The special working-copy runtime mode.

### Generated deployment

A built deployment instance materialized from `deployments`, typically keyed by branch slug or explicit deployment name.

### Home config

`rig` v2 has two config scopes:

- Project config (`rig.json`)
  Defines components, lane overrides, project-specific production branch behavior,
  generated deployment template settings, and provider choices that should travel
  with the repo.

- Home config (`~/.rig-v2/config.json` or equivalent)
  Defines machine/user defaults such as default production branch, generated
  deployment caps, replacement policy, default provider profile, and web-control
  preferences. `rigd` reads these defaults when resolving deploy intent and
  enforcing runtime inventory limits. Project config can override them.

Current implementation: `V2HomeConfigStore` reads and writes
`$RIG_V2_ROOT/config.json` or `~/.rig-v2/config.json` and normalizes missing
fields to explicit defaults. Deploy intent resolution uses project
`live.deployBranch` first, then home `deploy.productionBranch`, then `main`.
Generated deployment caps are enforced during deploy-intent materialization and
`rigd` generated deploy actions with `reject` and `oldest` replacement policies.

## High-Level UX

### Primary deployment model

- `git push rig <production-branch>` updates `live`; the production branch
  defaults from home config, and can be overridden by project config.
- `git push rig <branch>` creates or updates the corresponding generated
  deployment when the branch is not the configured production branch.

CLI deploys still exist, but they target refs/lanes instead of the old env model.

### Primary CLI

Canonical verbs:

- `rig up`
- `rig down`
- `rig logs`
- `rig status`
- `rig deploy`
- `rig bump`
- `rig doctor`
- `rig init`

Rules:

- Inside a managed repo, project name is omitted by default.
- `--project` exists only for cross-project control.
- `down` stops by default.
- `down --destroy` tears down generated deployment state.
- `status` remains the canonical inspect verb.

### Package-manager guardrails

`rig` should discourage long-running lifecycle via `npm run dev`, `bun run dev`, `vite dev`, `next dev`, etc.

The v2 approach is a package-manager integration plugin:

- optional
- setup-time only
- non-JS repos are unaffected

When enabled, it may generate scripts such as:

- `rig:up`
- `rig:down`
- `rig:logs`
- `rig:deploy`

It must not overwrite `dev`, `start`, or similar conventional scripts by default.

## Configuration Direction

## Shape

The exact schema can evolve, but the top-level structure should look like:

```json
{
  "name": "pantry",
  "domain": "pantry.b-relay.com",
  "components": {
    "api": {
      "mode": "managed"
    },
    "cli": {
      "mode": "installed"
    }
  },
  "live": {},
  "deployments": {},
  "local": {}
}
```

Key goals:

- define components once
- override only what differs by lane
- avoid duplicated arrays of nearly identical component definitions

### Components

Every component definition is rooted in the shared top-level `components` map.

Common component identity:

- name
- mode
- optional metadata

Mode-specific behavior:

- `managed`
  Supports runtime-oriented fields such as command, health, port, hooks, dependencies, proxy eligibility, and daemonization.

- `installed`
  Supports install-oriented fields such as build, entrypoint, shim/install strategy, and exposed executable names.

### Dependencies

Dependencies stay intentionally narrow.

Rules:

- only `managed` components can declare dependencies
- dependencies only control startup ordering and shutdown ordering
- dependencies do not imply restart propagation
- dependencies do not imply runtime cascade behavior after boot
- dependencies do not model tool prerequisites in v2

This keeps the concept simple and predictable.

### Lane overrides

`live`, `deployments`, and `local` can override only the fields that commonly differ:

- command/build
- environment variables / env file references
- proxy exposure / domain rules
- health checks
- provider selection
- install naming/details for `installed` components

Lane overrides should be partial patches, not full duplicated component redefinitions.

### Interpolation

The config must support built-in interpolation values for:

- branch slug
- deployment name
- workspace path
- assigned ports
- subdomain
- lane name

Generated deployment subdomains default from branch slugs, but must be overrideable.

### Effect-native validation

`rig` v2 should migrate validation from Zod to Effect Schema.

Rules:

- new v2 schemas use Effect Schema
- schemas remain the source of runtime validation and TypeScript types
- every config field must keep clear user-facing documentation
- validation errors must map into tagged `rig` errors with structured context and hints
- localhost-only validation remains mandatory
- legacy Zod schemas may remain during the transition only where needed for v1 compatibility

## Effect Stack

`rig` v2 targets Effect v4 as the backend foundation.

This applies to:

- core command logic
- `rigd`
- provider services and layers
- structured errors
- config parsing and validation via Effect Schema
- CLI parsing via Effect CLI
- health, logs, deploys, recovery, and doctor flows

Effect v4 may need to be pinned to a beta while v4 is not the npm `latest` release. If v4 is still prerelease when implementation starts, pin the exact beta version intentionally and document the upgrade path to the stable v4 release.

Use [`effect-v4-help-notes.md`](./effect-v4-help-notes.md) as the living implementation reference for Effect v4 migration work. Contributors and agents should read it before v2 Effect changes and update it when they verify a new API, migration detail, Bun integration pattern, package constraint, or source link.

## Deployment Model

### `live`

`live` is the stable built deployment lane.

It is the operational replacement for old `prod`.

### `local`

`local` is the only working-copy lane.

It is explicitly different from built deployments:

- runs from the current repo checkout
- may use HMR/dev commands
- does not require git push

### Generated deployments

Generated deployments are built deployments created from the `deployments` template.

Typical examples:

- branch-based previews
- named temporary review environments

Properties:

- isolated workspace
- isolated ports
- isolated logs
- isolated runtime state
- generated or overridden subdomain

## Git and Versioning

### Git-driven deploys

Normal deploys are git-push driven:

- `git push rig main` updates `live`
- `git push rig my-branch` updates or creates that generated deployment

### Optional version metadata

Semver and tags remain optional metadata, not the main deploy path.

Use:

- `rig bump patch`
- `rig bump minor`
- `rig bump major`
- `rig bump set <version>`

Tags are useful for labeling and rollback anchors, but not required for routine deploys.

## Plugin Architecture

All external concerns remain behind interfaces.

### Required provider families

- process supervisor / daemon manager
- proxy/router manager
- SCM integration
- workspace/deployment materializer
- logging/event transport
- control-plane transport
- health checking
- package-manager integration
- tunnel/exposure

### Core And Bundled Providers

`rigd` is the core process supervisor and runtime authority. It is bundled with
Rig, but it is not a plugin in the same sense as optional provider extensions.
Lane config still selects it through the same provider id slot so bundled and
future third-party providers use one interface shape.

The shipped bundled providers include:

- rigd core process supervisor
- launchd
- Caddy
- local git
- localhost HTTP control-plane transport on `127.0.0.1`
- manual Tailscale DNS routing for private remote access

Launchd is a bundled first-party process supervisor plugin. A lane may choose
`providers.processSupervisor = "launchd"` when it should install/use launchd
instead of the default core `rigd` supervisor path.

These are defaults and bundled options, not assumptions embedded in core logic.

V2 exposes these through explicit provider-family service tags and a provider
registry service so `rigd`, `doctor`, and future web control-plane surfaces can
report the selected provider profile and capability metadata without importing
concrete providers from core logic.

### Stub providers

Stub/test providers must be first-class plugins.

They are not special test-only hacks.

Examples:

- stub process supervisor
- stub proxy manager
- stub SCM provider
- stub control-plane transport
- stub tunnel/exposure provider

These are necessary so the main binary can be tested safely without touching real system integrations.

## `rigd`

`rigd` is the new runtime authority.

It is a local daemon/server process and should itself be manageable by `rig` as a normal `managed` component.

### Responsibilities

`rigd` owns:

- deployment inventory
- process supervision
- structured logs
- health state
- port allocation
- deploy actions
- provider coordination
- local state reconciliation

### CLI relationship

The CLI becomes a client of `rigd` over a local API/socket.

Current MVP: `rig2` uses an in-process local API contract while the daemon boundary is still being built. The API surface already models health, project/deployment inventory, structured logs, health state, lifecycle action receipts, and deploy action receipts so later transport work can preserve the same interface shape.

Current runtime-facing v2 commands route through the rigd-backed lifecycle service. Any remaining direct command assembly is compatibility scaffolding for v1 or tests, not the v2 source of truth.

### Persistent state

`rigd` persists restart evidence under the isolated v2 state root. The current
state-store contract records runtime events, accepted action receipts, health
summaries, provider observations, deployment snapshots, and rigd-owned port
reservations in `runtime/rigd-state.json`.

Reconstruction is evidence-based. Missing health, provider, or deployment
evidence returns a tagged unsafe-reconstruction error with a recovery hint
rather than guessing at runtime state.

### Web relationship

`rigd` serves a localhost-first control plane on `127.0.0.1`.

The hosted web UI lives at `https://rig.b-relay.com`, but the local machine does
not need to expose a public port by default. A user can route a private
Tailscale DNS name to the localhost server. Public internet exposure should be a
provider/plugin concern, for example a Cloudflare Tunnel plugin.

Current MVP control-plane contract:

- website: `https://rig.b-relay.com`
- transport: localhost HTTP server bound to `127.0.0.1`
- exposure: localhost first, with optional Tailscale DNS or tunnel plugins
- auth: not required for local/Tailscale-only access; token pairing required for public internet exposure
- status: documented localhost-first contract

The current implementation exposes this through interfaces for the local
server, tunnel exposure provider, and auth boundary. `rigd` health reports the
local server status, exposure mode, auth mode, heartbeat, and tunnel/transport
errors. Runtime events and action receipts serialize into plain JSON envelopes
for later hosted-control-plane transport work.

The hosted control plane is `rig.b-relay.com`.

The web UI should:

- list projects
- list deployments
- show logs and health
- trigger lifecycle and deploy actions
- edit config

Current read-side contract: `rigd.webReadModel` exposes project rows,
deployment rows, and health snapshots for `rigd`, deployments, components, and
providers from durable state. `rigd.webLogs` exposes filtered structured log
windows by project, lane, deployment, component, and line count. These read
models serialize through the control-plane `read-model` envelope.

Current write-side contract: `rigd` accepts control-plane lifecycle actions,
live deploy actions, generated deploy actions, and explicit generated teardown
actions. These route through the same runtime authority used by CLI-visible
state, persist durable action receipts, and emit structured events/logs.
Generated deploy writes materialize deployment inventory before acceptance.
Generated teardown writes reject `local` and `live` targets and only operate on
materialized generated deployments. Provider capability checks and deploy
preflight checks stay behind the `V2RigdActionPreflight` interface so bundled
and future external providers can share the same validation boundary.

Current config-edit contract: `rigd.configRead` returns editor-ready v2 config
state with raw JSON data, decoded config, a content revision, and editable
field docs. `rigd.configPreview` accepts structured `set` and `remove` patch
operations expressed as path arrays, applies them in memory, validates the
candidate config with the v2 Effect Schema, and returns field-doc-aware diffs
without writing. `rigd.configApply` repeats the same validation, rejects stale
revisions, writes atomically through the config file store interface, and
returns a backup path for recovery. `rig2 config read`, `rig2 config set`, and
`rig2 config unset` are the current user-facing project config surface for this
contract; hosted web editing can call the same interface later.

## Reliability Requirements

The redesign is also a reliability pass.

### Preflight before cutover

Built deployments must be fully prepared before traffic/runtime cutover:

- dependencies installed
- binaries available
- env resolved
- health checks valid
- hooks runnable
- ports reserved

### Process supervision

Use process-group-aware supervision so `down` and restarts do not leave orphaned child processes.

### Logs

Structured logs are the source of truth for both CLI and web.

### Port management

Generated deployments must support automatic port assignment.

### Doctor checks

`rig doctor` should cover common local-machine failures:

- PATH issues
- missing binaries/files
- health-check mismatch
- port conflicts
- stale runtime state
- provider misconfiguration

The v2 runway exposes this as a `V2Doctor` interface so deploy preflight,
doctor output, and recovery checks can share the same structured failure model
without binding core logic to concrete process or provider implementations.

## Recoverable State

`.rig` remains the persisted rig root, but the system should be able to recover from partial loss where safe.

If `rigd` is still alive, it should be able to reconstruct minimum operational state from:

- supervised runtime state
- provider state
- deployment inventory
- SCM/deployment metadata

This does not mean “silently rewrite everything,” but it does mean accidental deletion of `.rig` should not automatically imply total operational blindness.

## Testing Direction

The long-term target is to keep end-to-end coverage on the main shipped binary.

### Target test model

Use the main `rig` binary with:

- `RIG_ROOT` for isolated state
- stub providers for launchd/process supervision, proxy, SCM, and other external concerns

### Transitional rule

The separate smoke-only binary has been retired; coverage should stay on the main binary.

The target architecture is:

- one main binary
- isolated rig root
- selected provider composition

During active v2 development, a separate `rig2` binary or v2 entrypoint is allowed and preferred for safety. The long-term target is still one main `rig` binary after cutover, but `rig2` gives v2 a safe runway while v1 keeps production workloads running.

## `rig init`

The current `rig init` is too minimal.

The redesign should make it a real setup tool while keeping it non-interactive.

`rig init` should scaffold:

- base config structure
- provider/plugin selection
- lane wiring
- optional package-manager integration

It should stay explicit and scriptable so AI agents can run it without prompts.

## Rollout Plan

### Phase A

Write and adopt this v2 design spec.

### Phase B

Refactor docs and onboarding around the new concepts:

- `components`
- `mode`
- `live`
- `deployments`
- `local`

### Phase C

Introduce provider selection and stub-provider compatibility into the main binary.

Before or as part of this phase, establish the isolated v2 dev binary/entrypoint and state root so v2 can be tested without touching v1 production state.

### Phase D

Introduce `rigd` and move runtime truth behind it.

### Phase E

Transition CLI and config model from old env/service/type semantics to the new model.

### Phase F

Keep main-binary E2E coverage under `RIG_ROOT` and safe provider composition at parity.

## Non-Goals

- No app presets in v2
- No built-in migration CLI command
- No separate rig website
- No broad dependency model for installed/tool prerequisites in v2
