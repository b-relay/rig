# Rig V2 Cutover Readiness

This document is the HITL audit for GitHub issue #22. It records what is ready,
the approved replacement direction, and which follow-up issues hold known gaps.

No runtime routing from `rig` to v2 is enabled by this document.

## HITL Decision

There are no external users to preserve compatibility for. The only current
user is the maintainer, so the project can move quickly.

The approved cutover model is replacement, not gradual routing:

- keep `rig2` isolated while v2 is incomplete
- do not add command-by-command routing from the old `rig` CLI into v2
- do not add an environment-variable or config gate for mixed v1/v2 behavior
- when v2 is good enough, rename or build `rig2` as `rig`
- after the rename, `rig` is the new CLI model, not a compatibility wrapper

The safety requirement is still real: until the replacement is deliberate,
v2 must not accidentally mutate the maintainer's current v1 state, launchd
labels, Caddy config, workspaces, logs, or runtime metadata.

## Readiness Summary

V2 is ready as an isolated runway:

- `rig2` has an isolated entrypoint.
- V2 state defaults to `~/.rig-v2` or `RIG_V2_ROOT`.
- Effect v4 services/layers, Effect Schema validation, and Effect CLI parsing
  are in place for v2.
- Provider contracts are explicit interfaces.
- Main-binary E2E coverage runs under isolated state and safe provider
  composition.
- `rigd` owns v2 runtime health, inventory, logs, events, receipts, web read
  models, web write actions, and config edit interfaces.

V2 is not ready to be renamed to `rig` until the follow-up gaps are closed or
intentionally deferred.

## Pantry Cutover Target

The first real replacement validation target is `pantry`:

- live web routing must resolve `pantry.b-relay.com` to the configured
  localhost-bound managed service through the v2 Caddy proxy router
- Caddy upsert must adopt or replace an existing `pantry.b-relay.com` site
  block instead of appending a duplicate; Caddy rejects duplicate site
  definitions as ambiguous
- the default Caddy provider should render the portable baseline only:
  `domain { reverse_proxy http://127.0.0.1:<port> }`. Local extras such as
  `import cloudflare` and `import backend_errors` belong in Caddy provider
  config, not in the hard-coded default renderer. The v2 home config now
  carries bundled Caddy provider defaults for the Caddyfile path, per-site
  extra config lines, and reload behavior.
- v2 config interpolation should be component-first: `${web.port}` resolves
  the port for the `web` component. The older `${port.web}` shape is not the
  preferred public syntax.
- the installed CLI component must build from the deployment workspace and
  install an executable named `pantry` into the v2-managed bin root
- live config should use the `pantry` project identity, `pantry.b-relay.com`
  domain, a `live.proxy.upstream` managed service, and an installed component
  with `installName: "pantry"`
- tests should keep the bin root, Caddyfile, launchd home, and v2 state root
  isolated until the replacement is deliberate

On the maintainer machine, the running root Caddy service currently starts
`/usr/local/bin/caddy run --config /usr/local/etc/Caddyfile --envfile
/etc/secrets/cloudflare.env` from launchd label `com.caddyserver.caddy`.
Updating a Caddyfile is not enough by itself; the running server must receive a
graceful reload or be restarted by launchd. Prefer Caddy's reload/admin API
path where possible. `rig2` should not be run as root; the Caddy provider
defaults to manual reload, and command-mode reload should only use a
non-interactive command the current user is allowed to run. If the root launchd
service must be restarted manually, the machine-specific fallback is:

```bash
sudo launchctl kickstart -k system/com.caddyserver.caddy
```

## Replacement Readiness Matrix

| Final CLI area | Current v1 behavior | Current `rig2` equivalent | Readiness status | Replacement decision |
|---|---|---|---|---|
| Init/setup | `rig init` registers projects and can scaffold v1 or v2 config | `rig2 init --project <name> --path <path>` writes a v2 `rig.json`, can add non-overwriting `rig:` package scripts, and records project initialization in isolated `rigd` state | partial: starter config is intentionally minimal and still needs richer component/plugin prompts or flags before final replacement | expand setup ergonomics before replacement or intentionally keep the first replacement init minimal |
| Lifecycle start | `rig start <name> dev|prod` | `rig2 up --lane local|live` | partial: repo-inferred and `--config` paths load validated v2 config and route config-backed `rigd` lifecycle writes through ordered runtime provider methods; desired running state is persisted and reconciled on `rigd.start`; `rigd.managedProcessExited` records crashes, restarts while budget allows, and marks repeated crashes failed; core `rigd` process supervision, launchd plist install/bootstrap, provider stdout/stderr ingestion, `git-worktree` workspace resolution, and `native-health` HTTP/command checks are concrete | #23 rename/build validation |
| Lifecycle stop | `rig stop <name> dev|prod` | `rig2 down --lane local|live` | partial: repo-inferred and `--config` paths load validated v2 config and route config-backed `rigd` lifecycle writes through ordered runtime provider methods; desired state is marked stopped so startup reconciliation skips it; core `rigd` process stop behavior, launchd bootout/plist removal, and `git-worktree` workspace resolution are concrete | #23 rename/build validation |
| Lifecycle restart | `rig restart` | `rig2 restart --lane local|live` | partial: repo-inferred and `--config` paths load validated v2 config; restart routes through `rigd` as an ordered down then up lifecycle sequence for the selected lane | #23 rename/build validation |
| Status | `rig status` | `rig2 status` | partial: reports readable foundation, `rigd`, deployment, and failure state by default; `--json` also emits structured foundation/inventory/runtime details; runtime execution result details are recorded for config-backed writes | adapter parity follow-ups |
| Logs | `rig logs` | `rig2 logs` | partial: reads structured `rigd` logs with execution details and provider-backed component execution events; `structured-log-file` writes deployment JSONL event logs; process-supervisor stdout/stderr lines from the core `rigd` provider are ingested when commands emit them | adapter parity follow-ups |
| Deploy | `rig deploy <name> dev|prod` | `rig2 deploy --target live|generated --ref <ref>` | partial: repo-inferred and `--config` paths load validated v2 config; config-backed live/generated deploy actions execute through ordered runtime provider methods and persist desired running state for startup reconciliation; generated deployment caps enforce home-config `reject`/`oldest` policies; `native-health` HTTP/command validation, `structured-log-file` event persistence, `package-json-scripts` installed-component builds, core `rigd` process supervision, launchd process supervision, `local-git` ref fetch/verification, `git-worktree` workspace materialization, and v2-namespaced Caddy route upsert/remove are concrete | #23 rename/build validation |
| Version metadata | `rig version` | `rig2 bump` | partial: semver is optional metadata | final CLI can keep `bump` if it remains simpler than `version` |
| Global inventory | `rig list` | `rig2 list` | partial: reads global v2 project/deployment inventory from `rigd.webReadModel`; `--json` emits the structured read model | #23 rename/build validation |
| Config | `rig config` | `rig2 config read/set/unset` backed by `rigd.configRead/configPreview/configApply` | partial: project config CLI surface exists; hosted/web editing is still future work | #24 complete |
| Docs/help | `rig docs`, `--help`, `-h` | README, `docs/DESIGN_V2.md`, `docs/rig2-guide.md`, Effect CLI help | partial | update final docs during replacement work |
| Forget/purge | `rig forget` | no direct `rig2 forget` | not implemented | defer unless needed for replacement usability |
| Daemon authority | no v1 equivalent | `rig2 rigd` | v2-only | keep as v2 runtime authority command |
| Doctor | no v1 equivalent | `rig2 doctor` | v2-only | keep and expand as provider-backed execution lands |

## Provider Safety

Cutover tests must keep provider mutation explicit:

- Use `RIG_ROOT` and `RIG_V2_ROOT` temporary directories in tests.
- Use stub provider profiles for agent and CI paths unless the test is
  specifically validating real providers.
- Never let cutover tests mutate the user `~/.rig`, `~/.rig-v2`, Caddyfile, or
  launchd labels.
- Keep launchd, Caddy, filesystem, process, SCM, control-plane transport, and
  tunnel/exposure concerns behind interfaces.
- Prove risky multi-component behavior with checked-in fake Rig 2 projects
  before using Pantry as the cutover target. The first fixture is
  `fixtures/rig2-projects/fullstack-basic/rig2.json`, which models a
  Postgres-like service, Convex-like service, API, and Vite-like web component
  with isolated `local`, `live`, and generated deployment ports.
- Main-binary v2 tests must prove the selected provider profile before running
  any lifecycle/deploy action.

## Validation Checklist

Before renaming or building `rig2` as `rig`:

- `bun install`
- `bun test`
- `bun run build`
- `bun run build:rig2`
- `git diff --check`
- Run main-binary E2E with isolated `RIG_ROOT`.
- Run `rig2` command tests with isolated `RIG_V2_ROOT`.
- Run a stub-provider lifecycle path.
- Run a stub-provider generated deployment path.
- Run the Pantry readiness tests proving `pantry.b-relay.com` Caddy routing and
  `pantry` CLI installation under an isolated v2 bin root.
- Run `rigd` read model, write action, and config edit tests.
- Confirm current v1 state is preserved until the replacement is deliberate.
- Confirm rollback steps are documented and tested for the rename/build path.

## Rollback Checklist

The replacement should be reversible:

- Keep the last known v1 binary available from git history or a saved artifact
  until the replacement is validated.
- Do not migrate v1 state in place.
- Preserve `~/.rig` separately from `~/.rig-v2`.
- If the replacement fails, restore the previous `rig` build and continue using
  the old state.
- If config edit apply fails, use the reported `rig.json.backup-*.json` file.
- If generated deployment state is stale, use `rigd` inventory/read models to
  inspect state before deleting anything manually.

## Replacement Plan

Recommended order:

1. Keep `rig2` as the proving ground.
2. Close or intentionally defer the known usability gaps in #25 and related provider adapter follow-ups.
3. Update the build so the v2 entrypoint can produce the final `rig` binary.
4. Run the validation checklist under isolated state and stub providers.
5. Save or preserve a rollback path to the current v1 binary.
6. Rename/build `rig2` as `rig`.
7. Validate the maintainer's real workflow and current machine state.

## Follow-Up Issues

Known gaps are filed instead of hidden in this plan:

- #23 Rename/build rig2 as rig when replacement criteria are met.
- #26 Add hosted control-plane transport adapter for rig.b-relay.com.
- #27 Add launchd process-supervisor adapter for rig2 execution. Complete:
  v2 launchd process supervision now installs v2-namespaced plists,
  bootstraps them through launchctl, removes them on down, and supports
  injected launchctl/home paths for isolated tests.
- #30 Add workspace materializer adapter for rig2 deployments. Complete:
  `git-worktree` now removes stale worktrees, materializes detached workspaces
  at deploy refs, removes generated workspaces during teardown, and receives
  source repo paths from loaded config.
- #29 Add SCM checkout adapter for rig2 deploy execution. Complete:
  `local-git` now fetches origin refs, verifies deploy refs resolve to commits,
  and reports tagged runtime errors for fetch or ref-resolution failures.
- #28 Add proxy router adapter for rig2 provider execution. Complete:
  `caddy` now upserts and removes v2-namespaced Caddyfile routes from
  deployment domains to localhost component ports, adopts same-domain existing
  blocks to avoid duplicate ambiguous site definitions, renders portable
  reverse-proxy-only blocks by default, accepts home-config-style per-site
  extra config, and can run an explicitly configured reload command after
  writes.

## HITL Decisions

Resolved:

- Cutover is a rename/build replacement, not command-by-command routing.
- No v1/v2 mixed gate is needed.
- V1 compatibility is not a long-term product requirement because there are no
  external users.
- `rig2` should remain until v2 is good enough, then become `rig`.

Still useful to decide before replacement:

- Whether `bump` is the final command name for optional version metadata.
- Whether v2 needs `restart`, `list`, and `forget` before the rename.
- Which real local project should be the first replacement validation target.
