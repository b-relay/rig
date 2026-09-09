# Issue #80: observation failure explanations

Scope: preserve unknown state and the shared observation budget, while distinguishing
rejected observations from deadline expiry. No scheduler or provider-contract redesign.

## Contract ledger

- Caller job: Project status, doctor, registration guards, and application inventory
  consume `observeTargets(targets, observations)` reports. Their call shape stays unchanged.
- Inputs: recorded Targets, caller-supplied read-only observation effects, and budget
  (default 2,000 ms). `withinDeadline` borrows the request's abort controller and accepts
  the pending work plus explicitly named deadline/failure fallback values.
- Outputs/effects: reports retain source, route, and port metadata; provider effects
  receive an AbortSignal. Rejection produces unknown with `Observation failed.`;
  deadline expiry produces unknown with the existing deadline explanation. Exception
  payloads never enter these fallbacks. No Target mutation, logging, or runtime writes.
- Ambient access: existing request-owned timer and AbortController remain in
  `observeTargets`. Provider reads/blocking/failures remain behind ObservationEffects.
  Scheduler injection/redesign belongs to the later simplification scope (#83).
- Prerequisites/lifetime: observations are started concurrently under one request
  deadline; listeners detach after completion/abort and the request clears its timer.
- Failure owner: status chooses user-facing fallback policy; `withinDeadline` selects
  the failure value for rejection and the deadline value for abort. Both retain unknown.
- Direct callees: supplied process/health/artifact/persistent effects are external
  read-only boundaries covered through test substitutes. Promise/timer/abort primitives
  are trusted platform operations; aggregate's established state rules are unchanged.
- Exactness/depth: named fallback fields avoid positional ambiguity; the caller owns
  explanation vocabulary and the wrapper owns deadline mechanics. No duplicate scheduler.
- Verification boundary: public `observeTargets` output. Existing cases cover successful
  observations, partial health failure, crashes/stops, installed capabilities, metadata,
  and hung concurrent probes. Added immediate rejection includes a secret-like payload.
  Empty input and invalid internal Target shapes are unchanged, outside this repair.

## Red/green evidence

1. Added immediate-rejection regression first: focused suite yielded 5 pass / 1 fail,
   showing the existing deadline reason in place of the expected failure reason.
2. Split fallback selection and strengthened the unresponsive-probe test to require
   deadline wording: `RIG_ROOT=/tmp/rig-80-test-root bun test tests/runtime-status.test.ts`
   yielded 6 pass / 0 fail (12 assertions).
3. Installed locked worktree dependencies; `RIG_ROOT=/tmp/rig-80-test-root bun run typecheck`
   passed. Initial typecheck had missing dependency errors before installation.
4. `git diff --check` passed. Full suite/build and exactly two independent review axes
   are reserved for the supervisor's subsequent gates; not claimed here.

No real Rig state or live provider processes were accessed. The existing deadline does
not forcibly terminate adapters that ignore cancellation; that behavior is unchanged.
