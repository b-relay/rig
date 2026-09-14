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
`RIG_ROOT` must be an absolute path: an empty value means the default
`~/.rig`, and a relative value makes `rig`, `rigd`, and `git-remote-rig` exit
with a usage error before they create or read anything, rather than rooting
Rig in the current working directory.

Install the daemon:

```bash
rigd install
rigd status
```

`rigd install` owns daemon setup and creates the local control-plane auth token.
It only runs when no daemon process exists, and it issues a fresh token every
time, so a credential left behind by a crashed daemon does not outlive it.
A credential file that exists but is empty or unreadable is a `DAEMON_TOKEN`
error naming `<RIG_ROOT>/auth/control-plane.token` and the cause, never "not
installed": `rigd status` reports it as a warning with the daemon unreachable,
`rigd install` refuses to replace a daemon it cannot verify (stop it with
`rigd uninstall`, which signals the recorded pid, or restore the file), and with
no daemon running `rigd install` simply reissues the credential.
Normal `rig` commands do not install or manually start `rigd`; if the daemon is
missing or unreachable, they report the problem and point to `rigd status` or
`rigd install`. Before sending the token anywhere, `rig`, `git-remote-rig`,
and `rigd status` check that the process recorded in the daemon's address file
still exists and is the same process: the daemon records its start time beside
its pid, so a pid that was reused by an unrelated process after a crash or
reboot counts as exited. A record left by a daemon that died is reported as
stale and its port is never contacted, so another local process that later
binds that port does not receive the credential. `rigd install` reclaims such
a record; `rigd uninstall` signals only a process proven to be the recorded
daemon. A daemon that is reachable but has no installation record (deleted by
hand, or started manually) is adopted by `rigd install`, which writes the
record, and `rigd uninstall` can still stop it: it removes the launchd job if
one exists and then signals the recorded pid. A record written by an older rigd carries no start time, so a live pid
in it cannot be verified: `rigd status` warns, `rigd install` and `rigd
uninstall` refuse, and a manual `rigd start` refuses, each naming the files
under `<RIG_ROOT>/daemon` to remove once you have confirmed no rigd is running.

Both records are written whole (through a sibling temp file and rename), so a
crash never leaves a torn record. A lease that still cannot be read is
reclaimed at the next start unless the address record names a live process, in
which case startup refuses and names both files. A daemon releases only records
that still name its own instance on shutdown; a record corrupted or replaced
while it ran is left alone and never turns a clean stop into a failure.

Daemon startup takes a lock directory, `<RIG_ROOT>/daemon/acquiring`, and
records its own pid and start time inside it. A lock whose holder has exited or
whose pid now belongs to another process is reclaimed on the next start, as is
a lock with no holder record that is more than a minute old. A lock held by a
live process, or a holder-less lock begun in the last minute, is refused as
`DAEMON_START_LOCK` with the lock path and pid in the hint. When any start
fails, the daemon writes `<RIG_ROOT>/daemon/startup-failure.json` before it
exits, and `rigd install` reports that failure's message and hint as
`DAEMON_START` as soon as it appears, instead of waiting out its timeout;
the failed installation is removed so `rigd status` reports it not installed.
When the daemon records nothing within five seconds, the `DAEMON_START` hint
names `startup.log` to inspect.

Stopping, restarting, or upgrading `rigd` is not a Target stop. Managed
processes keep serving while the daemon is down, and the next daemon adopts
them through their recorded process leases without re-running start hooks.
A stop signal (SIGTERM, `launchctl bootout`) first stops the daemon accepting
new connections, then lets the commands already running finish and answer
their callers, and only then closes what is still open, such as a log follow.
A command sent after the stop began is refused as `DAEMON_DRAINING` or fails
to connect.
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

`rig --version` and `rigd --version` print the version, and a serving daemon
reports its own version to `rigd status`, which warns when it differs from the
`rigd` you ran. Upgrading is `rigd install`: when the serving daemon reports
another version, or the installation record names another version or command,
the install stops that daemon, starts the current one, and reports what it
replaced; managed processes keep serving under their leases and the new daemon
adopts them. A daemon of the same version and command is reported `unchanged`.
When `rig` sends a command that the daemon does not accept, the error names
both versions and says to run `rigd install`, because `rig` only sends commands
its own grammar allows.

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
writes the route file but leaves the reload to you. The route file and
`rig.yaml` may be symlinks: Rig writes through the link, so the linked file
changes and the link stays in place, with the `.rig-backup` and `.bak` copies
beside the linked file.

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
`--domain app.test --proxy web` scaffolds one hostname per Target: `live`
serves `app.test`, `local` serves `local.app.test`, and each Preview serves
`<branch-slug>.app.test`, so two Targets never contend for one route. The
scaffold writes `domain: ${subdomain}.app.test` with a `live.domain`
override; edit either to change the scheme.

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

Each deploy checks out its revision under
`<RIG_ROOT>/targets/<project>/<id>/revisions/<uuid>` as a worktree of Rig's
own mirror and installs its dependencies once, recording that in a
`.rig-prepared` file at the workspace root. Once the new revision is committed,
the superseded checkout, its install output, and its worktree registration are
removed; a candidate that fails to start is removed the same way when the
previous plan is restored. A revision that could not be removed is reported as
a deploy warning naming its path, and the deploy still succeeds. Destroying a
Preview also drops its worktree registration from the mirror.

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

The Host config's `deploy.generated.maxActive` caps Previews per Project;
every recorded Preview counts, running or not. Under `replacePolicy: oldest`, a
new Preview destroys as many Previews as needed to fit under the cap once the
new one is committed, choosing Previews whose deploy never completed first,
then stopped Previews, then running ones, oldest first within each group. Each
removal follows the same verified-shutdown, retire, then delete sequence as
`rig down preview --destroy`, so a replaced Preview's data root and source
history do not linger on disk. Every removal is announced before the deploy's
own outcome line (`share feature-b-9876fedc retired feature/b (Preview
limit)`, or `share feature/b retired (Preview limit)` on a git push) and is
recorded in `rig activity` as a `destroy` operation with the message
`Preview limit`. If a removal fails (for example a process that will not stop, or a
data root that cannot be deleted), the new Preview stays deployed, the old
record is kept with pending-destruction evidence, and the deploy result carries
a warning naming the Preview and the `rig down preview <branch> --destroy`
command that finishes it; the Project is over its cap until then. Under
`replacePolicy: reject`, a deploy at the cap fails with `PREVIEW_LIMIT`.

A deploy whose activation fails (a build, hook, or health failure) leaves the
Target recorded at the new Commit but incomplete: its effects were rolled back
and nothing is running. `rig status` and `rig doctor` say so. `rig up` finishes
it, installing, routing, and starting the recorded plan under its own
checkpoint, after which a deploy of the same Commit is `unchanged` again;
redeploying the same Commit also works.

Every port recorded by any Target in any Project is reserved while that record
exists, whether the Target is running or stopped. A Target whose deployment
transition is unresolved also keeps the ports of the plan that `rig down` may
restore, so no other Target can be planned onto them in the meantime.

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

Each ref in a push batch is answered on its own: a tag or a Branch deletion is
reported by git as `[remote rejected]` with Rig's reason, while a Branch in the
same batch still deploys. A fatal helper error, such as rigd answering `status`
with an invalid reply, is printed and ends the helper, so git reports the
failure instead of waiting forever.

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

The Working copy Target follows the repository's current `rig.yaml`: `rig up
local` on a stopped Target and `rig restart local` re-plan it from the config
on disk before starting, keeping its Target id, data root, and recorded ports
where the config still allows them. `rig up local` on a Target that is already
running keeps the plan its processes were started from; `rig doctor` reports
`config-drift` for it and names `rig restart local` as the fix. A valid config
that adds a component the recorded plan has no port for is also reported as
`config-drift`, naming the added components; `config-invalid` is reserved for
a config that does not parse or resolve, and carries the parser's message.
Deployed Targets (`live`, `preview`) keep their recorded plan until the next
deploy. They are planned from the committed config in their checkout, so `rig
doctor` compares a deployed Target with that revision's config, not with the
working copy; uncommitted edits are not drift for it. When the checkout's
config resolves to a different plan than the recorded one, doctor names `rig
deploy <target> --force` as the fix, because a same-Commit deploy without
`--force` is `unchanged`.

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

Each journal carries a format version (currently 1). A journal written by a
newer rigd whose version this one does not read is refused as
`EFFECTS_CHECKPOINT` with both versions named and nothing changed; a journal of
the same version with fields this rigd does not know is read normally and those
fields survive any rewrite, so a downgrade cannot strand a Target. A journal
with an invalid value is refused with the file path and the offending field in
the hint. When rigd starts, it reclaims checkpoints and preparation claims whose
Target no longer exists in state; a pending journal that recorded a change, or
one that cannot be read, is left in place and recorded in the diagnostic log
with its reason, since only rollback or a person should decide about it.

`down` stops a Target and retains its inventory, data, logs, and source history.
When every process is verified stopped but a `preStop` or `postStop` hook
fails, `down` reports `STOP_HOOKS` with the Target stopped. `restart` treats
the same case the way deploy transitions do: it continues to the start half
and lists each failed shutdown hook as a warning in its result, so a flaky hook
does not turn a restart into an outage. A process that could not be stopped
still aborts both commands.

Preview records written by older Rig versions, before the source history root
was recorded, are repaired when rigd reads its state: a Preview whose checkout
sits under `<RIG_ROOT>/targets/<project>/<id>/revisions` gets that directory
as its source root, so it can be destroyed like any other. A record whose
checkout lies elsewhere keeps failing destroy with `DESTROY_OWNERSHIP`.

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
pending. Already deleted bytes cannot be restored by retry. Until then
`rig status` marks the Preview `destructionPending` and warns with the
destroy command that finishes it, and `rig doctor` fails its
`<preview>/destruction` check without counting the retired components as
separate failures.

Logs:

```bash
rig logs live
rig logs preview feature/login
rig logs preview feature/login --follow
```

`rig logs` prints recent stdout and stderr together by default and exits.
`--follow` streams. Logs may be read for stopped Targets when logs exist.
`--lines` sizes the first page only; a follow then fetches up to 1000 new
entries per poll so a busy Target is not throttled to the page size. A follow
ends on Ctrl-C, SIGTERM, or when whatever reads its output goes away (for
example `rig logs live --follow | head`): the write that fails is dropped, the
command exits 0, and rigd sees no further polls. A quiet follow notices the
missing reader at its next line, not before.
Output identifies component, timestamp, and stream with `>` for stdout and `!`
for stderr; legacy records with missing evidence must be marked unknown.
A record that cannot be parsed (for example one cut short by a crash and glued
onto the next), or a run longer than the reader's 4 MiB window, is shown in
place as an unknown-stream line "Rig skipped an unreadable log record (N
bytes)." and reading or following continues past it; Rig never edits the
retained file. Rig's own writers record a newline-free run in pieces of at most
64 Ki characters, so their records never exceed that window.
A Target log directory removed while a component runs is recreated by the
next line of output. While output cannot be recorded at all (the path is not a
directory, or is not writable), `rig status` prints the reason under the still
running component, naming the log directory, and clears it once a line is
recorded again.

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
read-only by default. One report reads the repository config once, so the
identity check and every Working copy comparison see the same revision even
while the file is being edited. A config the parser rejects is
`config-invalid` and carries the parser's message; a config that could not be
read at all (permissions, I/O) is `config-unreadable`; a config that names
another Project is `identity-drift` and is not compared. Host, ownership,
recovery and deployed-Target checks still run in each of these cases. A failing component check carries what was observed
(the exit code, an unverified lease, an expired status deadline) in its
message, and its hint follows from that: an exit points at `rig logs
<target>`, an unknown observation at daemon state, an expired deadline at
running doctor again.

An unreadable `<RIG_ROOT>/runtime/state.json` (invalid JSON, a wrong version,
or a malformed record) never makes `rigd` exit: startup records the failure in
the daemon diagnostic log and keeps serving, `rig doctor` reports
`runtime-state` as failed with the file path and the first problem, and every
other command fails with that same message. Every state write is flushed to
disk before it replaces the file, and the version it replaces stays beside it
as `state.json.bak`; the failure message points at that copy when it exists.
`rigd uninstall` refuses until the file is repaired, because it cannot verify
that Targets are stopped without it.

A legacy adoption manifest at `<RIG_ROOT>/runtime/legacy-adoption.json` whose
status is still `requires-adoption` blocks every mutating command and
`rig status` with `LEGACY_ADOPTION_PENDING`, and `rig doctor` reports
`runtime-ownership` as failed. The error and the doctor hint name that file.
No `rigd` command produces or finalizes the manifest in this release: verify
each legacy process and route it lists yourself, then move the file aside or
delete it to release runtime control.

The state file carries a format version (currently 3; version 2 files are
read and rewritten as 3). A file written by a newer `rigd` is refused as
`STATE_VERSION`, naming both versions, rather than loaded with fields dropped.
Keys this `rigd` does not know are kept through every read and write, so a
newer version's fields survive a temporary downgrade.

`rig` waits for `rigd` to answer a lifecycle or deploy command however long
it takes; `rigd` owns every budget (`hookTimeout`, `buildTimeout`,
`installTimeout`, `readyTimeout`). Reads such
as `status`, `list`, and `doctor` give up after five seconds and report
`rigd did not answer the doctor read within 5 s; it may be busy`, which is
distinct from `rigd is not reachable`: a slow daemon never turns `rig doctor`
into the offline host report. Reads are answered without queueing, so run
`rig activity` to see what `rigd` is doing, then retry.

`rigd` runs one mutation at a time across all Projects, so a slow hook or
readiness wait in one Project delays `rig up` and `rig deploy` elsewhere. When
a mutation has gone two seconds without an answer, `rig` prints on stderr
which operation `rigd` is running (Project, Target, action, operation id, and
start time) and how many more commands are ahead, so a wait always has a
visible cause; the command then keeps waiting for its own result.

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
It includes daemon administration and terminal crash evidence. rigd keeps the
most recent 1000 Operations in its state; older ones remain in the diagnostic
log until its retention expires. A request rigd refuses before an Operation
begins (an unregistered Project, a missing Target, a deploy aimed at local, an
init without a directory) is a usage mistake and is not listed; a refusal after
the attempt began (a failed preflight, an unresolved transition) is listed as
failed. Diagnostics live
in separate `logs/rig/rig.jsonl` and `logs/rigd/rigd.jsonl` files beneath the Rig
root, with daily rotation and 14-day retention by default. That retention does
not delete Target logs, activity, or Persistent storage. A record cut short by
a killed writer never glues onto the next one (the next record starts on its
own line) and never disables rotation: the segment's day comes from its first
complete record, or from the file's creation time when none can be read. Daemon administration
activity is written under a lock file that records the writer's pid and start
time; a lock left by a writer that died or was replaced, or an unreadable lock
older than a minute, is reclaimed by the next administration. When activity
cannot be recorded, the warning names the journal or lock file to inspect, and
the administration outcome itself is unchanged.

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

A lane (`local`, `live`, or `deployments`) may override a shared Component
under `components.<name>`. Scalar fields such as `command`, `port`, or
`envFile` replace the shared value, while `env` and `hooks` merge per key:
a lane that adds `hooks.postStart` keeps the shared `preStart`, and a lane
that repeats a key replaces just that entry.

A lane's `providers.processSupervisor` selects `rigd` (default; the daemon
owns child processes), `child` (alias of `rigd`), or `launchd` (one launchd
agent per Component). Any other name is rejected when the config is parsed, so
a typo can never be recorded in a Target plan. A launchd Component whose
application crashed and is waiting out its restart backoff is not restarted
again by `rig up` or `rig restart`; they wait for the restart the wrapper has
scheduled, then for the application to appear, and only report
`LAUNCHD_START` when it misses that schedule. Stopping a launchd Component
waits for the wrapper's full shutdown budget (SIGTERM, then SIGKILL, plus
headroom) before reporting `LAUNCHD_STOP`, and every stop that finds the job
gone, including one after a logout that already unloaded it, removes the
job's plist, request, and evidence files from `$RIG_ROOT/launchd`; a failed
bootstrap removes them too.

### Hooks and interpolation

Hooks are shell commands that run around a Target's processes. A Project may
declare `hooks` at the top level; a managed, Convex, or Postgres Component may
declare its own. Installed executables and SQLite paths have no process, so
`hooks` on them is rejected when the config is parsed; use an installed
Component's `build` for steps that must run before installation. Every hook
runs under `/bin/sh -c` in the Target workspace with the inherited base
environment, the Project `envFile` and `env`, and, for a Component hook, the
Component's own `envFile` and `env` layered on top. The inherited base is the
same for hooks, builds, and managed processes in both install modes: only
`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_ALL`,
`LC_CTYPE`, and `TZ` from the shell that ran `rigd install`. Tokens and other
variables in that shell never reach rigd or a Project's processes; declare
what a process needs in `envFile` or `env`. A hook writes its output to the
Target's logs under the Component name, or `setup` for Project hooks.

An `envFile` holds one `KEY=value` per line, with an optional `export`, single
or double quotes, and a `# comment` after the value (after the closing quote of
a quoted one; a `#` inside quotes is part of the value). Anything else, such as
a bare `KEY`, an unclosed quote, or text after a closing quote, is rejected as
`ENV_FILE` naming the file and line. A deployed Target reads its `envFile` from
the checked-out revision, so a gitignored `.env` is absent there and the
command fails as `ENV_FILE_MISSING` naming the path before any hook or process
runs: commit the file, declare the values in that lane's `env`, or remove
`envFile`.

Every hook, build, and dependency install runs within a budget in seconds:
`hookTimeout` on the Project (default 120) sets Project hooks and the default
for Component hooks, which may set their own `hookTimeout`; an installed
Component's `buildTimeout` bounds its `build` (default 600); the Project's
`installTimeout` bounds dependency installation on `live` and Preview Targets
(default 600). A command past its budget is killed together with anything it
started, what it printed until then is kept in the Target logs, and the
command fails as `HOOK_TIMEOUT`, `BUILD_TIMEOUT`, or `DEPENDENCIES_TIMEOUT`,
naming the hook or Component and the budget that ran out. A build that times
out leaves the previous installed artifact in place.

`rig up`, `rig restart`, and every deploy run hooks in this order:

1. Project `preStart`, only when at least one managed process is not already
   running. Installed executables are built and installed after it, so it may
   prepare what a build needs. On `live` and Preview Targets the checkout is
   immutable, so an installed executable is rebuilt only when its
   `entrypoint`, `build`, destination, or declared environment (`envFile`,
   lane `env`, Component `env`) changes, or when its source or installed
   artifact no longer matches the receipt; a daemon restarted from another
   shell does not rebuild anything. On `local`, Rig cannot see which files a
   build reads, so `build` runs on every `rig up` and `rig restart`; the
   executable is republished only when the build output actually changed,
   and an identical output is reported `unchanged`. Renaming a Component
   while keeping its `installName` hands the executable to the new name
   within the same Target; only another Target's Component is refused with
   `ARTIFACT_CONFLICT`, which names the owner.
2. For each Component in dependency order: the Component's `preStart`, the
   process start, readiness, then the Component's `postStart`. Readiness means
   the `health` check passed, or, for a Component without `health`, that the
   process survived the start grace period. A Component that was already
   running is skipped along with its hooks.
3. Routing, then Project `postStart` (again only when something started).

`rig down` runs Project `preStop`, then each active Component's `preStop`,
stops it, and runs its `postStop`; Project `postStop` runs last. Stop hooks
are skipped for Components that are already stopped. A start hook that exits
non-zero fails the command with `HOOK_FAILED`, which names the hook and the
Component (or the Project) and the exit code, and rolls back the processes
that command started. Stop-hook failures are reported as described above
without leaving processes running.

Every process Rig starts must listen on localhost only. Component
commands, health checks, and hooks are checked when the config is parsed and
again after interpolation: an explicit bind flag such as `--host`, `--bind`,
`--listen`, or `--addr` must name `127.0.0.1` or `localhost`, and a wildcard
address (`0.0.0.0`, `::`, `[::]`) is rejected anywhere in the command,
including inside a quoted wrapper like `sh -c "..."`. In `env`, bind-style
keys (`HOST`, `HOSTNAME`, `BIND`, `BIND_ADDR`, `BIND_ADDRESS`, `BIND_HOST`,
`LISTEN`, `LISTEN_ADDR`, `LISTEN_ADDRESS`, `LISTEN_HOST`, `ADDR`, `ADDRESS`)
may not hold a wildcard address; other env values are not inspected, because
`HOST` often names a public hostname rather than a bind address. A process
that reads its bind address from somewhere Rig cannot see is your
responsibility. A `health` value that starts with `http://` or `https://` in
any letter case is an HTTP probe: the whole string must parse as a URL with
no username or password and a hostname of `127.0.0.1` or `localhost`. Query
strings may mention other hosts. Any other `health` value is a shell command
and follows the command rule.

Commands, hooks, health checks, and build commands may use `${...}`
placeholders. The available properties are:

- `lane` (`local`, `live`, or `deployment`), `target` (`local`, `live`, or
  `preview`), `deployment` (the Target's deployment name), `branchSlug`, and
  `subdomain`.
- `workspace` and `dataRoot`: the Target's checkout and persistent storage.
  On `live` and Preview Targets, rigd owns both, so a SQLite `path` must
  resolve inside `dataRoot` and an `envFile` inside `workspace`; an absolute
  or `..` path that escapes them is rejected when the config is resolved,
  naming the Component and field. `local` keeps whatever path you wrote.
- Per Component `<name>`: `<name>.port` (also `ports.<name>` and
  `port.<name>`) and `<name>.url` for any Component with a port;
  `<name>.sitePort`, `<name>.siteUrl`, and `<name>.stateDir` for Convex;
  `<name>.dataDir` for Postgres; `<name>.path` for SQLite.

`branch`, `commit`, `domain`, and `project` are not interpolation properties,
and an unknown placeholder is rejected when the config is resolved so a typo
never reaches a shell. Because those strings run
under `/bin/sh -c`, Rig single-quotes any substituted value that contains a
space or other shell-special character, so a repository or `RIG_ROOT` under a
path like `~/Projects/My App` still resolves to one argument. A placeholder
the author already wrapped in quotes is substituted as is. Values substituted
into `env`, `domain`, `envFile`, and `entrypoint` are never quoted.

Not every config change needs a CLI command. Advanced or structured Project
policy may be edited directly in config or through a future Rig UI, while
`rig doctor` and preflight validate the result.

Rig serializes its own config edits with `rig.yaml.lock` beside the file. The
lock records the editing pid, so one left by a crashed edit is reclaimed once
that process is gone (or, when it recorded nothing, after a minute). An edit
refused as `config_locked` names the lock file and the live pid holding it.

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
registered identity/path conflicts. They do not delete Project data. `repoint`
re-plans the Working copy Target from the new directory's config with the same
port reservation as `rig up`: a port that another Target records is refused
with `PORT_RESERVED` and the registration is left unchanged.

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
