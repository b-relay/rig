# Pantry Cutover Rehearsal Plan

Status: active plan, non-destructive.

Date: 2026-05-01

## Goal

Move Pantry toward the current `rig` runtime without losing live Pantry data or
breaking the running app.

The first rehearsal is intentionally read-only against live Pantry state. No
cleanup, deletion, launchd changes, Caddy reloads, or live process restarts are
part of this plan until a later explicit approval.

## Current Inventory

Pantry repo:

- Repo path: `/Users/clay/Projects/github/b-relay/pantry`
- Current branch: `main`
- Remote: `git@github.com:b-relay/pantry.git`
- Recent head: `59c067b Record rig issues and sync 1.4.0 version`
- Existing Pantry config: `/Users/clay/Projects/github/b-relay/pantry/rig.json`
- Existing config shape: old `environments.dev/prod` schema, not current
  `components`/`local`/`live`/`deployments` schema

Historical Rig state:

- Registry: `~/.rig/registry.json` contains `pantry` pointing at the Pantry repo.
- Historical Pantry workspaces: `~/.rig/workspaces/pantry`
- Historical Pantry workspace size: about `7.5G`
- Historical Pantry binaries:
  - `~/.rig/bin/pantry`
  - `~/.rig/bin/pantry-dev`
- Historical Caddyfile: `~/.rig/caddy/Caddyfile`
- Historical Caddyfile backups: `~/.rig/caddy/Caddyfile.backup-*`

Live runtime evidence observed:

- `127.0.0.1:3070` is listening and responded successfully.
- `127.0.0.1:3290/version` responded successfully.
- No listener was observed on dev ports `5173` or `3210`.
- Port `3070` is served by a `node` process.
- Port `3290` is served by a `convex-local` process.

Caddy evidence:

- User launchd label: `homebrew.mxcl.caddy`
- Caddy command: `/usr/local/opt/caddy/bin/caddy run --config /usr/local/etc/Caddyfile`
- Active `/usr/local/etc/Caddyfile` includes:
  - `pantry.b-relay.com -> http://127.0.0.1:3070`
  - `dev.pantry.b-relay.com -> http://127.0.0.1:5173`
- Historical `~/.rig/caddy/Caddyfile` includes old rig markers for:
  - `# [rig:pantry:prod:web]`
  - `# [rig:pantry:dev:web]`

Current `rig` compatibility:

- Running current `rig doctor --project pantry --config /Users/clay/Projects/github/b-relay/pantry/rig.json`
  under an isolated temporary `RIG_ROOT` fails validation because the Pantry
  config is still the old schema:
  - missing top-level `components`

## Preservation Rules

Follow `docs/state-preservation-policy.md`.

Do not delete or overwrite:

- `~/.rig`
- `~/.rig/workspaces/pantry`
- `~/.rig/bin/pantry`
- `~/.rig/bin/pantry-dev`
- `~/.rig/caddy`
- `/usr/local/etc/Caddyfile`
- Pantry `.env*` files
- Pantry Convex/local data

Do not stop, restart, or replace the live Pantry processes until a later
cutover step explicitly says to do so.

## Target Current Rig Shape

The Pantry config needs to be migrated from:

- `environments.dev`
- `environments.prod`
- service objects with `type: "server" | "bin"`
- `healthCheck`

to:

- shared `components`
- `local`
- `live`
- `deployments`
- managed components with `mode: "managed"`
- installed components with `mode: "installed"`
- `health`

The current prod values to preserve are:

- project: `pantry`
- domain: `pantry.b-relay.com`
- live deploy branch: `main`
- live Convex command: `./scripts/start-convex.sh prod`
- live Convex port: `3290`
- live Convex health: `http://127.0.0.1:3290/version`
- live web command:
  `VITE_CONVEX_URL=http://127.0.0.1:3290 ./node_modules/.bin/vite preview --host 127.0.0.1 --port 3070`
- live web port: `3070`
- live web health: `http://127.0.0.1:3070`
- live web depends on `convex`
- live web preStart:
  `VITE_CONVEX_URL=http://127.0.0.1:3290 bun run build`
- installed CLI build:
  `PANTRY_DEFAULT_CONVEX_URL=http://127.0.0.1:3290 bun build --env 'PANTRY_DEFAULT_*' --compile cli/index.ts --outfile dist/pantry`
- installed CLI entrypoint: `dist/pantry`
- proxy upstream: `web`

## Rehearsal Sequence

1. Create a branch or patch in the Pantry repo that migrates `rig.json` to the
   current schema.
2. Validate that new Pantry `rig.json` with current `rig` using a temporary
   `RIG_ROOT`.
3. Run `rig doctor --project pantry --config /path/to/pantry/rig.json` with an
   isolated `RIG_ROOT`.
4. Run a live-lane rehearsal with isolated state, bin root, workspaces, Caddyfile,
   and logs. This must not use `~/.rig` or `/usr/local/etc/Caddyfile`.
5. Confirm the isolated rehearsal can:
   - install dependencies
   - build the web app
   - build/install the `pantry` CLI
   - start Convex on isolated ports
   - start web on an isolated port
   - pass health checks
   - render a Caddy route in an isolated Caddyfile
6. Only after the isolated rehearsal passes, prepare a live cutover checklist.

## Live Cutover Gates

Do not run live cutover until all are true:

- Current Pantry `rig.json` validates under current `rig`.
- Isolated rehearsal passes.
- Active Pantry state has been inventoried again immediately before cutover.
- Rollback command path is written down.
- Existing Caddyfile has been backed up.
- Existing Pantry binary path is backed up or preserved.
- Maintainer explicitly approves touching live state.

## Rollback Handles

Rollback must keep these available:

- Existing `~/.rig/bin/pantry`
- Existing `~/.rig/workspaces/pantry/prod/1.4.0`
- Existing `/usr/local/etc/Caddyfile`
- Existing `homebrew.mxcl.caddy` launchd service
- Existing running live Pantry ports `3070` and `3290`

## Next Concrete Step

Create the Pantry `rig.json` migration patch in the Pantry repo, then validate
it with current `rig` using a temporary `RIG_ROOT`.
