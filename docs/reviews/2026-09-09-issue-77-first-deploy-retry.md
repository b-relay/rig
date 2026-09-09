# Issue #77: retry a failed first deployment

## Design and agreed seams

Use public runtime.command and FileStateStore persistence with injected lifecycle,
source, and document boundaries. Tests use fresh temporary roots only. The issue
is read from the supervisor GitHub snapshot after live gh failed to connect.

Compared two shapes before implementation:
1. Separate deployment-attempt ledger keyed by Target, with completion lookup for
   every deploy. This adds another durable entity and reconciliation policy.
2. Optional deploymentIncomplete marker on the Target and its recovery snapshot.
   This is the smallest shape: existing deployment transactions own the marker,
   completion clears it, and rollback preserves the prior completion distinction.

Choose 2. A candidate is incomplete until a durable commit decision (including
no-up). Recovery snapshots preserve whether the restored record was incomplete;
first attempts have no completed predecessor. Existing records without metadata
retain existing no-op semantics. Reading old state never adds inferred metadata
or rewrites it; desired stopped is never evidence of deployment failure. Historical
failed attempts without the marker remain indistinguishable and require explicit
force; automatically migrating them is outside the state preservation policy.

## Verification

- Red: runtime-application had 21 pass / 1 fail; reopened identical retry returned
  unchanged instead of deployed. Initial run first required the authorized
  existing node_modules symlink (missing yaml); this was not the behavior red.
- Green: runtime-application, deployment-effects, and state: 44 pass / 0 fail,
  188 assertions. Strict bun run typecheck passed.
- Coverage includes actual second activation, unchanged identity/storage paths and
  retained file data, failed/deployed Activity, subsequent successful no-op,
  completed running/stopped/no-up controls, recovery precedence from #76,
  persisted rollback of both incomplete and completed predecessor plans, and old
  records read unchanged without inferred metadata.
- Full suite/build and two independent exact-head reviews belong to the supervisor.

## Function contract ledger

activateDeployment(candidate, previous, noUp, deps) owns deployment completion.
Inputs remain explicit Target records, no-up intent and runtime dependencies;
outputs remain candidate mutation, durable inventory, lifecycle/checkpoint effects,
completed Target or existing tagged/provider errors. New metadata is set before
persisting the pending transition, captures the predecessor completion distinction,
and is removed only from the durable committing decision. Failed rollback leaves
existing recovery guidance authoritative. A failed first attempt retains its
incomplete marker, identity, and persistent storage. Rollback of a later failed
attempt restores the predecessor including its marker. No new ambient input,
error channel, caller prerequisite, or interface method is introduced.

Its direct callees are assertDeploymentRecovered (pure validation), persistTarget
(serialized injected state update), stopForTransition (injected lifecycle effects),
and lifecycle checkpoint/up/retireSuperseded/commit/rollback (injected provider
and filesystem effects). Their contracts are trusted through runtime-application,
deployment-effects, and state tests; none adds a new ambient acquisition here.
The existing transaction remains the effect owner and error-policy owner.

stopForRecovery(target, deps) retains its caller-owned Target, provider effects,
state mutation, returned recovered record and existing failure behavior. It restores
the completion marker alongside the previous plan/Branch/Commit on rollback;
committing recovery already carries the completed decision. Its direct callees
remain stopForTransition, lifecycle.commitEffects/restoreEffects and persistTarget,
with the same tested effects and ordering. No metadata is inferred from desired.

createRuntime's execute(command) is the serialized command effect owner over
captured RuntimeDependencies. The matching-source shortcut gains a single explicit
state condition. Existing recovery validation runs first. Sources/documents/store
reads, Activity writes, clock/id callbacks, diagnostics and lifecycle effects stay
behind their injected boundaries. planTarget already preserves Target id,
createdAt, logRoot and dataRoot; it builds a fresh candidate, so no old marker leaks
into a completed decision. Both application activation and explicit-down callers
were inspected. No broader function refactor is needed for this issue.

Test callbacks own only their fresh temporary filesystem roots and injected
lifecycle behavior. Their meaningful outputs are public command outcomes, persisted
state roundtrips and retained storage. Empty/invalid schema and unresolved recovery
channels are covered by existing state and runtime tests. Historical failed records
without completion metadata remain an explicit compatibility limitation, not a
migration or inferred stopped-state fix.
