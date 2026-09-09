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
   tests/typecheck/build, final independent review, close proven tickets/push.

## Contracts and preservation

Public seams under test: CLI subprocess, daemon HTTP client, config documents,
provider operations, runtime actions and read models. These extend the already
accepted plan; no extra interview is required by the current authorization.
Retain old source in Git while replacing its implementation and behavior tests.
Never delete user's live state, workspaces, launchd jobs, or Caddy configuration.
Legacy state reads are compatible or fail closed; no silent data migration.
All tests use isolated RIG_ROOT and provider-owned paths.

## Ticket evidence

Track #64 local cwd; #65 cross-client stop; #66 partial-target idempotency;
#67 real health/crash recovery; #68 explicit repoint/rename; #69 independent
source store; #70 consistent identity; #71 truthful doctor; #72 scoped JSON;
#73 recorded Branch/Commit. Close only with test and implementation evidence.

## Validation baseline

Previous code: 255 tests pass under an isolated .rig path; 145 TypeScript errors.
Old tests tied to Effect internals will be replaced with equivalent public
behavior coverage, not retained as a parallel production runtime.
