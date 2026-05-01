# Rig Context

## Terms

### Rig 2

The replacement CLI and runtime model for Rig. Rig 2 is currently developed
beside v1 in the same repo, but v1 is temporary and will be deleted at cutover.
Rig 2 should not preserve v1-shaped interfaces unless they buy a short migration
step.

### rigd

The Rig 2 runtime authority. `rigd` is the only module that should mutate
runtime state for lifecycle and deploy actions: deployment inventory, generated
deployment materialization, port reservations, runtime events, receipts, health
state, and process execution all sit behind `rigd`.

### Deploy intent

The classification of a requested deploy. Deploy intent answers what target a
ref maps to, such as `live` or a generated deployment, and may carry optional
version or rollback metadata. Deploy intent does not materialize deployments,
enforce generated deployment caps, write inventory, reserve ports, or start
processes.

### Replacement policy

The rule for what happens when generated deployments exceed the active cap.
Home config owns the machine default, and project config may later override it
when a repo needs different behavior. `rigd` enforces the policy because
rejecting, replacing, or destroying generated deployments mutates runtime state.

### Runtime journal

The internal `rigd` module that records runtime evidence: accepted receipts,
runtime events, health summaries, provider observations, deployment snapshots,
port reservations, desired deployment state, and managed process failures.
Callers do not write the runtime journal directly.

### Read model

A derived view of runtime journal evidence, shaped for CLI and web consumers.
Project lists, deployment rows, health snapshots, and log windows should come
from read models so CLI and web views agree.

### Preflight

The safety gate `rigd` runs before lifecycle or deploy actions mutate runtime
state. Preflight gathers evidence about dependencies, binaries, env, hooks,
health ownership, ports, provider readiness, and stale state. Doctor reports
the same evidence for humans, but `rigd` owns enforcing the gate.

### Runtime plan

The resolved Rig 2 shape that runtime execution, preflight, and provider
adapters consume. The runtime plan uses Rig 2 concepts: deployments, lanes,
managed components, installed components, workspace roots, data roots, log
roots, runtime roots, proxy config, provider selections, hooks, env, health,
and dependencies. V1-shaped `Environment`, `RigConfig`, `server`, `bin`, `dev`,
and `prod` shapes are temporary migration code only.

### Provider contract

The small interface for a provider family, such as process supervision, proxy
routing, workspace materialization, health checking, event transport, lifecycle
hooks, package management, SCM, tunnel exposure, or control-plane transport.

### Provider adapter

A focused concrete implementation of one provider contract, such as rigd
process supervision, launchd process supervision, Caddy proxy routing, git
worktree materialization, native health checks, package.json script installs,
or stub providers. Each provider adapter should live in its own focused module
rather than inside the provider contract module.
