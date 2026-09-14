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
It only runs when no daemon process exists, and it issues a fresh token every
time, so a credential left behind by a crashed daemon does not outlive it.
Normal `rig` commands do not install or manually start `rigd`; if the daemon is
missing or unreachable, they report the problem and point to `rigd status` or
`rigd install`. Before sending the token anywhere, `rig`, `git-remote-rig`,
and `rigd status` check that the process recorded in the daemon's address file
still exists. A record left by a daemon that died is reported as stale and its
port is never contacted, so another local process that later binds that port
does not receive the credential.

Stopping, restarting, or upgrading `rigd` is not a Target stop. Managed
processes keep serving while the daemon is down, and the next daemon adopts
them through their recorded process leases without re-running start hooks.
`rigd uninstall` is the exception: it refuses while any Target is running.
When the daemon is not reachable at all, `rigd uninstall` still removes the
launchd job and installation record and warns that Targets were left as they
are; the next `rigd install` adopts them.

The launchd job records the `PATH` entry that resolves to the running
executable (for example `~/.bun/bin/bun` rather than a versioned Cellar path),
so package upgrades do not strand it. The job restarts only after a crash, with
a ten second throttle, so a broken install does not spin. `rigd status` and
`rig doctor` name the recorded program when it no longer exists; run
`rigd install` again to record the current one. A failed `launchctl bootstrap`
reports launchctl's reason and leaves nothing installed.

Connect the Host Caddy once. Rig writes its marked route blocks to
`<RIG_ROOT>/proxy/Caddyfile` (or `providers.caddy.caddyfile`) and never edits
the Caddyfile the running Caddy loads. That Caddyfile must import the route
file, with an absolute path because the Host Caddy usually runs as another
user:

```caddyfile
# /usr/local/etc/Caddyfile
import /Users/deploy/.rig/proxy/Caddyfile
```

Reload Caddy after adding the line. Until then every Rig route is inert:
`rig doctor` reports `caddy-proxy` as failed and `rig status` marks routes
`unpublished`. Rig looks for the import in `providers.caddy.hostCaddyfile`, or
in `/usr/local/etc/Caddyfile`, `/opt/homebrew/etc/Caddyfile`, and
`/etc/caddy/Caddyfile` when unset. Host TLS or error snippets that every
generated site block needs, such as `import cloudflare`, go in
`providers.caddy.extraConfig`. With `providers.caddy.reload.mode: manual` Rig
writes the route file but leaves the reload to you.

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

A deployed Target is planned from the `rig.yaml` committed on the deployed
revision, so its components, ports, and hooks match the code it serves. The
working copy's config only identifies the Project (its name and the live
deploy branch policy); uncommitted edits to it never reach a live or Preview
plan. A revision whose committed config names a different Project is refused
as `PROJECT_IDENTITY`, and an invalid committed config fails the deploy with
the revision's path in the message.

Every deploy resolves its Project from `--project` or the working directory
and, before anything changes, prints a line such as
`Deploying share (/Users/me/share) to live from main.` on stderr. A deploy run
from the wrong checkout is therefore visible in the first line of output, and
the final line names the deployed revision, for example
`share live deployed main@470a510 (was 83496f8)`.

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
Target, the old process is stopped rather than left running on stale code, so
nothing serves until `rig up`; the deploy output warns and names that command.
`--force` redeploys even when the same Commit is already deployed.

A deploy whose activation fails (a build, hook, or health failure) leaves the
Target recorded at the new Commit but incomplete: its effects were rolled back
and nothing is running. `rig status` and `rig doctor` say so. `rig up` finishes
it, installing, routing, and starting the recorded plan under its own
checkpoint, after which a deploy of the same Commit is `unchanged` again;
redeploying the same Commit also works.

CLI deploy uses local Branches only. It should warn, not block, when the Branch
is ahead or behind its configured upstream. It should not fetch implicitly.

## Git Push Deploy

`rig init` configures the conventional Git remote name:

```bash
git push rig main
git push rig feature/login
git push rig main:preview/main
```

The remote advertises only completed deployments. A Target whose last deploy
failed or was interrupted, or whose transition is still unresolved, is
withheld from `list for-push`, so a repeated `git push rig <branch>` sends the
push again instead of reporting "Everything up-to-date"; rigd then finishes or
refuses it with the usual deployment errors. Interrupting a push with Ctrl-C
prints the operation id that rigd may still be running; check `rig activity`
or `rig status` before pushing again.

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

`up` reports `started` only for processes Rig has confirmed alive. A component
with a `health` URL is polled until it answers or `readyTimeout` expires, and
between polls Rig asks its supervisor whether the process still exists: a
process that exits fails the start at once as `PROCESS_EXITED`, naming the exit
code, instead of waiting out the timeout. A health answer counts only while
Rig's own process is running, so a foreign listener on the port cannot certify
a dead component. A component without a health check must survive a short
start grace period (half a second) before it counts as started; a command that
exits earlier, such as a missing binary or a port already in use, fails `up`
and rolls the start back.

Route and installed-executable changes run inside a durable effect
checkpoint under `<RIG_ROOT>/effect-checkpoints`. The journal records each
write before it starts and the result after it finishes, so a daemon killed in
between is recovered by the next `rig down` (rollback) or the recorded commit
decision (roll-forward) without treating its own half-finished write as an
external edit. Only a change made to an owned file *after* the journal
captured it is refused as `EFFECTS_CHANGED`.

`down` stops a Target and retains its inventory, data, logs, and source history.
When every process is verified stopped but a `preStop` or `postStop` hook
fails, `down` reports `STOP_HOOKS` with the Target stopped. `restart` treats
the same case the way deploy transitions do: it continues to the start half
and lists each failed shutdown hook as a warning in its result, so a flaky hook
does not turn a restart into an outage. A process that could not be stopped
still aborts both commands.

`rig down preview <branch> --destroy` verifies shutdown, retires the Preview's
owned route and installed artifacts, deletes its canonical Target root (owned
data, logs, and source history), and removes its inventory record. `--destroy`
is the confirmation; there is no additional TTY prompt or `--yes` flag.

Other Targets, Project repositories, unrelated Host state, and shared Persistent
storage outside that owned root are preserved. Symlink destinations are never
deleted. Uncertain shutdown or ambiguous ownership prevents deletion. A destroy
refused before anything was retired (a missing provider, an unverified stop)
leaves the Preview stopped but unlocked: fix the cause and destroy again, or
bring it back up. A cleanup failure after retirement began retains a stopped
Preview with pending-destruction evidence; retry the same explicit destroy
command to finish. It cannot be restarted or redeployed while deletion is
pending. Already deleted bytes cannot be restored by retry.

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

`rig` waits for `rigd` to answer a lifecycle or deploy command however long
it takes; `rigd` owns every budget (hooks, builds, `readyTimeout`). Reads such
as `status`, `list`, and `doctor` give up after five seconds and report
`rigd did not answer within 5 s; operation <id> may still be running`, which
is distinct from `rigd is not reachable`. Check `rig activity` before
retrying so the same operation is not queued twice.

While a deploy is running, `rig status` and `rig doctor` report the Target
as `deploy in progress (operation <id>)` and show whatever is observed at that
moment. The "unresolved deployment transition; run down" warning is reserved
for a transition that no live operation owns, such as one interrupted by a
daemon crash.

Status shares one two-second budget across concurrent observations. Managed
components without health checks are running, not healthy; uncertain observations
are unknown. Configured-only components are configured, installed-tool Targets
can be ready, and partial runtime capability is degraded. Recorded routes stay
visible when stopped, and show `unpublished` when no Host Caddyfile loads Rig's
route file (see Setup). Doctor owns current-config drift and failed checks; it
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

A lane's `providers.processSupervisor` selects `rigd` (default; the daemon
owns child processes), `child` (alias of `rigd`), or `launchd` (one launchd
agent per Component). Any other name is rejected when the config is parsed, so
a typo can never be recorded in a Target plan.

Commands, hooks, health checks, and build commands may use `${...}`
placeholders such as `${workspace}`, `${dataRoot}`, `${web.port}`,
`${db.path}`, `${pg.dataDir}`, and `${cx.stateDir}`. Because those strings run
under `/bin/sh -c`, Rig single-quotes any substituted value that contains a
space or other shell-special character, so a repository or `RIG_ROOT` under a
path like `~/Projects/My App` still resolves to one argument. A placeholder
the author already wrapped in quotes is substituted as is. Values substituted
into `env`, `domain`, `envFile`, and `entrypoint` are never quoted.

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
