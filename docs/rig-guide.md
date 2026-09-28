# Rig Guide

This guide describes how to set up and use Rig. Domain terms are defined in
[CONTEXT.md](../CONTEXT.md) and the architecture in [DESIGN.md](../DESIGN.md).
Every command and flag is listed in the [command reference](commands.md).
Three complete example configs live in [examples](examples).

## Setup

Build the CLI:

```bash
bun install
bun run build
bun run typecheck
```

The build produces `rig`, `rigd`, and `git-remote-rig`. Put all three in the
chosen executable directory for Git push deployment. Source development and
tests must set an isolated `RIG_ROOT`; do not install into the real Host to
try a change. `RIG_ROOT` must be an absolute path: an empty value means the default
`~/.rig`, and a relative value makes `rig`, `rigd`, and `git-remote-rig` exit
with a usage error before they create or read anything, rather than rooting
Rig in the current working directory. Every command writes under the root (at
least its diagnostic log), so a root that is a file, or a directory the user
cannot write, is named by path before anything runs (`The Rig root /x is not
writable.` with a `chmod u+rwx` hint) instead of surfacing as a generic
failure whose hint points at a log that could not be written either. A root
that does not exist yet is fine as long as its nearest existing ancestor is a
writable directory.

Every command answers `--help` and `-h`, and `rig help <command>` (for
example `rig help deploy`, `rig help recipe diff`, or `rig deploy help`) prints
that command's usage; `rig help nonsense` fails with `Unknown command 'nonsense'.` and exit
1 instead of printing nothing. A usage error names the command it belongs to
in its hint (`rig up --bogus` says `Run rig up --help.`), and an empty value
for an option or argument that takes one (`--path ""`, `--project ""`,
`--deployment ""`, `rig repoint ""`, `rig deploy preview ""`) is refused as
empty rather than silently treated as the default. A Preview that was never
deployed is reported by the Branch or name that was typed (`Preview
'feature/x' has no recorded deployment.`), never by its internal hashed slug.

Install the daemon:

```bash
rigd install
rigd status
```

`rigd status` exits 0 only when the daemon is reachable; otherwise it exits 1
and its last line says what to do (`rigd is not installed. Run rigd install.`,
`rigd is installed but not running. Run rigd install to start it.`, or, for a
running daemon that does not answer, `Run rig doctor, or rigd uninstall and
then rigd install.`). `rigd capture <request-file>` is the command launchd
runs for each Service under the `launchd` supervisor; it is listed in
`rigd --help` and answers `--help`, but people never run it themselves.

`rigd install` owns daemon setup and creates the local control-plane auth token.
It issues a fresh token whenever it starts a daemon, so a credential left
behind by a crashed daemon does not outlive it; a current daemon that is
already reachable is left as it is and keeps its token.
A credential file that exists but is empty or unreadable is a `DAEMON_TOKEN`
error naming `<RIG_ROOT>/auth/control-plane.token` and the cause, never "not
installed": `rigd status` reports it as a warning with the daemon unreachable,
`rigd install` refuses to replace a daemon it cannot verify (stop it with
`rigd uninstall`, or restore the file), and with
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
one exists and then signals the recorded pid. A record that carries no start
time cannot verify a live pid: `rigd status` warns, and `rigd install`, `rigd
uninstall` and a starting daemon refuse, naming the files under
`<RIG_ROOT>/daemon` to remove once you have confirmed no rigd is running.

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
them through their recorded process leases without starting them again.
A stop signal (SIGTERM, `launchctl bootout`) first stops the daemon accepting
new connections, then lets the commands already running finish and answer
their callers, and only then closes what is still open, such as a log follow.
A command sent after the stop began, or one still waiting behind another
operation on its Target, is refused as `DAEMON_DRAINING` or fails to connect.
A stop signal never waits out a Service's `stop_timeout`, which may be an hour:
a command waiting for a Service to exit stops waiting and fails `STOP_DETACHED`,
and the Service keeps stopping on its own (its capture wrapper, or launchd,
still enforces the grace and the SIGKILL after it). A daemon killed while an
operation waits for a Service to exit leaves that Service stopping the same way.
For `rig down` and `rig restart` the Target was recorded as meant to be stopped
before its stop began, so the next daemon's startup pass stops it again (a
`restart` cut short this way leaves the Target stopped; run `rig up`). An
interrupted deploy, Preview destroy or a `down` that was resolving an
unfinished deploy is left for you to run again, and `rig status` says so.
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

The daemon's loopback `/health` endpoint answers `HEAD` as well as `GET`, so
a probe that only wants the status line gets 200 without a body.
`rig --version` and `rigd --version` print the build stamp: the release number
plus the commit the executable was built from, such as `0.1.0+cb6077187ba5`
(`bun build --define process.env.RIG_BUILD_COMMIT=...` embeds what
`git describe --always --dirty` reports; a build from a tree with uncommitted
changes ends in `-dirty`, and a run from source or a build outside git reports
`0.1.0+dev`; two `-dirty` builds of one commit, or two `+dev` runs, are not
distinguishable from each other). Deploys build from a clean checkout of the
Commit, so their stamps are never `-dirty`. A serving daemon reports its stamp to
`rigd status`, which warns when it differs from the `rigd` you ran. Upgrading
is `rigd install`: when the serving daemon reports another stamp, or the
installation record names another stamp, command, or bun for source-file
Tools (see "Config"), the install stops that
daemon, starts the current one, and reports what it replaced; managed processes
keep serving under their leases and the new daemon adopts them. The comparison
is equality only, so a rollback to an older commit is swapped in the same way,
and a daemon from before stamps counts as different. A daemon of the same stamp,
command, and bun is reported `unchanged`.
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

Rig refuses to add a route whose hostname another block in the route file
already serves (`ROUTE_CONFLICT`), comparing addresses the way Caddy does:
`app.example.test`, `https://app.example.test` and `app.example.test:443` are
one site, while `app.example.test:8443` is another. Removing a route that was
never written leaves the file and Caddy untouched.

Reload Caddy after adding the line. Until then every Rig route is inert:
`rig doctor` reports `caddy-proxy` as failed and `rig status` marks routes
`unpublished`. Rig looks for the import in `providers.caddy.host_caddyfile`, or
in `/usr/local/etc/Caddyfile`, `/opt/homebrew/etc/Caddyfile`, and
`/etc/caddy/Caddyfile` when unset. Host TLS or error snippets that every
generated site block needs, such as `import cloudflare`, go in
`providers.caddy.extra_config`. When the Host Caddyfile imports the route file,
Rig checks each change by adapting the Host Caddyfile (`caddy adapt`), so those
lines may use snippets the Host Caddyfile defines; a change Caddy rejects is
put back and kept beside the route file as `.rejected`. Until the import
exists, the route file is validated alone, where such a snippet is unknown.
Rig runs `caddy` as your user, without the Host Caddy's secrets, so write a
secret in the Host Caddyfile as `{env.NAME}`, which the running Caddy fills
in, not as `{$NAME}`, which whoever parses the file must hold:

```caddyfile
(cloudflare) {
	tls {
		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
	}
}
```

```yaml
# <RIG_ROOT>/config.yaml
providers:
  caddy:
    extra_config:
      - import cloudflare
    reload:
      mode: command
      command: caddy reload --config /usr/local/etc/Caddyfile
```

A changed `extra_config` reaches a route the next time that Target starts or
deploys. `providers.caddy.reload.mode` is `manual` by
default: Rig writes the route file and leaves every reload to you. With
`mode: command` and a `reload.command`, Rig runs that command after each route
change. The route file and
`rig.yaml` may be symlinks: Rig writes through the link, so the linked file
changes and the link stays in place, with the `.rig-backup` and `.bak` copies
beside the linked file. A config edit keeps exactly one `rig.yaml.bak`, the
text as it was before the latest edit, replacing the previous copy rather than
adding a file per revision.

When Caddy rejects a route change, the failure names Caddy's last error line,
for example `Caddy rejected the updated routes: ... port 99999 is out of
range`, and keeps the rejected text at `<route file>.rejected` so you can read
what Caddy saw; the live route file is left unchanged (`ROUTE_VALIDATE`). In
`command` mode a reload that fails carries the same last line and restores the
previous configuration. A `caddy`
executable that cannot start is reported as `CADDY_UNAVAILABLE` rather than a
route problem, and `rig doctor` lists `provider/caddy` beside `provider/bun`
and `provider/git`. The diagnostic log records that last line under `evidence`;
full command output never enters the log.

## Initialize A Project

From inside a Git repository:

```bash
rig init
```

`rig init` should:

- resolve the repository root, even when run from a subdirectory; a `rig.yaml`
  already present at or above the given directory inside the repository is
  registered instead, so `rig init --path packages/web` and `rig status` from
  `packages/web` agree on the Project
- choose a Project identity, defaulting to a slug from the repo directory
- confirm the Production branch interactively; the default is, in order,
  `--production-branch`, the branch `origin/HEAD` names, the host
  `deploy.production_branch` default, then `main`. The checked-out branch is
  never assumed to be Production: a non-interactive `rig init` on `feature/wip`
  records the host default, and the interactive prompt names the differing
  checkout so a deliberate answer can override it
- write committed Project config, `rig.yaml`, at the repo root (see below for
  what a new config needs)
- configure the `rig` Git remote when possible
- register the Project with `rigd`

If run outside Git in an interactive terminal, `rig init` may ask before running
`git init`. It should not create commits.

If config is written but `rigd` registration fails, `rig init` should report the
partial state without rolling the file back. A later `rig init` should resume
registration idempotently when the config still matches the workspace. An
existing config is never rewritten by `rig init`: scaffold flags passed with it
(`--production-branch`, `--domain`, `--service`, `--tool`) are reported as not
applied in a warning that names the kept config, so the outcome "registered"
never hides an ignored flag.

A second repository whose config (or directory slug) names an already
registered Project fails with `PROJECT_CONFLICT`. The hint names the
registered directory and both ways forward: `rig repoint <this directory>
--project <name>` when the repository moved, or another name for the new
Project, which is `name` in its `rig.yaml` when a config exists and `rig init
--project <other name>` when none does.

A Project needs at least one Service or Tool, so a new config is scaffolded
from flags:

```bash
rig init --service web --run "bun run start" --port 3000 \
  --ready http://127.0.0.1:3000/health --domain app.test
rig init --tool report --bin .rig-build/report \
  --tool-build "go build -o .rig-build/report ./cmd/report"
```

`--service <name> --run <command>` declares one Service; `--port <n>` pins its
`http` port (otherwise the port is `auto`) and `--ready <check>` sets its
readiness check. `--tool <name> --bin <path>` declares one Tool, with
`--tool-build <command>` as its build. Both may be given together, under
different names. `--run`, `--port`, or `--ready` without `--service`, and
`--bin` or `--tool-build` without `--tool`, are usage errors. With neither a
Service nor a Tool and no existing `rig.yaml`, init fails as `empty_project`:
pass the flags, or write `rig.yaml` by hand and run `rig init` again to
register it. The scaffold also writes `production_branch` and the default
Target names (`targets.working.name: local`, `targets.stable.name: live`),
under a first-line comment that points editors at the config schema (see
"Config").

Config is always `rig.yaml`. Explicit
`--production-branch` and `--create-git` support noninteractive setup. Project
identity comes from existing config when present, not a conflicting folder name.
`--domain app.test` with `--service web` scaffolds `domain: app.test` and a
`proxy` that sends `/` to the Service's `http` port. The Stable Target serves
`app.test`, each Preview serves `<preview name>.app.test`, and the Working
copy has no route unless `targets.working.domain` is set, so two Targets never
contend for one route. A `domain` value must be a hostname such as `app.test`;
`${rig.target}` is the only reference it may contain (for example
`${rig.target}.preview.app.test` under `targets.preview.domain`). A scheme,
port, path, wildcard, or comma-separated list is rejected when the config is
parsed, and a Preview whose resolved hostname is still invalid is rejected
when the Target is planned, before anything reaches Caddy.

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
folder name. Workspace discovery searches for `rig.yaml` from the current
directory upward, but never above the nearest Git working repository: a nested
repository without its own config (a vendored checkout inside a registered
Project, say) is "no Project", not the enclosing one, which is also what `rig
init` there would register.

`rig list` is host-scoped. It shows Projects plus summary metadata such as
Target count. It does not show every Target for every Project, and it never
observes a Target, so it is quick and says nothing about what is running
(`rig status` does). It does check that each registered directory still
exists: a Project whose directory is gone is marked `(directory missing: rig
repoint or rig forget <name>)`.

## Targets

Rig commands act on Targets:

| Target form        | Meaning                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `local`            | Working copy Target backed by the current checkout. `local` is its default name; `targets.working.name` renames it. |
| `live`             | Stable Target, deployed from the Production branch. `live` is its default name; `targets.stable.name` renames it.   |
| `preview <branch>` | Preview Target for a Branch. Branch names may include slashes.                                                      |

A Project has one Working copy Target, one Stable Target, and any number of
generated Previews. The examples in this guide use the default names `local`
and `live`; a Project that sets `targets.working.name: dev` and
`targets.stable.name: production` runs `rig up dev` and `rig deploy
production` instead. The two names must differ, and neither may be `preview`,
`help`, or end like a generated Preview name (a dash and eight hex digits). Renaming a
Target keeps its identity and stored data.

A bare name selects the Working copy Target or the Stable Target by its
configured name. A name a Target is still recorded under also keeps selecting
it until that Target is next planned from the renamed config, so a renamed
Target stays reachable. Any other name fails as `TARGET_UNKNOWN`, and the hint
lists the names that exist. Previews must use the `preview` selector, which is
reserved: `--deployment <name>` cannot give a new Preview the name of the
Working copy or Stable Target (`PREVIEW_NAME`), and a Working copy or Stable
Target cannot be renamed to a name another Target of the Project is still
recorded under (`TARGET_NAME`). While a name is configured for one Target and
still recorded for the other, selecting it fails as `TARGET_AMBIGUOUS`; the
hint gives the name that is safe to use first.

Target-aware commands with no selected Target show an interactive picker in a
TTY and fail as `TARGET_REQUIRED` in non-interactive use:

```bash
rig up
rig down
rig restart
rig logs
```

`rig status` is different: it takes no Target and always shows every Target of
the selected Project. `rig deploy` with no Target prints its help.

## Deploy

Stable deploy:

```bash
rig deploy live
rig deploy live main
```

Deploy is one command, `rig deploy <target> [branch]`, where `<target>` is the
Stable Target's configured name (`live` unless `rig.yaml` renames it) or
`preview`. Naming the Working copy Target fails as `DEPLOY_TARGET`; use `rig
up` for it. `rig deploy live` deploys the configured Production branch:
`production_branch` in the Project config, else the Host config's
`deploy.production_branch`, else `main`. It can run from
detached HEAD because it does not deploy the current checkout; it then prints
which Production branch it deploys. If the current checkout is on another
Branch, a terminal asks for confirmation and a non-interactive run is refused
as `PRODUCTION_CONFIRMATION`, with `rig deploy live <production>` as the way to
say it explicitly. The Stable Target only takes the Production branch: any
other Branch is refused as `BRANCH_POLICY`.

A deployed Target is planned from the `rig.yaml` committed on the deployed
revision, so its Services, Tools, ports, and Target name match the code it
serves. The working copy's config only identifies the Project (its name, its
Target names for selection, and the Production branch policy); uncommitted
edits to it never reach a Stable or Preview plan. A revision whose committed
config names a different Project is refused as `PROJECT_IDENTITY`, and an
invalid committed config fails the deploy with the revision's path in the
message: fix the config on that Branch and deploy the new Commit.

Each deploy checks out its revision under
`<RIG_ROOT>/targets/<project id>/<target id>/revisions/<uuid>` as a worktree of Rig's
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

`rig deploy preview` uses the current Branch: the one checked out where the
command runs, so a linked worktree deploys its own Branch. With `--project` it
is the Branch of the registered checkout. It fails from detached HEAD. A
Preview deploy from the Production branch itself is rejected; create a branch
such as `preview/main` when you want a preview of production code.
`--deployment <name>` names the Preview explicitly instead of deriving the
name from the Branch; only `preview` takes it.

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

The Host config's `deploy.previews.max` caps Previews per Project (default 25);
every recorded Preview counts, running or not. Under `replace_policy: oldest`, a
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
`replace_policy: reject`, a deploy at the cap fails with `PREVIEW_LIMIT`.

A deploy builds the new Commit before it touches the Deployment that is
running, so a failed build leaves the previous Deployment serving. A first
deploy whose build or activation fails leaves the Target recorded at the new
Commit but incomplete: its effects were rolled back and nothing is running.
`rig status` and `rig doctor` say so. After a readiness failure `rig up`
finishes it, installing, routing, and starting the recorded plan under its own
checkpoint, after which a deploy of the same Commit is `unchanged` again. After
a build failure `rig up` is refused as `PREPARATION_INCOMPLETE`; redeploying
the same Commit builds it again in a fresh Deployment.

Every port recorded by any Target in any Project is reserved while that record
exists, whether the Target is running or stopped. A Target whose deployment
transition is unresolved also keeps the ports of the plan that `rig down` may
restore, so no other Target can be planned onto them in the meantime. A pinned
port another Target holds is refused as `PORT_RESERVED`, naming the owning
Target and Project. Rig keeps ports apart among its own Targets only; it does
not reserve them against other processes on the machine.

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
refuses it with the usual deployment errors. A deployment whose local Branch
no longer contains the deployed Commit (the Branch was deleted and recreated,
or rebased) is withheld too, so the push goes through and redeploys instead
of git rejecting it as non-fast-forward with a `git pull` hint the Rig remote
cannot serve. A push that fails, for example because the pushed Commit's
`rig.yaml` is invalid, is recorded in `rig activity` under the Target it aimed
at with the same code the error carries (`INVALID_YAML`), not as an unexpected
failure of no Target. Interrupting a push with Ctrl-C
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
- Rig remote pushes do not support `--no-up`.

A successful push prints one line per Branch on stderr naming the Project,
the Branch, the outcome, the Target it landed on (Preview names are derived,
such as `feature-login-0d6e4079`), its route, and the operation id, for
example `demo feature/login deployed to feature-login-0d6e4079 at
feature-login-0d6e4079.demo.test (operation 3f2c…)`. Two git behaviours are worth
knowing. `git push --force rig <branch>` with the Commit that is already
deployed never reaches rigd: git sees the advertised ref and answers
"Everything up-to-date", so a same-Commit redeploy is `rig deploy <target>
--force`. `git push --all rig` deploys every local Branch as a Preview, one
after another, and the Preview limit retires the oldest ones as it goes; push
Branches by name unless that is what you want. Pushing from a directory that
is registered as a different Project (`git push other main` from the `demo`
checkout) is refused with `PROJECT_PATH_CONFLICT` naming both Projects and the
remote URL to use; `rig repoint` is only suggested for a directory no Project
is registered at.

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
that adds a Service the recorded plan has no port for is also reported as
`config-drift`, naming the added Services; `config-invalid` is reserved for
a config that does not parse or resolve, and carries the parser's message.
Deployed Targets (the Stable Target and Previews) keep their recorded plan
until the next deploy. They are planned from the committed config in their
checkout, so `rig doctor` compares a deployed Target with that revision's
config, not with the working copy; uncommitted edits are not drift for it.
When the checkout's
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

`up` reports `started` only for processes Rig has confirmed alive. A Service
with a `ready` URL is polled until it answers or `ready_timeout` (default
`30s`) expires, and
between polls Rig asks its supervisor whether the process still exists: a
process that exits fails the start at once as `PROCESS_EXITED`, naming the exit
code, instead of waiting out the timeout. A health answer counts only while
Rig's own process is running, so a foreign listener on the port cannot certify
a dead Service. An HTTP probe is ready on any answer below 400, a redirect
included, since a process that redirects is serving; a status of 400 or more,
a refused connection, or a shell check that exits non-zero is not ready. When
`ready_timeout` expires, `HEALTH_FAILED` names the last observation, for
example `web did not become ready (last check: HTTP 503).` or `(last check:
exit code 3: probing)`, and the Target log records each change in that
observation as a `health` line, so a probe that never answers, a 5xx, or a
check command's last output line is visible in `rig logs` rather than
discarded. A Service without a `ready` check is ready once every port it
declares accepts a connection on `127.0.0.1` or `::1`, within the same
`ready_timeout`. A Service with neither a check nor a port must survive a short
start grace period (half a second) before it counts as started; a command that
exits earlier, such as a missing binary or a port already in use, fails `up`
and rolls the start back. `HEALTH_FAILED` details carry `outcome`:
`unanswered` when no check answered within the budget, `unready` when the last
answer said not ready.

After readiness and before anything is published, Rig inspects what the
Service's process and its descendants listen on (TCP). A listener bound
beyond loopback, such as `*`, `0.0.0.0`, or a LAN address, fails the start as
`LISTENER_NONLOCAL`; `127.0.0.0/8`, `::1`, and IPv4-mapped loopback are
accepted. When the owning process or its sockets cannot be established the
start fails as `LISTENER_UNKNOWN` rather than being assumed safe. A routed
port, and a port used as readiness evidence, must be listened on by the
Service's own process tree: an answer from anyone else keeps the Service
unready. This inspection happens at activation. It is evidence about that
moment, not containment: a process can bind another address later, and Rig
does not watch for it. UDP and Unix sockets are not inspected.

Route and installed-executable changes run inside a durable effect
checkpoint under `<RIG_ROOT>/effect-checkpoints`. The journal records each
write before it starts and the result after it finishes, so a daemon killed in
between is recovered by the next `rig down` (rollback) or the recorded commit
decision (roll-forward) without treating its own half-finished write as an
external edit. Only a change made to an owned file _after_ the journal
captured it is refused as `EFFECTS_CHANGED`.

Installed executables share one bin directory, so while a Target's checkpoint
is unfinished, no other Target may install at a path it covers: that install is
refused as `ARTIFACT_CONFLICT`, naming the Project and Target to run
`rig down` for. This holds across a rigd restart, because rigd reads the
unfinished journals left on disk before it starts any change, including
journals it could not recover itself (from a newer rigd, say); if a journal
or an executable's ownership record cannot be read then, the change fails
rather than guess. A recovery holds the paths it undoes while it runs. If
another Target nevertheless owns an executable the interrupted change was
writing (an older rigd could let it install there), recovery refuses as
`EFFECTS_CHANGED`, removes nothing and keeps the checkpoint. Give that other
Component a different `installName` and deploy it again, or remove its Target;
then run `rig down` for the first Target again.

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
A process that could not be stopped aborts `down` and `restart`. Rig runs no
hooks: they are not part of the config.

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
`--follow` streams. Logs may be read for stopped Targets when logs exist. Every
follow page is validated the same way as the first; a malformed page ends the
follow with `DAEMON_PROTOCOL` and no further poll, which is distinct from
cancellation.
`--lines` sizes the first page only; a follow then fetches up to 1000 new
entries per poll so a busy Target is not throttled to the page size. A follow
ends on Ctrl-C, SIGTERM, or when whatever reads its output goes away (for
example `rig logs live --follow | head`): the write that fails is dropped, the
command exits 0, and rigd sees no further polls. A quiet follow notices the
missing reader at its next line, not before.

Every value `rig` prints on one terminal line (Project, Target, Branch and
Component names, warnings, log lines, prompt labels) is shown as terminal-safe
text: escape sequences (7- and 8-bit), zero-width characters and bidi
controls are dropped, and any other control character becomes a space, so an
untrusted repository cannot rewrite, hide, or reorder what `rig status`,
`rig list`, `rig logs`, or a prompt displays. `--json` output is not altered.
Output identifies component, timestamp, and stream with `>` for stdout, `!`
for stderr, and `~` for health-check evidence; a record with missing
evidence is marked unknown. Times are the UTC clock the record was
written at, printed with a `Z` (`23:30:00Z`) so they are not mistaken for
local time. Build and install
output is recorded line by line as the command produces it, each line at
the time it was seen, so a long build is visible in `rig logs --follow` while
it runs rather than as one burst afterwards.
A Target's `target.jsonl` is rotated once it reaches 64 MiB: the full file
becomes `target.jsonl.1`, replacing the previous one, so a chatty Component
holds at most about 128 MiB of log on disk. `rig logs` reads both generations
and a `--follow` continues across the rotation without repeating or losing
lines. The files launchd writes for a job (`<component>.stdout.log` and
`<component>.stderr.log`, which hold a capture wrapper's own crash output or
an uncaptured app's output) are shown under their Component with an unknown
time. A log file that cannot be opened, or that is not a regular file, fails
as `LOG_UNREADABLE` naming the file and the reason; `LOG_CURSOR` is reserved
for a follow whose cursor no longer matches the files.
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
Like `rig logs` and `rig activity`, it validates the reply before rendering:
a reply whose collection is missing or holds a malformed record fails as
`DAEMON_PROTOCOL` ("rigd returned an invalid response") with a nonzero exit,
so a version mismatch can never look like "No Projects registered", "No logs
yet", or "No activity yet"; only a validated empty collection prints those.

`rig doctor` always runs Host diagnostics. When a Project context is available,
it also runs Project diagnostics and the clean report names the Project ("Host
and pantry healthy"). Outside a Project, in a directory whose config is invalid,
in a directory whose valid config names a Project that is not registered, or
when rigd is unreachable, it still runs the Host checks and ends with a note
that says Project checks were skipped and why ("Project checks were skipped:
Project 'app' is not registered. Run rig init in this Project directory."), so
a clean Host report is never mistaken for a clean Project. For the Stable
Target, a `live/branch` check compares the Branch it was deployed from with the
current Production Branch (`production_branch`, else the Host default); a
Production Branch changed since the deploy is `production-branch-drift` with a
hint to redeploy. `doctor` is read-only by default. One report reads the repository config once, so the
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

Background failures inside `rigd` are not dropped. When the diagnostic log
cannot be written, or a supervision pass fails, `rigd` keeps one
bounded notice per channel (a count, the first and last time, and the latest
message; never log contents) and `rig doctor` reports it as a failing
`rigd/diagnostics` or `rigd/monitor` check with what it means: operation
outcomes are never changed by a logging failure, and exits are neither
recorded nor retried until a pass succeeds again, which clears the notice. The
notices live in memory and reset when `rigd` restarts.

An unreadable `<RIG_ROOT>/runtime/state.json` (invalid JSON, a wrong version,
or a malformed record) never makes `rigd` exit: startup records the failure in
the daemon diagnostic log and keeps serving, `rig doctor` reports
`runtime-state` as failed with the file path and the first problem, and every
other command fails with that same message. Every state write is flushed to
disk before it replaces the file, and the version it replaces stays beside it
as `state.json.bak`; the failure message points at that copy when it exists.
`rigd uninstall` refuses until the file is repaired, because it cannot verify
that Targets are stopped without it. Registered `repoPath` and `configPath`
values must be absolute; a hand-edited relative path is reported as a
malformed record rather than resolved against the daemon's working directory,
and a command that sends a relative path is refused as an invalid request
(`rig` resolves paths against your directory before sending).

The state file carries a format version (currently 4). A file written by a
newer or an older `rigd` is refused as `STATE_VERSION`, naming both versions,
rather than loaded with fields dropped or misread.
Keys this `rigd` does not know are kept through every read and write, so a
newer version's fields survive a temporary downgrade. Services that take
longer than about 4 s to stop need `rig down` first; see `stop_timeout`.

`rig` waits for `rigd` to answer a lifecycle or deploy command however long
it takes; `rigd` owns every budget (`build_timeout`, `ready_timeout`, each
at most one day, and the fixed dependency-install budget). Reads such
as `status`, `list`, and `doctor` give up after five seconds and report
`rigd did not answer the doctor read within 5 s; it may be busy`, which is
distinct from `rigd is not reachable`: a slow daemon never turns `rig doctor`
into the offline host report. Reads are answered without queueing, so run
`rig activity` to see what `rigd` is doing, then retry.

`rigd` runs one mutation at a time per Target, and Projects are independent:
a slow build, readiness wait or stop in one Project never delays `rig up`,
`rig deploy` or an automatic restart in another, and the Targets of one Project
(its Working copy, Stable Target and each Preview) run their operations side by
side. Only two operations on the same Target wait for each other, in the order
they arrived. Operations on the whole Project (`rename`, `repoint` and
`forget`) wait for every operation of that Project;
`rename`, `repoint` and `forget` refuse at once with `PROJECT_ACTIVE` while a
Target is running, mid-transition or still stopping, instead of waiting only to
refuse. A config edit from the website, and `rig init` of a Project already
registered, waits only for another edit, `init`, rename, repoint or forget of
the same Project, never for a Target. `rigd uninstall` refuses at
once with `TARGETS_RUNNING` while any operation runs. Resources the Targets share, such as ports chosen for `auto`, the
Preview limit, the route file and the state file, are taken only for the moment
each choice or write needs, never while a process is being stopped or built. A
deploy of a new Preview at the Preview limit also takes the Preview it is about
to replace, so that Preview's own commands wait until it is gone. See
[ADR 0007](adr/0007-per-target-operation-queue.md).

When a lifecycle or deploy command has gone two seconds without an answer and
`rigd` is holding it behind another operation on its Target, `rig` prints on
stderr what it is waiting for, and how many more operations are ahead of it.
Behind a stop it names the Service and when it is killed, as time left and local
time:

```text
Waiting: fletcher local is stopping (google-scheduler, killing in 18m at 04:31)
```

Behind anything else it names the operation and the local time it started. When
the command's own operation waits for a Service to exit for longer than about
two seconds (`rig down`, `rig restart`, a deploy replacing or rolling back the
Target, a Preview destroy), `rig` shows each Service it has stopped and the
countdown to the one it waits on. Every deadline is shown as local time as well
as time left, so a log read later still makes sense.

- On a terminal the lines update in place:

  ```text
  Stopping fletcher local
    web                 stopped
    google-scheduler    stopping · killing in 18m 42s (04:31:07)
    (Ctrl-C to leave it stopping in the background)
  ```

- Without a terminal (a pipe, CI, an agent) nothing is redrawn and there are no
  carriage returns. `rig` appends plain lines: one when the wait starts, one every
  five minutes, one when a minute is left, and one when it ends. The `Waiting:`
  line follows the same rule, plus a line whenever what it waits for changes.

  ```text
  google-scheduler stopping, killing in 25m (04:31:07)
  google-scheduler stopping, killing in 20m (04:31:07)
  google-scheduler stopped after 6m 18s
  ```

The command then keeps waiting for its own result.

While `rig` shows a Service stopping, Ctrl-C detaches at once: the stop carries
on in `rigd`, and `rig` exits 130 with
`Left google-scheduler stopping in the background (killing at 04:31). Run rig down local --kill to stop it now.`
`rig down --kill` and `rig restart --kill` skip each Service's `stop_timeout`:
SIGTERM, then SIGKILL after the 1.5 s kill wait. A `--kill` also cuts short a
stop already running on that Target, whichever command started it (including
one left in the background, or one the next `rigd` resumed at startup), and
any stop another command makes on that Target while the `--kill` command runs;
then it does its own stop. There is no `--force` alias.

Ctrl-C (or SIGTERM) before a lifecycle or deploy command is submitted cancels
it: `rig` exits 0 and no runtime change was requested. Ctrl-C during a read
such as `rig list` or a `rig logs --follow` poll abandons the read and exits 0. Once a mutation is submitted the first Ctrl-C is acknowledged but not
honoured, because `rigd` finishes the mutation either way: `rig` prints
`rigd is still running up (operation <id>); it finishes in the background.
Press Ctrl-C again to detach.` on stderr and keeps waiting, and a mutation
that then completes renders its result as usual. A second Ctrl-C detaches:
`rig` exits 130, records `command.detached` in its diagnostic log, and names
`rig activity <id>` for the outcome (`--json` prints an `error` object with
code `DETACHED` and the `operationId`). A third Ctrl-C ends the process with
status 130 without waiting for anything. Ctrl-C or EOF at an interactive
prompt (a Target picker, an `init` question, a Production confirmation) is
the same cancellation: exit 0, no message, no diagnostic record. Answering no
to a confirmation is an explicit decision and is reported as `The operation
was cancelled.` with exit 1.

While a deploy is running, `rig status` and `rig doctor` report the Target
as `deploy in progress (operation <id>)` and show whatever is observed at that
moment. The "unresolved deployment transition; run down" warning is reserved
for a transition that no live operation owns, such as one interrupted by a
daemon crash.

Status shares one two-second budget across concurrent observations. Services
without a `ready` check are running, not healthy; uncertain observations
are unknown. Configured-only Components are configured, Tool-only Targets
can be ready, and partial runtime capability is degraded. Every Component
counts toward the Target state: a missing database or executable beside a
healthy process is degraded, not healthy. A Target whose processes all run but
at least one fails its health check is unhealthy, which is distinct from failed
(a process that exited or was never found). Processes decide whether a Target
is live at all: a Target whose processes are all stopped is stopped whatever
the state of its data. While an operation is waiting for a Target's Services to
exit (`rig down`, the stop half of `rig restart`, a deploy replacing or rolling
back the Target, the stop of a failed start, a Preview destroy, or the daemon
re-stopping it at startup), the Target is `stopping`, whatever its processes
show at that moment, and the Service being waited on reads
`stopping · killing in 18m (04:31)`. A Service that needed SIGKILL to stop
reads `stopped` with `Stopped after timeout (SIGKILL): it did not exit within its
stop_timeout.` (or `Killed by --kill (SIGKILL)`) until it starts again, and the
operation's Activity record says the same, so you can tell the grace was too
short. A deployed Target's line shows the
Branch and the short Commit it serves (`live  healthy  main@abc1234`); the
Working copy shows `working copy` there instead. Recorded routes stay
visible when stopped, and show `unpublished` when no Host Caddyfile loads Rig's
route file (see Setup). Doctor owns current-config drift and failed checks; it
does not repair or deploy configuration implicitly.

`rig activity` displays final daemon Operations separately from Target output.
It includes daemon administration and terminal crash evidence; two `rigd
install` runs that overlap both record their outcome, because an
administration waits (about five seconds) for a live writer to release the
activity journal before warning that its record was lost. rigd keeps the
most recent 1000 Operations in its state, and `rig activity` lists the latest
100 of them; older ones remain in the diagnostic log until its retention
expires. A request rigd refuses before an Operation
begins (an unregistered Project, a missing Target, a deploy aimed at local, an
init without a directory) is a usage mistake and is not listed; a refusal after
the attempt began (a failed preflight, an unresolved transition) is listed as
failed. Each line ends with the record's Operation id and is followed by its
message: the error code for a failed Operation, or `web exited with code 137.`
for a crash. A failure that prints `Operation: <id>` can be looked up with
`rig activity <id>` (a unique prefix of the id also works), which shows only
that record or reports that none was recorded, as happens when the request
never reached rigd. A failure the user can correct (a bad argument, a config
problem, a missing branch or directory, a reserved port, a Component that
never became ready, an unreachable or mismatched daemon) prints only its
message and hint; the `Operation:` and `Details:` lines, and the
`operationId`/`diagnosticPath` fields under `--json`, mark an internal fault.
The Operation id is assigned before any interactive prompt, so a fault while
`rig init` or `rig up` is still gathering answers prints both lines together.
Config validation hints name the field and the rule in plain words
(`Fix name: must start with a letter or digit and contain only letters,
digits, '_' or '-'.`, `Fix config: has no field named "bogusField".`), and
rig checks `--project` and `--deployment` before sending a request, so a
name rigd would reject is named at the terminal instead of being reported
as a version mismatch. Diagnostics live
in separate `logs/rig/rig.jsonl` and `logs/rigd/rigd.jsonl` files beneath the Rig
root, with daily rotation and 14-day retention by default. That retention does
not delete Target logs (which are size-bounded instead, see Logs), activity,
or Persistent storage. A record cut short by
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
- Services and Tools: commands, ports, readiness checks, builds, environment
- the hostname and the `proxy` routes

Host config (`<RIG_ROOT>/config.yaml`, every key optional) owns machine
capability:

- `deploy.production_branch`: the Production branch of Projects that set none
  (default `main`)
- `deploy.previews.max` (default 25) and `deploy.previews.replace_policy`
  (default `oldest`): the Preview limit and what happens at it (see Deploy)
- `providers.caddy`: the route file, the Host Caddyfile, `extra_config`, and the
  reload mode (see Setup)
- `diagnostics.retention_days` (default 14) and `diagnostics.level`
- `alerts.channels.macos.enabled`: whether operator alerts are posted as
  macOS notifications (see "Operator alerts"). When unset, it is on for a
  `rigd` installed as a LaunchAgent and off for a process-mode `rigd`
  (`RIG_ROOT` set, as tests and agent runs use)

Editors can check and complete both files from JSON Schemas generated from
the same validation Rig runs: [`schemas/rig.schema.json`](../schemas/rig.schema.json)
for `rig.yaml` and
[`schemas/host-config.schema.json`](../schemas/host-config.schema.json) for the
Host `config.yaml`. Make this comment the first line of the file:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/b-relay/rig/main/schemas/rig.schema.json
```

For the Host config, use `host-config.schema.json` in the same address. Inside
this repository a relative path such as `../../schemas/rig.schema.json` works
too, as in `docs/examples`. `rig init` writes the line into the `rig.yaml` it
scaffolds. The line is an ordinary YAML comment, so Rig ignores it. With it, an
editor running
[yaml-language-server](https://github.com/redhat-developer/yaml-language-server)
(the Red Hat YAML extension in VS Code, or the same server in Neovim, Zed,
Helix and others) offers field names and the allowed values of settings such
as `supervisor` and `restart`, flags unknown keys, and shows each field's
documentation on hover, including its default and, for a field that takes
`${...}` references, the references valid there. An editor cannot complete
inside a string, so the reference list is hover text. The schema covers field
shapes only; rules that span fields (a declared port behind each `proxy`
value, dependency cycles, reference resolution) are still reported by
`rig config` and `rig doctor`. Contributors regenerate the files with
`bun run schema` after changing `src/config/schema.ts`; a test fails until
they match.

A small `rig.yaml` with two Services, a Tool, and a route:

```yaml
name: pantry
production_branch: main
domain: pantry.test

env:
  LOG_FORMAT: json

services:
  api:
    run: bun run src/api.ts
    ports: { http: auto }
    env:
      HOST: 127.0.0.1
      PORT: ${services.api.ports.http}
      DATA_DIR: ${rig.data}
    ready: http://127.0.0.1:${services.api.ports.http}/health
  web:
    run: bun run src/web.ts --port ${services.web.ports.http}
    ports: { http: 3000 }
    env:
      API_URL: http://127.0.0.1:${services.api.ports.http}
    ready: http://127.0.0.1:${services.web.ports.http}/
    ready_timeout: 1m
    depends_on: [api]

tools:
  pantryctl:
    build: bun build --compile src/cli.ts --outfile .rig-build/pantryctl
    build_timeout: 5m
    bin: .rig-build/pantryctl

proxy:
  /: ${services.web.ports.http}

targets:
  working:
    name: local
    env: { LOG_FORMAT: pretty }
  stable:
    name: live
  preview:
    domain: ${rig.target}.preview.pantry.test
```

Top-level fields: `name` (required Project identity), `description`,
`production_branch`, `domain`, `supervisor`, `build`, `build_timeout`, `env`,
`env_file`, `services`, `tools`, `proxy`, and `targets`. A Project needs at
least one Service or Tool, and a Tool cannot share a Service's name. Service
and Tool names use lowercase letters, digits, and `-`. Unknown keys are
rejected with their field path.

A Service is a long-running process Rig starts and supervises. Its fields:

- `run` (required): the foreground shell command, run under `/bin/sh -c` in
  the Target workspace.
- `ports`: named local TCP ports. `auto` lets Rig choose a free port and keep
  it for the Target; a number from 1 to 65535 pins it. Previews always use
  chosen ports, so a pin applies to the Working copy and Stable Target only.
- `ready`: a localhost HTTP URL or a shell command that reports readiness, and
  `ready_timeout` (default `30s`).
- `stop_timeout`: how long the Service may take to exit after its stop signal
  (SIGTERM) before Rig ends it with SIGKILL, from `1s` to `1h` (default `10s`).
  It is the time after the signal, not a total. Every stop honours it: `rig
down`, `rig restart`, a deploy that replaces or rolls back the Target, a
  Preview destroy, the stop of a failed start, and `rigd` re-stopping a Target
  at startup. A role patch may set it (`targets.stable.services.worker.stop_timeout`).
  Rig waits for SIGKILL's kill wait (1.5 s) on top. A Service that exits within
  its grace is a requested stop; one that needs SIGKILL is recorded as
  `stopped after timeout (SIGKILL)`. `rig down --kill` skips the grace.

  **Changed default.** Until this setting existed every Service had 1.5 s. It is
  now 10 s, so a Service that ignores SIGTERM takes about 10 s to `rig down`
  instead of about 1.5 s. Set `stop_timeout: 2s` to keep a short stop.

  **Downgrading.** Under `supervisor: rigd`, a `rigd` from before
  `stop_timeout` kills a Service's capture wrapper about 4 s after its stop
  signal, whatever grace the wrapper was started with, and does not signal the
  application behind it. An application still inside a longer grace then keeps
  running, and holding its ports, after its wrapper is gone. Run `rig down` on
  Targets whose Services take longer than about 4 s to stop before a temporary
  downgrade, or end such a process by hand afterwards.

- `depends_on`: Services that must be running and ready before this one
  starts. Unknown names and cycles are rejected when the config is parsed.
- `env` and `env_file`: see below.
- `restart`: `always` (default), `on-failure`, or `no`; see "Automatic
  restart".
- `build` and `build_timeout`: the Service's own build unit; see
  "Environment, builds, and startup".

A Tool is an executable the Project makes available on the Host rather than a
process Rig keeps running. `bin` (required) is the executable's path relative
to the workspace; `build` is an optional shell command that produces it, and
`build_timeout` bounds that build.

A `bin` that is a source file (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, or
`.cjs`) is not copied. Rig publishes a two-line shim,
`exec <bun> <workspace>/<bin> "$@"`, which runs the file in place, so its
relative imports resolve, and passes its arguments through. `<bun>` is the bun
that `rigd install` recorded in `<RIG_ROOT>/daemon/install.json`. A `rigd` run
from source records the bun running it. The compiled `rigd` (the output of
`bun run build`) is not bun, so it records the first `bun` on the `PATH` of
the shell that ran `rigd install`. Either way Rig prefers the `PATH` entry
that resolves to that bun over a versioned Cellar path, so a package upgrade
does not strand it. Rig never looks bun up when the Tool runs.

When `rigd install` finds no bun it still installs, since built Tools and
Services do not need one, and warns that source-file Tools will fail. Publishing
such a Tool without a recorded bun, or with a recorded one that is gone, fails
as `BUN_NOT_FOUND` and publishes nothing; an earlier shim stays as it was. With
no recorded bun, every `rig up`, `rig restart`, or deploy of a Target with a
source-file Tool fails this way when it reaches that Tool, even while its
earlier shim still runs. A Stable Target or Preview whose Project installs its
dependencies with bun fails before that, as `DEPENDENCIES_FAILED`, when bun is
not on the `PATH` that `rigd install` recorded. A shim
already published with a bun that has since been removed is not republished,
so `rig status` still shows it `installed`; `rig doctor` reports the missing
bun as `tool-bun`. Install bun, or fix `PATH`, and run `rigd install` again. A
different bun counts as a changed installation, so the daemon is replaced, and
the next `rig up` or deploy republishes each shim with the new bun. Until then,
and once after upgrading from a Rig that did not record bun, `rig status` and
`rig doctor` show those Tools as `unknown`; `rig up <target>` republishes them.
When `rigd install` adopts a running daemon, it cannot know which bun that
daemon read, so it records none and warns; run `rigd install` again to restart
the daemon with the current bun.

Durations are a positive whole number with a unit of `s`, `m`, or `h`, such as
`30s`, `10m`, or `1h`, up to one day.

`domain` is the hostname the Stable Target serves, and `proxy` maps a path
prefix to a declared port reference; `/` is required when `proxy` is present.
A prefix matches at a slash boundary (`/api` serves `/api` and `/api/users`,
not `/apix`), the longest matching prefix wins, and the upstream receives the
path unchanged. Wildcards are not prefixes, and two prefixes that differ only
by a trailing slash (`/api` and `/api/`) are one path and are refused. Upstreams are reached at
`127.0.0.1:<port>`, so a routed port must listen on IPv4 loopback.
While a routed Service is being started, by `up` or automatically, its paths
answer `503` until it is verified; the other paths of the Target keep their
upstreams. A replacement that fails verification is stopped and its paths stay
at `503`, also while other Services of the Target start or recover: a path is
released only when its own Service is next verified, by an automatic retry or
by `rig up` or `rig restart`. If the route cannot be withdrawn, the start is
not attempted.
A Preview serves `<preview name>.<domain>`, or `targets.preview.domain` with
`${rig.target}` replaced by the Preview's name. The Working copy has no route
unless `targets.working.domain` is set. A Target with no resolved hostname or
no `proxy` gets no route. A Tool-only Project needs neither.

The Production branch is `production_branch`, else the Host config's
`deploy.production_branch`, else `main`.

### Target names and settings patches

`targets` has three fixed keys, one per Target role: `working`, `stable`, and
`preview`. `targets.working.name` and `targets.stable.name` set the names that
select and display those Targets (defaults `local` and `live`; see Targets).
`targets.preview` takes no `name`, because Preview names come from their
Branch.

Everything else under a role is a settings patch applied over the top-level
settings for Targets of that role. A patch may set `domain`, `supervisor`,
`build`, `build_timeout`, `env`, `env_file`, `proxy`, and fields of existing
entries under `services.<name>` and `tools.<name>`. Maps merge per key: a
patch that sets `env.LOG_FORMAT` keeps every other shared `env` key, and a
patch under `services.api` leaves the Service's other fields alone. Lists
(such as `depends_on`) and scalars (such as `run` or a port) replace the
shared value. A patch cannot add a Service or Tool that the top level does not
declare, remove or null one out, set `production_branch`, `description` or
`role`, contain `targets`, or pin a port under `targets.preview`. The patched result
for each role is validated when the config is parsed, so a broken dependency
or a port pinned twice is reported under `targets.<role>`.

### Supervisors

`supervisor` selects `rigd` (default; the daemon owns child processes) or
`launchd` (one launchd agent per Service), at the top level or in a role
patch; a single Service cannot choose its own. Any other name is rejected when the config is parsed, so a typo can
never be recorded in a Target plan. Neither supervisor starts a Service again
by itself (launchd jobs are written with `KeepAlive` false); see "Automatic
restart". Both supervisors take every wait of a stop from the Service's
`stop_timeout`, so no outer layer kills the capture wrapper before its
application's grace can finish. The wrapper gives the application its grace,
then SIGKILL and a 1.5 s kill wait. `rigd` waits for the wrapper that long plus
2 s headroom before it would kill the wrapper. A launchd job's plist carries an
`ExitTimeOut` of the same budget rounded up to whole seconds (launchd's own
default is 5 s). Stopping a launchd Service waits for that `ExitTimeOut`, the
kill wait and headroom before reporting `LAUNCHD_STOP`, and every stop that finds the job
gone, including one after a logout that already unloaded it, removes the
job's plist, request, and evidence files from `$RIG_ROOT/launchd`; a failed
bootstrap removes them too.

### Automatic restart

`rigd` decides whether a Service that ended is started again; a supervisor
only starts it once and records how it ended. `restart` selects the policy:

| The Service                                                | `always`                   | `on-failure`  | `no`          |
| ---------------------------------------------------------- | -------------------------- | ------------- | ------------- |
| exited with code 0                                         | started again              | stays stopped | stays stopped |
| exited non-zero, or was ended by a signal Rig did not send | started again              | started again | stays stopped |
| is gone and nothing recorded how it ended                  | started again, more slowly | stays stopped | stays stopped |
| was stopped by `rig down` or `rig restart`                 | stays stopped              | stays stopped | stays stopped |

Each start is named, and an exit only counts when its record names the start
Rig last made. Every Service runs under a small capture wrapper (`rigd
capture`) that records how its process ended. When that record is missing,
for example because one signal ended the wrapper together with its process,
Rig reads what the supervisor saw of the wrapper instead: launchd's record of
the job (`last exit code` or `last terminating signal` in `launchctl print`)
under `supervisor: launchd`, or the wrapper's own exit as `rigd` saw it under
`supervisor: rigd`. A wrapper that is asked to stop by a signal stops its
process first and then ends by that same signal, so a signal found there is
how the process ended. It counts as a known exit, and Activity names where it
came from ("web was ended by SIGTERM (from launchd's record of its job)"). A
wrapper's exit code 0 is not counted, because a wrapper from an older `rigd`
also exits 0 after an outside SIGTERM. If the wrapper is gone but the process
it ran is still running on its own, the Service is reported `unknown`. Rig
neither signals that process nor starts another beside it; end it yourself,
then run `rig up`.

A Service that is gone with no record anywhere (its launchd job was unloaded
too, or nothing could be written or read) has `exit: unknown`. Under
`on-failure` and `no` it is reported `failed` and is never started again
automatically: run `rig up`. Under `always` it is started again, but only
once the supervisor shows that nothing of the old start still runs and none of
its ports accepts connections. While a port is still held, the attempt waits
and spends nothing. These retries have their own slower budget: three
attempts within any 10 minutes, 5 seconds, 1 minute and 5 minutes after the
exit. Activity and status say it was an unknown exit that was restarted.
`rig status` tells the cases apart in a stopped Service's `exit` field
(`clean`, `failed`, `requested`, `unknown`) and its reason, and Activity
records each exit and each automatic restart.

A Service gets five automatic attempts after known exits within any 60
seconds, the first 100 ms after the exit and each further one after twice the
previous delay. An attempt that fails to start spends an attempt. An attempt
refused because a Service it depends on is not running does not: the Service
waits, and `rig status` shows what it is waiting for. It starts in the pass in
which its dependency is running again. An attempt whose end nobody saw (the
supervisor could not start it, or its process was gone without a record
before it was ready) is an unknown exit like any other. A Service that used
all the attempts of either budget stays stopped, and stays so across `rigd`
restarts, until `rig up`, `rig restart`, or a new deployment starts it, which
also resets both counts. An `up` that finds a Service already running changes
nothing about it. `rig down` cancels any scheduled attempt. Siblings are
independent: one Service staying stopped never stops or restarts another, and
a Service that survived a `rigd` restart is adopted, not started twice.

Nothing is started again while `rigd` itself is down; the first pass of the
next daemon applies the same rules to what it finds. Every start, automatic
or not, reads the env files fresh.

#### After the Mac restarts or you log in again

A restart of the Mac ends every Service; logging out and in again ends those
of the old login session. Rig's
Service launchd jobs live under `$RIG_ROOT/launchd`, not
`~/Library/LaunchAgents`, so launchd does not load them again at login, but
`rigd` itself comes back. At each start, `rigd` compares the Host's boot
(`kern.bootsessionuuid`, new at every boot) and your GUI login session (the
audit session of launchd's `gui/<uid>` domain, new at every login) with the
ones it recorded last time:

- **Stable Targets meant to run** are started again the way `rig up` starts
  them: every Service in dependency order, whatever its `restart` policy, with
  fresh automatic-restart budgets. Activity records one `host-restart` entry
  ("The Mac restarted …" or "You logged out and in again …") and one `up` entry
  per Stable Target. `rig status` says each Service was started again by
  `rigd` ("restarted after reboot" or "restarted after login"). A Stable Target
  that fails to start is reported `failed` (every Service the start left stopped
  is, and none is retried automatically), stays meant to run, and waits for
  `rig up`.
- **The Working copy and Previews** stay stopped, even under
  `restart: always`. `rig status` reports their Services `stopped`, with
  `exit: unknown` and a reason that says they stopped when the Mac restarted
  (or when you logged out). Run `rig up` to start them. Until that start, no
  unknown exit of that Target is retried automatically; after it, the usual
  rules apply again. A Service that survived a logout is left running, and
  one whose earlier exit had already left it stopped (a clean exit under
  `on-failure`, say) keeps that status.
- Targets meant to be stopped stay stopped.

A plain `rigd` restart in the same boot and login session detects nothing and
follows the rules above. So does the first start of a `rigd` that had recorded
no session yet. A new boot is detected only when both boots could be read, and
a new login only when both login sessions could be (there is none to read
without a GUI login, over SSH only, say). A start that finds no restart but
could not read part of the session keeps the earlier record, so a reboot it
could not see yet is found at the next start. After a restart, a field the
read missed is kept from what was known before, except that a reboot ends
every login session, so no login is kept across one. `rigd` records the session only
once it has acted on the restart for every Target, so a daemon that stops or
is asked to stop halfway keeps it pending: the next start finishes it (even if
it can read nothing of the session) without recording it in Activity a second
time and without starting (or retrying) a Stable Target it already started, or
failed to start, for that restart. A restart whose Activity entry could not be
written yet is recorded by the start that finishes it. Only a session that changed since the
pending restart was found, such as a logout and login after it, is a new
restart.

### Operator alerts

`rigd` tells you when a Stable Target stops serving and stays down, so an
outage does not wait for someone to run `rig status`. The Working copy and
Previews never alert.

Every 30 seconds `rigd` observes each Stable Target that is meant to run, the
same way `rig status` does. It counts the Target as down when one of its
Services:

- has failed, including an unknown exit that is not started again;
- has used up its automatic restarts, even after clean exits;
- is still `starting`, for example waiting for a dependency that does not come
  back;
- fails its readiness check, or does not answer it within 5 seconds.

A Target also counts as down when its route is unpublished (no host Caddyfile
loads Rig's routes), or when a deploy left it mid-transition: its rollback
could not finish, or `rigd` stopped during the deploy. Its alert then says to
run `rig down` first, then `rig up`. An operation that is working on the
Target now (a deploy, a restart, an up or a down of that Target, or a change to
its whole Project such as `rig forget`), or an observation that did
not answer, changes nothing either way: a Target already counted as down gets
no first alert while an operation may be fixing it. Operations on different
Targets run at the same time; each one running, or waiting its turn, holds
back only the Stable Targets it may be changing. After the Mac restarts or you
log in again, `rigd` starting a Stable Target again counts the same way, so
a slow start is not mistaken for downtime since the restart.

The timing:

- **After 5 minutes down**, you get one alert. Normal restarts, deploy swaps
  and the retries after an unknown exit end well within that time, so they
  stay quiet. The 5 minutes count from the earliest exit Rig recorded for the
  Target's down Services, or else from when `rigd` first saw it down.
- **Targets that go down within one minute of each other** are one event and
  get one alert naming all of them, once each has been down 5 minutes: "3
  Stable Targets across 3 Projects went down at 13:58:58 UTC".
- **Every 6 hours** while any alerted Stable Target stays down, a reminder
  names each one and how long it has been down.
- **When it comes back**, one message says so, with how long it was down. A
  Target you stop with `rig down`, or that is no longer recorded, gets the same
  closing message, worded for that case.

An alert names the Project, the Target, the Services that keep it down with
the reason Rig recorded, and the command that starts it again
(`rig up live --project pantry`). A macOS notification carries a short form
of this: the command first for one Target, or the name of each Target for a
group (a banner shows its first lines; expand the notification for the rest).
The full text is in `rig activity`, where each alert that went out is
one `outage` entry: `failed` when Targets went down, `unchanged` for a
reminder, and `started` or `stopped` when they are no longer down. A Host-wide
event is one entry, not one per Service.

`rig doctor` has a `stable-targets` check that lists every Stable Target Rig
counts as down and for how long ("pantry live for 42 h (since
2026-09-25T13:58:58.000Z)"), with the commands that recover them. While `rigd`
is reachable, `rigd status` prints a `Down` line for each.

**Delivery.** The only channel today is a macOS user notification, posted
with `osascript` from `rigd`'s LaunchAgent in your login session. macOS files
these notifications under Script Editor. The first time, allow notifications
for Script Editor in System Settings > Notifications, or macOS may keep them
out of sight. Set `alerts.channels.macos.enabled: false` in the Host config to
turn the channel off. Rig then still counts downtime and records each alert in
Activity and doctor, but sends nothing. A process-mode `rigd` (`RIG_ROOT` set)
leaves the channel off unless its Host config sets `enabled: true`, so tests
and agent runs never post to your screen.

A delivery that fails is recorded in Activity (`alert failed`, with the
reason) and in the diagnostic log. It never changes the outcome of a
lifecycle operation. Rig tries again after 5 minutes, then waits twice as long
after each further failure, up to 6 hours. Alert state is kept in runtime
state under the Rig root, so a `rigd` restart neither repeats an alert nor
forgets one: a Target that recovered while `rigd` was stopped still gets its
closing message.

Push channels that reach you away from the Mac, such as Slack, come later,
together with a place to keep their secrets.

### Recipes

A recipe prints an ordinary Service for a common local dependency. There is no
plugin behind it: the block uses the same `run`, `ports`, `env` and `ready` you
would write by hand, and once pasted it is yours to edit.

```sh
rig recipe list
rig recipe generate postgres                 # prints a Service named db
rig recipe generate postgres@1 --name orders-db
rig recipe diff                              # every Service with a recipe comment
rig recipe diff orders-db --project pantry
```

`list` and `generate` need neither `rigd` nor a Project, and write nothing.
`generate` prints to stdout; paste the block under `services:` (it is indented
for that). `--name` renames the Service and every reference the block makes to
itself. The recipe's programs (`initdb`, `postgres`, `pg_isready`; `bunx` for
Convex) must be on the supervisor's `PATH`; Rig does not install them.

The first line of the block records where it came from:

```yaml
services:
  # rig-recipe: postgres@1 name=db
  db:
    run: ...
```

Keep that comment directly above the Service key. It is only a comment: Rig
never plans or runs from it, and deleting it just means `rig recipe diff` has
nothing to compare the Service with. `rig recipe diff` reads the config and
reports, field by field, what a newer bundled version changed (`Changed in`)
and what you changed since generating (`Your changes to`). It never edits
`rig.yaml`; to adopt a newer version, generate it and merge by hand.

`rig doctor` adds a `Notices` section when a Service was generated from an
older version than the one bundled, or when a recipe comment names a recipe or
version this Rig does not bundle or is not in the form Rig writes. Notices are
information: they do not fail doctor or change its exit code. A Service that
matches the bundled version, customized or not, is not mentioned. The offline
doctor (when `rigd` is unreachable) does not compute notices.

The Convex recipe keeps its backend state where the Convex CLI puts it (under
the user's home directory, per Convex project), not in `${rig.data}`: the CLI
offers no option for it. Targets of one Project may therefore share that state.

### Environment, builds, and startup

Every build and process runs under `/bin/sh -c` in the Target workspace. Rig
composes its environment fresh for each invocation, each layer replacing names
of the one before:

1. the baseline: `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`,
   `LC_CTYPE`, and `TZ` from the shell that ran `rigd install`, plus a
   `TMPDIR` Rig owns for the Target (`<RIG_ROOT>/tmp/<target id>`, mode 700).
   `USER` and `LOGNAME` name the operator's account as that shell had it, so
   tools that find the operator's login by account name (the macOS Keychain,
   for example) work as they do in a terminal
2. the top-level `env`
3. the Service's own `env`
4. the top-level `env_file` entries, in the order listed
5. the operator's Project files `<RIG_ROOT>/env/<project>/all.env`, then
   `<role>.env` (`working.env`, `stable.env`, or `preview.env`)
6. the Service's `env_file` entries, in the order listed
7. the operator's Service files `<RIG_ROOT>/env/<project>/<service>/all.env`,
   then `<role>.env`

A Service never reads another Service's `env` or files. A Tool build and
dependency installation get the Project layers only (1, 2, 4, 5). Nothing else
of the daemon's or the installing shell's environment reaches a Project's
processes: no `SHELL`, tokens, or Rig's own variables. Declare what a
process needs in `env` or an env file. Git discovery (`rig init`,
and `git push rig`) is Rig's own tooling; it runs with the login basics of
that shell and ignores `GIT_DIR` and `GIT_WORK_TREE`, so it always describes
the directory it was asked about. A build writes its output to the Target's
logs under the Tool name, and dependency installation under `setup`.

`env` is public configuration and is recorded in the Target plan. Secrets
belong in env files: their values are read when an invocation starts and go
only into that process's environment, never into references, plans, build
receipts, errors, or logs. Because files are read again on every start,
`rig restart` picks up a changed file; a changed file does not rerun a
completed build.

A listed `env_file` is required: when it is missing the command fails as
`ENV_FILE_MISSING` naming the path before any build or process runs. The
operator files under `<RIG_ROOT>/env/` are optional and are the usual home for
secrets, since they sit outside every checkout and so work for the Stable
Target and Previews too. A listed path may be absolute, start with `~/` (the
operator's home; `~user` is rejected as `invalid_path`), or be relative to the
Target workspace. On the Stable Target and Previews a relative path must stay
inside that workspace (`path_outside_target` otherwise) and is read from the
checked-out revision. An env file inside a Git repository must be ignored by
Git, otherwise the command fails as `ENV_FILE_TRACKED`: never commit a file
that holds secrets. When Git is present but cannot answer, the command fails
as `ENV_FILE_UNVERIFIED` rather than loading an unchecked file. A file other users can read still loads, with a warning in
the Target log asking for `chmod 600`.

When a file supplies a name that `env` or a lower file also supplies, the
Target log notes the name and the sources, never the values. One case is
refused rather than noted. If a `run`, `build`, or shell `ready` command
reaches a public env value through a reference, directly or through another
`env` value, that value is already part of the command text. A file that gives
the same name a different final value would make the command text and the
process environment disagree, so the invocation fails as `ENV_CONFLICT`,
naming the name, the Component, and the two sources. An equal value is no
conflict. Remove the name from the file, or have the command read `$NAME` from
the environment instead of referencing it.

An env file holds one `KEY=value` per line, with an optional `export`, single
or double quotes, and a `# comment` after the value (after the closing quote of
a quoted one; a `#` inside quotes is part of the value). Anything else, such as
a bare `KEY`, an unclosed quote, or text after a closing quote, is rejected as
`ENV_FILE` naming the file and line. Its contents are plain data and never
take part in `${...}` references.

Each declared `build` is one build unit: the top-level `build` is the shared
unit, and every Service and Tool `build` is its own. Units run one at a time,
the shared unit first, then Service units in dependency order, then Tool units
by name. Two units with the same command text are still two units. A unit runs
within `build_timeout` (its Service's or Tool's own, else the top-level one,
else ten minutes), and dependency installation on the Stable Target and
Previews within a fixed ten minutes. A command past its budget is killed
together with anything it started, what it printed until then is kept in the
Target logs, and the command fails as `BUILD_TIMEOUT` or
`DEPENDENCIES_TIMEOUT`, naming the unit and the budget that ran out. A failed
or timed-out build starts nothing and leaves the previous installed executable
in place.

On the Stable Target and Previews, builds belong to the Deployment. Every
deploy, including `--no-up`, builds all units of the new Commit's checkout
before the previous Deployment is stopped, and records each unit as started,
then succeeded or failed. `rig up` and `rig restart` start that prepared
Deployment and never build, whatever happened to a build's output since; if a
Service no longer starts because its build output is gone, deploy with
`--force`. A deploy of the same Commit is `unchanged`; `--force` checks the
Commit out again and builds a fresh Deployment. Rig cannot know what a shell
command did when `rigd` stopped before its outcome was recorded, so it never
runs that unit again under the same Deployment: `rig up`, `rig restart`, and a
plain deploy of the same Commit are refused as `BUILD_UNKNOWN`, and
`rig deploy <target> --force` (or a new Commit) is the way through. A
Deployment with a failed or missing unit is refused as
`PREPARATION_INCOMPLETE` the same way. Builds see `env_file` values when they
run, but a changed value never reruns a completed build; it reaches the next
process start.

On the Working copy, Rig cannot see which files a build reads, so explicit
commands build current source: `rig up` runs the unit of every Service that is
not running and of every Tool, with the shared unit first when any of them
runs; with every Service running and no Tool it builds nothing. `rig restart`
runs every unit. A Working copy that is already planned keeps its plan across
`rig up`; when `rig.yaml` changed since, the result carries a warning that
running Services still use the earlier plan, and `rig restart` applies the
current file.

`rig up`, `rig restart`, and an activating deploy then work in this order:

1. Tools are installed. The executable is republished only when the built
   file, its destination, the Tool's declared policy, or (for a source-file
   `bin`) the recorded bun changed, and is
   otherwise reported `unchanged`; a daemon restarted from another shell
   republishes nothing (a `rigd install` that records a different bun
   republishes each source-file Tool's shim). `deploy --no-up` publishes no Tool; the later `rig up`
   does, under its own checkpoint. Installed executables share one `bin/`
   directory across every Project and Target on the Host: `<tool>` for the
   Stable Target, and `<tool>-<target name>` for the Working copy (by default
   `<tool>-local`) and for a Preview. Two Projects that both install `cli` on
   their Stable Target therefore collide, and the second is refused with
   `ARTIFACT_CONFLICT`, which names the owning Project, Target, and Tool;
   rename one of the Tools.
   An executable Rig did not install is never overwritten
   (`ARTIFACT_UNOWNED`), and one that was edited by hand after installation
   is neither replaced nor retired (`ARTIFACT_CHANGED`, which blocks
   `rig down preview --destroy` too): both name the file, and moving or
   deleting it is the way through.
2. Each Service in dependency order: the process start, then readiness.
   Readiness means the `ready` check passed; without `ready`, that every
   declared port accepts a connection; without ports either, that the process
   survived the start grace period. Then its listeners are inspected. A
   Service that was already running is skipped, except that one another
   Service lists in `depends_on` is verified the same way first, so a
   dependent never starts against a running but unready dependency.
   `depends_on` gates starting only: a dependency that stops later does not
   stop its dependents.
3. Routing.

`rig down` stops each running Service, dependents first, each within its
`stop_timeout`. A start that fails rolls back the processes that command
started, within the same grace.

Rig has no hooks and no plugins. Run a database as an ordinary Service whose `run` command
starts it, and put preparation steps in a `build` or in the script `run`
invokes. A `run` command whose executable the shell cannot find fails as
`PROCESS_EXITED` with exit code 127 and a hint that names the missing tool
problem instead of waiting out `ready_timeout`.

### Localhost binding

Every process Rig starts must listen on localhost only. `run`, `ready`, and
`build` commands are checked when the config is parsed, and `run` and `ready`
again after references are resolved: an explicit bind flag such as `--host`,
`--bind`, `--listen`, or `--addr` must name a literal `127.0.0.1` or
`localhost` (not a reference), and a wildcard
address (`0.0.0.0`, `::`, `[::]`) is rejected anywhere in the command,
including inside a quoted wrapper like `sh -c "..."`. In `env`, bind-style
keys (`HOST`, `HOSTNAME`, `BIND`, `BIND_ADDR`, `BIND_ADDRESS`, `BIND_HOST`,
`LISTEN`, `LISTEN_ADDR`, `LISTEN_ADDRESS`, `LISTEN_HOST`, `ADDR`, `ADDRESS`)
may not hold a wildcard address; other env values are not inspected, because
`HOST` often names a public hostname rather than a bind address. A process
that reads its bind address from somewhere Rig cannot see is your
responsibility. A `ready` value that starts with `http://` or `https://` in
any letter case is an HTTP probe: the whole string must parse as a URL with
no username or password and a hostname of `127.0.0.1` or `localhost`. Query
strings may mention other hosts. Any other `ready` value is a shell command
and follows the command rule.

### References

`run`, `ready`, `build`, `bin`, `env` values, and `env_file` paths
may use `${...}` references. A reference is the exact path of one value in the
selected Target's own settings (the base config with that role's patch
applied), or one of the `rig.*` values Rig generates:

- `${env.<NAME>}` and `${services.<service>.env.<NAME>}`: a public `env`
  value. Values may reference each other; Rig resolves them recursively.
- any other scalar setting by its path, such as
  `${services.api.ready_timeout}`.
- `${services.<service>.ports.<port>}`: the concrete number of a declared
  port in this Target. `proxy` values must be exactly one such reference.
- `${rig.target}`: the Target's actual name, configured or generated. It is
  the only reference a `domain` may contain.
- `${rig.workspace}`: the Target's checkout, which is the repository for the
  Working copy.
- `${rig.data}`: this Service's persistent directory in this Target. It is
  only available inside a Service.
- `${rig.host}`: the Target's hostname when it has both a hostname and a
  `proxy`, otherwise empty.
- `${rig.url}`: `https://<hostname>` when the Target has a route;
  `http://127.0.0.1:<port>` of the `/` upstream when it has a `proxy` but no
  hostname; empty without a `proxy`.

References are checked when the config is parsed, for the base config and for
each role's patched settings, so a typo never reaches a shell. Each rejection
names the field that holds the reference, such as `services.web.run`:

- `unknown_reference`: no such path.
- `reference_not_scalar`: the path names a map or list, not one value.
- `reference_into_targets`: the path reaches into `targets`. A reference reads
  the selected Target's settings, not another role's patch.
- `reference_cycle`: values reference each other in a loop.
- `invalid_context`: `${rig.data}` outside a Service, or a shared or Tool
  `build` that reaches a Service's `env` or data, directly or through another
  value. Those builds run with Project inputs only. A reference inside a
  backquoted command is refused the same way; write `$(...)` instead.

Because the base config is checked by itself, a value that only a role patch
defines cannot be referenced from the base; give it a base value and let the
patch replace it. Env file contents are never referenceable. Write `$${VAR}`
for a literal `${VAR}` the shell should expand; `$VAR` is always left to the
shell.

Because `run`, a shell `ready`, and `build` run under `/bin/sh -c`, Rig
substitutes every value as literal data, never as shell code. A bare
reference is single-quoted when its value is empty or contains a space or
other shell-special character, so a repository or `RIG_ROOT` under a path
like `~/Projects/My App` still resolves to one argument. Inside the author's
own double or single quotes the value is escaped for that quote (a `$(...)`
inside them starts a command of its own and is quoted as such), so a `$`, a
backquote, or a quote character in the value stays part of the argument. A
`ready` value that resolves to an HTTP URL is handed to the HTTP probe
unquoted. Values substituted into `env`, `domain`, `env_file`, and `bin` are
never quoted.

Not every config change needs a CLI command. Advanced or structured Project
policy may be edited directly in config or through a future Rig UI, while
`rig doctor` and preflight validate the result.

Rig serializes its own config edits with `rig.yaml.lock` beside the file. The
lock records the editing pid, so one left by a crashed edit is reclaimed once
that process is gone (or, when it recorded nothing, after a minute). An edit
refused as `config_locked` names the lock file and the live pid holding it.

Current config surface:

- `rig config` prints validated Project config and its source path.
- there is no `rig config set`.
- managed fields such as Project identity are not simple settable fields.
- `--json` is available for status/lifecycle/deploy; there is no global flag.

Config is YAML only: a Project uses `rig.yaml` and the Host uses
`<RIG_ROOT>/config.yaml`. No other file name or format is read; `.yml` is
unsupported. YAML accepts one document with comments,
rejecting duplicate keys, tags, anchors, aliases, and merge keys. Supported
structured edits preserve comments/order or refuse before mutation.

A Project is its Git repository: every command run inside a linked worktree
(`git worktree add ../wt feature`, or one kept inside the repository such as
`.worktrees/feature`), and `git push rig` from one, resolves to the main
working tree, so the registered path stays the main checkout. The Production
branch comes from the Project or Host config (at `rig init`, from
`origin/HEAD`), never from the worktree's checked-out Branch. A directory in
the worktree finds its Project config at the same place in the main checkout,
searching upward from the deepest directory the main checkout holds there as
a plain directory of its own (not a symlink or a separate repository), and the
main checkout's `rig.yaml` is the one read: an uncommitted or branch-only edit
to the worktree's copy does not change the Project. `rig deploy preview` without a
Branch still deploys the worktree's own Branch. A push from a directory that is
not the registered repository or one of its worktrees fails with
`PROJECT_PATH_CONFLICT`, naming both paths.

`rig rename <name>` and `rig repoint <path>` require stopped Targets (none
running, meant to run, or mid-recovery) and validate registered identity/path
conflicts. They do not delete Project data. `rig rename <current name>` is
"unchanged" and leaves the config file alone. `repoint` requires the new
directory to be a Git working repository (`GIT_REQUIRED` otherwise, since
deploys and pushes would fail there) and re-plans the Working copy Target from
its config with the same port reservation as `rig up`: a port that another
Target records is refused with `PORT_RESERVED` and the registration is left
unchanged.

`rig forget <name>` removes a Project's registration under the same stopped
requirement. The repository, its `rig.yaml`, and its `rig` remote are not
touched, and the Project's activity history is kept. A Preview must be
destroyed first (`rig down preview <branch> --destroy`), because forgetting
would orphan its data; `forget` refuses with `PROJECT_TARGETS` naming the
Previews. Stopped `local` and `live` records go with the registration, and a
warning names the live workspace and data root that remain on disk for the
operator to delete.

A moved repository is recovered from inside it: `cd <new path> && rig repoint .`
selects the Project by the config's name, so the registered path may differ.
Until then, a `--project` command whose registered directory no longer exists
fails with `PROJECT_MOVED`, naming the old directory and the repoint command;
`rig status` carries the same text as a warning and `rig doctor` reports
`project-config` with reason `directory-missing`. Running another command from
an unregistered copy fails with `PROJECT_PATH_CONFLICT`, which names both
directories. `rig init` over a conflicting registration names the registered
Project and path, and whether `repoint` or `rename` resolves it.

Editing `name` in the config by hand is adopted the same way: `rig rename <new
name> --project <old name>` (or `rig rename <new name>` from the repository)
accepts a config that already declares the new name and updates the
registration and Git remote. Until then every command that reads the config
fails with `PROJECT_IDENTITY`, naming both names and that command, and `rig
doctor` reports `identity-drift` with the same hint.

## Provider Boundary

`rigd` resolves Host config and Project config into a runtime plan before
calling providers.

Providers receive everything they need from that plan. They do not read Host
config, Project config, or global path helpers themselves. The bundled
providers are the `rigd` and `launchd` process supervisors, the Caddy router,
the Git source store, the artifact installer for Tools, and the command
runner; their contracts live in `src/providers/contracts.ts`. Operator alert
channels implement `OperatorAlerts` (`src/domain/operator-alerts.ts`); the
macOS notification is the bundled one.

Tests supply isolated provider interfaces and `RIG_ROOT`. There are no
`--state-root` or `--config` path overrides.
Caddy command reload requires an explicit nonblank command; the manual
policy never substitutes a default reload command.
