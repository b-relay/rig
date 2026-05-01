# rig

Local Mac deployment manager.

`rig` runs, inspects, and deploys local projects on one Mac. It is repo-first,
Effect v4 based, and built around `rigd` as the runtime authority. Runtime
state defaults to `~/.rig`; set `RIG_ROOT` for isolated test, CI, or agent
runs.

## Model

Rig projects use one `rig.json` with:

| Term | Meaning |
|---|---|
| `components` | Shared project units defined once. |
| `managed` | Long-running supervised runtime component. |
| `installed` | Build/install executable surface, not a supervised runtime. |
| `local` | Working-copy runtime lane. |
| `live` | Stable built deployment lane. |
| `deployments` | Template for generated previews and named deployments. |

Runtime mutation goes through `rigd`. CLI, future hosted control-plane
transport, logs, receipts, health, config editing, lifecycle actions, and deploy
actions use the same rig runtime state.

## Safety Model

Normal usage writes under `~/.rig`. Tests, CI, and agent runs should set
`RIG_ROOT` so they cannot touch real state, launchd labels, Caddyfile routes,
logs, workspaces, or generated deployment inventory.

Provider behavior is selected through profiles:

| Profile | Use |
|---|---|
| `stub` | Tests, agent runs, and config-flow validation. |
| `default` | Real local providers such as `rigd`, Caddy, local git, native health, package scripts, and optional launchd. |

## Install

```bash
bun install
bun run build
./rig --help
```

## Quick Start

Create or update a rig project config:

```bash
./rig init --project pantry --path . --provider-profile stub --package-scripts
```

Run local lifecycle commands from inside a managed repo:

```bash
./rig up
./rig status
./rig logs
./rig down
```

Run cross-project commands explicitly:

```bash
./rig up --project pantry
./rig status --project pantry --lane live
./rig deploy --project pantry --ref main --target live
./rig deploy --project pantry --ref feature/preview --target generated
./rig doctor --project pantry
```

Use isolated state for tests or agent runs:

```bash
export RIG_ROOT="$(mktemp -d)"
./rig init --project pantry --path . --provider-profile stub
```

Start the local authority explicitly when needed:

```bash
./rig rigd
```

## Docs

- [Rig product requirements](./docs/PRD.md)
- [Rig guide](./docs/rig-guide.md)
- [Rig design](./DESIGN.md)
- [Post-cutover validation](./docs/rig-cutover-readiness.md)
- [Effect v4 notes](./docs/effect-v4-help-notes.md)

## Development

```bash
bun install
bun test
bun run build
```

Architecture rules:

- Runtime: Bun.
- Language: TypeScript strict mode.
- Effects, services, layers, errors, schema validation, and CLI parsing use
  Effect v4.
- External concerns stay behind provider-family interfaces in `src/rig`.
- Concrete providers live in focused modules under `src/rig/providers`.
- `rigd` is the runtime authority for lifecycle, deploy, inventory, health,
  logs, receipts, config editing, and control-plane contracts.
- All output goes through the logger interface. Do not use `console.log` in
  runtime code.
