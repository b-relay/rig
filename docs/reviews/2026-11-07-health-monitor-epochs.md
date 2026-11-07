# Health monitor epochs

How the health monitor keeps a stale observation out of what it caches and records. This was the long comment at the top of `src/runtime/health-monitor.ts` until #439 split the monitor: the rule spans the runtime, the state store and four modules, so it lives here and each owner keeps a short comment.

## Owners

| Module                              | Owns                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/runtime/health-cache.ts`       | The epochs, `current`, the cached states and policies, the health-restart marks, forgetting               |
| `src/runtime/health-records.ts`     | The writes to state: Activity about a change of health, the end of an unhealthy stretch                   |
| `src/runtime/health-work.ts`        | Jobs in flight, check slots, probe timeouts and aborts, `stop`'s bound                                    |
| `src/runtime/health-monitor.ts`     | Passes, checks and restarts: the effects, using the three above                                           |
| `src/domain/health-policy.ts`       | Pure decisions: what a result means, when a restart is due, what a read of the record means for the cache |
| `src/runtime/health-transitions.ts` | The store wrapper that reports the runtime's writes as transitions                                        |

## The rule

- The epoch is one counter for the whole monitor. It only goes up, so no value is handed out twice.
- A Service's epoch is the later of two marks: its own and its Target's. Each mark is the epoch at the last lifecycle transition of that Service or Target. One with no mark has epoch 0.
- Every lifecycle transition advances the epoch and marks, synchronously, through `invalidate` or `started`. The runtime calls them while it still holds the Target's lock:
  - the lifecycle calls `invalidate(target, service)` as it begins any start (fresh, automatic, health restart or explicit, with or without an unhealthy stretch) or any stop of a Service (down, restart, a rollback, a destroy);
  - it calls `started` once a start passed its start check;
  - the state store (`health-transitions.ts`) calls `invalidate(target)` on every write that changes a Target's plan, desired state, recovery or pending destruction, or removes it, and `invalidate(target, service)` on every write that records another process for a Service.
- Every unit of work (a pass, a check, a restart) takes `since = epoch()` before the state read its writes derive from. Each of its writes for a Service (to the cache, to the policy it caches, to Activity, to the run record) is applied only while `current(target, service, since)` holds. The comparison is synchronous and comes right before the write, with no await between; a state write is compared again inside the store's update, as it is applied.
- Activity about a change of health is written only after the cache write that made the change was applied.
- A Service's own transition drops what was cached about the process it replaced; `started` or the next pass caches anew. A Target's keeps its Services' cache, so a write after a start (its plan or desired state recorded) does not undo what `started` cached.
- `stop` makes every comparison fail.

A Service or Target nothing is known about any more is forgotten, its marks included. That is safe because only a pass forgets, only keys untouched since its own read, with no check or restart in flight and whose Target no Operation holds, and passes run one at a time.

## Where each comparison is made

Each is synchronous with the write it guards. The `tests/health-monitor-interleavings.test.ts` harness injects every lifecycle event at every yield point and checks the invariants these give.

| Where                                                                                                                              | Guards                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `pass`, per Service: `cache.policy(…, since, …)`                                                                                   | Caching the policy; a Service touched since the read is skipped |
| `pass`: `cache.write` of the judged state                                                                                          | The state the read implies, and the paused state while busy     |
| `checkTurn`: `cache.policy` after its own read, slot held                                                                          | Starting the check at all                                       |
| `check`: `cache.write` after a new process or check is seen                                                                        | Starting the count afresh                                       |
| `check`, after the probe: `cache.current` with the cached check and process, then `cache.write` of `recordCheck`, no await between | The result itself                                               |
| `health-records`: `current` before the store write and again inside `update`                                                       | Activity and the end of a stretch                               |
| `act`: `cache.current(…, verdict.since)` after its read, no await until the request                                                | Asking for a restart                                            |
| `act`: `cache.write` after the restart                                                                                             | What a skipped, failed or made restart means for the back-off   |
| `cache.forget`: `current` per key                                                                                                  | Forgetting only what nothing touched since the pass's read      |

## Equivalence when it was split

The split in #438 and #439 changed no behaviour. Besides the existing tests, seeded traces ran the old and new monitor side by side over the same dependencies (state reads and writes, refused writes, process observations, probes that pass, fail, crash or never answer, timeouts, health restarts that are made, fail, are skipped or deferred, and stops), with lifecycle events injected at random yield points. Every dependency call, every report, the results and `retained()` after each step, and the state were compared line by line; the PR gives the counts. The same harness reported differences for each deliberate mutation tried: dropping `act`'s epoch check, dropping the recheck inside the store's update, and adding one await before the result's cache write.

Claude Opus 5.5 (high) on behalf of Brendon
