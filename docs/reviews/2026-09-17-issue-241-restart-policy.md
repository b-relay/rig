# Issue #241 run notes — runtime-owned restart policy

Branch `feat/issue-241-restart-policy`, PR against `feat/issue-114-config-cutover`.
No runtime was installed and no live daemon, job, route or data was touched; every
test runs in a temporary `RIG_ROOT`.

## What changed

- `restart: always | on-failure | no` is runnable. `resolveTargetPlan` records the
  policy on each managed component (`always` when unset) instead of refusing the
  other two as `unsupported_setting`.
- Supervisors no longer respawn anything. `ManagedProcess.keepAlive`, the child
  supervisor's `restartLimit`/`restartWindowMs`/`restartBackoffMs`, the wrapper's
  restart loop, launchd `KeepAlive`, and the `restartPending`/`restartAt`
  observation fields are gone. A start carries an `incarnation`; whoever holds
  the application's child handle (the child supervisor, or the capture wrapper's
  inner one) writes `<root>/process-exits/<sha256(key)>.json` when it ends, and a
  stopped observation carries `incarnation` + `exitCode`/`signal` only from that
  record.
- The runtime owns the decision (`src/runtime/supervision.ts`). Per Target it
  keeps `services[name] = { deployment, intent, incarnation, attempts, outcome,
  retryAt, exhausted }`. `runtime.reconcile()` (first pass) and the new
  `runtime.supervise()` (every second, plus a timer for the `nextRetryAt` a pass
  returns) run inside the runtime queue, record each exit once with Activity, and
  start an eligible Service again through the new `lifecycle.recover(target,
  service, journal)`, which starts that one Service under the same prepare /
  readiness / route steps as `up` and rolls its own start back on failure.
- `lifecycle.up` and `recover` take an `ActivationJournal`: `starting(service)`
  is saved before the process is spawned and returns its incarnation;
  `activated(service, incarnation)` is called after readiness and before hooks /
  route publication. It is a no-op here and is the transition #242 gates on.
- Status derives `exit: clean | failed | requested | unknown`, `signal`, and a
  reason naming the policy and `rig up`, from the record and the live observation
  without writing anything. A scheduled retry reads as `starting`.
- `monitorRuntimeFailures` is replaced by the supervision pass; the daemon's
  monitor loop now runs `runtime.supervise()`.

## Decisions

**Shape comparison (provider contract).**
A, chosen: passive supervisors + durable exit evidence; the runtime decides and
starts. B, rejected: the provider keeps respawning and asks the runtime for
approval through a callback. B needs an IPC path from the launchd capture wrapper
back into `rigd`, cannot gate a route while `rigd` is down, and keeps two owners
of budget and backoff (the wrapper's memory and the runtime's record). The spec
(plans/114-config-spec.md, Q23) says restart implemented purely inside an adapter
without coordinating readiness/routing is insufficient. A's cost: nothing restarts
while `rigd` is down. That matches the spec's unknown-outcome rule after a reboot
and is documented in the guide.

**Evidence is keyed by incarnation and Deployment.** A record whose `deployment`
is not the plan's `workspacePath`, or an exit record whose incarnation is not the
one the runtime last saved, proves nothing: the outcome is `unknown`, which no
policy retries. A stale record is also removed before every spawn.

**Record before acting.** `starting` is persisted before the spawn; an exit is
persisted (with its Activity) before a retry is scheduled; `retryAt` and
`exhausted` are persisted before they are honoured. A store failure ends that
Service's pass, so no retry happens without its prerequisite evidence.

**Service records are written on their own.** `saveRun` updates only
`services[name]` of the stored Target. A rollback that restarts the previous
Deployment while the stored record still holds the candidate's pending `recovery`
therefore cannot clear it. Targets with `recovery` or `destructionPending` are
skipped by both passes.

**Every failed automatic attempt spends budget**, including one `recover`
refuses before spawning (`SERVICE_DEPENDENCY`). Otherwise a dependent of a
stopped `no` Service would be asked again every second forever; now it ends
`exhausted` with the cause in Activity and status.

**Budget.** 5 attempts per rolling 60 s, delay `100 ms × 2^n` from the recorded
exit. `exhausted` is sticky until an explicit start (`up` of a stopped Service,
`restart`, a deployment) begins a new activation with `attempts: []`. An `up`
that finds the Service running never calls `starting`, so it resets nothing.

**Stop intent.** `down`, `restart`'s stop half, failed-deploy stops and Preview
destruction set every record's `intent: "stopped"` and drop `retryAt` in the same
write that sets `desired: "stopped"`, before anything is signalled. A later pass
at the old due time finds the intent and returns.

**`stop()` and exit records.** Child `stop` removes the record only when the
process was running when stop was asked; an exit that came first stays readable.
That is what lets the capture wrapper's own cleanup (`shutdown → stop`) leave its
application's exit for `rigd`/launchd to read. launchd `stop` always removes it.

**Not changed (scope).** The capture request file and launchd plist still hold
the start's environment (0600), as before this ticket; every start, automatic
included, asks `effects.environment` again, so env files are read fresh.
`plan.daemon.keepAlive` remains in the state and migration schemas and is
ignored.

## Function-design ledger (findings only)

| Function | Finding | Resolution |
| --- | --- | --- |
| `createChildSupervisor` | Hidden policy: timers, budget and restart state in provider memory, invisible to the runtime and lost with the process. | Removed; the supervisor's observable channels are now process + lease + exit record. |
| `launchd observe` | Reported launchd's `last exit code`, which under capture is the wrapper's and names no start. | Reports only the wrapper-written exit record. |
| `superviseTarget` / `superviseService` | Effects: store, lifecycle, observation, clock, id, diagnostic: all parameters (`Deps`). Observation is bounded by the status budget so a hung provider cannot hold the runtime queue. Failure owner: the pass; errors become diagnostics, never raised to the daemon loop. | — |
| `saveRun` | Mutates caller-owned `target.services`; reverted when the store refuses so memory never claims more than disk. | Stated in its contract. |
| `activationJournal` | `explicit` vs `automatic` decides budget accounting; one owner for both `up` and `recover`. `failed` is only meaningful for explicit starts (`start-failed`, never retried). | — |
| `stoppedStanding` | Pure; status stays read-only. Needs no clock (`at` is unused when deriving). | — |
| `startFailureMonitor` | Reads `Date.now()` for the `nextRetryAt` timer; it is the daemon's timing effect owner already (`setInterval`). | Kept; covered by a timing test. |
| `lifecycle.recover` | Duplicates no start policy: shares `startService` with `up`. Rollback owner for its own start. | — |

Inherited debt named, not changed: the outer child supervisor in capture mode
reports `running` while the wrapper lives, whatever the application does.

## Evidence

- First red: `tests/restart-policy.test.ts` "after a daemon restart…" failed with
  `unsupported_setting` for `restart: on-failure`; green once the plan carried the
  policy and the reopened runtime's `reconcile()` returned `nextRetryAt` and the
  following `supervise()` started only the eligible Service.
- `tests/restart-policy.test.ts` (15): policy table for zero / nonzero / signal
  exits, stale incarnation, daemon reopen, survivor adoption, exhaustion with
  delays 100–1600 ms surviving reopen, explicit reset, unchanged `up`, repeated
  `down`, cancelled retry at its old due time, failed evidence write, activation
  failure, failed explicit `up`, pending recovery, dependency down, and a real
  child-process recovery through the runtime.
- `tests/providers-exit-contract.test.ts` (14): the same seven cases against the
  child supervisor (real processes) and the launchd supervisor (scripted
  `launchctl`, real exit-record and capture files).
- `tests/providers-launchd.test.ts`: a real launchd job under the real capture
  wrapper exits 7, is observed `{stopped, exitCode 7, incarnation}`, stays
  stopped, and the next `ensureRunning` recovers it. Labels are
  `test.rig.<uuid>` and are booted out in `finally`.
- Tests that pinned superseded behaviour were rewritten, not deleted, except the
  three provider-budget/timer tests whose subject no longer exists
  (`providers-process-timing`, `providers-process`). `runtime-status` now pins
  that an exit code without a matching recorded start is `exit: unknown`.
  `deployment-effects` "final inventory failure" no longer counts store writes.
  `activity-e2e` uses `restart: "no"` so one crash is one Activity entry.
- `bun run typecheck`, `bun run build`: clean. Full `bun test`: see the PR body.

## Handoff

- **#242** consumes `ActivationJournal.activated(service, incarnation)` (called
  after readiness, before postStart and `effects.route`) for listener inspection
  in both `up` and `recover`; automatic recovery already goes through it.
  The "Service without ports" refusal is still in `resolve.ts`.
- **#244** migrated Targets have no `services` records, so a migrated Service
  that is not running reads `exit: unknown` and needs `rig up`; a running one is
  adopted. `daemon.keepAlive` is ignored. Leases written before this change have
  no `incarnation` and are still adopted.
- **#245** gate: both providers' real-process smokes live in
  `tests/providers-exit-contract.test.ts` and `tests/restart-policy.test.ts`.
