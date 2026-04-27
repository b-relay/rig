# Rig2 Guide

`rig2` is the v2 runway for Rig. It is intentionally separate from the current
`rig` binary while v2 is still being validated.

Use `rig` for current production workflows. Use `rig2` to try the new v2 model
under isolated state.

## What Is Different

| Area | Rig v1 | Rig2 |
|---|---|---|
| Binary | `rig` | `rig2` |
| State root | `~/.rig` or `RIG_ROOT` | `~/.rig-v2` or `RIG_V2_ROOT` |
| Config shape | `environments.dev` and `environments.prod` | shared `components`, plus `local`, `live`, and `deployments` |
| Runtime lanes | `dev` and `prod` | `local`, `live`, and generated deployments |
| Components | v1 `services` with `server` or `bin` type | v2 `components` with `managed` or `installed` mode |
| CLI style | project/env positional commands | repo-first commands, with `--project` and `--config` for cross-project use |
| Deploy model | prod release/version oriented | git ref oriented; semver is optional metadata |
| Runtime authority | command-assembled runtime state | `rigd` owns state, receipts, logs, health, and control-plane contracts |
| Providers | concrete local defaults | provider interfaces and profiles |

## When To Use It

Use `rig2` for:

- testing the v2 config model
- validating repo-first lifecycle commands
- exercising `rigd` state, read models, action receipts, and config editing
- isolated agent or CI work with `RIG_V2_ROOT`

Do not use `rig2` as the default production manager yet. The current production
manager is still `rig`.

## Basic Setup

Install dependencies and build both binaries:

```bash
bun install
bun run build
bun run build:rig2
```

For isolated testing, set a temporary v2 state root:

```bash
export RIG_V2_ROOT="$(mktemp -d)"
```

## Create A V2 Config

You can scaffold a v2-style `rig.json` with the current `rig` init command:

```bash
./rig init pantry --path . --v2 --provider-profile stub --package-scripts
```

Use `stub` for isolated tests and agent runs. Use `default` only when you are
ready for real local providers. The process supervisor is selected per lane
with `providers.processSupervisor`; it defaults to the core `rigd` supervisor.
Use `"launchd"` there only for lanes that should use the bundled launchd plugin.

Minimal v2 shape:

```json
{
  "name": "pantry",
  "components": {
    "web": {
      "mode": "managed",
      "command": "bun run start -- --port ${port.web}",
      "port": 3070,
      "health": "http://127.0.0.1:${port.web}/health"
    }
  },
  "deployments": {
    "subdomain": "${branchSlug}",
    "providerProfile": "stub",
    "providers": {
      "processSupervisor": "rigd"
    }
  }
}
```

## Common Commands

Start the local `rigd` authority:

```bash
./rig2 rigd
```

Start the local lane from inside a managed repo:

```bash
./rig2 up
```

Start or inspect a project from outside the repo:

```bash
./rig2 up --project pantry
./rig2 status --project pantry
```

When running outside the project repo, pass the v2 config path if the command
should use deployment inventory or provider-backed execution:

```bash
./rig2 up --project pantry --config /path/to/pantry/rig.json
./rig2 status --project pantry --config /path/to/pantry/rig.json
```

Use the live lane:

```bash
./rig2 status --project pantry --lane live
./rig2 logs --project pantry --lane live --lines 100
```

Create deploy intents:

```bash
./rig2 deploy --project pantry --ref main --target live
./rig2 deploy --project pantry --ref feature/preview --target generated
./rig2 deploy --project pantry --ref feature/preview --target generated --deployment preview-a
./rig2 deploy --project pantry --config /path/to/pantry/rig.json --ref feature/preview --target generated
```

Manage optional version metadata:

```bash
./rig2 bump --project pantry --current 1.2.3 --bump patch
./rig2 bump --project pantry --current 1.2.3 --set 2.0.0
```

Run doctor checks:

```bash
./rig2 doctor --project pantry
```

## Config Editing Model

The v2 config editor is exposed through `rigd` interfaces today:

- `configRead`
- `configPreview`
- `configApply`

Edits are structured patches, not raw text writes. A patch operation uses a
path array:

```json
{
  "op": "set",
  "path": ["components", "web", "port"],
  "value": 4080
}
```

`configPreview` validates the candidate config with the v2 Effect Schema and
returns diffs without writing. `configApply` checks the expected revision,
validates again, writes atomically, and returns a backup path.

A CLI or hosted control-plane surface for these methods is still follow-up
work: #24.

## Current Limits

- `rig2` is not the default `rig` behavior yet.
- Repo-inferred `rig2 up`, `down`, `status`, `logs`, and `deploy` load the v2
  `rig.json` through the config-loader interface. Outside the repo, use
  `--project` plus `--config` to get the same validated config-backed path.
- Config-backed `rigd` lifecycle and deploy actions now run through ordered v2
  runtime provider methods before receipts are persisted. Runtime execution
  emits component-scoped events into `rigd` logs for web/CLI filtering. Concrete
  first-party adapter parity is still pending, but `structured-log-file` now
  writes deployment-scoped JSONL event logs under the v2 log root, and
  `native-health` now performs real HTTP health checks. Command health checks
  and process stdout/stderr ingestion are still follow-up work.
- `rig2` config editing exists behind `rigd` interfaces, but there is no
  polished user-facing CLI command for it yet.
- Hosted web transport for `rig.b-relay.com` is not implemented yet.

Tracked follow-ups:

- #23 rename/build `rig2` as `rig` when replacement criteria are met
- #24 expose config editing through a CLI or control-plane transport
- #25 connect lifecycle and deploy actions to provider-backed execution
- #26 add hosted control-plane transport adapter
