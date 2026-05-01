# Rig Post-Cutover Validation

This document started as the HITL audit for GitHub issue #22. It now records
the completed replacement, the remaining validation gates, and the rollback
posture for real-provider use.

## Completed Replacement

The approved cutover model was replacement, not gradual routing. That work is
complete:

- legacy implementation code was removed from the repo
- the final entrypoint and compiled binary are `rig`
- runtime state defaults to `~/.rig`, with `RIG_ROOT` for isolated runs
- Effect v4 services/layers, Effect Schema validation, and Effect CLI parsing
  are active in the main command path
- provider contracts are explicit interfaces
- `rigd` owns runtime health, inventory, logs, events, receipts, web read
  models, web write actions, and config edit interfaces

Remaining work is post-cutover product and provider hardening.

## Safety Rules

- Use `RIG_ROOT` temporary directories for tests, CI, and agent runs.
- Use stub provider profiles unless a test is specifically validating real
  providers.
- Do not let tests mutate the user's real rig state, Caddyfile, launchd labels,
  workspaces, logs, or generated deployment inventory.
- Keep launchd, Caddy, filesystem, process, SCM, control-plane transport, and
  tunnel/exposure concerns behind provider interfaces.
- Follow the
  [state preservation policy](./state-preservation-policy.md) before migrating,
  archiving, or deleting historical runtime state.

## Pantry Validation Target

The first real replacement validation target is `pantry`.

Pantry readiness requires:

- live web routing resolves `pantry.b-relay.com` to the configured
  localhost-bound managed service through the Caddy proxy router
- Caddy upsert adopts or replaces an existing same-domain site block instead of
  appending a duplicate
- default Caddy rendering stays portable:
  `domain { reverse_proxy http://127.0.0.1:<port> }`
- machine-specific Caddy snippets such as `import cloudflare` and
  `import backend_errors` come from home config, not hard-coded provider output
- config interpolation stays component-first, for example `${web.port}`
- the installed CLI component builds from the deployment workspace and installs
  an executable named `pantry` into the rig-managed bin root
- bin root, Caddyfile, launchd home, and rig state root remain isolated during
  dry runs

On the maintainer machine, the running root Caddy service currently starts
`/usr/local/bin/caddy run --config /usr/local/etc/Caddyfile --envfile
/etc/secrets/cloudflare.env` from launchd label `com.caddyserver.caddy`.
Updating a Caddyfile is not enough by itself; the running server must receive a
graceful reload or be restarted by launchd. Prefer Caddy's reload/admin API
path where possible. `rig` should not be run as root.

Machine-specific fallback when manual restart is required:

```bash
sudo launchctl kickstart -k system/com.caddyserver.caddy
```

## Readiness Matrix

| Area | Current behavior | Follow-up |
|---|---|---|
| Init/setup | `rig init` writes `rig.json`, can add non-overwriting `rig:` scripts, can scaffold bundled component stubs, domain/proxy metadata, and initialization state. | Expand ergonomics from real project friction. |
| Lifecycle | `rig up/down/restart --lane local|live` routes config-backed writes through `rigd` and selected providers. | Deepen provider parity and failure reporting. |
| Status/logs | `rig status`, `rig list`, and `rig logs` read shared `rigd` read models and structured logs. | Improve operator summaries where real use shows gaps. |
| Deploy | `rig deploy --target live|generated --ref <ref>` executes through SCM, workspace, package, health, process, event, and proxy providers. | Prove real Caddy reachability and Pantry dry run. |
| Config | `rig config read/set/unset` uses `rigd.configRead/configPreview/configApply`. | Connect hosted/web editing later. |
| Version metadata | `rig bump` carries optional semver/rollback metadata. | Decide whether `bump` remains final. |
| Forget/purge | No direct replacement command yet. | Defer unless real use needs it. |
| Daemon authority | `rig rigd`. | Keep as runtime authority command. |
| Doctor | `rig doctor`. | Caddy reload-command misconfiguration is reported as an actionable provider diagnostic. |

## Validation Checklist

- `bun install`
- `bun test`
- `bun run build`
- `git diff --check`
- Run command tests with isolated `RIG_ROOT`.
- Run a stub-provider lifecycle path.
- Run a stub-provider generated deployment path.
- Keep the fake-project CLI flow green for local, live, and generated deploys.
- Keep the isolated real-Caddy reachability E2E green before Pantry cutover.
  The isolated high-port shape uses an explicit `http://` site address and a
  temporary Caddy home so Caddy does not write to the user's real Caddy config
  or autosave location.
- Run Pantry readiness tests proving Caddy routing, SQLite state preparation,
  and `pantry` CLI installation under isolated paths. The current dry run uses
  real package installation, real Caddy route rendering/reachability, real
  health checks, and real structured event logs with capture providers for SCM,
  workspace materialization, and process restart.
- Confirm historical runtime state follows the documented preservation policy.

## Rollback

The replacement should remain reversible:

- Keep the last known old binary available from git history or a saved artifact
  until the replacement is validated on real projects.
- Do not migrate historical state in place.
- Preserve historical state according to the
  [state preservation policy](./state-preservation-policy.md).
- If the replacement fails, restore the previous `rig` build and continue using
  the preserved state.
- If config edit apply fails, use the reported `rig.json.backup-*.json` file.
- If generated deployment state is stale, use `rigd` inventory/read models to
  inspect state before deleting anything manually.

## Open Decisions

- Whether `bump` is the final command name for optional version metadata.
- Whether `forget` needs a replacement command.
- Whether Pantry should be the first real project to cut over after isolated
  Caddy validation is green.

## Current Follow-Up Issues

- #48 Add isolated real-Caddy reachability E2E.
- #49 Add isolated Pantry cutover dry run.
- #50 Improve `rig init` from real project setup friction.
- #51 Keep the historical rig state preservation policy current.
- #52 Harden hosted control-plane transport lifecycle.
- #53 Keep doctor real-provider diagnostics actionable as more failures are found.
