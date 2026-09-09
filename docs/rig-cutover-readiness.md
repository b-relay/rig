# Rig TypeScript Cutover Readiness

Status: September 9 release validation and rollout to available Host Projects
passed. [PR #74](https://github.com/b-relay/rig/pull/74) is the single review
delivery. See [live results](reviews/2026-09-09-live-rollout-results.md) for
backups, the Pantry resume exception, and the missing inactive source. The
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

## Verified evidence and limits

| Area | Final evidence | Limit |
|---|---|---|
| Runtime authority | 186 tests / 989 assertions, strict typecheck, three compiled binaries, and 16 compiled lifecycle/Git-push checks passed. | Tests used isolated roots; real Host evidence was checked separately. |
| Providers | Actual owned Pantry jobs healthy; exact Rig release installed; daemon restart preserves Pantry PIDs and sampled HTTP health. | Active system Caddy remains separately owned and byte-identical. |
| Config | Core's obsolete JSON converted with behavior preserved; all available Project configs validate. | Pantry's recorded safe-resume policy intentionally differs from source config. |
| Activity/logs | Correlated real startup/idempotency activity, current stdout/stderr, legacy unknown streams, and unauthorized HTTP rejection verified. | Application log contents remain private. |
| Legacy state | Original bytes retained, consistent production database backup, independent Git sources, and completed verified adoption. | The inactive rig-env-check temporary source is missing and remains explicit. |
| Delivery | Single PR #74 and issue acceptance mapping for #64–73. | Review/merge remains with the user; Slack has no connector or available browser. |

See [milestone evidence](reviews/2026-09-09-rewrite-milestones.md),
[ticket acceptance](reviews/2026-09-09-ticket-acceptance.md), and
[live results](reviews/2026-09-09-live-rollout-results.md).

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
