# Issue 83: bounded Status and Activity observations

## Design and scope

Baseline: ffb460f30af83e17ca1b79fb3da2ac6e0fbed544, including #80's safe
rejection-versus-expiry explanation. Live issue fetch failed because api.github.com
was unavailable; used the supervisor's issue-83.json snapshot (no comments).

Compared two shapes before extracting the shared owner:

- A deadline session with `observe` and `close` would permit incremental jobs,
  but make each caller responsible for the session lifetime and cleanup.
- A finite batch of provider jobs returning ordered tagged results owns the
  complete lifetime, cancellation request, cleanup and common budget. Selected:
  both callers already enumerate finite snapshots, so no incremental session or
  generic scheduler framework is needed.

Before: each caller constructed a timer, controller and per-observation listener,
then collapsed settlement into domain fallbacks. After: `boundedObservations`
accepts jobs, budget and `ObservationDeadline`, returning completed/rejected/expired
results in input order. Status maps results into reports; Activity alone identifies
terminal crashes, hashes event identity and rechecks state before durable writes.
`observeTargets` accepts an optional fourth deadline argument;
`FailureMonitorOptions` accepts `deadline`. Existing call sites retain production
scheduling by default. The timing seam is exercised through these real callers.

The deadline covers provider observations only. Activity reads state before
starting the batch and writes after the batch has released its timer. Store I/O
has no new deadline. Expiry wins if its callback runs before the observation's
settlement handler; an already-settled job keeps its result. Resolving a provider
promise does not synchronously execute its settlement handler. Cancellation is
only a request: noncooperating promises may remain pending after the batch returns.
The owner installs no AbortSignal listeners; it releases its set of unfinished
settlers and cancels its scheduled work on every completion path.

## Contract ledger

| Function | Inputs and outputs | Effects, ownership and failures | Direct callees and trust |
| --- | --- | --- | --- |
| `boundedObservations` | Read-only finite jobs, budget, deadline; ordered tagged result array | Owns controller, pending settlers and timer lifetime. Invokes supplied jobs; inherits their read-only provider I/O and possible indefinite blocking. Synchronous throws and rejection become data; expiry does not await cancellation. Caller must not supply result-mutating jobs. | Deadline contract requires asynchronous, nonthrowing schedule/cancel; production adapter tested by timer integration. Promise/Set/AbortController are platform primitives. Jobs untrusted, covered through caller rejection/expiry tests. |
| `timerObservationDeadline.schedule` and returned cancel | Budget/callback; cleanup callable | Explicit production effect owner for platform setTimeout/clearTimeout; callback released by cancellation. | Bun timer primitives trusted through production integration check. |
| `observeTargets` and observation/report callbacks | Targets, observation providers, budget/deadline; owned report array | Reads snapshot values; no state writes. Per-component provider rejection yields safe unknown failure text, expiry distinct safe text. Callbacks may finish late but cannot mutate returned reports. | Shared batch trusted through public caller tests. Provider contracts remain read-only/cancellable observations; aggregate is existing pure policy. |
| `monitorRuntimeFailures` and observation/update callbacks | Store, process provider, timestamp callable, budget/deadline; recorded count and Activity writes | Reads snapshot, observes, then conditionally writes. Store failures propagate; observation failures are ignored for crash policy. Caller serialization and atomic store update remain prerequisites. | StateStore contract and existing crash tests trusted; SHA-256/JSON deterministic primitives. `now` retains caller effects. Shared batch tested through real monitor. |
| Controlled deadline test adapter | Explicit budget/callback; pending state and expiry control | Owns callback until cleanup. No ambient time. | Used only at production consumers' timing seam. |

Pure mapping/aggregation operates on ordinary and empty arrays, preserves ordering
and evidence, and cannot reject external input independently; provider failures
are handled by settlement. There are no new user-input schemas or tagged thrown
errors: provider rejection remains structured internal data, deliberately absent
from user reports.

Inherited debt: provider implementations can read external state and retain their
own cancellation listeners; the batch cannot force termination or clean a
provider's resources. Existing runtime callers select the production default;
readiness timing and broad runtime-dependency reshaping are outside #83.

## TDD evidence

- First controlled Status test failed with expected `[123]` versus actual `[]`
  because the old caller ignored the injected deadline. Existing six tests passed.
- Shared owner plus Status integration made all seven Status tests pass.
- First controlled Activity test failed with expected `[77]` versus actual `[]`
  because Activity still owned its timer. Existing three tests passed.
- Activity integration made both focused files pass (11 tests).
- Initial typecheck lacked worktree dependencies; linking the checkout's existing
  node_modules restored strict `bun run typecheck` with zero diagnostics.

Final validation and independent review are recorded below when complete.

## Final implementation verification

- `RIG_ROOT=/tmp/rig-issue-83-tests.rig bun test tests/runtime-status.test.ts tests/activity-crashes.test.ts tests/runtime-application.test.ts tests/project-registration.test.ts tests/runtime-review-regressions.test.ts`: **57 pass, 0 fail, 211 assertions**.
- `bun run typecheck`: pass, zero diagnostics.
- `git diff --check`: pass.
- Controlled coverage: multi-Target common expiry and cancellation propagation;
  completed/rejected/empty cleanup; expiry before queued completion; completed
  sibling retained while health remains pending; late Status resolution; late
  Activity resolution/rejection; duplicate evidence; racing desired state,
  recovery and generation; no store I/O budget. Retained one production timer
  integration check. Replaced redundant wall-time Activity timeout assertions
  with controlled caller coverage; route retention timeout is also controlled.
- Re-read real Status consumers in application, project-status, registration and
  doctor, plus serialized monitor invocation in daemon composition. Existing
  defaults remain compatible and Activity still runs under `runtime.exclusive`.
- Full suite, compiled entrypoints and independent reviews are the supervisor's
  subsequent gates; intentionally not run by this implementation worker. No live
  launchd, Caddy or production Target validation was attempted.
