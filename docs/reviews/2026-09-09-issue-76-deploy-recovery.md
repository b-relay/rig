# Issue #76: recovery before matching deployment no-op

## Scope and result

The runtime now checks explicit recovery before accepting a matching Branch/Commit
as unchanged. Pending, blocked, and committing records produce the existing
DEPLOY_RECOVERY error and down guidance, preserve Target evidence, and record a
failed deploy Activity. Completed running, deliberately stopped, and successful
no-up deployments remain unchanged on matching retries. Failed first activation
with cleared recovery is #77 and is deliberately outside this change.

Issue evidence: supervisor's saved GitHub #76 JSON (live gh read could not connect).
CONTEXT.md Redeploy and PRD Product Baseline/R8 remain the governing contracts.
No state schema, scheduler, provider contract, or recovery transition changed.

## Function contract ledger

`assertDeploymentRecovered(previous)` is a synchronous validation boundary. Its
input is only optional recovery-bearing Target data; it borrows without retaining
or mutating it. Output is void or the existing tagged RigError with unchanged
message/hint. No ambient access, I/O, callbacks, or ordering prerequisites exist.
Its sole callee is the trusted RigError constructor (structured error data, no
outside effects). Undefined Target and absent recovery permit progress; every
recovery stage rejects. Empty collections and partial progress cannot occur.

The caller's job is to reject unresolved deployments before claiming success.
`execute(command)` still owns serialized command effects through captured explicit
RuntimeDependencies. Its deploy path selects inventory, resolves source, validates
recovery, chooses no-op or activation, and records the final Activity. The only
new call is `assertDeploymentRecovered(target)` after source resolution and before
the equality shortcut. Reads of documents, source, state and clock, mutations of
state/Activity, lifecycle effects, and diagnostics remain owned by existing
injected providers. The new guard neither acquires nor alters those dependencies.
Existing source resolution errors can still precede recovery guidance; changing
that precedence is outside this issue. Its existing catch owns failed Activity.

`activateDeployment(candidate, previous, noUp, deps)` retains its exact caller
contract and all effects: injected checkpoint/lifecycle/store reads and writes,
candidate mutation, returned completed Target, and tagged activation/rollback
failures. The same guard replaces its inline check, keeping direct callers safe.
No new ambient access or failure channel is introduced. Existing checkpoint,
persistTarget, and stopForTransition behavior is trusted through deployment-effects
tests; all transaction ordering after validation is unchanged. The guard is one
policy owner shared by the command and activation entry points, rather than a
second independent copy of recovery guidance. No major interface redesign needed.

Both production callers were read after the change. Regression callbacks control
recovery stage and completed lifecycle mode through the existing in-memory injected
fixture, await public runtime.command, and inspect agreed state/Activity outcomes.
Fixture dependencies own all effects; they never reach real Rig state. Existing
fixture clock behavior remains inherited and assertions do not depend on timestamps.

## Verification

- Red: isolated runtime-application file, 15 passed / 3 failed. Each new stage case
  failed because deploy resolved instead of rejecting.
- Green: runtime-application and deployment-effects, 37 passed / 0 failed,
  158 assertions. Includes six new cases for recovery and completed no-op behavior.
- Strict `bun run typecheck` passed.
- Tests ran with fresh `/tmp/rig-76-*` RIG_ROOT values; dependencies were symlinked
  from the existing checkout. No real state, binaries, or installed services changed.
- Full suite/build and independent review are reserved for the supervisor gate.
