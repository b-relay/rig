# Rig

Rig runs, inspects, and deploys local Mac projects. The `rig` CLI talks to
`rigd`, which owns runtime state and coordinates process, Git, artifact, and
routing providers. The implementation uses strict
TypeScript, Bun, and Zod.

## Usage

```sh
rig init
rig up
rig status
rig logs
rig monitor
rig down

rig deploy
rig deploy preview feature/login
rig run nightly-import
rig doctor
rig dns list
```

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

The build produces `rig` and `rigd`. Keep tests and development
isolated from the installed Host with `RIG_ROOT`:

```sh
export RIG_ROOT="$(mktemp -d /tmp/rig-dev.XXXXXX)"
bun run src/index.ts --help
bun run src/rigd.ts --help
```

### Releasing

A release is a tag. Bump `RIG_VERSION` in `src/domain/version.ts`, merge it,
then tag that commit `v<version>` and push the tag. The release workflow
(`.github/workflows/release.yml`) runs `scripts/package-release.sh`, which
compiles `rig` and `rigd` for Apple Silicon and Intel Macs into
`rig-<tag>-darwin-<arch>.tar.gz`, writes the tag into the `install` script, and
lists every file in `SHA256SUMS`. It then attests each file's build provenance
and publishes the GitHub Release. Run `scripts/package-release.sh <tag> dist`
from a clean checkout to try one locally.

The `install` script downloads one release's archive for the Mac it runs on,
checks it against `SHA256SUMS`, puts `rig` and `rigd` in `<RIG_ROOT>/bin`, and
runs `rigd install`. It changes nothing outside the Rig root: when
`<RIG_ROOT>/bin` is not on `PATH`, it prints the line to add rather than editing
a shell profile. It leaves alone a `rig` or `rigd` that a Rig Project's Target
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

## Documentation

- [The Rig website and dashboard](docs/website.md)
- [User guide](docs/rig-guide.md), [command reference](docs/commands.md), and [example configs](docs/examples)
- [Editor JSON Schemas](schemas) for `rig.yaml` and the Host `config.yaml` (see "Config" in the guide)
- [Domain terms](CONTEXT.md) and [architecture](DESIGN.md)
- [Decision records](docs/adr)
- [Dated review records](docs/reviews)
