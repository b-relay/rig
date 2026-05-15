# Rig Guide

This guide describes the accepted Rig product model. Some implementation
cleanup is still tracked in GitHub issues; do not use older lane/ref/bump
examples as product direction.

## Setup

Build the CLI:

```bash
bun install
bun run build
```

Install the daemon:

```bash
rigd install
rigd status
```

`rigd install` owns daemon setup and creates the local control-plane auth token.
Normal `rig` commands do not install or manually start `rigd`; if the daemon is
missing or unreachable, they report the problem and point to `rigd status` or
`rigd install`.

## Initialize A Project

From inside a Git repository:

```bash
rig init
```

`rig init` should:

- resolve the repository root, even when run from a subdirectory
- choose a Project identity, defaulting to a slug from the repo directory
- confirm the Production branch interactively
- write committed Project config at the repo root
- configure the `rig` Git remote when possible
- register the Project with `rigd`

If run outside Git in an interactive terminal, `rig init` may ask before running
`git init`. It should not create commits.

If config is written but `rigd` registration fails, `rig init` should report the
partial state without rolling the file back. A later `rig init` should resume
registration idempotently when the config still matches the workspace.

## Project And Host Scope

Project-scoped commands require a Project context:

```bash
rig status
rig up local
rig down live
rig restart preview feature/login
rig logs live
rig deploy live
```

They infer the Project from the current workspace or use:

```bash
rig status --project pantry
rig deploy live --project pantry
```

`--project` selects the configured Project identity known to `rigd`, not the
folder name.

`rig list` is host-scoped. It shows Projects plus summary metadata such as
Target count. It does not show every Target for every Project.

## Targets

Rig commands act on Targets:

| Target form | Meaning |
|---|---|
| `local` | Working copy Target backed by the current checkout. |
| `live` | First Stable Target. Future Project config may support custom stable target names. |
| `preview <branch>` | Preview Target for a Branch. Branch names may include slashes. |

Bare names such as `local` or `live` resolve to the Working copy Target or
Stable Targets. Previews must use the `preview` selector.

Target-aware commands with no selected Target should show an interactive picker
in a TTY and fail with guidance in non-interactive use:

```bash
rig up
rig down
rig restart
rig logs
```

`rig status` is different: it shows all Targets for the selected Project by
default.

## Deploy

Stable deploy:

```bash
rig deploy live
rig deploy live main
```

`rig deploy live` deploys the configured Production branch. It can run from
detached HEAD because it does not deploy the current checkout. If the current
checkout differs from the Production branch, interactive commands should make
the deployed branch clear.

Preview deploy:

```bash
rig deploy preview
rig deploy preview feature/login
```

`rig deploy preview` uses the current Branch. It fails from detached HEAD. A
Preview deploy from the Production branch itself is rejected; create a branch
such as `preview/main` when you want a preview of production code.

Deploy options:

```bash
rig deploy live --no-up
rig deploy preview feature/login --no-up
rig deploy preview feature/login --force
```

`--no-up` materializes without starting. If a new Commit replaces a running
Target, the old process is stopped rather than left running on stale code.
`--force` redeploys even when the same Commit is already deployed.

CLI deploy uses local Branches only. It should warn, not block, when the Branch
is ahead or behind its configured upstream. It should not fetch implicitly.

## Git Push Deploy

`rig init` configures the conventional Git remote name:

```bash
git push rig main
git push rig feature/login
git push rig main:preview/main
```

Rig remote classification uses the pushed destination Branch:

- Production branch updates the Stable Target and brings it up by default.
- Any other destination Branch creates or updates a Preview and brings it up by
  default.
- Same-Commit pushes are no-ops and should not start a stopped Target.
- Rig remote pushes do not support `--no-up` in the first release.

## Lifecycle And Logs

Lifecycle commands act only on existing Targets. They do not create missing
Deployments.

```bash
rig up local
rig down live
rig restart preview feature/login
```

If `rig up preview feature/login` names a Preview that has not been deployed,
Rig should fail and tell the user to deploy it first.

`down` stops a Target but does not remove it from inventory. Stopped Previews
remain visible until a future cleanup/delete design removes them.

Logs:

```bash
rig logs live
rig logs preview feature/login
rig logs preview feature/login --follow
```

`rig logs` prints recent stdout and stderr together by default and exits.
`--follow` streams. Logs may be read for stopped Targets when logs exist.

## Status, List, Doctor

```bash
rig status
rig list
rig doctor
rig doctor --project pantry
```

`rig status` is Project-scoped and shows all Targets for that Project. It fails
outside a Project unless `--project <name>` is provided.

`rig list` is Host-scoped and daemon-backed. It fails if `rigd` is unreachable.

`rig doctor` always runs Host diagnostics. When a Project context is available,
it also runs Project diagnostics. Outside a Project, it may succeed with
Host-only checks and a note that Project checks were skipped. `doctor` is
read-only by default.

## Config

Project config is committed and owns portable Project intent:

- Project identity
- Production branch
- Target names
- commands and health paths
- route shape
- Preview naming policy

Host config owns machine capability:

- local tool paths
- base domains
- port ranges
- runtime roots
- daemon address and local auth token
- installed provider defaults

Not every config change needs a CLI command. Advanced or structured Project
policy may be edited directly in config or through a future Rig UI, while
`rig doctor` and preflight validate the result.

First cleanup scope:

- `rig config get` is optional and read-only if present.
- `rig config set` is omitted.
- managed fields such as Project identity are not simple settable fields.
- broad `--json` output flags are avoided.

## Provider Boundary

`rigd` resolves Host config and Project config into a runtime plan before
calling providers.

Provider calls use:

- shared Runtime context for common domain facts and capabilities
- typed provider-specific config for settings only that provider understands

Providers must not read home config, Project config, or global path helpers
directly. First-party providers and future third-party providers should use the
same contract shape.

Stub providers, provider profiles, `--state-root`, and generic `--config` path
overrides are test/dev/internal surfaces, not normal release UX.
