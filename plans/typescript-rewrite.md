# Rig TypeScript rewrite execution

Status: implemented, validated, and deployed to available Projects; PR #74 is
the single review delivery. Slack delivery is unavailable. User authorization: September 9, finish current PRD and
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
   its link in Slack when available. Release validation and live rollout passed;
   PR #74 contains delivery. The missing inactive source and Slack capability
   remain explicit limitations.

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

## Final Evidence And Delivery Limitations

Detailed interface decisions, independent findings, fixes, and contract ledgers
are in `docs/reviews/2026-09-09-rewrite-milestones.md`. Milestones 1–4 passed final
validation: 186 tests, 989 assertions, strict typecheck, three compiled binaries,
and 16 compiled-only lifecycle/Git-push checks. Independent reviews covered
launchd/Caddy, hard daemon-exit recovery, deployment commit boundaries, artifact
ownership, registration, doctor, interactions, and legacy logs. Live compatibility
cutover has completed for available Projects. See
[the live results](../docs/reviews/2026-09-09-live-rollout-results.md) for exact
backups, source preservation, production resume exception, and final readback.

The [config review](../docs/reviews/2026-09-09-config-contracts.md) records document
and resolver contracts. The [legacy migration review](../docs/reviews/2026-09-09-legacy-migration.md)
and [Pantry source evidence](../docs/reviews/2026-09-09-legacy-source-evidence.md)
separate recovered source provenance, preserved metadata, and provider adoption.
The adoption suite verifies stale revisions, incomplete/contradictory ownership,
missing manifests, and tampered completion provenance fail closed. Passing
migration fixtures do not prove that the actual Host has been adopted.

Before live reconciliation was enabled, the cutover prevented the old recorded
Rig/live build from reinstalling legacy binaries. Independent Git source
ownership was established for materialized Targets while preserving their
workspaces/data, and legacy process and route ownership was verified before
adoption was finalized. Pantry and pantry2 remain distinct; the missing inactive
registration remains explicit in the live results.

The current source/dependency graph removes Effect. Final checks passed after
all implementation and review fixes: `bun run typecheck`, `bun test`, and
`bun run build`; compiled `rig`, `rigd`, and `git-remote-rig` passed help and a
real isolated lifecycle/Git-push smoke test. Exact evidence is in the milestone
review notes.

Live upgrade and preservation readback passed independently after the isolated
release gate. [PR #74](https://github.com/b-relay/rig/pull/74) links #64–73 with
[acceptance evidence](../docs/reviews/2026-09-09-ticket-acceptance.md).
The missing inactive rig-env-check source cannot be upgraded. Slack delivery
is blocked because this session has neither a Slack connector nor an available
browser; the PR link is delivered in the conversation. No merge is performed.

## Subsequent repository cleanup

The [cleanup review](../docs/reviews/2026-09-09-repository-cleanup.md) records
documentation pruning, shared policy owners, three boundary fixes, and remaining
design work. Its isolated validation passes 194 tests and strict typecheck;
the separate cleanup delivery does not update the Host rollout recorded above.

Follow-up #79 preserves fresh application state behind launchd capture wrappers,
including backoff, recovery identity, and exhausted retry status. Its bounded
provider/status regression and observation contracts are recorded in
[the capture observation review](../docs/reviews/2026-09-09-issue-79-capture-observations.md).

Follow-up #81 gates pre-stop hooks on managed process observations for explicit
stop and daemon reconciliation, preserving post-stop cleanup and stop failure
classification. See [the policy and validation evidence](../docs/reviews/2026-09-09-issue-81-pre-stop-hooks.md).
