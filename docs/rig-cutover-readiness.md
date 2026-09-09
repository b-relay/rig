# Rig TypeScript Cutover Readiness

Status: September 9 implementation validation is in progress. Existing Host
rollout and final delivery have not been established by this document. The
[prior Effect cutover record](rig-cutover-readiness-pre-typescript.md) is retained
as historical evidence, not current instructions or a completion claim.

## Current Architecture

`rig` and `git-remote-rig` call the authenticated localhost `rigd` runtime.
The implementation uses strict TypeScript, Bun, Zod, explicit capability
interfaces, and process/Git/artifact/Caddy adapters. The build packages all three
executables. Effect code and dependencies are removed from the current source;
Git retains the predecessor implementation.

Project and Host documents are YAML-first with legacy JSON compatibility.
Only the default provider profile is supported. Tests use injected providers
and isolated `RIG_ROOT`; a historical stub profile must never select real effects.
User config is not automatically converted during runtime cutover.

## Evidence And Pending Gates

| Area | Evidence | Remaining release gate |
|---|---|---|
| Runtime authority | Real isolated CLI/daemon lifecycle and cross-client stop tests. | Final compiled-binary battle tests and independent review. |
| Providers | Isolated process capture/recovery, launchd, independent Git, artifact, and Caddy tests. | Verify actual Host ownership and routing during each explicit cutover. |
| Config | Restricted YAML/JSON, safe editor, unsupported-profile, and reload-command tests. | Validate every existing Project/Host document without converting formats. |
| Activity | Final admin outcomes survive daemon shutdown; terminal crash monitoring deduplicates persistent evidence. | Final runtime integration and operator-visible evidence checks. |
| Legacy state | Exact backups, revision checks, explicit source recovery, and guarded adoption fixtures. | Publish and verify real metadata only after reviewing the actual source revision. |
| Delivery | One implementation branch and acceptance evidence for #64–#73. | One PR, then its link in Slack. |

See [milestone evidence](reviews/2026-09-09-rewrite-milestones.md),
[migration review](reviews/2026-09-09-legacy-migration.md), and
[Pantry source provenance](reviews/2026-09-09-legacy-source-evidence.md).
Passing a fixture does not prove a live service or migration succeeded.

## Live Cutover Contract

1. Finish isolated battle tests, strict typecheck, build, and material review fixes.
2. Inventory current registrations, source paths, binaries, exact process owners,
   Caddy routes, and Persistent storage. Back up exact affected bytes and preserve
   rollback artifacts before changing the Host.
3. Establish independent Git source ownership. Preserve original workspaces and
   untracked/environment files. Recover missing Branch/Commit only from verified
   historical execution and source evidence; keep Pantry and pantry2 identities distinct.
4. Quiesce legacy writers and publish new metadata using the reviewed revision.
   Keep ownership adoption pending until every exact legacy process and route
   has a verified disposition. Unreadable, missing, contradictory, or tampered
   adoption evidence must not authorize runtime effects.
5. Prevent old Rig/live recorded policy from reinstalling legacy binaries when
   reconciliation starts. Explicitly deploy the reviewed source and preserve its
   actual Branch/Commit identity.
6. Verify each Project's desired state, process ownership, health, routes,
   installed binary identity, logs, and retained Persistent storage. Record actual
   outcomes and any blocked registrations before declaring rollout complete.

Do not broadly delete state, workspaces, jobs, routes, or data. Replace only exact
owned resources required by the explicit cutover. No stale machine-specific
Caddy command from the historical record is authorization or current capability
evidence. Follow the [state preservation policy](state-preservation-policy.md).

## Rollback

Retain original legacy files, the migration backup, the original adoption
manifest, source workspaces, and the previous binaries and provider definitions.
A rollback must restore matching runtime and provider ownership together;
replacing a binary alone is insufficient after process/route ownership changes.
If verification fails, keep the failed transition evidence and restore only the
reviewed owned resources. Preserve unrelated Host configuration and Project data.
