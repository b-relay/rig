# Rig Guide

This guide describes the TypeScript implementation. The latest installed release,
rollout checks, and legacy-wrapper monitoring limitation are recorded in the
[September 10 rollout](reviews/2026-09-10-live-rollout-results.md). Initial migration
evidence remains in [cutover readiness](rig-cutover-readiness.md). Product acceptance criteria live
in the [PRD](PRD.md); predecessor plans are indexed in [history](history.md).

## Setup

Build the CLI:

```bash
bun install
bun run build
bun run typecheck
```

The build produces `rig`, `rigd`, and `git-remote-rig`. Put all three in the
chosen executable directory for Git push deployment. Source development and
tests must set an isolated `RIG_ROOT`; do not install into the real Host simply
to try the rewrite. Existing Host state needs the explicit backed-up cutover.

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

New config uses `rig.yaml`; matching existing `rig.json` is preserved. Explicit
`--production-branch` and `--create-git` support noninteractive setup. Project
identity comes from existing config when present, not a conflicting folder name.

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
Preview Deployments. `rig up local` may create the Working copy Target directly
from the registered repository.

```bash
rig up local
rig down live
rig restart preview feature/login
```

If `rig up preview feature/login` names a Preview that has not been deployed,
Rig should fail and tell the user to deploy it first.

`down` stops a Target and retains its inventory, data, logs, and source history.
`rig down preview <branch> --destroy` verifies shutdown, retires the Preview's
owned route and installed artifacts, deletes its canonical Target root (owned
data, logs, and source history), and removes its inventory record. `--destroy`
is the confirmation; there is no additional TTY prompt or `--yes` flag.

Other Targets, Project repositories, unrelated Host state, and shared Persistent
storage outside that owned root are preserved. Symlink destinations are never
deleted. Uncertain shutdown or ambiguous ownership prevents deletion. A cleanup
failure retains a stopped Preview with pending-destruction evidence; retry the
same explicit destroy command to finish. It cannot be restarted or redeployed
while deletion is pending. Already deleted bytes cannot be restored by retry.

Logs:

```bash
rig logs live
rig logs preview feature/login
rig logs preview feature/login --follow
```

`rig logs` prints recent stdout and stderr together by default and exits.
`--follow` streams. Logs may be read for stopped Targets when logs exist.
Output identifies component, timestamp, and stream with `>` for stdout and `!`
for stderr; legacy records with missing evidence must be marked unknown.

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

Status shares one two-second budget across concurrent observations. Managed
components without health checks are running, not healthy; uncertain observations
are unknown. Configured-only components are configured, installed-tool Targets
can be ready, and partial runtime capability is degraded. Recorded routes stay
visible when stopped. Doctor owns current-config drift and failed checks; it
does not repair or deploy configuration implicitly.

`rig activity` displays final daemon Operations separately from Target output.
It includes daemon administration and terminal crash evidence. Diagnostics live
in separate `logs/rig/rig.jsonl` and `logs/rigd/rigd.jsonl` files beneath the Rig
root, with daily rotation and 14-day retention by default. That retention does
not delete Target logs, activity, or Persistent storage.

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

Current config surface:

- `rig config` prints validated Project config and its source path.
- `rig config set` is omitted.
- managed fields such as Project identity are not simple settable fields.
- `--json` is available for status/lifecycle/deploy; there is no global flag.

Project files use `rig.yaml` or legacy `rig.json`; Host files use `config.yaml`
or legacy `config.json`. `.yml` is unsupported and both filenames in one scope
are ambiguous. YAML accepts one document with comments, rejecting duplicate keys,
tags, anchors, aliases, and merge keys. Existing config formats are never
automatically converted, and supported structured edits preserve comments/order
or refuse before mutation.

`rig rename <name>` and `rig repoint <path>` require stopped Targets and validate
registered identity/path conflicts. They do not delete Project data.

## Provider Boundary

`rigd` resolves Host config and Project config into a runtime plan before
calling providers.

Provider calls use:

- shared Runtime context for common domain facts and capabilities
- typed provider-specific config for settings only that provider understands

Providers must not read home config, Project config, or global path helpers
directly. First-party providers and future third-party providers should use the
same contract shape.

Only the default provider profile is supported; stub and isolated-e2e profiles
are rejected. Tests supply isolated provider interfaces and `RIG_ROOT`.
`--state-root` and generic `--config` path overrides are absent from normal UX.
Caddy command reload requires an explicit nonblank command; manual/disabled
policies never substitute a default reload command.
