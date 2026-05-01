# Rig2 Guide

`rig2` is the v2 runway for Rig. It is intentionally separate from the current
`rig` binary while v2 is still being validated.

Use `rig` for current production workflows. Use `rig2` to try the new v2 model
under isolated state.

V2 uses two config scopes:

- project `rig.json` for repo-specific components, lane overrides, and
  project-specific deploy behavior
- home rig config for machine/user defaults such as production branch defaults,
  generated deployment caps, replacement policy, and provider defaults

The home config lives at `~/.rig-v2/config.json` by default, or
`$RIG_V2_ROOT/config.json` when `RIG_V2_ROOT` is set. Missing home config uses
these defaults:

```json
{
  "deploy": {
    "productionBranch": "main",
    "generated": {
      "maxActive": 5,
      "replacePolicy": "oldest"
    }
  },
  "providers": {
    "defaultProfile": "default",
    "caddy": {
      "extraConfig": [],
      "reload": {
        "mode": "manual"
      }
    }
  },
  "web": {
    "controlPlane": "localhost"
  }
}
```

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

You can scaffold a v2-style `rig.json` with the `rig2` init command:

```bash
./rig2 init --project pantry --path . --provider-profile stub --package-scripts
```

Add bundled component plugins at init time when the project needs Rig-owned
database/backend components:

```bash
./rig2 init --project pantry --path . --provider-profile stub --uses sqlite,postgres,convex
```

`--uses` accepts `sqlite`, `postgres`, and `convex`. It only writes component
stubs such as `{ "uses": "postgres" }`; it does not add dependencies between
components, ports, Vite/Next presets, or package-manager-specific app commands.

Routing metadata can be scaffolded at the same time:

```bash
./rig2 init --project pantry --path . --domain pantry.b-relay.com --proxy web
```

`--domain` writes the project domain. `--proxy web` writes `proxy.upstream` as
`"web"` in the local, live, and generated deployment lanes. It does not create a
`web` component; add that component explicitly with the command, package manager,
and port your project actually uses.

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
      "command": "bun run start -- --port ${web.port}",
      "port": 3070,
      "health": "http://127.0.0.1:${web.port}/health"
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

Interpolation is component-first. For a component named `web`, `${web.port}`
means "the resolved port for the `web` component." In the `local` and `live`
lanes that is usually the component's configured `port`; in generated
deployments it can be the assigned per-deployment port.

## Caddy Provider Config

The bundled Caddy provider renders portable site blocks by default:

```caddy
# [rig2:pantry:live:web]
pantry.b-relay.com {
  reverse_proxy http://127.0.0.1:3070
}
```

Machine-specific Caddy behavior belongs in the v2 home config, not in project
config or the hard-coded renderer. For example, a maintainer machine that uses
the system Caddyfile plus reusable snippets can set:

```json
{
  "providers": {
    "caddy": {
      "caddyfile": "/usr/local/etc/Caddyfile",
      "extraConfig": ["import cloudflare", "import backend_errors"],
      "reload": {
        "mode": "manual",
        "command": "sudo launchctl kickstart -k system/com.caddyserver.caddy"
      }
    }
  }
}
```

`extraConfig` lines are inserted inside every Rig-managed site block after the
`reverse_proxy` line. The default reload mode is `manual`, so `rig2` writes the
Caddyfile but does not require sudo. If `reload.mode` is `command`, the bundled
Caddy provider runs the configured command after route upsert/remove. Use that
only with a command the current user can run non-interactively, such as a
passwordless narrow helper or an unprivileged Caddy admin reload.

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
./rig2 list
./rig2 up --project pantry
./rig2 restart --project pantry
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
./rig2 restart --project pantry --lane live
./rig2 status --project pantry --lane live
./rig2 logs --project pantry --lane live --lines 100
```

`rig2 status` defaults to readable terminal output. Add `--json` when you also
need the structured foundation, `rigd`, inventory, and runtime status details:

```bash
./rig2 status --project pantry --json
```

`rig2 list` reads the global v2 project/deployment inventory from `rigd` state.
Add `--json` to emit the structured read model:

```bash
./rig2 list --json
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

## Config Editing

The v2 config editor is exposed through `rig2 config` commands backed by
`rigd` interfaces:

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

Read the current project config from inside a managed repo:

```bash
./rig2 config read
```

Preview a config edit without writing:

```bash
./rig2 config set --path live.deployBranch --json '"stable"'
```

Apply the same edit:

```bash
./rig2 config set --path live.deployBranch --json '"stable"' --apply
```

Remove a field:

```bash
./rig2 config unset --path live.deployBranch --apply
```

Outside the repo, pass both project and config path:

```bash
./rig2 config read --project pantry --config /path/to/pantry/rig.json
./rig2 config set --project pantry --config /path/to/pantry/rig.json --path components.web.port --json 4080
```

`--json` must be valid JSON, so strings need quotes, booleans use `true` or
`false`, numbers are plain numbers, and objects/arrays use normal JSON syntax.

## Current Limits

- `rig2` is not the default `rig` behavior yet.
- Repo-inferred `rig2 up`, `down`, `status`, `logs`, and `deploy` load the v2
  `rig.json` through the config-loader interface. Outside the repo, use
  `--project` plus `--config` to get the same validated config-backed path.
- Config-backed `rigd` lifecycle and deploy actions now run through ordered v2
  runtime provider methods before receipts are persisted. Runtime execution
  emits component-scoped events into `rigd` logs for web/CLI filtering. Concrete
  `structured-log-file` writes deployment-scoped JSONL event logs,
  `native-health` performs real HTTP and command health checks,
  `package-json-scripts` runs installed-component build commands and installs
  executables into the v2-managed bin root, the core `rigd` process supervisor
  runs managed component commands while returning provider stdout/stderr lines
  for log ingestion, the bundled `launchd` process supervisor installs/removes
  v2-namespaced plists, `local-git` fetches and verifies deploy refs,
  `git-worktree` materializes/removes deployment workspaces at those refs, and
  `caddy` upserts/removes v2-namespaced Caddyfile routes.
- Config-backed lifecycle and deploy writes persist desired runtime state.
  `rigd.start` reconciles desired-running deployments from that state, so a
  fresh `rigd` process can restart previously running local/live/generated
  deployment records without needing project config to be passed again.
- `rigd.managedProcessExited` records managed process crashes, keeps stdout and
  stderr evidence when provided, restarts the desired-running deployment while
  the retry budget allows it, and marks the deployment failed after repeated
  crashes inside the backoff window. The core `rigd` process supervisor wires
  real child-process exits into this entrypoint, and `rig2 status` exposes
  desired deployment state plus recent managed-service failure evidence.
- Pantry cutover readiness is covered by v2 tests for a live
  `pantry.b-relay.com` route and an installed `pantry` CLI under an isolated
  v2 bin root.
- `rig2 config read`, `rig2 config set`, and `rig2 config unset` expose
  project config read/preview/apply through `rigd`. Hosted web config editing
  is still future work.
- Hosted web transport for `rig.b-relay.com` is not implemented yet.
- Home config is schema-validated and file-backed. Deploy intent now uses
  project `live.deployBranch` first, then home `deploy.productionBranch`, then
  the built-in `main` default. Generated deployment caps from home config are
  enforced for deploy-intent materialization and `rigd` generated deploy
  actions with `reject` and `oldest` replacement policies.

Tracked follow-ups:

- #23 rename/build `rig2` as `rig` when replacement criteria are met
- #26 add hosted control-plane transport adapter

Current plugin/preset track:

- SQLite tracks per-lane/per-deployment database file paths. SQLite is not a
  long-running supervised process, so this plugin stays focused on path
  ownership and status metadata.
- Postgres provides a supervised localhost-bound database component with
  per-lane/per-deployment port and data-root tracking.
- Convex Local provides a supervised localhost-bound Convex component with
  cloud/site ports and project-local state tracking.

Web framework presets such as Vite or Next.js are intentionally not first-class
plugins yet. Their default value is mostly command scaffolding, and teams can
write those commands directly with their package manager of choice. A later
adapter should only exist if Rig needs to safely edit framework config such as
allowed hosts or CORS.

Keep these plugins simple at first. Rig's job is to keep all parts of a
website/service in one project lifecycle, supervise daemon components through
`rigd`, and record which localhost ports and paths belong to `local`, `live`,
and generated deployments. Application environment variables, database users,
schemas, migrations, and connection strings remain developer-owned unless a
later plugin explicitly adds helpers.

Each v2 deployment has a Rig-owned `dataRoot` outside the app workspace:
`<stateRoot>/data/<project>/<lane>` for `local` and `live`, and
`<stateRoot>/data/<project>/deployments/<name>` for generated deployments.
Configs can interpolate it as `${dataRoot}`.

Plugin-backed components use `uses` instead of `mode`. `mode` remains reserved
for raw Rig primitives such as `managed` and `installed`; `uses` means the
component comes from a bundled or future external component plugin. SQLite is a
file-backed component:

```json
{
  "components": {
    "sqlite": {
      "uses": "sqlite"
    },
    "api": {
      "mode": "managed",
      "command": "bun run api -- --sqlite ${sqlite.path}",
      "dependsOn": ["sqlite"]
    }
  }
}
```

SQLite defaults to `${dataRoot}/sqlite/<component>.sqlite`, so the example
above resolves `${sqlite.path}` to `${dataRoot}/sqlite/sqlite.sqlite`. `rigd` prepares
the parent directory on `up` and deploy before starting managed processes; the
app still decides how to consume the path.

Postgres is a process-backed component:

```json
{
  "components": {
    "postgres": {
      "uses": "postgres",
      "port": 55432
    },
    "api": {
      "mode": "managed",
      "command": "bun run api -- --postgres ${postgres.port}",
      "dependsOn": ["postgres"]
    }
  }
}
```

Postgres defaults to `${dataRoot}/postgres/<component>` for its data directory,
exposes `${postgres.dataDir}` and `${postgres.port}`, and resolves to a managed
service bound to `127.0.0.1`. The default command runs `initdb` on first start
when `PG_VERSION` is missing, then runs `postgres -D <dataDir> -h 127.0.0.1 -p
<port>`. `rig2 init --uses postgres` writes only the component stub; add a
component or lane `port` before running local/live lanes. Rig does not create
database users, schemas, migrations, or connection strings. Lane overrides may still set `port`, `command`, `health`,
`readyTimeout`, and `dependsOn`.

Convex Local is a process-backed component:

```json
{
  "components": {
    "convex": {
      "uses": "convex",
      "port": 3210,
      "sitePort": 3211
    },
    "api": {
      "mode": "managed",
      "command": "bun run api -- --convex ${convex.url}",
      "dependsOn": ["convex"]
    }
  }
}
```

Convex resolves to a managed service using `bunx convex dev --local
--local-cloud-port <port> --local-site-port <sitePort>`, a health check at
`${convex.url}/instance_name`, and Convex's project-local state directory at
`${workspace}/.convex/local/default`. Rig exposes `${convex.url}`,
`${convex.siteUrl}`, `${convex.port}`, `${convex.sitePort}`, and
`${convex.stateDir}` for interpolation. `rig2 init --uses convex` writes only
the component stub; add `port` and optionally `sitePort` before running
local/live lanes. Lane overrides may still set `port`,
`sitePort`, `command`, `health`, `readyTimeout`, and `dependsOn`.

Convex CLI 1.36.1 does not expose a supported data-directory flag for
`convex dev`; it stores local backend state under the workspace `.convex`
directory and passes sqlite/storage paths only to its internal backend binary.
Rig keeps that behavior instead of relying on unsupported backend flags.

Internally, `uses` components resolve through the first-party component-plugin
resolver boundary. That keeps SQLite, Postgres, and Convex Local out of the raw
lane resolver path without inventing external plugin loading yet.

Caddy remains the first router provider. Traefik and Pangolin are useful
research references but are not current defaults: Traefik fits Docker/provider
discovery-heavy systems, while Pangolin is better understood as an
identity-aware remote-access/tunnel layer. Database remote access is optional
future scope, not a requirement for database plugins.
