# Rig TypeScript rewrite execution

Status: in progress. User authorization: September 9, finish current PRD and
all open GitHub tickets using plain TypeScript/Bun, without Effect. Review
subagents after every major milestone. User unavailable; make bounded decisions.

## Milestones

1. Config/domain foundation: Zod schemas, restricted YAML/JSON documents,
   normalized Target plan, explicit errors and provider interfaces. Review.
2. Durable runtime: authenticated daemon, process ownership, recorded-state
   lifecycle, source-store deployment, route/package adapters. Review.
3. Complete CLI: human/structured output, diagnostics/activity, fresh status,
   logs, doctor, init/config, rename/repoint, Git remote deployment. Review.
4. Compatibility and end-to-end: preserve old records/data, verify actual
   isolated processes/Caddy/daemon, remove all Effect code/dependencies, full
   tests/typecheck/build, final independent review, and ticket acceptance evidence.
5. Existing-Project rollout and delivery: after battle testing, inventory and
   back up each affected Host resource, complete explicit compatibility/source
   ownership cutover, verify runtime/data preservation, publish one PR, and send
   its link in Slack. Release validation passed; live rollout and PR delivery are pending.

## Contracts and preservation

Public seams under test: CLI subprocess, daemon HTTP client, config documents,
provider operations, runtime actions and read models. These extend the already
accepted plan; no extra interview is required by the current authorization.
Retain old source in Git while replacing its implementation and behavior tests.
Never broadly delete the user's live state, workspaces, launchd jobs, or Caddy
configuration. An explicit verified cutover may replace exact owned process and
route resources after backups, retaining unrelated resources and rollback evidence.
Legacy state reads are compatible or fail closed; no silent data migration.
All tests use isolated RIG_ROOT and provider-owned paths.
Keep existing Project and Host config formats; runtime compatibility work does
not authorize automatic JSON-to-YAML conversion.

## Ticket evidence

Track #64 local cwd; #65 cross-client stop; #66 partial-target idempotency;
#67 real health/crash recovery; #68 explicit repoint/rename; #69 independent
source store; #70 consistent identity; #71 truthful doctor; #72 scoped
status/lifecycle/deploy JSON;
#73 recorded Branch/Commit. Close only with test and implementation evidence.

## Validation baseline

Previous code: 255 tests pass under an isolated .rig path; 145 TypeScript errors.
Old tests tied to Effect internals will be replaced with equivalent public
behavior coverage, not retained as a parallel production runtime.

## Delivery update

Latest user instruction: deliver one big PR rather than pushing to main. Send
its link in Slack when ready. Battle-test the finished implementation before
updating existing Rig projects; inventory, backup, and verify each live rollout.
The user allows additional subagents and requests milestone reviews.

## Current Evidence And Remaining Work

Detailed interface decisions, independent findings, fixes, and contract ledgers
are in `docs/reviews/2026-09-09-rewrite-milestones.md`. Milestones 1–4 passed final
validation: 186 tests, 989 assertions, strict typecheck, three compiled binaries,
and 16 compiled-only lifecycle/Git-push checks. Independent reviews covered
launchd/Caddy, hard daemon-exit recovery, deployment commit boundaries, artifact
ownership, registration, doctor, interactions, and legacy logs. Live compatibility
cutover remains pending; no real Project has been changed at this checkpoint.

The [config review](../docs/reviews/2026-09-09-config-contracts.md) records document
and resolver contracts. The [legacy migration review](../docs/reviews/2026-09-09-legacy-migration.md)
and [Pantry source evidence](../docs/reviews/2026-09-09-legacy-source-evidence.md)
separate recovered source provenance, preserved metadata, and provider adoption.
The adoption suite verifies stale revisions, incomplete/contradictory ownership,
missing manifests, and tampered completion provenance fail closed. Passing
migration fixtures do not prove that the actual Host has been adopted.

Before enabling live reconciliation, prevent the old recorded Rig/live build
from reinstalling legacy binaries. Establish independent Git source ownership
for materialized Targets while preserving existing workspaces/data; verify every
legacy process and route before finalizing adoption. Keep ambiguous or missing
registrations explicit rather than merging Project identities.

The current source/dependency graph removes Effect. Final checks passed after
all implementation and review fixes: `bun run typecheck`, `bun test`, and
`bun run build`; compiled `rig`, `rigd`, and `git-remote-rig` passed help and a
real isolated lifecycle/Git-push smoke test. Exact evidence is in the milestone
review notes.

Remaining release gates: verify each live upgrade and preservation readback;
publish the single PR with ticket evidence. Slack delivery is currently blocked
because this session has neither a Slack connector nor an available browser;
provide the PR link in the conversation if that capability remains unavailable.
No live gate is complete merely because isolated tests passed.
