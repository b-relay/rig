# September 9 TypeScript rollout results

The reviewed implementation release is `087ce3b84da0b2afef61f2886839474106e8b0ac`.
It was deployed through the new Git remote helper. GitHub main was not changed;
[PR #74](https://github.com/b-relay/rig/pull/74) is the single review delivery.
This public summary omits machine paths, process identifiers, database digests,
and application-source details. The full operator record remains in the private
verified backup.

## Preservation and migration

Exact scoped backups preceded replacement. The legacy application jobs were
stopped and their processes, listeners, and database handles verified absent
before a consistent production-storage backup. Both original and backup database
integrity checks passed. No application data was reset or written by a test.

Original registry/runtime bytes and historical metadata remain intact. All seven
registrations and three recorded Targets were retained. Provider adoption validates
against its preserved pending predecessor. Retired launchd definitions are backed
up; unrelated jobs and active system Caddy configuration remain unchanged.

The deployed application's broken Git link was repaired without checkout, reset,
or clean; application files and symlinks were verified unchanged by that repair.
The recovered source remains a distinct Project identity. Deployed application
and Rig workspaces now use independent owned object stores without borrowed
alternates. Normal startup rebuilt the owned application CLI from preserved source.

## Reviewed production-resume exception

Automatic approval review rejected startup with a production code/schema push
hook. The request was not executed. Source review also found an unpinned backend
selection in the application's startup script.

Two independent reviewers approved a reduced-effect resume plan: omit that push
hook and pin the previously running backend executable. The original plan was
backed up; the daemon was stopped for the exact recorded-policy adjustment.
Remaining source, workspace, environment, port, and storage policy was preserved.
The running backend was verified against its pinned copy. No production push ran.

The safer restart succeeded. Because source configuration remains unchanged,
`doctor` correctly reports intentional recorded-policy drift. Do not deploy merely
to clear it; a later application deployment is a separate explicit action.
The recovered Project's guidance documents this condition.

## Existing Project outcomes

| Project | Verified result |
| --- | --- |
| rig | Reviewed release deployed; all three executable ownership records and receipts verified; ready. |
| pantry | Managed components healthy and CLI installed; original application source and production storage preserved. |
| supervisor | Stopped local Target now uses its registered working copy; doctor passes. |
| core | Obsolete JSON converted with production/development behavior preserved; no Target created; doctor passes. |
| pantry2 | Separate identity and source preserved; valid configuration; no Target created; doctor passes. |
| fletcher | Existing configuration and guidance already compatible; no Target created; doctor passes. |
| rig-env-check | Inactive registration retained; its deleted temporary source cannot be upgraded or tested and remains explicitly reported. |

Ten external Project guidance files were updated from reviewed proposals with
exact backups and readback. Updates replace obsolete commands and issue routing,
retain historical incident text, and explain the application resume exception.
Existing symlinks and unrelated user changes were preserved. These local Project
updates did not create additional PRs or commits in their repositories.

## Live verification and independent review

The final independent verifier passed **39 checks**:

- Immutable daemon release identity, authenticated health, and actual loaded
  executable were verified separately from managed binary installation.
- Application startup succeeded; repeated startup returned `unchanged`.
- Real Git-push self-deployment installed the exact reviewed Rig release. All
  installed artifact hashes match their ownership/receipt evidence; help works.
- Application listeners are localhost-only. Backend, web, existing public route,
  and a nonempty static asset pass HTTP checks.
- A scoped daemon restart produced a new daemon identity while retaining the
  application's managed process identities. All four HTTP samples passed;
  this is sampled availability rather than continuous monitoring.
- Current stdout/stderr, explicitly unknown legacy streams, opaque log cursors,
  correlated activity, and rejection of unauthenticated requests were verified.
- Read-only comparison of all populated application tables found exactly the
  same documents as the consistent stopped backup: none missing, changed, or
  added. Both database integrity checks passed. An initial verifier metadata
  classification error failed closed; corrected classification verified actual
  nonzero application records. Both evidence versions were retained privately.

Independent final review found no new material migration defect. Intentional
application config drift, missing inactive source, and externally managed system
routing remain explicit. Operator scripts, exact evidence, and rollback resources
are archived privately. Rollback apply mode was not needed. A superseded incomplete
backup created during this session was removed after final verification.

## Delivery

See [milestone evidence](2026-09-09-rewrite-milestones.md) and
[ticket acceptance](2026-09-09-ticket-acceptance.md). All issues #64–73 are
implemented and delivered for review in the single PR; closing is tied to merge.
No GitHub-main push or merge was performed.

Slack delivery is unavailable: the session exposes neither a Slack connector nor
an available browser. No Slack message was sent; the PR link is provided in the
conversation instead.
