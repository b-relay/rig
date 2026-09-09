# Issue #91 — process-stop inspection

Base: `6e0e53ce00f7df10e95904fa49292cab4b4d4cc9`.
Public seams: `Supervisor.stop` / `observe` / `ensureRunning`, with the concrete
process-inspection adapter receiving controlled OS signal and command effects.
The existing user authorization covers these provider/lifecycle test seams.

## Design and before/after

Before, the supervisor accepted an identity reader, but its module-level stop
helpers called `process.kill` and `runCommand` directly. Substituting identity
could not reproduce permission-denied delivery or the fallback presence probe.

Compared two shapes:

1. Add `kill` and `run` separately to supervisor options and keep fallback policy
   inside the supervisor. This makes the tests possible but leaves OS command
   details beside restart, capture, and lease coordination.
2. A `ProcessInspection` with identity, group presence, and group signaling; its
   concrete factory alone accepts the OS signal function and command runner.
   This contains permission fallback, PID-row validation, and signal failures in
   one adapter without forwarding runners through runtime callers. Chosen.

`ChildSupervisorOptions.processInspection` replaces its unused identity-only
`inspect` option. Launchd's separate identity reader remains unchanged. Production
composition and capture wrappers keep using the default adapter. The process
adapter reuses the existing identity reader and preserves `/bin/ps -g PID -o
pid=` with a 2-second timeout, plus identity command locale/timezone policy.

Fallback presence now requires every stdout row to be a positive decimal PID and
stderr to be empty. Empty success, mixed malformed rows, failed commands, rejected
commands, and diagnostic-bearing results reject with `PROCESS_INSPECT`. EPERM
signal delivery to a confirmed present group rejects with `PROCESS_SIGNAL`;
permission-denied probes after successful delivery continue normal escalation.
Only exit 1 with empty stdout/stderr proves fallback absence.

A regression also showed `owned.stopped` (restart suppression intent) made
`observe` assert absence after failed escalation. Observation now uses child exit
or fresh identity evidence. Restart cancellation still uses the intent flag.

## Function contracts and effects

| Function | Inputs and result | Mutation, effects, failure, ownership and trust |
| --- | --- | --- |
| `createProcessInspection` | Optional OS signal operation and bounded command runner; returns retained inspection capabilities | Adapter owns default OS effects, retains supplied functions. Direct callees: existing identity reader verified by recovery smoke; command runner retains bounded timeout/capture/cancellation behavior. |
| `groupExists` | Group leader PID; materialized boolean | Calls signal 0; ESRCH is absent, success present; EPERM runs bounded ps. Validates external PID rows with Zod. Ambiguous/failed fallback rejects `PROCESS_INSPECT`; unexpected non-EPERM probe errors retain existing propagation. No state writes or destructive signals. |
| `signalGroup` | Group leader PID and named signal; void on delivered signal or proven absence | Sends negative-PID group signal. ESRCH/EPERM-proven absence are accepted; otherwise `PROCESS_SIGNAL`, or inspection error if absence is uncertain. Caller owns identity proof; adapter owns signal/fallback translation. |
| supervisor `stop` | Ownership key plus retained process map/options; stopped or unchanged | Serialized per key. Cancels scheduled restart; recovers validated lease; observes current state; marks restart suppression; freshly checks identity before recovered-PID signaling. TERM then polls every 20ms for configured timeout (default 1500ms, capture 4000ms); KILL then polls for 1500ms. Each EPERM inspection may itself take up to 2000ms, so deadlines are not a strict total wall-clock bound. Awaits owned pipe drains, then queued file writes, before removing lease and capture request. Unknown ownership, uncertain inspection, refused signals or timeout reject before cleanup. Retains receiver ownership state for retries. |
| supervisor `observe` | Key and optional abort signal; materialized process observation | Reads recovered lease and current OS identity/presence; may populate owned map during recovery. Stop intent is never proof of exit. Inspection failure becomes unknown. Child presence still uses its existing direct positive-PID probe; group fallback belongs only to stop. |

Direct callers reread: runtime lifecycle down still aggregates failures into
`STOP_INCOMPLETE`, keeps conservative pre-stop hooks and applies post-stop hooks
only after successful changed stops. `ensureRunning`, shutdown, production
composition, and captured-process shutdown retain their existing contracts.

Inherited debt deliberately retained: direct-child observations use OS signal 0;
wall clock/sleep and filesystem effects remain supervisor-owned; output write
errors are recorded on the owned process under existing capture semantics;
recovered supervisors cannot await another daemon's in-memory drains. A capture
wrapper's graceful stop drains its own application before it exits. This change
does not redesign capture status sidecar retention, restart policy, launchd, or
PID/birth-time identity resolution.

## TDD and verification

- Red 1: public stop EPERM/absence test failed because inspection seam did not
  exist; extracted adapter made it green.
- Red 2: malformed `424242 unexpected` was incorrectly accepted as presence,
  producing `PROCESS_SIGNAL` instead of `PROCESS_INSPECT`; complete-row
  validation made it green.
- Red 3: failed TERM/KILL escalation rejected `STOP_TIMEOUT`, but subsequent
  observation falsely returned stopped; evidence-based observation made it green.
- Controlled stop matrix: successful signal probe, ESRCH without fallback, EPERM
  absence, EPERM presence, malformed/mixed/empty/diagnostic-bearing results,
  command exit failure/rejection, signal refusal, unsuccessful escalation,
  recovery identity mismatch on initial and final pre-signal checks, repeated stop,
  exact command policy, cleanup success and lease preservation on failure.
- Real owned-process coverage: live child, shell descendants, recovered matching
  and mismatched leases, captured processes surviving daemon replacement,
  pending restart cancellation, direct and wrapped delayed final stdout/stderr
  draining before lease/capture-request cleanup, repeated stop, and verified PID
  exit. Only run-owned processes are started or signaled.
- EPERM itself is verified through controlled adapter inputs, not privileged
  manipulation of real unrelated processes. Real smoke uses ordinary owned
  children and the default production adapter.
- Focused validation: isolated `RIG_ROOT=/tmp/rig-issue-91-focused.rig`,
  `bun test tests/providers-process-stop.test.ts tests/providers-process.test.ts
  tests/runtime-lifecycle.test.ts`: 41 passed, 0 failed, 149 assertions. Strict `bunx tsc --noEmit` passed
  after frozen-lockfile dependency installation in the worktree.
- Full suite, compiled entrypoints, and two independent reviews are the parent
  supervisor's final gate; no full-gate claim is made here.

## Final-gate follow-up: inherited launchd terminal-observation race

The parent gate at `040c7532e297ffa323839a411f06fc115a58e2fb` reported
327 passed / 1 failed: launchd public-status coverage expected two failed
components but observed two unknown components immediately after a terminal child
snapshot. Failed-gate evidence is retained by the supervisor under
`/tmp/rig-supervisor-20260909/gate-91-failed-1`.

Focused original launchd tests passed (2 tests, 23 assertions). A controlled
replay then made the exact failure deterministic: return a launchctl PID snapshot
for the real wrapper, wait for that wrapper's actual exit before its real identity
lookup, and observe public status. This yields unknown because ownership can no
longer be verified. The same replay failed identically after temporarily restoring
`child-supervisor.ts` from exact base `6e0e53ce00f7df10e95904fa49292cab4b4d4cc9`;
the current source was restored immediately afterward.

Ranked hypotheses were (1) wrapper exit between PID snapshot and identity lookup,
(2) changed stop timing from #91, and (3) stale capture evidence. The deterministic
identity/exit barrier establishes (1), and the exact-base comparison rules out a
new #91 requirement for the failure. The captured terminal child observation does
not synchronize wrapper process exit. There is no production failure here:
unknown correctly preserves uncertainty across the independent OS observations.

The smallest correction is test-only: explicitly verify this transient unknown
through the existing controlled launchctl seam and real identity reader, then
await wrapper exit before asserting final failed status from launchctl's exit
record. No capture freshness, identity, or production observation rule changes.
The test's injected identity function only waits for its owned wrapper exit, then
uses the unchanged production reader; all process cleanup remains run-owned.

Red: replay on current and exact-base supervisor both produced the original
failed-versus-unknown assertion. Green: focused launchd coverage passed with 2 tests
and 24 assertions; strict TypeScript and diff whitespace checks passed. Three
additional focused repetitions all passed (2 tests / 24 assertions each); the full
suite remains the parent's gate. The temporary baseline substitution and replay
expectation were removed; the intentional race coverage remains in the test.
