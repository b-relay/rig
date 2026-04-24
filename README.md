# rig

Local Mac deployment manager.

`rig` is a declarative, config-driven CLI for running project deployments on your own Mac. Think Vercel, but for your local machine: one `rig.json`, service lifecycle orchestration, reverse proxy wiring, and daemon integration.

The active v1 binary still uses explicit `dev`/`prod` environments. The v2 runway is being built in parallel around repo-first projects, shared `components`, `managed` and `installed` component modes, `local`, `live`, and generated `deployments`. See [DESIGN_V2.md](./DESIGN_V2.md) for the target model.

## Why Rig Exists

Every project eventually reinvents the same deployment boilerplate:
- Start/stop scripts
- PID and log file management
- Port conflict checks
- Dev/prod environment split
- Reverse proxy configuration
- launchd plist management

`rig` centralizes that into one tool and one schema (`rig.json`). V2 keeps that goal but reduces repeated config by defining components once and resolving lane-specific overrides.

## V2 Runway

V2 is intentionally isolated while v1 keeps managing production apps.

- `rig2` is the experimental v2 entrypoint.
- V2 backend work targets Effect v4 through the pinned `effect-v4` package alias.
- V2 validation uses Effect Schema; v1 Zod schemas remain only for legacy compatibility.
- V2 command parsing uses Effect CLI; v1 hand-written parsing remains transitional.
- V2 state defaults to `~/.rig-v2` or `RIG_V2_ROOT`, never `~/.rig`.
- Provider profiles are explicit: `default` keeps launchd/Caddy/local git defaults, and `stub` is selectable for isolated tests and agent runs.
- Generated deployment materialization uses v2 interfaces for deployment inventory and state storage, with isolated workspace, log, and runtime roots under the v2 state root.
- `rig-smoke` remains transitional until main-binary isolated E2E coverage reaches parity.

Current v2 vocabulary:

| V2 term | Meaning |
|---|---|
| `components` | Shared project units defined once. |
| `managed` | Long-running supervised runtime component. |
| `installed` | Build/install executable surface, not a supervised runtime. |
| `local` | Working-copy runtime lane. |
| `live` | Stable built deployment lane. |
| `deployments` | Template for generated previews and named deployments. |

Try the foundation path:

```bash
bun run start:rig2 status --project pantry
bun run start:rig2 up
bun run start:rig2 logs --lane live --project pantry
```

## Installation

```bash
git clone https://github.com/b-relay/rig.git
cd rig
bun install
```

### Bootstrap (Rig Deploys Rig)

Production deploys use version tags, so create a tag first:

```bash
git tag -a v0.1.0 -m "v0.1.0"
```

Register, deploy, and start rig:

```bash
bun run src/index.ts init rig --path .
bun run src/index.ts deploy rig prod
bun run src/index.ts start rig prod
```

After this, `~/.rig/bin/rig` should be on your PATH and rig is self-deployed.

## Quick Start

### Prerequisites

- macOS
- Bun installed
- A project repo with a `rig.json` at its root

### 1. Install dependencies and build rig

```bash
bun install
bun run build
./rig --help
```

### 2. Register your project

```bash
./rig init pantry --path ~/Projects/pantry
```

### 3. Create `rig.json`

Example minimal config:

```json
{
  "name": "pantry",
  "version": "0.1.0",
  "environments": {
    "dev": {
      "services": [
        {
          "name": "web",
          "type": "server",
          "command": "bunx vite dev --host 127.0.0.1 --port 5173",
          "port": 5173,
          "healthCheck": "http://127.0.0.1:5173"
        }
      ]
    }
  }
}
```

### 4. Deploy and run

These commands are the v1 production surface. The experimental `rig2` entrypoint already exposes repo-first `up`, `down`, `status`, and `logs` aliases as the v2 command runway.

```bash
./rig deploy pantry dev
./rig start pantry dev
./rig status pantry dev
./rig stop pantry dev
```

## CLI Reference

### Global behavior

- `rig --help`, `rig -h`: show main help
- `rig help`: show main help
- `rig help <command>`: show command help
- Every subcommand supports `--help` and `-h`
- Environment is explicit where required: pass exactly one positional `dev` or `prod`

### Command summary

| Command | Purpose |
|---|---|
| `deploy` | Apply `rig.json` changes and reconcile deployment state |
| `init` | Initialize/register a project |
| `start` | Start all configured services for an environment |
| `stop` | Stop all services for an environment |
| `restart` | Stop then start services (hooks included) |
| `status` | Show status for one or all projects |
| `logs` | Show service logs (follow/filter options) |
| `version` | Show or mutate production version metadata |
| `list` | List registered projects |
| `config` | Show `rig.json` schema reference |

### `deploy`

```bash
rig deploy <name> <dev|prod>
rig deploy --help
```

Flags:
- `<dev|prod>` positional environment selector (required)
- `--help`, `-h`

Examples:

```bash
rig deploy pantry dev
rig deploy pantry prod
```

### `init`

```bash
rig init <name> --path <project-path>
rig init --help
```

Flags:
- `--path <project-path>` (required)
- `--help`, `-h`

Example:

```bash
rig init pantry --path ~/Projects/pantry
```

### `start`

```bash
rig start <name> <dev|prod> [--foreground]
rig start --help
```

Flags:
- `<dev|prod>` positional environment selector (required)
- `--foreground` (optional, default: `false`)
- `--help`, `-h`

Examples:

```bash
rig start pantry dev
rig start pantry prod
rig start pantry prod --foreground
```

### `stop`

```bash
rig stop <name> <dev|prod>
rig stop --help
```

Flags:
- `<dev|prod>` positional environment selector (required)
- `--help`, `-h`

Examples:

```bash
rig stop pantry dev
rig stop pantry prod
```

### `restart`

```bash
rig restart <name> <dev|prod>
rig restart --help
```

Flags:
- `<dev|prod>` positional environment selector (required)
- `--help`, `-h`

Examples:

```bash
rig restart pantry dev
rig restart pantry prod
```

### `status`

```bash
rig status [<name>] [dev|prod]
rig status --help
```

Flags:
- `dev` or `prod` positional environment selector (optional; if omitted, shows both)
- `--help`, `-h`

Examples:

```bash
rig status
rig status pantry
rig status pantry prod
```

### `logs`

```bash
rig logs <name> <dev|prod> [--follow] [--lines <n>] [--service <name>]
rig logs --help
```

Flags:
- `<dev|prod>` positional environment selector (required)
- `--follow` (optional, default: `false`)
- `--lines <n>` (optional integer, default: `50`, min: `1`)
- `--service <name>` (optional)
- `--help`, `-h`

Examples:

```bash
rig logs pantry dev --follow
rig logs pantry prod --lines 100 --service web
```

### `version`

```bash
rig version <name>
rig version <name> patch|minor|major|undo|list
rig version --help
```

Actions:
- `show` (default when omitted)
- `patch`
- `minor`
- `major`
- `undo`
- `list`

Examples:

```bash
rig version pantry
rig version pantry patch
rig version pantry list
```

### `list`

```bash
rig list
rig list --help
```

Flags:
- `--help`, `-h`

Example:

```bash
rig list
```

### `config`

```bash
rig config
rig config --help
```

Flags:
- `--help`, `-h`

Example:

```bash
rig config
```

## Configuration Reference (`rig.json`)

Schema source: `src/schema/config.ts` (`RigConfigSchema`).

### Top-level fields

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | `string` | yes | none | Project identifier. Used in CLI commands and paths. Must match `^[a-z0-9-]+$`. |
| `description` | `string` | no | none | Human-readable project description. |
| `version` | `string` | yes | none | Semver string (`X.Y.Z`). |
| `domain` | `string` | no | none | Base domain. Prod uses `domain`, dev uses `dev.<domain>`. |
| `hooks` | `TopLevelHooks` | no | none | Top-level lifecycle hooks. |
| `environments` | `{ prod?: Environment, dev?: Environment }` | yes | none | Environment definitions. At least one of `prod`/`dev` must exist. |
| `daemon` | `DaemonConfig` | no | `{ enabled: false, keepAlive: false }` | launchd daemon settings. |

### `TopLevelHooks`

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `preStart` | `string \| null` | no | none | Run before any service starts for this project in both `dev` and `prod`. |
| `postStart` | `string \| null` | no | none | Run after all services are healthy for this project in both `dev` and `prod`. |
| `preStop` | `string \| null` | no | none | Run before stopping this project's services in both `dev` and `prod`. |
| `postStop` | `string \| null` | no | none | Run after all services are stopped for this project in both `dev` and `prod`. |

### `Environment`

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `envFile` | `string` | no | none | Default env file for all services in this environment. |
| `proxy` | `ProxyConfig` | no | none | Reverse proxy config for this environment. |
| `services` | `Service[]` | yes | none | Services to run. Minimum length is `1`. |

Environment-level validation:
- Service names must be unique within the environment.
- `dependsOn` entries must reference existing service names.
- If `proxy` is set, `proxy.upstream` must match a service name.

### `ProxyConfig`

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `upstream` | `string` | yes | none | Service name to route traffic to. |

### `Service` union

`Service` is a discriminated union on `type`:
- `type: "server"` => `ServerService`
- `type: "bin"` => `BinService`

#### `ServerService`

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | `string` | yes | none | Unique service name within the environment. |
| `type` | `"server"` | yes | none | Long-running daemon service. |
| `command` | `string` | yes | none | Shell command to start service. Must not contain `0.0.0.0`. |
| `port` | `number` | yes | none | Listening port (`1..65535`). |
| `healthCheck` | `string` | no | none | HTTP URL or command health check. URLs must not contain `0.0.0.0`. |
| `readyTimeout` | `number` | no | `30` | Seconds to wait for health check success. |
| `dependsOn` | `string[]` | no | none | Services that must be healthy first. |
| `hooks` | `ServiceHooks` | no | none | Service lifecycle hooks. |
| `envFile` | `string` | no | none | Service env file (overrides environment `envFile`). |

#### `BinService`

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | `string` | yes | none | Unique service name within the environment. |
| `type` | `"bin"` | yes | none | CLI tool service installed to `~/.rig/bin/` by default. |
| `entrypoint` | `string` | yes | none | File path or command string (for example `bun cli/index.ts`). |
| `build` | `string` | no | none | Build command to produce binary. |
| `hooks` | `ServiceHooks` | no | none | Service lifecycle hooks. |
| `envFile` | `string` | no | none | Service env file (overrides environment `envFile`). |

Additional `BinService` validation:
- If `build` is set, `entrypoint` cannot be a command string (cannot contain spaces).

### `ServiceHooks`

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `preStart` | `string \| null` | no | none | Run before this service starts. |
| `postStart` | `string \| null` | no | none | Run after this service is healthy. |
| `preStop` | `string \| null` | no | none | Run before SIGTERM for this service. |
| `postStop` | `string \| null` | no | none | Run after this service is confirmed stopped. |

### `DaemonConfig`

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `enabled` | `boolean` | no | `false` | Whether to manage a launchd plist for this project. |
| `keepAlive` | `boolean` | no | `false` | Whether launchd should restart when process exits. |

### Inheritance and precedence rules

- `envFile`: environment-level `envFile` is default; service `envFile` overrides it.
- Hooks: top-level project hooks are environment-agnostic and run for both `dev` and `prod`, wrapping service hooks (`preStart` top-level first, `postStart` top-level last; analogous for stop).
- Proxy: defined per environment, upstream references a service by name.

### Localhost-only enforcement

Schema rejects `0.0.0.0` in:
- `services[].command` for `server` services
- `services[].healthCheck` when provided

Use `127.0.0.1` bindings.

## Environments

`rig` models two explicit environments: `dev` and `prod`.

### Dev vs prod behavior

- `dev` and `prod` are explicit positional environment selectors; no implicit default.
- Dev deploy/start resolve workspace to the registered repo path.
- Prod deploy creates versioned workspaces under `~/.rig/workspaces/<name>/prod/<version>` and updates `current` symlink.
- Deploy computes proxy domain as:
  - prod: `<domain>`
  - dev: `dev.<domain>`

### Env files

- `envFile` can be absolute or relative.
- Relative paths resolve from the active workspace path.
- Dotenv loader supports:
  - `KEY=value`
  - `export KEY=value`
  - comments (`# ...`)
  - quoted values (`"..."`, `'...'`)

### Proxy setup

- Proxy entries are written to `~/.rig/caddy/Caddyfile`.
- Rig-managed blocks are marked with comments in this form:

```caddy
# [rig:pantry:dev:web]
dev.pantry.example.com {
	reverse_proxy http://127.0.0.1:5173
	import cloudflare
	import backend_errors
}
```

- `rig deploy` adds or updates managed blocks for `<name>:<env>`.

## Services

### `server` services

Runtime flow (`rig start`):
1. Validate config and resolve environment.
2. Check declared ports are free.
3. Run top-level `preStart`.
4. Start server services in dependency order (`dependsOn`).
5. Poll health checks (`http` when value starts with `http://` or `https://`, otherwise command mode).
6. Run service `postStart` hooks.
7. Persist runtime state under `<workspace>/.rig/` (`pids.json`, `logs/`).

Stop flow (`rig stop`):
1. Stop launchd daemon first if running.
2. Run top-level `preStop`.
3. Stop server services in reverse dependency order.
4. Clean orphan PIDs if tracking contains removed services.
5. Run top-level `postStop`.

### `bin` services

Install target:
- `~/.rig/bin/<service-name>` for prod
- `~/.rig/bin/<service-name>-dev` for dev

Resolution behavior:
- `build` set: run build command, require binary at `entrypoint`.
- No `build` + command string entrypoint (contains spaces): create command shim.
- No `build` + file entrypoint:
  - binary file: copy directly
  - script/text file: create shim that `cd`s into workspace and executes it

### Hooks

Available hook phases at top-level and service-level:
- `preStart`
- `postStart`
- `preStop`
- `postStop`

Project-level `hooks.*` are not environment-specific. If they are set in `rig.json`, they run for both `rig start ... dev` and `rig start ... prod` (and likewise for stop/restart). Use service hooks or shell conditionals inside the command if behavior needs to differ by environment.

`restart` is `stop` then `start`, so stop hooks then start hooks execute in sequence.

## Architecture Overview

Core architectural rules (from `AGENTS.md` + source layout):
- External concerns are interfaces in `src/interfaces/`.
- Core business logic in `src/core/` does not import provider implementations.
- Implementations live in `src/providers/` and are wired as Effect Layers in `src/index.ts`.
- Schema and argument validation use Zod (`src/schema/config.ts`, `src/schema/args.ts`).
- Errors are tagged classes with structured context + `hint` (`src/schema/errors.ts`).

For v2 Effect work, read [`effect-v4-help-notes.md`](./effect-v4-help-notes.md) before changing Effect v4, Effect Schema, Effect CLI, Effect Platform, or Effect testing code. Keep that file updated with verified APIs, package/version constraints, migration findings, Bun integration notes, and links that would help the next contributor.

### Extending rig

Typical extension workflow:
1. Add/extend an interface in `src/interfaces/`.
2. Implement provider in `src/providers/`.
3. Wire provider layer in `src/index.ts`.
4. Consume only the interface from `src/core/`.
5. Add/adjust Zod schema and tests.

## Examples

### Example 1: Simple single-service project

```json
{
  "name": "notes",
  "description": "Personal notes app",
  "version": "0.1.0",
  "environments": {
    "dev": {
      "services": [
        {
          "name": "web",
          "type": "server",
          "command": "bunx vite dev --host 127.0.0.1 --port 4173",
          "port": 4173,
          "healthCheck": "http://127.0.0.1:4173"
        }
      ]
    }
  }
}
```

### Example 2: Multi-service with proxy + daemon + bins

```json
{
  "name": "pantry",
  "description": "Grocery and meal tracker",
  "version": "1.4.2",
  "domain": "pantry.example.com",
  "hooks": {
    "preStart": "bun install",
    "postStart": "echo 'all services healthy'",
    "preStop": null,
    "postStop": null
  },
  "environments": {
    "prod": {
      "envFile": ".env.prod",
      "proxy": {
        "upstream": "web"
      },
      "services": [
        {
          "name": "db",
          "type": "server",
          "command": "postgres -D ./var/postgres -h 127.0.0.1 -p 55432",
          "port": 55432,
          "healthCheck": "pg_isready -h 127.0.0.1 -p 55432",
          "readyTimeout": 60
        },
        {
          "name": "api",
          "type": "server",
          "command": "bun run server.ts --host 127.0.0.1 --port 8080",
          "port": 8080,
          "healthCheck": "http://127.0.0.1:8080/health",
          "dependsOn": [
            "db"
          ],
          "envFile": ".env.api.prod",
          "hooks": {
            "preStart": "bun run db:migrate",
            "postStart": null,
            "preStop": null,
            "postStop": null
          }
        },
        {
          "name": "web",
          "type": "server",
          "command": "bunx vite preview --host 127.0.0.1 --port 3070",
          "port": 3070,
          "healthCheck": "http://127.0.0.1:3070",
          "dependsOn": [
            "api"
          ]
        },
        {
          "name": "cli",
          "type": "bin",
          "build": "bun build --compile cli/index.ts --outfile dist/pantry",
          "entrypoint": "dist/pantry"
        }
      ]
    },
    "dev": {
      "envFile": ".env.dev",
      "proxy": {
        "upstream": "web"
      },
      "services": [
        {
          "name": "db",
          "type": "server",
          "command": "postgres -D ./var/postgres-dev -h 127.0.0.1 -p 55433",
          "port": 55433,
          "healthCheck": "pg_isready -h 127.0.0.1 -p 55433"
        },
        {
          "name": "api",
          "type": "server",
          "command": "bun --watch run server.ts --host 127.0.0.1 --port 8081",
          "port": 8081,
          "healthCheck": "http://127.0.0.1:8081/health",
          "dependsOn": [
            "db"
          ],
          "envFile": ".env.api.dev"
        },
        {
          "name": "web",
          "type": "server",
          "command": "bunx vite dev --host 127.0.0.1 --port 5173",
          "port": 5173,
          "healthCheck": "http://127.0.0.1:5173",
          "dependsOn": [
            "api"
          ]
        },
        {
          "name": "cli",
          "type": "bin",
          "entrypoint": "bun cli/index.ts"
        }
      ]
    }
  },
  "daemon": {
    "enabled": true,
    "keepAlive": true
  }
}
```
