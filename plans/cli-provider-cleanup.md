# Plan: CLI And Provider Cleanup

> Source PRD: GitHub issue #54 and `docs/PRD.md`
> Status: complete - implemented through GitHub issues #55 through #62

## Goal

Make the normal Rig release surface match the accepted domain model:

- `rig` is the user CLI.
- `rigd` is daemon administration and runtime authority.
- Deploys are Branch/Commit based.
- Lifecycle commands act on existing Targets.
- Project config owns portable Project intent.
- Host config owns machine capability.
- Providers receive resolved Runtime context and typed provider config from
  `rigd`.

## Non-Goals

- Do not implement project deletion.
- Do not implement Preview cleanup automation.
- Do not implement custom Target names or multiple Stable Target stages.
- Do not implement remote `rigd` hosts.
- Do not implement `rig doctor --fix`.
- Do not add generic `rig config set`.

## Vertical Slices

### 1. Clean Public CLI Surface

Remove obsolete normal command surfaces and lock down help/parser behavior.

Acceptance:

- `rig bump` is removed.
- Normal `rig` help does not expose `--state-root`, generic `--config`,
  provider-profile flags, package-script flags, broad `--json` flags, or stub
  provider choices.
- Tests document the removed/hidden surfaces.

### 2. Daemon Admin Boundary

Make `rigd` the only daemon administration surface.

Acceptance:

- `rigd install`, `rigd status`, and `rigd uninstall` exist as the daemon admin
  surface.
- `rigd install` creates the local auth token.
- `rigd uninstall` removes daemon admin artifacts but refuses while managed
  Targets are running.
- Normal `rig` commands do not install or manually start `rigd`.

### 3. Project Initialization

Make `rig init` create Project config and register with `rigd`.

Acceptance:

- `rig init` resolves the Git root and writes Project config there.
- Interactive init confirms Project identity and Production branch.
- Init configures the `rig` Git remote when safe.
- Init requires `rigd` registration for full success.
- Partial config-written registration failures are recoverable by rerunning
  `rig init`.

### 4. Inventory And Diagnostics

Align `list`, `status`, and `doctor` with their scopes.

Acceptance:

- `rig list` reads daemon-backed Host inventory and shows Project summaries with
  Target counts.
- `rig status` is Project-scoped and shows all Targets for one Project.
- `rig doctor` always runs Host checks and adds Project checks when a Project
  context exists.
- Doctor reports Project identity drift, duplicate identity/path conflicts, and
  missing Host capabilities.

### 5. Branch/Commit Deploy

Implement the accepted Stable Target and Preview deploy behavior.

Acceptance:

- `rig deploy live` deploys the configured local Production branch.
- `rig deploy live <branch>` only accepts the configured Production branch.
- `rig deploy preview` deploys the current Branch and fails from detached HEAD.
- `rig deploy preview <branch>` deploys an explicit local Branch.
- Same-Commit deploys no-op unless `--force`.
- `--no-up` materializes without starting.
- CLI deploy warns for ahead/behind local upstream state without fetching.

### 6. Rig Remote Deploy Classification

Make Git push deployment match the Branch model.

Acceptance:

- The pushed destination Branch controls classification.
- Production branch pushes update the Stable Target and bring it up by default.
- Non-Production branch pushes update Previews and bring them up by default.
- Same-Commit pushes no-op and do not start stopped Targets.
- Rig remote pushes do not support `--no-up` in the first release.

### 7. Lifecycle And Logs

Make target-aware commands act only on existing Targets.

Acceptance:

- `rig up`, `rig down`, `rig restart`, and `rig logs` use the same Target
  selection model.
- Missing Preview lifecycle fails with guidance to deploy first.
- `down` stops without deleting inventory.
- `restart` can start an existing stopped Target without changing code.
- `logs` prints recent combined stdout/stderr by default and streams with
  `--follow`.

### 8. Provider Runtime Context

Remove provider access to global path/config helpers.

Acceptance:

- `rigd` resolves Project config and Host config into a runtime plan.
- Provider calls receive shared Runtime context plus typed provider-specific
  config.
- Caddy-specific paths/config go only to the Caddy provider.
- Tests prove providers can run against injected context without reading global
  helpers.

## Issue Order

Create implementation issues in the order above. Slices 1 and 2 can start
early, but slices 3-7 depend on the cleaned command vocabulary. Slice 8 can
proceed in parallel when it touches disjoint provider modules, but any provider
contract change should keep CLI behavior green.
