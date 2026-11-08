# Lifecycle split

How `createTargetLifecycle` is put together since #435 split `src/runtime/lifecycle.ts`, the rules each phase keeps, and the evidence that the split changed no behaviour. `lifecycle.ts` keeps the contracts (`TargetEffects`, `TargetLifecycle`, the journals, `StopControl`), `withStops`, and the one composition point: it builds each owner below and hands every `TargetLifecycle` method to its owner.

## Owners

| Module                    | Owns                                                                                                                                                                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build-preparation.ts`    | `prepare` and the build evidence it journals, the build process a daemon that died left behind (`observePreparation`, `stopPreparation`, `preparationProcessKey`), and a deploy's checks before anything stops (`environmentDigest`, `checkFirstBuild`, `checkEnvironmentValues`, `assertServiceEnvironments`) |
| `preparation-evidence.ts` | What recorded build outcomes allow: `assertPrepared`, `assertBuildsKnown`, `assertSourceBuildsKnown`, `uncertainAttempt`, and the wording they share. Pure.                                                                                                                                                    |
| `service-activation.ts`   | `up` and `recover`: each start's approval, spawn, readiness, publication, and the rollback of a failed start                                                                                                                                                                                                   |
| `service-readiness.ts`    | Every readiness decision: a Service's check, its survival without one, what it listens on (`ownedListeners`, `ownedRoutedPorts`, `loopbackAddress`), and whether it still runs as the process that was verified                                                                                                |
| `target-stops.ts`         | Stopping: `down`, `stop`, `withhold`, `withholdPorts`, and the one Service stop (grace, kill, detach, observers) every other phase uses                                                                                                                                                                        |
| `target-retirement.ts`    | `retire` and its rollback, and `withdrawRoutes` and its restoration                                                                                                                                                                                                                                            |
| `job-processes.ts`        | `startJob`, `observeJob`, `stopJob`, `jobProcessKey`                                                                                                                                                                                                                                                           |
| `guarded-effects.ts`      | The effects an Operation acts through: inside its route guard's exclusive section when it has one                                                                                                                                                                                                              |
| `plan-services.ts`        | The plan queries the phases share: Services, routed ports, process keys, dependents, and observing the managed Services before a start                                                                                                                                                                         |

The owners depend on each other in one direction: preparation, then stops (which stop the preparation process last), then activation (whose failed start stops through the stops owner), then retirement (whose rollback starts the Target again through activation). Jobs depend on none of them.

## What the split keeps

- Every body was moved, not rewritten. The two lookups that repeated `managedComponent` (in `stop` and `recover`) now call it; it throws the same SERVICE_UNKNOWN synchronously at the same point.
- Each `TargetLifecycle` method hands its call to its owner with a plain arrow, so a call passes through no more async frames than before, and every effect is awaited in the same order.
- A failed `up` withholds what it started, stops it in reverse start order, then rolls back its own checkpoint. A failed `recover` withholds and stops its one Service outside the route guard, as before.
- A retirement's rollback restores the checkpoint, then starts the Target with no stop control when it is meant to run. A detached stop leaves both as a crash would.
- `withdrawRoutes` publishes the withdrawn routes again in the order it withdrew them.

## Equivalence when it was split

Besides the existing tests, a harness ran the old `createTargetLifecycle` (from `origin/main` at `aac7d381`) and the new one over the same seeded scenarios with fake effects. Every effect call was deferred to a seeded scheduler that settles one call per turn of the event loop, on a virtual clock for readiness timing. The scenarios covered `up` (with and without a checkpoint, and with another Target's), `down` with and without a following start, `restart`, `recover`, `stop`, `retire`, `prepare`, `withdrawRoutes` and its restore, job start, observe and stop, the preparation process, and the route and effect-transaction calls, directly and through `withStops`. They injected failures of any effect call, readiness that never answers or never passes, listeners bound beyond loopback or unknown, processes that exit or are replaced by someone else's restart, kills, detaches, and failures the route guard latches.

The harness recorded every effect call with its arguments and its result or failure, every timer scheduled, fired and cancelled, every observer, guard, journal and kill call, each operation's reply or error with its code, message, hint, details and causes, and the final processes and routes. The PR gives the counts and the deliberate mutations it caught.
