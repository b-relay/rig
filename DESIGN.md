# Rig Design

This document is the architecture and UX contract for Rig. For detailed domain
terms, see [CONTEXT.md](./CONTEXT.md). For user-facing command examples, see
[docs/rig-guide.md](./docs/rig-guide.md).

## Core Principles

1. Rig is repo-first.
   Commands infer the Project when run inside a registered Project workspace.

2. Rig is lifecycle-first.
   `up`, `down`, `restart`, `logs`, `status`, and `doctor` are first-class
   operational commands, not wrappers around package-manager scripts.

3. Rig is Branch/Commit based.
   Deploys materialize Git Branches at exact Commits. Version bumps do not drive
   deployment.

4. `rigd` is the runtime authority.
   Runtime mutation, inventory, health, logs, receipts, ports, deploy actions,
   and provider coordination go through `rigd`.

5. Project config is portable policy.
   It belongs in the repo and should not contain machine-specific Host
   capability.

6. Host config is machine capability.
   It owns local tools, paths, domains, port ranges, auth tokens, daemon address,
   and installed provider defaults.

7. Providers do not discover global state.
   `rigd` resolves Project config and Host config into a runtime plan, then
   passes shared Runtime context plus typed provider-specific config to
   providers.

## Command Boundary

`rig` is the user CLI:

- `rig init`
- `rig list`
- `rig status`
- `rig doctor`
- `rig deploy`
- `rig up`
- `rig down`
- `rig restart`
- `rig logs`

`rigd` is daemon administration only:

- `rigd install`
- `rigd status`
- `rigd uninstall`

Normal `rig` commands do not install or manually start the daemon. They report
missing/unreachable daemon state and point to `rigd status` or `rigd install`.

## Targets

Rig acts on Targets:

- Working copy Target, named `local` in the first release.
- Stable Target, named `live` in the first release.
- Preview Target, selected as `preview <branch>`.

The model should leave room for future custom Target names and multiple Stable
Target stages, but first release implementation should keep the concrete names
simple.

## Deploy

`deploy` materializes Branches as Deployments:

- Stable Target deploy uses the configured Production branch.
- Preview deploy uses the current Branch or an explicit local Branch.
- CLI deploy does not accept arbitrary refs, tags, remote-tracking names, or
  detached HEAD as Branch identity.
- Rig remote deploy uses the pushed destination Branch name.

Deploying a new Commit brings the Target up by default. Deploying the same
Commit is a no-op unless `--force` is used. `--no-up` materializes without
starting, and if it replaces a running Target, the old process is stopped rather
than left running on stale code.

## Lifecycle

Lifecycle commands act on existing Targets:

- `up`
- `down`
- `restart`
- `logs`

They do not create missing Preview Deployments. A missing Preview must be
created by deploy first.

`down` stops but does not delete. Stopped Previews remain in inventory and in
status until a future cleanup or deletion design removes them.

## Inventory And Diagnostics

`rig status` is Project-scoped and shows all Targets for the selected Project.

`rig list` is Host-scoped and daemon-backed. It shows Projects plus summary
metadata such as Target count.

`rig doctor` always runs Host diagnostics and adds Project diagnostics when a
Project context is available. It is read-only by default.

## Config

Project config owns:

- Project identity
- Production branch
- Target names
- commands
- health paths
- route shape
- Preview naming policy

Host config owns:

- local tool paths
- base domains
- port ranges
- runtime roots
- daemon address
- local auth token
- installed provider defaults

Generic `rig config set` is omitted from the first cleanup slice. Some advanced
Project config may be edited directly or through a future UI, with `doctor` and
preflight validating the result.

## Provider Contract

Provider calls use a consistent shape:

- shared Runtime context for domain facts and common capabilities
- typed provider-specific config for settings only that provider understands

First-party providers and future third-party providers should use this same
contract shape.

## Removed Or Hidden Normal Surfaces

The first cleanup should remove or hide these from normal release UX:

- `rig bump`
- `--state-root`
- generic `--config`
- provider-profile flags
- package-script scaffolding flags
- broad `--json` flags
- stub provider choices
- direct `rigd` subcommand under `rig`

Project deletion is explicitly out of scope until a dedicated design defines
what deletion means for config, inventory, routes, processes, and Persistent
storage.
