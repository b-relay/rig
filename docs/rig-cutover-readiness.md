# Rig Cutover Readiness

This document started as the HITL audit for GitHub issue #22. It now records
the approved replacement direction, the completed promotion, and which
follow-up gaps remain intentionally separate from the old v1 code.

## HITL Decision

There are no external users to preserve compatibility for. The only current
user is the maintainer, so the project can move quickly.

The approved cutover model was replacement, not gradual routing:

- keep the replacement implementation isolated while it is incomplete
- do not add command-by-command routing from the old `rig` CLI into the
  replacement implementation
- do not add an environment-variable or config gate for mixed old/new behavior
- when the replacement implementation is good enough, build it as `rig`
- after the rename, `rig` is the new CLI model, not a compatibility wrapper

The safety requirement remains real: the promoted CLI must not accidentally
mutate legacy v1 state, launchd labels, Caddy config, workspaces, logs, or
runtime metadata.

## Readiness Summary

The rig implementation has been promoted to the main CLI:

- `rig` is the entrypoint.
- Rig state defaults to `~/.rig` or `RIG_ROOT`.
- Effect v4 services/layers, Effect Schema validation, and Effect CLI parsing
  are in place for rig.
- Provider contracts are explicit interfaces.
- Main-binary E2E coverage runs under isolated state and safe provider
  composition.
- `rigd` owns rig runtime health, inventory, logs, events, receipts, web read
  models, web write actions, and config edit interfaces.

Legacy v1 code has been removed from the repo. Remaining gaps are post-cutover
product or provider work, not blockers for keeping the old implementation.

## Pantry Cutover Target

The first real replacement validation target is `pantry`:

- live web routing must resolve `pantry.b-relay.com` to the configured
  localhost-bound managed service through the rig Caddy proxy router
- Caddy upsert must adopt or replace an existing `pantry.b-relay.com` site
  block instead of appending a duplicate; Caddy rejects duplicate site
  definitions as ambiguous
- the default Caddy provider should render the portable baseline only:
  `domain { reverse_proxy http://127.0.0.1:<port> }`. Local extras such as
  `import cloudflare` and `import backend_errors` belong in Caddy provider
  config, not in the hard-coded default renderer. The rig home config now
  carries bundled Caddy provider defaults for the Caddyfile path, per-site
  extra config lines, and reload behavior.
- rig config interpolation should be component-first: `${web.port}` resolves
  the port for the `web` component. The older `${port.web}` shape is not the
  preferred public syntax.
- the installed CLI component must build from the deployment workspace and
  install an executable named `pantry` into the rig-managed bin root
- live config should use the `pantry` project identity, `pantry.b-relay.com`
  domain, a `live.proxy.upstream` managed service, and an installed component
  with `installName: "pantry"`
- tests should keep the bin root, Caddyfile, launchd home, and rig state root
  isolated from real machine state

On the maintainer machine, the running root Caddy service currently starts
`/usr/local/bin/caddy run --config /usr/local/etc/Caddyfile --envfile
/etc/secrets/cloudflare.env` from launchd label `com.caddyserver.caddy`.
Updating a Caddyfile is not enough by itself; the running server must receive a
graceful reload or be restarted by launchd. Prefer Caddy's reload/admin API
path where possible. `rig` should not be run as root; the Caddy provider
defaults to manual reload, and command-mode reload should only use a
non-interactive command the current user is allowed to run. If the root launchd
service must be restarted manually, the machine-specific fallback is:

```bash
sudo launchctl kickstart -k system/com.caddyserver.caddy
```

## Replacement Readiness Matrix

| Final CLI area | Former v1 behavior | Current `rig` behavior | Readiness status | Replacement decision |
|---|---|---|---|---|
| Init/setup | `rig init` registered projects and scaffolded v1 config | `rig init --project <name> --path <path>` writes a rig `rig.json`, can add non-overwriting `rig:` package scripts, can scaffold SQLite/Postgres/Convex `uses` component stubs with `--uses`, can scaffold neutral project domain and lane proxy metadata with `--domain` and `--proxy`, and records project initialization in isolated `rigd` state | partial: starter config is intentionally minimal and still avoids generic web framework presets | expand setup ergonomics after cutover if needed |
| Lifecycle start | `rig start <name> dev|prod` | `rig up --lane local|live` | partial: repo-inferred and `--config` paths load validated rig config and route config-backed `rigd` lifecycle writes through ordered runtime provider methods selected from the resolved deployment `providerProfile`; desired running state is persisted and reconciled on `rigd.start`; `rigd.managedProcessExited` records crashes, restarts while budget allows, and marks repeated crashes failed; core `rigd` process supervision, launchd plist install/bootstrap, provider stdout/stderr ingestion, `git-worktree` workspace resolution, and `native-health` HTTP/command checks are concrete | replacement path is active |
| Lifecycle stop | `rig stop <name> dev|prod` | `rig down --lane local|live` | partial: repo-inferred and `--config` paths load validated rig config and route config-backed `rigd` lifecycle writes through ordered runtime provider methods; desired state is marked stopped so startup reconciliation skips it; core `rigd` process stop behavior, launchd bootout/plist removal, and `git-worktree` workspace resolution are concrete | replacement path is active |
| Lifecycle restart | `rig restart` | `rig restart --lane local|live` | partial: repo-inferred and `--config` paths load validated rig config; restart routes through `rigd` as an ordered down then up lifecycle sequence for the selected lane | replacement path is active |
| Status | `rig status` | `rig status` | partial: reports readable foundation, `rigd`, deployment, and failure state by default; `--json` also emits structured foundation/inventory/runtime details; runtime execution result details are recorded for config-backed writes | adapter parity follow-ups |
| Logs | `rig logs` | `rig logs` | partial: reads structured `rigd` logs with execution details and provider-backed component execution events; `structured-log-file` writes deployment JSONL event logs; process-supervisor stdout/stderr lines from the core `rigd` provider are ingested when commands emit them | adapter parity follow-ups |
| Deploy | `rig deploy <name> dev|prod` | `rig deploy --target live|generated --ref <ref>` | partial: repo-inferred and `--config` paths load validated rig config; config-backed live/generated deploy actions execute through ordered runtime provider methods and persist desired running state for startup reconciliation; generated deployment caps enforce home-config `reject`/`oldest` policies; `native-health` HTTP/command validation, `structured-log-file` event persistence, `package-json-scripts` installed-component builds, core `rigd` process supervision, launchd process supervision, `local-git` ref fetch/verification, `git-worktree` workspace materialization, and rig-namespaced Caddy route upsert/remove are concrete | replacement path is active |
| Version metadata | `rig version` | `rig bump` | partial: semver is optional metadata | final CLI can keep `bump` if it remains simpler than `version` |
| Global inventory | `rig list` | `rig list` | partial: reads global rig project/deployment inventory from `rigd.webReadModel`; `--json` emits the structured read model | replacement path is active |
| Config | `rig config` | `rig config read/set/unset` backed by `rigd.configRead/configPreview/configApply` | partial: project config CLI surface exists; hosted/web editing is still future work | #24 complete |
| Docs/help | `rig docs`, `--help`, `-h` | README, `DESIGN.md`, `docs/rig-guide.md`, Effect CLI help | partial | update final docs during replacement work |
| Forget/purge | `rig forget` | no direct `rig forget` replacement yet | not implemented | defer unless needed for replacement usability |
| Daemon authority | no v1 equivalent | `rigd` | rig-only | keep as runtime authority command |
| Doctor | no v1 equivalent | `rig doctor` | rig-only | keep and expand as provider-backed execution lands |

## Provider Safety

Cutover tests must keep provider mutation explicit:

- Use `RIG_ROOT` temporary directories in tests.
- Use stub provider profiles for agent and CI paths unless the test is
  specifically validating real providers.
- Never let cutover tests mutate the user's real rig state, Caddyfile, or
  launchd labels.
- Keep launchd, Caddy, filesystem, process, SCM, control-plane transport, and
  tunnel/exposure concerns behind interfaces.
- Prove risky multi-component behavior with checked-in fake Rig projects
  before using Pantry as the cutover target. The first fixture is
  `fixtures/rig-projects/fullstack-basic/rig.json`, which models a
  Postgres-like service, Convex-like service, API, and Vite-like web component
  with isolated `local`, `live`, and generated deployment ports.
- Keep a Pantry-like fake app flow green before real Pantry cutover; it should
  cover routed web, SQLite state, and an installed CLI named `pantry` under
  isolated rig state.
- Defer but keep tracked: add an isolated real-Caddy reachability E2E that
  starts a fake localhost app, writes a temp Caddyfile, runs Caddy on a high
  local port, upserts a Rig route, and verifies the app is reachable through
  Caddy with a `Host` header.

## Validation Checklist

For replacement validation:

- `bun install`
- `bun test`
- `bun run build`
- `git diff --check`
- Run `rig` command tests with isolated `RIG_ROOT`.
- Run a stub-provider lifecycle path.
- Run a stub-provider generated deployment path.
- Keep the fake-project CLI flow green for local, live, and generated deploys
  before testing Pantry itself.
- Run the Pantry readiness tests proving `pantry.b-relay.com` Caddy routing and
  `pantry` CLI installation under an isolated rig bin root.
- Before real Caddy cutover, run the isolated real-Caddy reachability E2E.
- Run `rigd` read model, write action, and config edit tests.
- Confirm legacy v1 state is preserved.
- Confirm rollback steps are documented for the v1-removal and rig promotion
  commit.

## Rollback Checklist

The replacement should be reversible:

- Keep the last known v1 binary available from git history or a saved artifact
  until the replacement is validated.
- Do not migrate v1 state in place.
- Preserve historical state separately from the current rig state root until a
  deliberate migration plan exists.
- If the replacement fails, restore the previous `rig` build and continue using
  the old state.
- If config edit apply fails, use the reported `rig.json.backup-*.json` file.
- If generated deployment state is stale, use `rigd` inventory/read models to
  inspect state before deleting anything manually.

## Completed Replacement

Completed direction:

1. Removed the legacy v1 implementation from the repo.
2. Promoted the replacement entrypoint and Effect CLI command name to `rig`.
3. Kept tests and agent runs isolated through `RIG_ROOT`.
4. Removed transitional alternate-CLI package scripts.
5. Kept provider adapter and hosted control-plane work tracked separately.

## Follow-Up Issues

Known gaps are filed instead of hidden in this plan:

- #23 Rename/build replacement CLI as rig when replacement criteria are met. Complete:
  v1 code was removed, the replacement entrypoint is now `rig`, and the build emits the
  final `rig` binary.
- #26 Add hosted control-plane transport adapter for rig.b-relay.com. Complete:
  the control-plane boundary now includes a hosted transport interface,
  disabled default adapter, pairing-token guard, and envelope send path.
- #27 Add launchd process-supervisor adapter for rig execution. Complete:
  rig launchd process supervision now installs rig-namespaced plists,
  bootstraps them through launchctl, removes them on down, and supports
  injected launchctl/home paths for isolated tests.
- #30 Add workspace materializer adapter for rig deployments. Complete:
  `git-worktree` now removes stale worktrees, materializes detached workspaces
  at deploy refs, removes generated workspaces during teardown, and receives
  source repo paths from loaded config.
- #29 Add SCM checkout adapter for rig deploy execution. Complete:
  `local-git` now fetches origin refs, verifies deploy refs resolve to commits,
  and reports tagged runtime errors for fetch or ref-resolution failures.
- #28 Add proxy router adapter for rig provider execution. Complete:
  `caddy` now upserts and removes rig-namespaced Caddyfile routes from
  deployment domains to localhost component ports, adopts same-domain existing
  blocks to avoid duplicate ambiguous site definitions, renders portable
  reverse-proxy-only blocks by default, accepts home-config-style per-site
  extra config, and can run an explicitly configured reload command after
  writes.

## HITL Decisions

Resolved:

- Cutover is a deliberate v1-removal and replacement-promotion commit, not
  command-by-command routing.
- No old/new mixed gate is needed.
- V1 compatibility is not a long-term product requirement because there are no
  external users.
- The replacement implementation is now the main `rig` implementation after v1 removal.

Still useful to decide after replacement:

- Whether `bump` is the final command name for optional version metadata.
- Whether `forget` needs a replacement command.
- Which real local project should be the first replacement validation target.
