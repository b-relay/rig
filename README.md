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
```

Commands discover the Project from the current workspace. Use `--project <name>`
to select a registered Project elsewhere, and `--help` on any command for options.
`local` runs the working copy; `live` runs the configured Production branch;
Previews run other Branches. Lifecycle commands reuse recorded deployment policy.

New configuration uses `rig.yaml` and Host `config.yaml`. Existing JSON documents
remain supported. See the [guide](docs/rig-guide.md) for setup, Git push deploys,
configuration, diagnostics, and command behavior.

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
They need permission to bind localhost and a local Caddy executable. Existing
Host upgrades follow the [state preservation policy](docs/state-preservation-policy.md)
and [cutover procedure](docs/rig-cutover-readiness.md).

## Module Map

| Module | Responsibility |
|---|---|
| `src/config` | Validated YAML/JSON documents, revision-checked edits, and Target plan resolution. |
| `src/runtime` and `src/domain` | Serialized operations, recorded policy, deployment recovery, and observed status. |
| `src/daemon` | Authenticated localhost transport, administration, and adapter composition. |
| `src/providers` and `src/adapters` | Process ownership, Git sources, artifacts, routes, and Host effects. |
| `src/cli` and `src/diagnostics` | Command grammar, human/structured output, and diagnostic evidence. |
| `src/git` | Branch preflight, repository registration, and Git remote protocol. |
| `src/migration` | Explicit legacy metadata publication and verified ownership adoption. |

## Documentation

- [Product requirements](docs/PRD.md), [domain terms](CONTEXT.md), and [architecture](DESIGN.md)
- [User guide](docs/rig-guide.md)
- [Release and rollout evidence](docs/rig-cutover-readiness.md)
- [Repository cleanup findings](docs/reviews/2026-09-09-repository-cleanup.md)
- [Historical plans and removed documentation](docs/history.md)
