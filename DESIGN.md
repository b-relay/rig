# Rig Design

This document is the architecture and UX contract for Rig. For detailed domain
terms, see [CONTEXT.md](./CONTEXT.md). For user-facing command examples, see
[docs/rig-guide.md](./docs/rig-guide.md).

Rig is strict TypeScript on Bun, validated with Zod, built from explicit
capability interfaces without Effect TS. See the
[module map](README.md#module-map) and the [decision records](docs/adr).

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
   It owns the default Production branch, the Preview limit, the Caddy
   provider settings, and diagnostics retention.

7. Providers do not discover global state.
   `rigd` resolves Project config and Host config into a runtime plan and
   passes providers what they need from it.

## Command Boundary

`rig` is the user CLI:

- `rig init`
- `rig list`
- `rig status`
- `rig doctor`
- `rig config`
- `rig activity`
- `rig rename` / `rig repoint` / `rig forget` for stopped Projects
- `rig recipe`
- `rig deploy`
- `rig up`
- `rig down`
- `rig restart`
- `rig logs`

`rigd` is daemon administration only:

- `rigd install`
- `rigd status`
- `rigd uninstall`
- `rigd capture`, the log-capture wrapper launchd runs; not a user command

Normal `rig` commands do not install or manually start the daemon. They report
missing/unreachable daemon state and point to `rigd status` or `rigd install`.

## Targets

Rig acts on Targets:

- Working copy Target, named `local` by default.
- Stable Target, named `live` by default.
- Preview Target, selected as `preview <branch>`.

`rig.yaml` keys Targets by role (`working`, `stable`, `preview`) and may rename
the Working copy and Stable Targets. A Project has one Stable Target.

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

`down` stops but does not delete. Stopped Previews remain in inventory and status.
Explicit `down preview <branch> --destroy` removes the Preview inventory and
owned route after stopping; it preserves data, source history, and logs.
`rig forget` removes a stopped Project's registration once its Previews are
destroyed; the repository, data, and activity history stay.

## Inventory And Diagnostics

`rig status` is Project-scoped and shows all Targets for the selected Project.

`rig list` is Host-scoped and daemon-backed. It shows Projects plus summary
metadata such as Target count.

`rig doctor` always runs Host diagnostics and adds Project diagnostics when a
Project context is available. It is read-only by default.

Observed status has one two-second total deadline. Configured checks distinguish
healthy from merely running; timeouts remain unknown. Up/down/restart consume
recorded Target policy, while doctor diagnoses drift against current config.
Final Operation activity is distinct from safe diagnostic JSONL and Target logs.

## Config

Project config owns:

- Project identity
- Production branch
- Target names
- Services and Tools: commands, ports, readiness checks, builds, environment
- the hostname and the `proxy` routes

Host config (`<RIG_ROOT>/config.yaml`) owns:

- the default Production branch
- the Preview limit and replace policy
- the Caddy provider settings
- diagnostics retention and level

Config is YAML only: `rig.yaml` for a Project, `config.yaml` for the Host.
Unknown keys and unsupported YAML features fail closed. `rig config` reads the
validated document and its source path. There is no `rig config set`: config
is edited by hand and checked by `doctor` and by deploy preflight.

## Provider Contract

Providers receive what they need from the resolved runtime plan. They do not
read Host config, Project config, or global paths themselves. The bundled
providers (process supervisors, Caddy router, Git source store, artifact
installer, command runner) and any future external provider use the same
contracts in `src/providers/contracts.ts`.

## Deliberately Absent

- version-bump deploys (`rig bump`)
- `--state-root` and generic `--config` path overrides; tests use `RIG_ROOT`
- provider-profile flags and stub provider choices
- a global `--json` flag; `--json` is per command (status, lifecycle, deploy)
- hooks and plugins

Project deletion that removes data is out of scope. `rig forget` only drops
the registration; files and Persistent storage stay on disk.
