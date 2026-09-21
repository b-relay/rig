# Rig

Rig runs, inspects, and deploys local Mac projects. The `rig` CLI and
`git-remote-rig` helper talk to `rigd`, which owns runtime state and coordinates
process, Git, artifact, and routing providers. The implementation uses strict
TypeScript, Bun, and Zod.

## Usage

```sh
rig init
rig up local
rig status
rig logs local
rig down local

rig deploy live
rig deploy preview feature/login
rig doctor
```

Commands discover the Project from the current workspace. Use `--project <name>`
to select a registered Project elsewhere, and `--help` on any command for options.
`local` runs the working copy; `live` runs the configured Production branch;
Previews run other Branches. `local` and `live` are the default Target names; a
Project may rename them under `targets` in `rig.yaml`. Lifecycle commands reuse
recorded deployment policy.

Configuration is YAML: `rig.yaml` for a Project and `<RIG_ROOT>/config.yaml`
for the Host. `rig recipe` generates ready-made Service blocks (Postgres,
Convex) to paste into `rig.yaml`. See the [guide](docs/rig-guide.md) for setup,
Git push deploys, configuration, diagnostics, and command behavior, and
[docs/examples](docs/examples) for complete configs.

## Development

```sh
bun install
bun run typecheck
bun test
bun run build
```

The build produces `rig`, `rigd`, and `git-remote-rig`. Keep tests and development
isolated from the installed Host with `RIG_ROOT`:

```sh
export RIG_ROOT="$(mktemp -d /tmp/rig-dev.XXXXXX)"
bun run src/index.ts --help
bun run src/rigd.ts --help
```

Integration tests create temporary daemons, processes, and provider resources.
They need permission to bind localhost and a local Caddy executable.

## Module Map

| Module | Responsibility |
|---|---|
| `src/config` | Validated YAML documents, revision-checked edits, and Target plan resolution. |
| `src/runtime` and `src/domain` | Serialized operations, recorded policy, deployment recovery, and observed status. |
| `src/daemon` | Authenticated localhost transport, administration, and adapter composition. |
| `src/providers` and `src/adapters` | Process ownership, Git sources, artifacts, routes, and Host effects. |
| `src/cli` and `src/diagnostics` | Command grammar, human/structured output, and diagnostic evidence. |
| `src/git` | Branch preflight, repository registration, and Git remote protocol. |
| `src/recipes` | Bundled recipe catalog, rendering, and comparison against a Project's config. |

## Documentation

- [User guide](docs/rig-guide.md), [command reference](docs/commands.md), and [example configs](docs/examples)
- [Editor JSON Schemas](schemas) for `rig.yaml` and the Host `config.yaml` (see "Config" in the guide)
- [Domain terms](CONTEXT.md) and [architecture](DESIGN.md)
- [Decision records](docs/adr)
- [Dated review records](docs/reviews)
