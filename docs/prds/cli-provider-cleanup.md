# Rig PRD

> Historical PRD for #54 and the completed #55–#62 CLI/provider cleanup.
> Preserved on 2026-09-09. See the [current PRD](../PRD.md) for the next increment.

## Problem Statement

Rig is a local Mac deployment manager whose current implementation still exposes
too many old and internal concepts: lanes, generated deployments, refs,
provider profiles, package-script flags, state-root overrides, direct config
paths, broad JSON flags, manual `rigd` startup, and version bump deployment
flow.

Those concepts make normal use harder and increase the chance of bad state:
deploying the wrong branch, pointing a command at the wrong state root, using
test providers in a real workflow, or letting providers mutate global paths
outside the resolved runtime context.

Rig needs a smaller release CLI and a sharper architecture:

- `rig` is the user CLI for Projects, Targets, deploy, lifecycle, logs, status,
  list, and doctor.
- `rigd` is the runtime authority and daemon admin surface.
- Project config owns portable Project intent.
- Host config owns machine capability.
- Providers receive resolved runtime context from `rigd`; they do not discover
  global state themselves.

## Solution

Center Rig around Projects, Targets, Branches, Commits, Deployments, and
Persistent storage.

The first release uses:

- Working copy Target named `local`
- one Stable Target named `live`
- Preview Targets selected as `preview <branch>`

The model should leave room for future custom Target names and multiple stable
stages, but the first cleanup slice should not implement that customization.

Deploys are Branch/Commit based:

- `rig deploy live` deploys the configured Production branch.
- `rig deploy live main` deploys an explicit Branch only if it is the
  Production branch.
- `rig deploy preview` deploys the current Branch as a Preview.
- `rig deploy preview feature/login` deploys an explicit Branch as a Preview.
- `git push rig main` updates the Stable Target.
- `git push rig feature/login` updates a Preview.

Lifecycle commands act on existing Targets:

- `rig up`
- `rig down`
- `rig restart`
- `rig logs`

They do not materialize missing Deployments. `deploy` materializes; lifecycle
starts, stops, restarts, or reads logs.

Daemon administration is separate:

- `rigd install`
- `rigd status`
- `rigd uninstall`

Normal `rig` commands should not install or start `rigd` automatically.

## User Stories

1. As a developer, I want `rig init` to register the current repo with Rig, so
   that normal commands can infer the Project.
2. As a developer, I want `rig init` to configure the `rig` Git remote, so that
   `git push rig <branch>` works.
3. As a developer, I want Project identity to be confirmed during init, so that
   routes and `--project` use a stable name.
4. As a developer, I want `rig status` to show all Targets for the current
   Project, so that I can understand runtime state quickly.
5. As a developer, I want `rig list` to show known Projects and Target counts,
   so that I can scan the Host inventory.
6. As a developer, I want `rig doctor` to run Host checks and Project checks
   when possible, so that install and project drift are both visible.
7. As a developer, I want `rig deploy live` to deploy the Production branch, so
   that stable deploys are predictable.
8. As a developer, I want `rig deploy preview` to deploy my current Branch, so
   that preview deploys are simple.
9. As a developer, I want Preview lifecycle commands to use
   `preview <branch>`, so that branches cannot be confused with Stable Targets.
10. As a developer, I want `rig up preview <branch>` to fail when the Preview
    does not exist yet, so that lifecycle does not secretly deploy code.
11. As a developer, I want `rig down` to stop but not delete Targets, so that
    stopping a Preview does not lose inventory or logs.
12. As a developer, I want stopped Previews visible in status, so that I can
    inspect what exists.
13. As a developer, I want `rig logs` to read stopped Target logs when present,
    so that I can debug crashes after a stop.
14. As a developer, I want `rig deploy --no-up`, so that I can materialize a
    Deployment without starting it.
15. As a developer, I want same-Commit deploys to be no-ops, so that repeated
    commands do not restart services unnecessarily.
16. As a developer, I want `rig bump` removed, so that deploys are not confused
    with version metadata.
17. As a developer, I want normal commands to hide `--state-root` and
    `--config`, so that I do not accidentally split runtime state.
18. As a developer, I want test/dev provider profiles hidden from normal help,
    so that release UX does not expose stubs.
19. As an operator, I want `rigd install` to set up daemon credentials, so that
    `rig` can authenticate to local `rigd`.
20. As an operator, I want `rigd uninstall` to refuse while Targets are running,
    so that uninstall does not leave unmanaged processes or routes.
21. As a maintainer, I want providers to receive resolved context from `rigd`,
    so that providers do not call global path helpers.
22. As a maintainer, I want Project config and Host config separated, so that
    repo policy stays portable.
23. As a future UI user, I want the web UI to talk to `rigd`, so that CLI and UI
    see the same runtime state.

## Implementation Decisions

- Use Project identity as the canonical `--project <name>` selector. Folder
  names are only defaults during initialization.
- Store Project identity, Production branch, Target names, and Preview routing
  policy in committed Project config.
- Treat Project identity as managed config; do not expose it as a simple
  `rig config set` field.
- Require Project identity to be unique per Host.
- Keep `rig list` Host-scoped and daemon-backed.
- Keep `rig status` Project-scoped and Project-wide by default.
- Let `rig doctor` run Host-only when no Project context exists.
- Keep `rig doctor` read-only by default. Reserve `rig doctor --fix` as a
  future shape, without designing repair behavior now.
- Keep `rigd` daemon-admin-only: install, status, uninstall.
- Use localhost HTTP bound to `127.0.0.1` with a local auth token as the first
  control-plane transport.
- Store the local control-plane auth token in Host/user state, not Project
  config.
- Remove `rig bump`.
- Omit `rig config set` from the first cleanup slice.
- Avoid broad normal-CLI `--json` flags in the first release.
- Remove package-script and provider-profile flags from normal CLI.
- Hide `--state-root` and generic `--config` from normal CLI.
- Keep stub providers for tests/dev/internal use.
- Providers use shared Runtime context plus typed provider-specific config.
- Project config owns Project intent; Host config owns machine capability.
- Project config may be valid even when a Host lacks capabilities; doctor and
  preflight report missing Host capability.

## Testing Decisions

- Use TDD for implementation.
- Test external command behavior through the public CLI where possible.
- Add parser/help tests proving removed normal flags and commands are absent.
- Add init tests for Project identity, Production branch selection, Rig remote
  setup, daemon registration, partial init recovery, and duplicate identity
  conflicts.
- Add deploy tests for Stable Target branch policy, Preview branch policy,
  detached HEAD behavior, same-Commit no-op, `--force`, `--no-up`, and upstream
  warnings.
- Add Rig remote classification tests for Production branch versus Preview
  branches.
- Add lifecycle/log tests proving lifecycle commands do not materialize missing
  Previews.
- Add status/list/doctor tests for project scope, host scope, daemon
  reachability, stopped Previews, and config/runtime identity drift.
- Add provider-boundary tests proving providers consume resolved context and do
  not call global path helpers.

## Out Of Scope

- Project deletion. Do not implement delete until a dedicated design exists.
- Preview cleanup automation. Stopped Previews remain until future cleanup or
  deletion design.
- Custom Target names and multiple Stable Target stages in the first cleanup
  slice.
- Remote `rigd` hosts. Keep interfaces future-ready, but first transport is
  local-only.
- `rig doctor --fix` behavior.
- A full web UI. A future UI should be a client of `rigd`.
- Generic project config mutation through `rig config set`.

## Implementation Order

Use tracer-bullet vertical slices:

1. Clean docs and PRD around the accepted domain model.
2. Remove obsolete normal CLI surfaces and lock down help/parser behavior.
3. Implement daemon admin surface and localhost control-plane auth boundary.
4. Implement Project initialization and registration.
5. Implement inventory and diagnostics commands.
6. Implement Branch/Commit deploy for Stable Targets and Previews.
7. Implement lifecycle/log Target selection.
8. Refactor providers behind resolved runtime context.
