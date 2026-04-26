# Rig V2 Cutover Readiness

This document is the non-HITL audit for GitHub issue #22. It records what is
ready, what remains gated on product approval, and which follow-up issues hold
known gaps.

No runtime routing from `rig` to v2 is enabled by this document.

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

V2 is not ready to become the default `rig` behavior until the HITL cutover
decisions are approved and the follow-up gaps are closed or intentionally
deferred.

## Command Parity Matrix

| Current `rig` command | Current v1 behavior | Current `rig2` equivalent | Parity status | Cutover decision |
|---|---|---|---|---|
| `rig init` | registers project; can scaffold v1 or v2 config | no `rig2 init` | partial: v2 scaffold exists through `rig init --v2` | keep v1 init; decide whether to add `rig2 init` or route v2 scaffold into final `rig init` |
| `rig deploy <name> dev` | reconciles dev workspace/runtime | `rig2 deploy --target live|generated --ref <ref>` | partial: v2 deploy intent and generated state exist, provider-backed deploy cutover still pending | blocked by #25 |
| `rig deploy <name> prod` | release/tag oriented prod deploy | `rig2 deploy --target live --ref main` | partial: v2 removes semver requirement but does not yet execute full provider-backed prod deploy | blocked by #25 |
| `rig start <name> dev` | starts v1 dev services | `rig2 up --lane local` | partial: v2 routes through `rigd` receipts/log state; provider-backed runtime execution still pending | blocked by #25 |
| `rig start <name> prod` | starts v1 prod services | `rig2 up --lane live` | partial: same as above | blocked by #25 |
| `rig stop <name> dev` | stops v1 dev services | `rig2 down --lane local` | partial: v2 routes through `rigd`; provider-backed runtime execution still pending | blocked by #25 |
| `rig stop <name> prod` | stops v1 prod services | `rig2 down --lane live` | partial: same as above | blocked by #25 |
| `rig restart` | stop then start for v1 env | no direct `rig2 restart` | not implemented | decide whether restart is a first-class v2 command or composed by UI/CLI |
| `rig status` | v1 project/env status | `rig2 status` | partial: v2 reports foundation and `rigd` state; runtime execution parity pending | keep v1 until #25 |
| `rig logs` | v1 service logs | `rig2 logs` | partial: v2 reads structured `rigd` logs; provider-backed component log ingestion pending | keep v1 until #25 |
| `rig version` | release metadata and semver edits | `rig2 bump` | partial: v2 treats semver as optional metadata | product decision needed for final naming |
| `rig list` | registered v1 projects | no direct `rig2 list` | not implemented | decide whether v2 global inventory belongs in `rigd` web read model, CLI, or both |
| `rig config` | v1 config display/set/unset/docs | `rigd.configRead/configPreview/configApply` interfaces | partial: v2 editor exists behind interfaces, no CLI/transport surface | blocked by #24 |
| `rig docs` | v1 docs and onboarding | README, `DESIGN_V2.md`, `docs/rig2-guide.md` | partial | add final cutover docs when behavior is approved |
| `rig forget` | unregister and optional purge | no direct `rig2 forget` | not implemented | decide whether project registry remains shared or v2-specific |
| n/a | no v1 daemon API command | `rig2 rigd` | v2-only | keep as v2 runtime authority command |
| n/a | v1 doctor is not equivalent | `rig2 doctor` | v2-only | keep; expand as provider-backed execution lands |

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

Before enabling any v2 behavior in `rig` by default:

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
- Confirm v1 production commands still work or have explicit deprecation
  messaging.
- Confirm rollback steps are documented and tested for the selected gate.

## Rollback Checklist

The first cutover should be reversible:

- Keep v1 command handlers available while v2 is gated.
- Gate v2 routing behind an explicit switch until approved.
- Do not migrate v1 state in place.
- Preserve `~/.rig` separately from `~/.rig-v2`.
- If v2 routing fails, turn off the gate and rerun the same command through v1.
- If config edit apply fails, use the reported `rig.json.backup-*.json` file.
- If generated deployment state is stale, use `rigd` inventory/read models to
  inspect state before deleting anything manually.

## Cutover Routing Plan

Recommended order:

1. Keep `rig2` as the proving ground.
2. Add a reversible gate for selected v2 commands in the main `rig` binary.
3. Route read-only v2 surfaces first, such as status/read models or doctor.
4. Route low-risk write surfaces next, such as config preview.
5. Route lifecycle/deploy only after provider-backed execution parity lands.
6. Rename or alias `rig2` behavior into `rig` only after user approval.
7. Leave v1 compatibility or explicit deprecation messaging until production
   apps are validated.

## Follow-Up Issues

Known gaps are filed instead of hidden in this plan:

- #23 Route v2 command paths through main rig behind a cutover gate.
- #24 Expose rigd config editing through rig2 CLI or control-plane transport.
- #25 Connect rig2 lifecycle and deploy actions to provider-backed execution.
- #26 Add hosted control-plane transport adapter for rig.b-relay.com.

## HITL Decisions Still Needed

These should be approved by the user before runtime cutover:

- Which command should route to v2 first.
- Whether the first gate is an environment variable, config flag, CLI namespace,
  or release branch behavior.
- Whether `rig2 bump` remains named `bump` or folds into a future `version`
  command.
- Whether v1 commands stay indefinitely or get dated deprecation messages.
- When `rig2` should be renamed, aliased, or removed.
