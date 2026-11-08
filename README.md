# Rig

Rig runs, inspects, and deploys local Mac projects. The `rig` CLI talks to
`rigd`, which owns runtime state and coordinates process, Git, artifact, and
routing providers. The implementation uses strict
TypeScript, Bun, and Zod.

## Install

Rig runs on macOS (Apple Silicon or Intel). Download the latest release's
`install` script and read it:

```sh
curl -fsSLO https://github.com/b-relay/rig/releases/latest/download/install
less install
```

Then, optionally, check it against the release's `SHA256SUMS` and its build
provenance:

```sh
curl -fsSLO https://github.com/b-relay/rig/releases/latest/download/SHA256SUMS
shasum -a 256 -c --ignore-missing SHA256SUMS
gh attestation verify install --repo b-relay/rig
```

And run it:

```sh
sh install
```

If you accept running it unread, this does the same in one line:

```sh
curl -fsSL https://github.com/b-relay/rig/releases/latest/download/install | sh
```

It puts `rig` and `rigd` in `~/.rig/bin` (and prints the line that adds it to
your `PATH`), the dashboard in `~/.rig/dashboard`, and starts `rigd`, which
serves the dashboard at `http://127.0.0.1:4280`. `rigd upgrade` installs a newer
release, and `rigd upgrade --check` says whether there is one. Releases follow
semantic versioning.

## Usage

A Project is a Git repository with a `rig.yaml`. `rig init` writes one with a
Service from flags (this one serves the directory with `python3`; any command
that serves HTTP on `${port}` will do) and registers it; `rig up` runs the
working copy:

```sh
git init -b main hello && cd hello
rig init --service web --command 'python3 -m http.server ${port} --bind 127.0.0.1'
rig up
rig status
rig logs
rig down
```

A deploy runs a Commit of a Branch, and `rig init` leaves the stable Target
off. Turn it on and commit, then deploy the Production branch (`main`) to
`stable`, and another local Branch to a Preview:

```sh
sed -i '' 's/stable: false/stable: true/' rig.yaml
git add rig.yaml && git commit -m "Run hello with Rig"
rig deploy
git branch feature/login
rig deploy preview feature/login
```

`rig monitor` watches CPU and memory, and `rig doctor` checks the Host and the
Project. `rig run nightly-import` runs a job declared in `rig.yaml`, once a
deploy has the Commit that declares it (below), and `rig dns list` needs Rig's
own Caddy and a DNS token.

Commands discover the Project from the current workspace. Use `--project <name>`
to select a registered Project elsewhere, and `--help` on any command for options.
The `working` Target runs the working copy; `stable` runs the configured
Production branch; Previews run other Branches. Those names are fixed. A Target
runs only when `targets` in `rig.yaml` turns it on, so a file without `targets`
runs nothing; `rig init` writes `working: true`, `preview: true` and
`stable: false`. Without a Target, `up`, `down`, `restart` and `logs` mean `working` and
`deploy` means `stable`. Lifecycle commands reuse recorded deployment policy.

Configuration is YAML: `rig.yaml` for a Project and `<RIG_ROOT>/config.yaml`
for the Host. A Project's keys use Docker Compose's names where the meaning
matches (`command`, `environment`, `env_file`, `working_dir`, `depends_on`,
`ports`, `restart`, `build`, and a Compose `healthcheck`), and the defaults keep
a small file small:

```yaml
name: notes
domain: notes.example.com
services:
  api:
    command: ./notes --port ${port}
    ports: { http: auto }
    healthcheck:
      test: http://127.0.0.1:${port}/health
targets: { working: true, stable: true }
```

A `jobs:` map beside `services:` runs commands on a cron schedule from the
same checkout and with the same references, in the stable Target unless a
job's `targets` say otherwise; `rig run <job>` runs one now, `rig status`
shows each job's last and next run, and a run's output is in `rig logs`
([ADR 0013](docs/adr/0013-scheduled-jobs.md)):

```yaml
jobs:
  nightly-import:
    command: ./notes import --db 127.0.0.1:${services.api.port}
    schedule: "30 3 * * *" # cron: 03:30 every day
    timezone: America/Chicago # default: the Mac's own time zone
    timeout: 2h
```

A job with `backup:` is a backup job: each run gets a fresh, empty
`$RIG_BACKUP_DIR` under `<RIG_ROOT>/backups`, a failed run's directory is
deleted, and only the newest `keep` successful backups stay.
`rig backup list` shows them, and `rig backup restore <job> latest` runs the
job's `restore` command against one, after asking
([ADR 0017](docs/adr/0017-backups.md)):

```yaml
jobs:
  db-backup:
    command: pg_dump -Fc -h 127.0.0.1 -p ${services.db.port} -d notes -f "$RIG_BACKUP_DIR/notes.dump"
    schedule: "0 3 * * *"
    backup:
      keep: 14
      restore: pg_restore --clean --if-exists -h 127.0.0.1 -p ${services.db.port} -d notes "$RIG_BACKUP_DIR/notes.dump"
```

`${port}` is the Service's one port, and with one Service that has one port the
domain routes to it without a `proxy`. A Service can also serve a hostname of
its own, such as `domain: api.notes.example.com` under it; a Preview gets
`api-<preview>.notes.example.com`. A Target is off unless `targets` turns
it on, so this file runs its checkout and deploys the stable Target but makes
no Previews; `rig init` writes `working` and `preview` on and `stable` off. The
healthcheck gates start and keeps
checking the Service while it runs; `rig status` shows its last result.

With Rig's own Caddy, `rig dns` and the dashboard's Proxy page manage your
Cloudflare DNS records with the token `rig proxy token` stored, and check
that every hostname Rig serves points at this Mac
([ADR 0018](docs/adr/0018-dns-records.md)). See the [guide](docs/rig-guide.md) for
setup, deploys, configuration, diagnostics, and command behavior, and
[docs/examples](docs/examples) for complete configs.

## Development

```sh
bun install
bun run typecheck
bun test
bun run build
bun run format:check
```

Rig is developed as a Rig Project on a Mac with Rig installed: `rig init` in
this repository registers it, and `rig up` runs its working Target. That serves
the dashboard from the working copy on a loopback port and publishes its Tools as
`rig-dev` and `rigd-dev`, beside the installed `rig` and `rigd`, which stay the
production release. Try a `rigd-dev` under its own `RIG_ROOT`, never the Host's.
The repository runs no stable Target.

`bun test` runs the full suite one file at a time. `bun run test:parallel` runs
the same files in four worker processes, starting the slowest files first from
`tests/timings.json`, and is several times faster. `bun run test:fast` does the
same without the end-to-end and compiled-binary files. `bun test <fragment>`
runs only the files whose path contains the fragment, for example
`bun test providers-process`. While working, run the typecheck and the focused
files for the change (or `test:fast`); run the full suite, the build and the
format check before merging to main or deploying to live.

Every test in the files `bunfig.toml` lists under `concurrentTestGlob` runs
concurrently with the file's other tests, so each must own its whole world: a
temporary `RIG_ROOT`, its own `rigd`, and ephemeral ports. The test scripts
start the `bun` that runs them (`$npm_execpath`), never whichever `bun` comes
first on the script `PATH`. After adding or reshaping slow files, refresh the
timings with
`bun test --parallel=4 --timings=tests/timings.json --update-timings`.

CI (`.github/workflows/ci.yml`) runs on every pull request and push to main.
A Linux job runs the format check and the typecheck. On an Apple Silicon Mac,
one job runs the whole suite as `bun run test:ci` (two files at a time, and at
most four of a file's concurrent tests at once), with `RIG_ROOT` set to a
directory no test uses, so a test that forgot its own root never reaches
`~/.rig`. It first builds Caddy 2.10.2 with the Cloudflare DNS module Rig's
Caddy needs, from pinned module versions, for the live Caddy tests, and fails
by name if a system tool the tests run is missing (`lockf`, `hdiutil`, `lsof`,
`ps`, `shasum`, `git`); nothing is skipped there. Git there names a new
repository's first branch `main`, as the tests assume. Only the
`hdiutil` volume test and the native process-usage reader skip, and only off
macOS. Another job packages the release with `scripts/package-release.sh`, runs
`bun run build`, and tries the package with `scripts/smoke-release.sh`; an Intel
Mac then tries the same files.

The build produces `rig` and `rigd`. Keep tests and development
isolated from the installed Host with `RIG_ROOT`. With only Bun, Git and
`bun install`, this runs a source `rigd`, the source CLI and the source
dashboard against one throwaway root:

```sh
export RIG_ROOT="$(mktemp -d /tmp/rig-dev.XXXXXX)"
bun run src/rigd.ts install   # a plain process under $RIG_ROOT, never launchd
bun run src/rigd.ts status
bun run src/index.ts list     # the source rig, talking to that rigd
RIG_WEB_KEY_FILE="$RIG_ROOT/auth/dashboard.key" PORT=4173 bun run web:dev
```

A source `rigd` serves no dashboard: it starts only a release's, from
`<RIG_ROOT>/dashboard/<release>`. So `web:dev` is the dashboard, with hot
reload, and `RIG_ROOT` points it at the same `rigd` (a Preview's
`RIG_WEB_SANDBOX_ROOT` would win over it). Open `http://127.0.0.1:4173/` and
sign in with any user name and the key in that file as the password; the site
writes the key on first start. To end, stop `web:dev` and any Target you
started (`bun run src/index.ts down <target>`), then run
`bun run src/rigd.ts uninstall`, which refuses while a Target runs, and delete
the directory. [Running it](docs/website.md#running-it) has the dashboard's
other modes.

### Releasing

A release is a tag. Releases follow semantic versioning: bump `RIG_VERSION` in
`src/domain/version.ts` (major for a breaking change to a command, config or the
control plane; minor for a new one; patch for a fix), merge it, then tag that
commit `v<version>` and push the tag. The release workflow
(`.github/workflows/release.yml`) refuses a tag on a commit that is not on
main, then runs all of CI on the tagged commit. CI's package job runs
`scripts/package-release.sh`, which compiles `rig` and `rigd` for Apple Silicon
and Intel Macs, builds the dashboard once (`scripts/build-dashboard.sh`; it runs
on either), generates `dashboard/THIRD_PARTY_NOTICES` from the licenses in
`node_modules` (`scripts/third-party-notices.ts`, which fails when a bundled
package has no license file), packs each architecture's `rig`, `rigd` and
`dashboard/` into `rig-<tag>-darwin-<arch>.tar.gz`, writes the tag into the
`install` script, and lists every file in `SHA256SUMS`.
`scripts/smoke-release.sh` then tries those files on an Apple Silicon and an
Intel Mac: every executable is built for its architecture, both archives hold the
notices, `rig --version` and `rigd --version` exit 0 printing exactly
`<version>+<commit>`, and the release's `install` script installs it into a
throwaway `RIG_ROOT` where the notices are kept, `rigd status` shows that build
serving and the packaged dashboard answers `/healthz`. Only when every CI job passes does the
release attest each file's build provenance and publish the files CI tried as
the GitHub Release. Run `scripts/package-release.sh <tag> dist` from a clean
checkout to try one locally, and `scripts/smoke-release.sh <tag> <commit> dist`
to smoke test it.

Publishing (`scripts/publish-release.ts`) uploads the files into a new draft,
which stays private, checks the draft holds exactly those files, each with this
run's SHA-256 (downloading any file GitHub reports no digest for), and only
then publishes it. Nothing is read as published or published unless the tag
still names the commit the run built. A release counts as already published
only when it holds exactly the release's files, each matching its published
`SHA256SUMS`, and that `SHA256SUMS` carries the release workflow's provenance
for the tag at that commit (`gh attestation verify`). A rebuild produces
different bytes, so a re-run never compares against its own. Drafts of a `v*`
tag belong to the release workflow. A release run can end in four ways:

- It fails before publishing (a failing check, packaging, the smoke test,
  attestation, or an upload): nothing is public, though a draft may be left.
  Re-run the workflow after a transient failure; it deletes the tag's drafts and
  uploads fresh files. When the tagged commit itself is wrong, delete the tag
  (`git push --delete origin v<version>`), fix main, and tag the fixed commit.
- It is interrupted while uploading: a private draft is left, and the next run
  of the tag replaces it.
- It fails after publishing, during cleanup say: the release is public and
  complete. A re-run finds it published with every file, changes nothing, and
  succeeds.
- A published release is not complete (a file missing, not matching its
  `SHA256SUMS`, or without provenance; publishing is never expected to leave
  one): the run fails and changes nothing. A published release is never
  replaced; compare its files with its `SHA256SUMS` and attestations by hand,
  and release a new version to change it.

The `install` script downloads one release's archive for the Mac it runs on,
checks it against `SHA256SUMS`, puts `rig` and `rigd` in `<RIG_ROOT>/bin` and
the dashboard in `<RIG_ROOT>/dashboard/<release>` (off `PATH`; `rigd` starts it),
runs `rigd install`, then removes earlier releases' dashboards once `rigd status`
shows this release serving (an install that adopted a running `rigd` of another
release keeps them). It writes only under the Rig root, besides what
`rigd install` sets up (a LaunchAgent in `~/Library/LaunchAgents`), and never
edits a shell profile: when `<RIG_ROOT>/bin` is not on `PATH`, it prints the
line to add. It leaves alone a `rig` or `rigd` that a Rig Project's Target
published, which Rig records in `<RIG_ROOT>/installed/owners` under the SHA-256
of the file's path. That record is bookkeeping between Rig's own deploys, not
protection: anything running as you can change these files. The installer checks
it with `RIG_ROOT` as spelled; through another spelling of the same directory (a
symlink) it does not see the record, and Rig notices instead, since that
Target's next deploy refuses bytes it did not publish (`ARTIFACT_CHANGED`, and
`rig doctor` reports it).

Integration tests create temporary daemons, processes, and provider resources.
They need permission to bind localhost and a local Caddy executable.

## Module Map

| Module                             | Responsibility                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `src/config`                       | Validated YAML documents, revision-checked edits, and Target plan resolution. |
| `src/runtime` and `src/domain`     | Per-Target operation queue, recorded policy, deployment recovery, and status. |
| `src/daemon`                       | Authenticated localhost transport, administration, and adapter composition.   |
| `src/providers` and `src/adapters` | Process ownership, Git sources, artifacts, routes, and Host effects.          |
| `src/cli` and `src/diagnostics`    | Command grammar, human/structured output, and diagnostic evidence.            |
| `src/git`                          | Branch preflight and repository registration.                                 |
| `web`                              | The rig.b-relay.com landing page, dashboard, and localhost relay to `rigd`.   |

### Tracing a behaviour

Where to start reading for four kinds of bug, in the order the work flows, and
which tests to extend:

- **A deploy leaves a Service stopped.** `src/runtime/application.ts`
  (`createRuntime`) selects the Target and Branch and decides a no-op or
  `--force`; `src/runtime/deploy.ts` (`deployCandidate`) builds, replaces and
  rolls back; `src/runtime/keep-decision.ts` decides which Services are kept
  ([ADR 0016](docs/adr/0016-keep-unchanged-services.md)); and
  `src/runtime/lifecycle.ts` (`createTargetLifecycle`) starts them and waits
  for readiness. Tests: `runtime-application`, `deployment-effects`,
  `keep-decision`, `keep-services`, `runtime-lifecycle`.
- **A Monitor value is wrong.** Presentation: `web/app/monitor/page.tsx` reads
  the report and `web/lib/usage.ts` (`chartReport`) shapes it. History:
  `src/runtime/usage-report.ts` (`usageReport`) over
  `src/adapters/sqlite-usage-history.ts`. Sampling:
  `src/runtime/usage-sampler.ts` (`createUsageSampler`) samples and totals the
  process readers that `src/daemon/composition.ts` picks, native or `ps`
  (`src/providers/native-process-usage.ts`, `ps-process-usage.ts`). The
  Service health monitor (`src/runtime/health-monitor.ts`) is unrelated.
  Tests: `dashboard-monitor`, `monitor-runtime`, `monitor-cli`,
  `usage-sampler`, `usage-history`, `process-usage-readers`.
- **A job runs at the wrong time.** `src/domain/cron.ts` calculates the
  instants; `src/runtime/job-scheduler.ts` (`createJobScheduler`) finds due
  times and dispatches them; `src/runtime/application.ts`
  (`runScheduledJob`) admits a run under the Target's lease and checks
  lateness; `src/runtime/jobs.ts` records runs; `src/runtime/job-status.ts`
  (`jobReports`) gives the next run status shows
  ([ADR 0013](docs/adr/0013-scheduled-jobs.md)). Tests: `cron`,
  `job-scheduler`, `jobs-runtime`.
- **A proxy route is not published.** `src/daemon/composition.ts`
  (`composeDaemon`) picks Rig's own Caddy (`src/providers/managed-caddy.ts`)
  when Host config has a `proxy` section, else the retiring external router
  (`src/providers/caddy-router.ts`). A Target's hostnames come from
  `src/runtime/ports.ts` (`plannedSites`); `src/adapters/target-routes.ts`
  publishes and withholds them through the `Router` in
  `src/providers/route-file.ts`, which owns the route file's blocks; and
  `managed-caddy.ts` switches and publishes generations
  ([ADR 0014](docs/adr/0014-rig-owned-caddy.md),
  [ADR 0020](docs/adr/0020-deploy-route-publishing.md)). Tests:
  `planned-sites`, `managed-caddy`, `activation-gates`, `verified-routes`,
  `deployment-effects`, and `providers-caddy` and `proxy-publication` for the
  external router.

## Documentation

- [The Rig website and dashboard](docs/website.md)
- [User guide](docs/rig-guide.md), [command reference](docs/commands.md), and [example configs](docs/examples)
- [Editor JSON Schemas](schemas) for `rig.yaml` and the Host `config.yaml` (see "Config" in the guide)
- [Domain terms](CONTEXT.md) and [architecture](DESIGN.md)
- [Decision records](docs/adr)
- [Dated review records](docs/reviews)
