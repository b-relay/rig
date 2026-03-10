# rig — Local Mac Deployment Manager

A declarative, config-driven CLI for managing local project deployments on a Mac Mini server. Non-interactive, AI-agent friendly. Think Vercel, but for any project on your local machine.

## Problem

Every project reinvents deployment boilerplate: start/stop scripts, PID management, port detection, dev/prod splitting, log management, Caddy config, launchd plists. `rig` absorbs all of it into one tool with a single config file.

## Core Principles

1. **Declarative** — `rig.json` is the source of truth. Change the config, run a command, and rig figures out what changed and applies it.
2. **Non-interactive** — No prompts. Every command is deterministic. AI agents can call any command blindly.
3. **Environment is always explicit** — No default env. You always specify `--dev` or `--prod`.
4. **Localhost only** — If a service runs on this machine, it binds to `127.0.0.1`. Never `0.0.0.0`. Enforced by schema validation.
5. **Dev folder ≠ rig folder** — Projects in `~/Projects/` are for development. Prod deployments run from managed copies/worktrees under `~/.rig/`.
6. **Config is always git-tracked** — `rig.json` lives in the project repo. The Caddyfile is also git-tracked via rig.

## CLI Design

```bash
# Apply config changes (the main command)
rig deploy <name> --dev|--prod         # The one command. Reads rig.json, diffs state,
                                             # applies changes, and starts/restarts services.

# Setup
rig init <name> --path <project-path>     # Scaffold rig.json + register project
                                             # (optional if rig.json already exists)

# Lifecycle
rig start <name> --dev|--prod             # Start services (without re-deploying)
rig stop <name> --dev|--prod              # Stop all services
rig restart <name> --dev|--prod           # Stop then start (runs all hooks)

# Monitoring
rig status [<name>] [--dev|--prod]        # Status, health, ports, version, everything

# Service management
rig logs <name> --dev|--prod [--follow] [--lines 50] [--service <name>]
# Versioning (prod only)
rig version <name>                        # Show current version + tag status
rig version <name> patch                  # Bump patch (0.1.0 → 0.1.1)
rig version <name> minor                  # Bump minor (0.1.0 → 0.2.0)
rig version <name> major                  # Bump major (0.1.0 → 1.0.0)
rig version <name> undo                   # Revert last bump (only if not deployed)
rig version <name> list                   # Version history

# Config reference
rig config --help                         # Full config docs, defaults, inheritance rules

# Listing
rig list                                  # List all managed projects with status
```

### No separate `caddy` or `launchd` subcommands

Caddy entries and launchd plists are derived from `rig.json`. When you run `rig deploy`, it:
- Diffs the current Caddyfile against what rig.json declares
- Updates Caddy entries if changed
- Creates/updates launchd plists if changed
- Notifies you to kickstart Caddy if the Caddyfile was modified

You never manually run caddy or launchd commands through rig.

## Project Config: `rig.json`

Lives in the project repo root. Validated with Zod at every read.

```json
{
  "name": "pantry",
  "description": "Grocery & meal tracker",
  "version": "0.0.0",
  "domain": "pantry.b-relay.com",
  "hooks": {
    "preStart": "bun install",
    "postStart": null,
    "preStop": null,
    "postStop": null
  },
  "environments": {
    "prod": {
      "envFile": ".env.prod",
      "proxy": { "upstream": "web" },
      "services": [
        {
          "name": "convex",
          "type": "server",
          "command": "env -u TZ ./convex-local-backend --interface 127.0.0.1 --instance-name pantry --port 3290 ...",
          "port": 3290,
          "healthCheck": "http://127.0.0.1:3290/version",
          "readyTimeout": 60,
          "hooks": {
            "preStart": "bunx convex dev --once"
          }
        },
        {
          "name": "web",
          "type": "server",
          "command": "bunx vite preview --port 3070 --host 127.0.0.1",
          "port": 3070,
          "healthCheck": "http://127.0.0.1:3070",
          "readyTimeout": 30,
          "dependsOn": ["convex"]
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
      "proxy": { "upstream": "web" },
      "services": [
        {
          "name": "convex",
          "type": "server",
          "command": "env -u TZ ./convex-local-backend --interface 127.0.0.1 --instance-name pantry-dev --port 3210 ...",
          "port": 3210,
          "healthCheck": "http://127.0.0.1:3210/version",
          "readyTimeout": 60,
          "hooks": {
            "preStart": "bunx convex dev --once"
          }
        },
        {
          "name": "web",
          "type": "server",
          "command": "bunx vite dev --host 127.0.0.1",
          "port": 5173,
          "healthCheck": "http://127.0.0.1:5173",
          "readyTimeout": 30,
          "dependsOn": ["convex"]
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

### Service Types

| Type | Description |
|------|-------------|
| `server` | Long-running daemon. Has `command`, `port`, `healthCheck`. Managed as a process. |
| `bin` | CLI tool. See **Bin Resolution Logic** below for full behavior. |

### Bin Resolution Logic

When deploying a `bin` service, rig resolves the entrypoint as follows:

1. **`build` is set** → run the build command → check `entrypoint` path:
   - If the file is a binary → copy to `~/.local/bin/`. ✓
   - If the file is NOT binary → error: `"build produced a non-binary file at <entrypoint>. Remove the build key and use hooks if you need a pre-step."`
2. **`build` is NOT set** → check `entrypoint`:
   - **File path exists and is a binary** → copy to `~/.local/bin/`. ✓
   - **File path exists but is a script** (shebang, not binary) → create a shim (not copied — would break relative imports). ✓
   - **Command string** (contains spaces, e.g. `bun cli/index.ts`) → create a shim script in `~/.local/bin/` that `cd`s to the workspace and runs the command. ✓
   - **File path does not exist** → error: `"Entrypoint <path> not found. Need to compile first? Add a build key."`

Dev bins get a `-dev` suffix automatically (e.g. `pantry-dev`).

**Examples:**

| Scenario | `build` | `entrypoint` | Result in `~/.local/bin/` |
|----------|---------|-------------|------------------------|
| Bun compiled (prod) | `bun build --compile ...` | `dist/pantry` | Binary copied |
| Rust (dev or prod) | `cargo build --release` | `target/release/pantry` | Binary copied |
| Bun script (dev) | _(none)_ | `bun cli/index.ts` | Shim: `cd <workspace> && exec bun cli/index.ts "$@"` |
| Go (prod) | `go build -o dist/pantry` | `dist/pantry` | Binary copied |
| Executable script | _(none)_ | `cli/index.ts` | Shim: `cd <workspace> && exec ./cli/index.ts "$@"` |

### Proxy per environment

Each environment specifies `"proxy": { "upstream": "<service-name>" }` to declare which service the reverse proxy routes to. Domain is derived from the top-level `domain` field:
- **prod** → `pantry.b-relay.com` proxies to the `web` service's port
- **dev** → `dev.pantry.b-relay.com` proxies to the `web` service's port


### Schema Validation (Zod)

Every `rig.json` read is validated against a Zod schema. Invalid configs fail fast with clear errors. The schema enforces:
- All ports use `127.0.0.1` (no `0.0.0.0` allowed anywhere)
- Environment must be explicitly specified in commands
- Required fields are present
- Port numbers are valid
- Service names are unique within an environment
- `dependsOn` references exist
- Version `0.0.0` blocks prod deploy
- Dev bin names must end in `-dev` (enforced by rig on copy)
- Cannot tag a commit that already has a version tag

Every Zod field uses `.describe()` with human+AI-readable docs:

```typescript
const ServiceSchema = z.object({
  name: z.string().describe("Unique service name within this environment."),
  type: z.enum(["server", "bin"]).describe("server = long-running daemon, bin = CLI tool."),
  envFile: z.string().optional().describe(
    "Env file for this service. Overrides the environment-level envFile if set."
  ),
  // ...
})
```

`rig config --help` renders these descriptions as a full config reference:

```
RIG.JSON REFERENCE

name (required)
  Project identifier. Used in all CLI commands.

version (required)
  Semver string. Starts at 0.0.0. Bump with: rig version <name> patch|minor|major

domain (optional)
  Base domain. Prod = domain, dev = dev.<domain>

environments.<env>.envFile (optional)
  Default env file for all services in this environment.

environments.<env>.services[].envFile (optional)
  Env file for this service. Overrides the environment-level envFile if set.

INHERITANCE:
  envFile:  environment-level → service-level (service wins)
  hooks:    top-level runs first, then service-level
  proxy:    per-environment, references a service by name
```

## Deployment Workspaces

**Key idea:** `~/Projects/` is for development. Prod deployments run from isolated copies.
CLI binaries are installed to `~/.local/bin/`.

```
~/.rig/
├── caddy/
│   └── Caddyfile                  # Git-tracked copy (symlinked from /usr/local/etc/Caddyfile or synced)
├── registry.json                  # Maps project names → repo paths
├── workspaces/
│   └── pantry/
│       ├── dev/
│       │   ├── pids.json          # Dev runs from the project repo directly
│       │   └── logs/              # Only runtime state lives here
│       │       ├── convex.log
│       │       └── web.log
│       └── prod/
│           ├── current -> v0.1.0/ # Symlink to active version
│           ├── v0.1.0/            # Versioned copy (kept)
│           ├── pids.json
│           └── logs/
│               ├── convex.log
│               └── web.log
└── versions/
    └── pantry.json                # Version history with timestamps
```

### How versioning works

**Versions are prod-only.** Dev has no version tracking.

**Prod requires a tagged commit:**
- `rig version pantry patch` (or `minor`/`major`) bumps the version in `rig.json` and creates a git tag (`v1.2.3`) on the current HEAD. It does NOT auto-commit — you commit when you're ready, but the tag pins the exact commit.
- `rig deploy pantry --prod` reads the version from `rig.json`, finds the matching git tag, and deploys from that exact commit.
- If the git tag doesn't exist, or HEAD has uncommitted changes that haven't been tagged, prod deploy **refuses**.
- Version `0.0.0` cannot be deployed to prod — it's the initial "not yet versioned" state. Bump to at least `0.1.0` first.
- Each version gets its own workspace: `~/.rig/workspaces/pantry/prod/v1.2.3/`
- `current` symlink points to the active version
- Previous version workspaces are kept on disk

**Version undo:**
`rig version pantry undo` reverts the last bump — but ONLY if that version was never deployed (no workspace exists for it). It reverts `rig.json` and deletes the git tag.

```bash
rig version pantry patch    # 1.0.0 → 1.0.1, creates git tag v1.0.1
rig version pantry minor    # 1.0.1 → 1.1.0, creates git tag v1.1.0
rig version pantry major    # 1.1.0 → 2.0.0, creates git tag v2.0.0
rig version pantry undo     # Reverts last bump (only if not deployed)
rig version pantry          # Show current version + tag status
rig version pantry list     # Show version history
```

**Dev:**
Dev has a single workspace at `~/.rig/workspaces/<name>/dev/` (no version subdirectories, no `current` symlink). Every `rig deploy --dev` syncs fresh from the repo — dirty working tree, uncommitted files, whatever. Dev is always changing; there's nothing to version.

### Git worktree vs copy

Prefer `git worktree` when possible (lighter, shares git objects). Fall back to full copy if the repo doesn't support worktrees or if explicitly configured.

## Caddy Integration

### Git-tracked Caddyfile

The canonical Caddyfile lives at `~/.rig/caddy/Caddyfile` and is git-tracked. launchd plists are also backed up at `~/.rig/launchd/` so we have history if anything breaks. The system Caddyfile at `/usr/local/etc/Caddyfile` is either:
- A symlink to `~/.rig/caddy/Caddyfile`, or
- Synced from it (if symlinks aren't practical for root-owned files)

### Auto-generated entries

`rig deploy` manages Caddy blocks using the existing pattern:

```caddy
# [rig:pantry:prod]
pantry.b-relay.com {
	reverse_proxy http://127.0.0.1:3070
	import cloudflare
	import backend_errors
}

# [rig:pantry:dev]
dev.pantry.b-relay.com {
	reverse_proxy http://127.0.0.1:5173
	import cloudflare
	import backend_errors
}
```

The `[rig:<name>:<env>]` comment is a marker for rig to find and update its own blocks. Manually-added Caddy blocks (without markers) are left untouched.

### Caddy reload

Caddy runs as a root launchd service. Deploy cannot restart it directly. When the Caddyfile changes, rig prints:

```
✓ Caddyfile updated (pantry prod domain changed).
  To reload: sudo launchctl kickstart -k system/caddy
```

## launchd Integration

When `daemon.enabled: true` in rig.json, `rig deploy` creates/updates a plist at:

```
~/Library/LaunchAgents/com.b-relay.rig.<name>-<env>.plist
```

The plist calls `rig start <name> --<env> --foreground` with `KeepAlive` if configured.

`rig deploy` handles loading/unloading automatically. If the plist changed, it unloads the old one and loads the new one.

## Hooks

All four hooks run at the appropriate lifecycle points:

| Hook | When it runs |
|------|-------------|
| `preStart` | Before any service starts (install deps, push schema, build, etc.) |
| `postStart` | After all services are healthy |
| `preStop` | Before sending SIGTERM to services |
| `postStop` | After all services are confirmed stopped |

**During `restart`:** All hooks run in order: `preStop` → stop → `postStop` → `preStart` → start → `postStart`.

Top-level `hooks.*` are project-level, not environment-specific. If they are defined in `rig.json`, they run for both `dev` and `prod`. If you need different behavior by environment, put the logic in service hooks or branch inside the hook command itself.

Hooks run in the workspace directory — for prod that's the versioned workspace under `~/.rig/`, for dev that's the project repo directly. Service-level hooks receive that service's resolved env vars (from envFile).

## Service Lifecycle

### `rig start <name> --prod`

1. Validate `rig.json` (Zod schema)
2. Resolve rig workspace (`~/.rig/workspaces/<name>/prod/current/`)
3. Check no declared ports are in use (fail fast)
4. Run `hooks.preStart`
5. Start services in dependency order:
   - Spawn process with env vars from envFile
   - Write PID to `pids.json`
   - Stream stdout/stderr to per-service log files
   - Poll `healthCheck` URL (up to `readyTimeout`)
   - If health check fails: kill everything, report error
6. Run `hooks.postStart`
7. Print status summary

### `rig stop <name> --prod`

1. Run `hooks.preStop`
2. Read PIDs from `pids.json`
3. SIGTERM all processes (reverse dependency order)
4. Wait up to 5s, then SIGKILL stragglers
5. Also check ports directly (catch orphans)
6. Clean up PID files
7. Run `hooks.postStop`

### `rig start --foreground` (launchd mode)

- Stays in foreground, monitors all services
- If any service dies, runs cleanup and exits (launchd KeepAlive restarts the whole stack)

### `rig deploy <name> --prod`

The smart command. Reads rig.json, diffs against current state, and applies only what changed:

- **Version changed** → create new workspace, migrate services
- **Ports changed** → restart affected services
- **Domain changed** → update Caddyfile, notify to reload
- **New service added** → start it
- **Service removed** → stop it
- **envFile changed** → restart affected services
- **launchd config changed** → update and reload plist
- **Hooks changed** → no action (hooks run on next start/stop)
- **Bin service changed** → rebuild/re-shim

## Architecture

### Design Principles

- **Modular with interfaces** — Every external concern (reverse proxy, process manager, workspace strategy) is defined as an interface. Implementations are swappable.
- **Effect TS services and layers** — Each interface maps to an Effect Service. Implementations are Layers. Testing uses mock layers.
- **Rich structured errors** — Every failure carries context: what happened, where, why, and a human+AI-readable hint. No bare `throw new Error("failed")`.
- **Separation of concerns** — CLI parsing, core logic, and provider implementations never directly import each other. They communicate through interfaces.
- **All subcommands support `--help`, `-h`, and `help`** — Every command prints detailed usage with examples.

### Module Structure

```
src/
├── cli/                    # CLI entry point + help rendering
│   ├── help.ts             # Help text generation for all commands
│   └── index.ts            # Main entry, arg parsing, command routing
├── core/                   # Business logic (no I/O, uses only interfaces)
│   ├── config-command.ts   # `rig config` command output
│   ├── config.ts           # Config loading + environment resolution
│   ├── deploy.ts           # Deploy orchestration (diff, apply)
│   ├── init.ts             # `rig init` command handler
│   ├── lifecycle.ts        # Start, stop, restart logic
│   ├── list.ts             # `rig list` command output
│   ├── logs.ts             # `rig logs` command handler
│   ├── shared.ts           # Shared core helpers (labels, config errors)
│   ├── status.ts           # Status + health aggregation
│   └── version.ts          # Version bumping, tagging, undo
├── interfaces/             # Contracts (no implementations)
│   ├── bin-installer.ts    # BinInstaller interface
│   ├── env-loader.ts       # EnvLoader interface
│   ├── file-system.ts      # FileSystem interface
│   ├── git.ts              # Git interface
│   ├── health-checker.ts   # HealthChecker interface
│   ├── hook-runner.ts      # HookRunner interface
│   ├── logger.ts           # Logger interface
│   ├── port-checker.ts     # PortChecker interface
│   ├── process-manager.ts  # ProcessManager interface
│   ├── registry.ts         # Registry interface
│   ├── reverse-proxy.ts    # ReverseProxy interface
│   ├── service-runner.ts   # ServiceRunner interface
│   └── workspace.ts        # Workspace interface
├── providers/              # Swappable implementations
│   ├── bun-bin.ts          # BunBinInstaller implements BinInstaller
│   ├── bun-git.ts          # BunGit implements Git (shells out to git)
│   ├── bun-hook-runner.ts  # BunHookRunner implements HookRunner
│   ├── bun-port-checker.ts # BunPortChecker implements PortChecker
│   ├── bun-service-runner.ts  # BunServiceRunner implements ServiceRunner
│   ├── caddy.ts            # CaddyProxy implements ReverseProxy
│   ├── cmd-health.ts       # CmdHealthChecker implements HealthChecker
│   ├── composite-logger.ts # CompositeLogger fan-outs to multiple loggers
│   ├── dotenv-loader.ts    # DotenvLoader implements EnvLoader
│   ├── file-logger.ts      # FileLogger appends structured log lines to file
│   ├── health-checker-dispatch.ts # DispatchHealthChecker routes by check type
│   ├── health-poll.ts      # Shared polling helper for health check providers
│   ├── http-health.ts      # HttpHealthChecker implements HealthChecker
│   ├── json-logger.ts      # JsonLogger implements Logger
│   ├── json-registry.ts    # JSONRegistry implements Registry
│   ├── launchd.ts          # LaunchdManager implements ProcessManager
│   ├── node-fs.ts          # NodeFileSystem implements FileSystem
│   ├── stub-bin-installer.ts   # StubBinInstaller for tests
│   ├── stub-git.ts             # StubGit for tests
│   ├── stub-health-checker.ts  # StubHealthChecker for tests
│   ├── stub-hook-runner.ts     # StubHookRunner for tests
│   ├── stub-port-checker.ts    # StubPortChecker for tests
│   ├── stub-process-manager.ts # StubProcessManager for tests
│   ├── stub-reverse-proxy.ts   # StubReverseProxy for tests
│   ├── stub-service-runner.ts  # StubServiceRunner for tests
│   ├── stub-workspace.ts       # StubWorkspace for tests
│   ├── terminal-logger.ts      # TerminalLogger implements Logger
│   └── worktree.ts             # GitWorktreeWorkspace implements Workspace
├── schema/                 # Zod schemas + validation
│   ├── args.ts             # CLI argument schemas per subcommand
│   ├── config.ts           # rig.json schema
│   └── errors.ts           # Structured error types
└── index.ts                # Wires layers together, runs CLI
```

### Interfaces

```typescript
// ── File System ──────────────────────────────────────────────────────────────
// Abstracts all I/O for testability. Tests use in-memory implementation.

interface FileSystem {
  read(path: string): Effect<string>
  write(path: string, content: string): Effect<void>
  append(path: string, content: string): Effect<void>
  copy(src: string, dest: string): Effect<void>
  symlink(target: string, link: string): Effect<void>
  exists(path: string): Effect<boolean>
  remove(path: string): Effect<void>
  mkdir(path: string): Effect<void>
  list(path: string): Effect<string[]>
  chmod(path: string, mode: number): Effect<void>
}

// ── Logger ───────────────────────────────────────────────────────────────────
// Current implementations: terminal, json, file, and composite fan-out
// `RIG_LOG_FORMAT=json` switches primary output to JsonLogger.
// `RIG_LOG_FILE=/path/to/rig.log` enables FileLogger and wraps with CompositeLogger.
// All output goes through this — never raw console.log.

interface Logger {
  info(message: string, details?: Record<string, unknown>): Effect<void>
  warn(message: string, details?: Record<string, unknown>): Effect<void>
  error(structured: RigError): Effect<void>
  success(message: string, details?: Record<string, unknown>): Effect<void>
  table(rows: Record<string, unknown>[]): Effect<void>
}

// ── Git ──────────────────────────────────────────────────────────────────────
// All git operations in one place. Branch detection uses ordered strategies.

interface Git {
  // Branch detection (uses strategy chain, see below)
  detectMainBranch(repoPath: string): Effect<string>

  // State queries
  isDirty(repoPath: string): Effect<boolean>
  currentBranch(repoPath: string): Effect<string>
  commitHash(repoPath: string, ref?: string): Effect<string>
  changedFiles(repoPath: string): Effect<string[]>

  // Tagging
  createTag(repoPath: string, tag: string): Effect<void>
  deleteTag(repoPath: string, tag: string): Effect<void>
  tagExists(repoPath: string, tag: string): Effect<boolean>
  commitHasTag(repoPath: string, commit: string): Effect<string | null>

  // Worktrees
  createWorktree(repoPath: string, dest: string, ref: string): Effect<void>
  removeWorktree(repoPath: string, dest: string): Effect<void>
}

// ── Reverse Proxy ────────────────────────────────────────────────────────────
// Current implementation: Caddy
// Future: nginx, Traefik, etc.

interface ReverseProxy {
  read(): Effect<ProxyEntry[]>
  add(entry: ProxyEntry): Effect<ProxyChange>
  update(entry: ProxyEntry): Effect<ProxyChange>
  remove(name: string, env: string): Effect<ProxyChange>
  diff(): Effect<ProxyDiff>
  backup(): Effect<string>  // Returns backup path
}

// ── Process Manager ──────────────────────────────────────────────────────────
// Current implementation: launchd
// Future: systemd (Linux), pm2, etc.

interface ProcessManager {
  install(config: DaemonConfig): Effect<void>
  uninstall(label: string): Effect<void>
  start(label: string): Effect<void>
  stop(label: string): Effect<void>
  status(label: string): Effect<DaemonStatus>
  backup(label: string): Effect<string>
}

// ── Workspace ────────────────────────────────────────────────────────────────
// Current implementations: git worktree (preferred), full copy (fallback)

interface Workspace {
  create(name: string, env: string, version: string, commitRef: string): Effect<string>
  resolve(name: string, env: string): Effect<string>
  sync(name: string, env: string): Effect<void>       // Dev: sync from repo
  list(name: string): Effect<WorkspaceInfo[]>
}

// ── Health Checker ───────────────────────────────────────────────────────────
// Current implementations: http (curl URL), command (shell exit code)
// Dispatched based on healthCheck string format.

interface HealthChecker {
  check(config: HealthCheckConfig): Effect<HealthResult>
  poll(config: HealthCheckConfig, interval: number, timeout: number): Effect<HealthResult>
}

// ── Hook Runner ──────────────────────────────────────────────────────────────
// Runs lifecycle hook shell commands in the resolved workspace with merged env.

interface HookRunner {
  runHook(
    command: string,
    opts: {
      workdir: string
      env: Readonly<Record<string, string>>
    }
  ): Effect<{
    exitCode: number
    stdout: string
    stderr: string
  }>
}

// ── Port Checker ─────────────────────────────────────────────────────────────
// Verifies `127.0.0.1` port availability before starting services.

interface PortChecker {
  check(port: number, service: string): Effect<void>
}

// ── Service Runner ───────────────────────────────────────────────────────────

interface ServiceRunner {
  start(service: ServerService, opts: RunOpts): Effect<RunningService>
  stop(service: RunningService): Effect<void>
  health(service: RunningService): Effect<HealthStatus>
  logs(service: string, opts: LogOpts): Effect<string>
}

// ── Bin Installer ────────────────────────────────────────────────────────────
// Handles building and installing CLI tools to ~/.local/bin/
// Current: bun build --compile, plain copy
// Future: other bundlers, cross-compilation

interface BinInstaller {
  build(config: BinService, workdir: string): Effect<string>  // Returns built path
  install(name: string, env: string, binaryPath: string): Effect<string>  // Returns shim path
  uninstall(name: string, env: string): Effect<void>
}

// ── Env Loader ───────────────────────────────────────────────────────────────
// Current implementation: .env file parser
// Future: 1Password CLI, Vault, AWS SSM, etc.

interface EnvLoader {
  load(envFile: string, workdir: string): Effect<Record<string, string>>
}

// ── Registry ─────────────────────────────────────────────────────────────────

interface Registry {
  register(name: string, repoPath: string): Effect<void>
  unregister(name: string): Effect<void>
  resolve(name: string): Effect<string>
  list(): Effect<RegistryEntry[]>
}
```

### Main Branch Detection Strategies

Strategies are tried in order. First success wins.

| Order | Strategy | How it works |
|-------|----------|-------------|
| 1 | **Git remote HEAD** | Run `git symbolic-ref refs/remotes/origin/HEAD`. Parse branch name. |
| 2 | **Convention check** | Check if `main` branch exists locally → use it. Else check `master`. |
| 3 | **Fail with hint** | Error: "Could not detect main branch. Create a main/master branch." |

Each strategy is its own function. The chain is explicit and easy to extend:

```typescript
const detectMainBranch = (repoPath: string, config?: RigConfig) =>
  tryRemoteHead(repoPath).pipe(
    Effect.orElse(() => tryConvention(repoPath)),
    Effect.orElse(() => Effect.fail(new MainBranchDetectionError({
      repoPath,
      strategiesTried: ["remote-head", "convention"],
      hint: "Could not detect main branch. Create a main/master branch."
    })))
  )
```

### Structured Errors

Every error is a tagged union with full context. AI agents can parse these programmatically.

```typescript
class VersionTagError {
  readonly _tag = "VersionTagError"
  constructor(
    readonly commit: string,
    readonly branch: string,
    readonly reason: "uncommitted-changes" | "already-tagged" | "not-main" | "zero-version",
    readonly hint: string,
    readonly details?: Record<string, unknown>
  ) {}
}

class PortConflictError {
  readonly _tag = "PortConflictError"
  constructor(
    readonly port: number,
    readonly service: string,
    readonly existingPid: number | null,
    readonly hint: string
  ) {}
}

class HealthCheckError {
  readonly _tag = "HealthCheckError"
  constructor(
    readonly service: string,
    readonly check: string,
    readonly timeout: number,
    readonly lastResponse: string | null,
    readonly hint: string
  ) {}
}

class ConfigValidationError {
  readonly _tag = "ConfigValidationError"
  constructor(
    readonly path: string,
    readonly issues: ZodIssue[],
    readonly hint: string
  ) {}
}
```

Example output:
```
✗ Cannot tag commit a1b2c3d on main: uncommitted changes detected.
  Hint: Commit or stash your changes, then retry.
  Changed files: rig.json, src/index.ts, README.md

✗ Port 3070 is already in use (pid 42381).
  Service: web (pantry prod)
  Hint: Run "rig stop pantry --prod" first, or check what's using port 3070.

✗ Health check failed for convex (pantry prod).
  Check: http://127.0.0.1:3290/version
  Timeout: 60s elapsed, no healthy response.
  Last response: connection refused
  Hint: Check runtime/logs/convex.log for startup errors.
```

## Tech Stack

| Layer | Tech |
|-------|------|
| Runtime | Bun |
| Language | TypeScript |
| Error handling | Effect TS |
| Schema validation | Zod (config + CLI arg parsing) |
| Process management | `Bun.spawn` |
| Config format | JSON |

Minimal dependencies. Infrastructure tooling should be fast, reliable, and boring.

## Out of Scope (for now)

- Blue/green deploys
- Rollback (previous versions are kept but no automatic rollback)
- Remote deployment
- Docker/containers
- Multi-machine orchestration
