# Readiness timing — issue #84

## Scope and interface decision

The approved public seams are `TargetLifecycle.up`, `TargetEffects`, and provider
operations. Tests exercise lifecycle outcomes and provider effects, with controlled
time; no private readiness entry point is exported. Base: `11cc654` (includes #81).
Initial sandbox retrieval failed; an authorized network read subsequently verified
the live issue body and empty comments list against the supervisor snapshot.

Before: `createTargetLifecycle(effects)` enclosed a readiness helper using ambient
`setTimeout` for deadline and retry. A never-settling health call was already bounded,
but expiry during a retry could wait for the remainder of the 100ms retry delay.

Two interfaces were compared before implementation:

- Lifecycle-owned scheduling: `createTargetLifecycle(effects, timing)` accepts one
  cancellable, one-shot scheduling capability. Lifecycle continues to own health,
  retry, failure interpretation, route gating and rollback.
- Bounded-readiness module: lifecycle receives an operation accepting a health
  callback and timeout, returning ready/expired or rejecting. This hides races but
  introduces another policy owner and callback contract for this sole caller.

Chose lifecycle-owned scheduling: the existing operation already owns the policy;
only its time source needs substitution. No observation-policy reuse or generic
runtime scheduler was introduced. The optional default is the documented production
scheduling effect owner, preserving existing daemon composition and other callers.
The timeout still comes from the recorded Component and provider selection from
its Target, with the existing 100ms retry policy.

After: deadline races both provider completion and retry waiting. Expiry requests
cancellation without depending on cooperation. Success and failure cancel pending
scheduling. Provider rejection remains the original rejection, including one queued
before expiry; it is not relabeled by a catch that checks a later abort state.
Late completion cannot pass the aborted check or restart the lifecycle sequence.
Rollback and the merged #81 pre-stop policy remain in their original owners.

## Function-design ledger and direct-callee trust

All changed functions use the full path; there are timer/provider callbacks and
mutable effect state. Caller job: start the recorded Target, publishing routes only
once newly started Components are ready. Call changed from
`awaitReady(component, target, effects)` to
`awaitReady(component, target, effects, timing)`.

| Function | Inputs and prerequisites | Outputs, mutation and failure | Ambient effects and direct callees |
| --- | --- | --- | --- |
| `createTargetLifecycle` / `up` | Effects, scheduling capability, recorded Target, optional matching checkpoint; validated plans and provider profile | Lifecycle methods; process, hook and route effects; started/unchanged; original error or rollback failure. Local started list determines rollback scope. External checkpoint remains caller-owned | `assertProviderProfile` trusted existing validation; supervisor/effect methods own process, environment, filesystem and routing effects through existing contracts and integration tests. `awaitReady` trusted by controlled lifecycle tests. No new ambient source except the explicitly documented default scheduling owner |
| `awaitReady` | Managed Component timeout, Target identity, health capability, timing; scheduling must not run inline or throw | Void readiness success; original provider rejection or tagged HEALTH_FAILED; requests abort on expiry; always cancels outstanding deadline/retry | Promise race and AbortController standard APIs trusted; health may block forever, reject or ignore abort, bounded here; timing exercised through injected deterministic and real scheduling tests |
| Production `schedule` and returned cancellation | Positive milliseconds, callback; event-loop scheduling | One callback after elapsed delay or no callback after cancellation; cancellation idempotent | Bun `setTimeout` / `clearTimeout` effect owner, real timer lifecycle smoke retained |
| Deadline and retry callbacks | Operation-local resolve/controller state | Settle their wait; deadline requests provider abort | Standard Promise settlement/AbortController; no route/process access and no retained Target mutation |
| Test `scheduleFixture`, `schedule`, cancellation, `advance` | Owned virtual time and task set; explicit increments | Mutates only supplied fixture state; due callbacks once, cancellation deletes pending task | No ambient clock; callbacks execute in due-time order with insertion order for ties; microtasks flushed separately |
| Test `fixture` and effect callbacks | Health callback, temporary RIG_ROOT; test Target | Owned running set, event journal, checkpoint and lifecycle; callbacks expose provider outcomes | RIG_ROOT acquisition is fixture effect ownership; filesystem/process operations are inert fakes at the existing provider boundary |
| Test `flush` | No external state | Allows bounded promise continuations to drain | Promise microtasks only; no wall-clock wait or production implementation inspection |

The body keeps peer lifecycle actions (start, readiness, post-start, route, commit).
Readiness owns probe/retry/deadline policy in one helper. Scheduling owns timer
acquisition/cancellation only. Return channels preserve lifecycle distinctions.
No new schema, storage or provider interface is added. Empty/no-managed and
already-running lifecycle behavior stays covered by existing lifecycle tests;
readiness has a single managed input and no empty-container case. Invalid timeout
is excluded by existing recorded-plan schema validation.

Inherited debt: provider calls outside readiness (prepare, start, hooks, route,
checkpoint and rollback) can still block; this ticket bounds health readiness only.
A provider ignoring cancellation may retain its own work after expiry; lifecycle
cannot terminate arbitrary JavaScript promises. Default production timer ownership
is intentionally local to lifecycle composition, rather than threaded through
runtime layers that never schedule. Real macOS launchd/Caddy were not exercised.

## TDD and verification

1. First public behavior test advanced the controlled deadline during never-settling
   health. Red: failure remained undefined (`0 pass, 1 fail`), proving injected time
   did not control the existing ambient implementation.
2. Added the lifecycle timing seam and raced expiry against health and retry.
   Green: `1 pass, 0 fail`; only the newly started process stopped, its local
   checkpoint rolled back, and late healthy resolution published nothing.
3. Added characterization and boundary coverage for immediate healthy, unhealthy
   then healthy at 100ms, repeated unhealthy, expiry during retry and deadline/retry
   coincidence, original rejection, rejection queued before expiry, provided and
   mismatched checkpoints, and health arriving after deadline in the same turn.

Final validation with `RIG_ROOT=/tmp/rig-84-validation/.rig`:

- `bun test tests/readiness-timing.test.ts tests/runtime-lifecycle.test.ts tests/deployment-effects.test.ts tests/deployment-e2e.test.ts tests/providers-process.test.ts`:
  **52 pass, 0 fail, 207 assertions** (9.92s). Includes the retained real timer smoke,
  real Branch deployment and child-process ownership/restart checks.
- `bun run typecheck`: passed after linking the existing workspace dependencies
  into this isolated worktree (initial missing-dependency diagnostics resolved).
- `git diff --check`: passed.

The initial sandbox focused run had 39 pass and 12 failures caused by blocked
`/bin/ps` and daemon localhost startup. The authorized rerun above passed all
checks. No live Host state, launchd or Caddy was changed. Re-read production
`src/daemon/composition.ts`: it constructs lifecycle once and uses the documented
real-timer default; runtime callers retain the same lifecycle operation interface.
Full suite, compiled entrypoints and independent reviews are reserved for the
supervisor's integration gate.
