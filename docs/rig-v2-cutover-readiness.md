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

## Replacement Readiness Matrix

| Final CLI area | Current v1 behavior | Current `rig2` equivalent | Readiness status | Replacement decision |
|---|---|---|---|---|
| Init/setup | `rig init` registers projects and can scaffold v1 or v2 config | v2 scaffold exists through `rig init --v2`; no `rig2 init` yet | partial | add v2-native init surface before replacement or intentionally keep setup in final `rig init` |
| Lifecycle start | `rig start <name> dev|prod` | `rig2 up --lane local|live` | partial: config-backed `rigd` lifecycle writes execute through the v2 runtime executor provider interface; direct CLI config loading and real-process parity still pending | #25 in progress |
| Lifecycle stop | `rig stop <name> dev|prod` | `rig2 down --lane local|live` | partial: config-backed `rigd` lifecycle writes execute through the v2 runtime executor provider interface; direct CLI config loading and real-process parity still pending | #25 in progress |
| Lifecycle restart | `rig restart` | no direct `rig2 restart` | not implemented | add first-class v2 `restart` or intentionally omit before replacement |
| Status | `rig status` | `rig2 status` | partial: reports foundation and `rigd` state; runtime execution result details are recorded for config-backed writes | #25 in progress |
| Logs | `rig logs` | `rig2 logs` | partial: reads structured `rigd` logs with execution details; provider-backed component log ingestion pending | #25 in progress |
| Deploy | `rig deploy <name> dev|prod` | `rig2 deploy --target live|generated --ref <ref>` | partial: generated state and config-backed deploy actions execute through the v2 runtime executor provider interface; direct CLI config loading and real-process parity still pending | #25 in progress |
| Version metadata | `rig version` | `rig2 bump` | partial: semver is optional metadata | final CLI can keep `bump` if it remains simpler than `version` |
| Global inventory | `rig list` | no direct `rig2 list` | not implemented | add v2 CLI inventory if shell workflows need it |
| Config | `rig config` | `rigd.configRead/configPreview/configApply` interfaces | partial: no CLI/transport surface | blocked by #24 |
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
2. Close or intentionally defer the known usability gaps in #24 and #25.
3. Update the build so the v2 entrypoint can produce the final `rig` binary.
4. Run the validation checklist under isolated state and stub providers.
5. Save or preserve a rollback path to the current v1 binary.
6. Rename/build `rig2` as `rig`.
7. Validate the maintainer's real workflow and current machine state.

## Follow-Up Issues

Known gaps are filed instead of hidden in this plan:

- #23 Rename/build rig2 as rig when replacement criteria are met.
- #24 Expose rigd config editing through rig2 CLI or control-plane transport.
- #25 Connect rig2 lifecycle and deploy actions to provider-backed execution.
- #26 Add hosted control-plane transport adapter for rig.b-relay.com.

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
