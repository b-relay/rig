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
rig down

rig deploy
rig deploy preview feature/login
rig doctor
```

Commands discover the Project from the current workspace. Use `--project <name>`
to select a registered Project elsewhere, and `--help` on any command for options.
The `working` Target runs the working copy; `stable` runs the configured
Production branch; Previews run other Branches. Those names are fixed. Only
`working` is on until `targets` in `rig.yaml` turns `stable` or `preview` on, and
without a Target `up`, `down` and `logs` mean `working` and `deploy` means
`stable`. Lifecycle commands reuse recorded deployment policy.

Configuration is YAML: `rig.yaml` for a Project and `<RIG_ROOT>/config.yaml`
for the Host. See the [guide](docs/rig-guide.md) for setup,
deploys, configuration, diagnostics, and command behavior, and
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
