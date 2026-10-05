import type { ManagedComponent } from "../config/types";
import { recordActivity } from "../domain/activity";
import { diagnosticErrorCode, failureReason } from "../domain/errors";
import {
  NEW_HEALTH,
  healthAction,
  healthRestartDueAt,
  isUnhealthy,
  nextCheckAt,
  recordCheck,
  restarted,
  type HealthAction,
  type HealthPolicy,
  type HealthState,
} from "../domain/health-policy";
import type { ServiceHealth } from "../domain/project-status";
import type {
  OperationRecord,
  ServiceRun,
  StateStore,
  TargetRecord,
} from "../domain/runtime";
import type { RuntimeDependencies } from "./contracts";
import type { ObservationEffects } from "./status";
import { currentRun } from "./supervision";

/* The epoch rule: how the monitor keeps a stale observation out of what it caches and records.
 *
 * - `clock` is one counter for the whole monitor. It only goes up, so no value is ever handed out twice.
 * - A Service's epoch is the later of two marks: its own and its Target's. Each mark is the clock value at the last
 *   lifecycle transition of that Service or Target. A Service or Target with no mark has epoch 0.
 * - Every lifecycle transition advances the clock and marks, synchronously, through `invalidate` or `started`. The runtime
 *   calls them while it still holds the Target's lock:
 *   - the lifecycle calls `invalidate(target, service)` as it begins any start (fresh, automatic, health restart or
 *     explicit, with or without an unhealthy stretch) or any stop of a Service (down, restart, a rollback, a destroy);
 *   - it calls `started` once a start passed its start check;
 *   - the runtime's state store calls `invalidate(target)` on every write that changes a Target's plan, desired state,
 *     recovery or pending destruction, or removes it, and `invalidate(target, service)` on every write that records
 *     another process for a Service (see `src/runtime/health-transitions.ts`).
 * - Every unit of work (a pass, a check, a restart) takes `since = clock` BEFORE the state read its writes derive from.
 *   Each of its writes for a Service (to the cache, to the policy it caches, to Activity, to the run record) is applied
 *   only while that Service's epoch is still at most `since`. The comparison is synchronous and comes right before the
 *   write, with no await between; a state write is compared again inside the store's update, as it is applied.
 * - Activity about a change of health is written only after the cache write that made the change was applied.
 * - A Service's own transition drops what was cached about the process it replaced; `started` or the next pass caches
 *   anew.
 * - `stop` makes every comparison fail.
 *
 * A Service or Target nothing is known about any more is forgotten, its marks included. That is safe because only a pass
 * forgets, only keys untouched since its own read and with no check or restart in flight, and passes run one at a time. */
/** How many ongoing checks run at once across the Host. */
export const HEALTH_CHECK_CONCURRENCY = 4;
/** How often rigd looks for checks that are due; a check runs at most this late. */
export const HEALTH_MONITOR_TICK_MS = 1000;
/** How long a stop waits for the checks and restarts in flight to settle once their probes were aborted. */
export const HEALTH_MONITOR_STOP_MS = 5000;

/** Reads the cached result of a Service's ongoing checks; undefined when rigd has none. */
export type HealthResults = (
  target: Pick<TargetRecord, "id">,
  service: string,
) => ServiceHealth | undefined;

/** How a health restart ended: done, or tried and failed, at the time it was attempted, which the back-off counts from and
 * the Service's record holds; skipped because the process that was judged is gone or was replaced; or deferred because
 * nothing could be established about it, so it is asked again. */
export type HealthRestartResult =
  | { outcome: "restarted" | "failed"; at: number }
  | { outcome: "skipped" | "deferred" };
/** A health restart rigd is asked for: which Service, and what the checks saw. */
export interface HealthRestartRequest {
  targetId: string;
  service: string;
  /** The process the checks judged; a Service running another one by now is left alone. */
  incarnation?: string;
  /** The check that judged it (`checkIdentity`); a Service whose recorded plan checks it another way by now is left alone. */
  check: string;
  /** The process is stopped because the last health restart's start failed its start check: start it, there is nothing to
   * stop. The record must still say so (`healthStretch.pendingStart`) and name `incarnation`. */
  start?: true;
  /** The restart's number in this unhealthy stretch, from 1. */
  attempt: number;
  failures: number;
  output?: string;
  /** When the stretch began, and the earlier restarts in it (Unix milliseconds). */
  since: number;
  restarts: readonly number[];
}
export interface HealthMonitorDependencies {
  store: Pick<StateStore, "read" | "update">;
  observations: Pick<ObservationEffects, "process" | "health">;
  /** Unix milliseconds. */
  now(): number;
  id(): string;
  /** Whether an Operation holds or waits for the Target, so one of its Services may be starting or stopping. */
  busy(target: TargetRecord): boolean;
  /** Stops and starts one Service through the normal stop path, under its Target's lock; says how that ended. */
  restart(request: HealthRestartRequest): Promise<HealthRestartResult>;
  /** Calls `fire` once after `delayMs`; returns the cancellation. A test passes a fake clock's. */
  schedule(delayMs: number, fire: () => void): () => void;
  diagnostic: RuntimeDependencies["diagnostic"];
  /** Checks that may run at once across the Host; HEALTH_CHECK_CONCURRENCY when absent. */
  concurrency?: number;
}
export interface HealthMonitor {
  /** Starts every check that is due, and every restart the policies call for, then returns without waiting for them. */
  pass(): Promise<void>;
  /** Resolves once every check and restart started so far has settled. */
  idle(): Promise<void>;
  /** A start of the Service passed its start check, the healthcheck's first passing check: a lifecycle transition (see
   * the epoch rule), whose result is cached as the newest thing known. It is healthy as of now and next checked one
   * interval later, unless it carries an unhealthy stretch on (an automatic or health restart), in which case it stays
   * unhealthy until an ongoing check passes, so its back-off holds. */
  started(target: TargetRecord, service: string, incarnation: string): void;
  /** A lifecycle transition of one Service, or with no Service of the whole Target: anything a pass, check or restart
   * read before it is not applied (see the epoch rule). The runtime calls it, while it holds the Target, as a start or stop
   * begins and on every state write that changes a Target's plan, desired state, recovery or destruction, removes it, or
   * records another process for a Service. */
  invalidate(targetId: string, service?: string): void;
  /** How many entries the monitor keeps: cached results, policies and epoch marks. Zero once nothing is monitored. */
  retained(): number;
  /** Ends the monitor: no pass starts anything after it, every probe in flight is aborted (a command probe's process group
   * is killed), nothing is written to state any more, and it resolves once the work in flight settled or `boundMs`
   * (HEALTH_MONITOR_STOP_MS when absent) passed, whichever comes first. */
  stop(boundMs?: number): Promise<void>;
  results: HealthResults;
}

/** The Service's ongoing check policy, from its recorded plan; undefined for a Service without a healthcheck, including
 * every plan recorded before healthcheck, whose `health` only gates start. */
export function healthPolicy(
  component: ManagedComponent,
): HealthPolicy | undefined {
  const check = component.healthcheck;
  if (!check) return undefined;
  return {
    intervalMs: check.interval * 1000,
    timeoutMs: check.timeout * 1000,
    retries: check.retries,
    onFailure: check.onFailure,
  };
}

/** Whether the Service's record says its last health restart's start failed, so the health monitor starts it again on the
 * back-off. Not once a Host restart stopped it: that keeps a working Target or Preview stopped until rig up, and a stable
 * Target is started by rigd's own start after the restart. */
export function healthStartPending(
  run: ServiceRun | undefined,
): run is ServiceRun & {
  healthStretch: NonNullable<ServiceRun["healthStretch"]>;
} {
  return (
    run?.healthStretch?.pendingStart !== undefined &&
    run.intent === "running" &&
    !(run.outcome?.kind === "unknown" && run.outcome.hostRestart)
  );
}
/** Which check a plan entry runs: its test, its policy, and what a test runs in or connects to. Results, and a restart, are
 * about one such check of one process; a deploy or edit that changes it starts afresh. */
export function checkIdentity(component: ManagedComponent): string {
  return JSON.stringify([
    component.health ?? null,
    component.healthcheck ?? null,
    component.workingDir ?? null,
    component.ports ?? component.port ?? null,
  ]);
}

type Due = Extract<HealthAction, { kind: "restart" }>;
/** A restart the policy calls for, and what it is about: the clock taken before the read it was judged from (see the
 * epoch rule), and the check and process it judged. */
interface Verdict {
  action: Due;
  since: number;
  check: string | undefined;
  incarnation: string | undefined;
  /** The process is stopped because the last health restart's start failed: start it again. */
  start?: true;
}
/** What the policy calls for, except that a process nothing identifies (adopted from a rigd older than incarnations) is
 * never restarted for its checks, since a restart could stop another process started meanwhile: it is checked and
 * reported as with report. */
function actionFor(
  state: HealthState,
  policy: HealthPolicy,
  now: number,
): HealthAction {
  const action = healthAction(state, policy, now);
  return action.kind === "restart" && state.incarnation === undefined
    ? { kind: "none" }
    : action;
}
const isDue = (action: HealthAction): action is Due =>
  action.kind === "restart";

/** rigd's ongoing health checks (ADR 0012). Each pass reads the recorded Targets meant to run and checks each Service that
 * has a healthcheck once it is due. Checks run beside the operation queue, never in it: a pass takes no lock and never
 * waits for an Operation. A Target an Operation holds or waits for may be starting or stopping a Service, so its checks
 * pause, and a process is first checked once Rig sees it running with the Target free, which is after its start check
 * passed; later checks follow at its interval. Checks of one Service never overlap, and at most `concurrency` run across
 * the Host; a check that does not answer within its timeout failed. A Service is unhealthy after `retries` failures in a
 * row and healthy again after one pass; Activity records both. `restart` Services are handed to `restart` as the back-off
 * allows, and a restart holds no check slot while it waits for its Target. Results live in memory; a health restart
 * records the unhealthy stretch on the Service it starts, so a new rigd continues its back-off. */
export function createHealthMonitor(
  deps: HealthMonitorDependencies,
): HealthMonitor {
  const states = new Map<string, HealthState>();
  const policies = new Map<string, HealthPolicy>();
  let clock = 0;
  /** The clock at each Service's last lifecycle transition, by `<target id>:<service>`. */
  const serviceMarks = new Map<string, number>();
  /** The clock at each Target's last lifecycle transition, by Target id. */
  const targetMarks = new Map<string, number>();
  /** Set by `stop`: from then on nothing is observed, started or written. */
  let stopped = false;
  /** The probes in flight, aborted by `stop`. */
  const probes = new Set<AbortController>();
  /** Services with a check or restart in flight, which nothing else of them overlaps. */
  const inFlight = new Set<string>();
  const work = new Set<Promise<void>>();
  const limit = deps.concurrency ?? HEALTH_CHECK_CONCURRENCY;
  let running = 0;
  const waiting: (() => void)[] = [];
  const slot = async () => {
    if (running < limit) running++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const idle = async () => {
    while (work.size) await Promise.allSettled([...work]);
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };
  const keyOf = (targetId: string, service: string) => `${targetId}:${service}`;
  /** Whether a write derived from a read taken at `since` may still be applied for the Service. */
  const current = (targetId: string, service: string, since: number) =>
    !stopped &&
    Math.max(
      serviceMarks.get(keyOf(targetId, service)) ?? 0,
      targetMarks.get(targetId) ?? 0,
    ) <= since;
  /** A transition: the Service's, or with no Service the whole Target's, epoch moves past every unit of work begun so far.
   * A Service's own transition (a start or stop begins, another process is recorded) also drops what was cached about it,
   * which was about what ran before; `started` or the next pass caches anew. A Target's keeps its Services' cache: a write
   * after a start (its plan or desired state recorded) must not undo what `started` cached, and a Target no longer
   * meant to run is forgotten by the next pass. */
  const invalidate = (targetId: string, service?: string) => {
    clock++;
    if (service === undefined) targetMarks.set(targetId, clock);
    else {
      serviceMarks.set(keyOf(targetId, service), clock);
      states.delete(keyOf(targetId, service));
    }
  };
  /** Caches `state` for the Service when the epoch rule allows it; says whether it did. */
  const write = (
    targetId: string,
    service: string,
    since: number,
    state: HealthState,
  ): boolean => {
    if (!current(targetId, service, since)) return false;
    states.set(keyOf(targetId, service), state);
    return true;
  };

  return {
    results(target, service) {
      const key = keyOf(target.id, service);
      const state = states.get(key),
        policy = policies.get(key);
      if (!state || !policy) return undefined;
      return {
        status: isUnhealthy(state)
          ? "unhealthy"
          : state.checkedAt === undefined
            ? "starting"
            : "healthy",
        ...(state.checkedAt !== undefined
          ? { checkedAt: new Date(state.checkedAt).toISOString() }
          : {}),
        failures: state.failures,
        retries: policy.retries,
        // A passing check clears it, so it is the output of a failure since the last pass.
        ...(state.output !== undefined ? { output: state.output } : {}),
        restarts: state.stretch?.restarts.length ?? 0,
      };
    },
    retained: () =>
      states.size + policies.size + serviceMarks.size + targetMarks.size,
    idle,
    invalidate,
    async stop(boundMs = HEALTH_MONITOR_STOP_MS) {
      stopped = true;
      for (const probe of probes) probe.abort();
      let cancel = () => {};
      await Promise.race([
        idle(),
        new Promise<void>((resolve) => {
          cancel = deps.schedule(boundMs, resolve);
        }),
      ]);
      cancel();
    },
    started(target, service, incarnation) {
      if (stopped) return;
      // The start itself is the transition, and what it says is the newest thing known: it is cached unconditionally.
      invalidate(target.id, service);
      const key = keyOf(target.id, service);
      const component = target.plan.components.find(
        (candidate): candidate is ManagedComponent =>
          candidate.kind === "managed" && candidate.name === service,
      );
      const policy = component && healthPolicy(component);
      if (!policy) {
        states.delete(key);
        policies.delete(key);
        return;
      }
      policies.set(key, policy);
      // Its start check passed. A start that carries an unhealthy stretch on (an automatic or health restart) stays
      // unhealthy until an ongoing check passes; any other is healthy as of now.
      const base = seeded(target, service);
      states.set(key, {
        ...base,
        incarnation,
        check: checkIdentity(component),
        eligibleSince: deps.now(),
        ...(base.stretch ? {} : { checkedAt: deps.now(), passed: true }),
      });
    },
    async pass() {
      if (stopped) return;
      const since = clock;
      const recorded = await deps.store.read();
      if (stopped) return;
      const monitored = new Set<string>();
      for (const target of recorded.targets) {
        if (
          target.desired !== "running" ||
          target.recovery ||
          target.destructionPending
        )
          continue;
        for (const component of target.plan.components) {
          if (component.kind !== "managed") continue;
          const policy = healthPolicy(component);
          if (!policy) continue;
          const key = keyOf(target.id, component.name);
          monitored.add(key);
          // Something happened to the Service after this read was taken: what the read says is not about it any more.
          if (!current(target.id, component.name, since)) continue;
          policies.set(key, policy);
          if (inFlight.has(key)) continue;
          const state = judged(target, component, states.get(key));
          // The last health restart's start failed: the Service is stopped and unhealthy, and is started again at the next
          // step of the back-off, whatever its restart policy (automatic restart leaves it alone). Never given up on; an
          // explicit start clears the stretch, and a down leaves the Target meant to stop.
          const run = currentRun(target, component.name);
          if (healthStartPending(run) && policy.onFailure === "restart") {
            write(target.id, component.name, since, state);
            if (deps.busy(target)) continue;
            inFlight.add(key);
            const verdict: Verdict = {
              action: {
                kind: "restart",
                attempt: run.healthStretch.restarts.length + 1,
              },
              since,
              check: checkIdentity(component),
              incarnation: run.incarnation,
              start: true,
            };
            const due = healthRestartDueAt(run.healthStretch);
            const job = (async () => {
              // Await: whether anything runs. A process the record says should be stopped but runs after all (a rollback
              // that could not stop it) is judged by its ongoing checks, as any running process; only a stopped one waits
              // for its next health restart.
              const seen = await withinTimeout(
                (signal) =>
                  deps.observations.process(target, component, signal),
                policy.timeoutMs,
              );
              if (seen !== undefined && "state" in seen) {
                if (seen.state === "running")
                  await checkTurn(target, component);
                else if (seen.state === "stopped" && deps.now() >= due)
                  await act(target.id, component.name, verdict);
              }
            })()
              .catch(async (error: unknown) => {
                await deps
                  .diagnostic({
                    operationId: deps.id(),
                    action: "health",
                    outcome: "failed",
                    target: target.name,
                    errorCode: diagnosticErrorCode(error),
                  })
                  .catch(() => {});
              })
              .finally(() => inFlight.delete(key));
            work.add(job);
            void job.finally(() => work.delete(job));
            continue;
          }
          // Starting or stopping: no check, and the process is first seen afresh once the Target is free.
          if (deps.busy(target)) {
            const { eligibleSince: _paused, ...rest } = state;
            write(target.id, component.name, since, rest);
            continue;
          }
          write(target.id, component.name, since, state);
          const action = actionFor(state, policy, deps.now());
          const due = nextCheckAt(state, policy);
          if (!isDue(action) && due !== undefined && deps.now() < due) continue;
          inFlight.add(key);
          const job = (async () => {
            try {
              // A restart due now is about this read of the process and check this state judged.
              const next: Verdict | undefined = isDue(action)
                ? {
                    action,
                    since,
                    check: state.check,
                    incarnation: state.incarnation,
                  }
                : undefined;
              if (next) await act(target.id, component.name, next);
              else await checkTurn(target, component);
            } catch (error) {
              await deps
                .diagnostic({
                  operationId: deps.id(),
                  action: "health",
                  outcome: "failed",
                  target: target.name,
                  errorCode: diagnosticErrorCode(error),
                })
                .catch(() => {});
            } finally {
              inFlight.delete(key);
            }
          })();
          work.add(job);
          void job.finally(() => work.delete(job));
        }
      }
      // A Service no longer meant to run, or no longer checked, forgets what was known about it, marks included, once
      // nothing touched it after this read and nothing of it is in flight; a Target, once none of its Services is left.
      const targetsKept = new Set<string>();
      for (const key of new Set([
        ...states.keys(),
        ...policies.keys(),
        ...serviceMarks.keys(),
      ])) {
        const split = key.lastIndexOf(":");
        const targetId = key.slice(0, split),
          service = key.slice(split + 1);
        if (
          monitored.has(key) ||
          inFlight.has(key) ||
          !current(targetId, service, since)
        ) {
          targetsKept.add(targetId);
          continue;
        }
        states.delete(key);
        policies.delete(key);
        serviceMarks.delete(key);
      }
      for (const [targetId, mark] of targetMarks)
        if (!targetsKept.has(targetId) && !stopped && mark <= since)
          targetMarks.delete(targetId);
    },
  };

  /** What the cache should hold for a Service after a pass's read: what it held, unless the read names another process
   * or another check, which start afresh from their record; and the unhealthy stretch as the record carries it on, when
   * a health restart counted an attempt there that the cache could not (its restart was itself a transition). */
  function judged(
    target: TargetRecord,
    component: ManagedComponent,
    known: HealthState | undefined,
  ): HealthState {
    const run = currentRun(target, component.name);
    if (
      known === undefined ||
      (known.incarnation !== undefined &&
        run?.incarnation !== undefined &&
        run.incarnation !== known.incarnation) ||
      (known.check !== undefined && known.check !== checkIdentity(component))
    )
      return seeded(target, component.name);
    const record = run?.healthStretch;
    if (!record || run?.incarnation !== known.incarnation) return known;
    // The record counted an attempt the cache could not (its restart was itself a transition); or it says this process's
    // health start failed although it was seen running, a stretch its checks must end before anything forgets it.
    const longer =
      known.stretch &&
      record.since === known.stretch.since &&
      record.restarts.length > known.stretch.restarts.length;
    const unseen = !known.stretch && record.pendingStart !== undefined;
    return longer || unseen
      ? {
          ...known,
          stretch: { since: record.since, restarts: [...record.restarts] },
        }
      : known;
  }

  /** One check of the Service with a probe slot held, and the restart it calls for. The check's own read comes with the
   * slot held: a deploy or restart while it waited is judged by what is recorded now, under the policy it has now. */
  async function checkTurn(
    target: TargetRecord,
    component: ManagedComponent,
  ): Promise<void> {
    let next: Verdict | undefined;
    await slot();
    try {
      const since = clock;
      const now = await checked(target.id, component.name);
      if (now && current(target.id, component.name, since)) {
        policies.set(keyOf(target.id, component.name), now.policy);
        next = await check(now.target, now.component, now.policy, since);
      }
    } finally {
      release();
    }
    if (next) await act(target.id, component.name, next);
  }
  /** The Service's Target, plan entry and policy as recorded now; undefined when the Target is no longer meant to run, the
   * Service is gone, or it has no healthcheck any more, so nothing of it is checked or restarted. */
  async function checked(
    targetId: string,
    service: string,
  ): Promise<
    | {
        target: TargetRecord;
        component: ManagedComponent;
        policy: HealthPolicy;
      }
    | undefined
  > {
    if (stopped) return undefined;
    const target = (await deps.store.read()).targets.find(
      (candidate) => candidate.id === targetId,
    );
    if (
      stopped ||
      !target ||
      target.desired !== "running" ||
      target.recovery ||
      target.destructionPending
    )
      return undefined;
    const component = target.plan.components.find(
      (candidate): candidate is ManagedComponent =>
        candidate.kind === "managed" && candidate.name === service,
    );
    const policy = component && healthPolicy(component);
    return component && policy ? { target, component, policy } : undefined;
  }
  /** Whether the Target is busy, in which case the Service's checks pause until it is free again. */
  function paused(
    target: TargetRecord,
    service: string,
    since: number,
  ): boolean {
    if (!deps.busy(target)) return false;
    const state = states.get(keyOf(target.id, service));
    if (state) {
      const { eligibleSince: _paused, ...rest } = state;
      write(target.id, service, since, rest);
    }
    return true;
  }
  /** The state a process of the Service starts from: nothing known of it, with the unhealthy stretch its record says a
   * health or automatic restart continued. The last output was about another process, and is not kept. */
  function seeded(target: TargetRecord, service: string): HealthState {
    const record = currentRun(target, service)?.healthStretch;
    return record
      ? {
          ...NEW_HEALTH,
          stretch: { since: record.since, restarts: [...record.restarts] },
        }
      : NEW_HEALTH;
  }

  /** The process a Service runs now, as the run record names it (every start records its incarnation before it spawns),
   * confirmed running by an observation. Undefined when it is not running, cannot be observed in time, or the observation
   * names another process, as while a start or stop is between its record and its effect. */
  async function runningProcess(
    target: TargetRecord,
    component: ManagedComponent,
    timeoutMs: number,
  ): Promise<{ identity: string | undefined } | "stopped" | undefined> {
    // The process and the check are read from one snapshot of state, so a check never adopts a process its plan entry
    // does not belong to.
    const recordedNow = async () => {
      const saved = (await deps.store.read()).targets.find(
        (t) => t.id === target.id,
      );
      const entry = saved?.plan.components.find(
        (candidate): candidate is ManagedComponent =>
          candidate.kind === "managed" && candidate.name === component.name,
      );
      return {
        check: entry && checkIdentity(entry),
        incarnation: saved && currentRun(saved, component.name)?.incarnation,
      };
    };
    const snapshot = await recordedNow();
    if (snapshot.check !== checkIdentity(component)) return undefined;
    const recorded = snapshot.incarnation;
    const observed = await withinTimeout(
      (signal) => deps.observations.process(target, component, signal),
      timeoutMs,
    );
    if (observed === undefined || "ready" in observed) return undefined;
    // Only a stopped process is stopped: an unknown one decides nothing, and its count stays.
    if (observed.state === "stopped") return "stopped";
    if (observed.state !== "running") return undefined;
    // The record must name the same process on both sides of the observation, which may be an old snapshot.
    const again = await recordedNow();
    if (
      again.check !== snapshot.check ||
      again.incarnation !== recorded ||
      (recorded !== undefined &&
        observed.incarnation !== undefined &&
        observed.incarnation !== recorded)
    )
      return undefined;
    // A record from before incarnations were kept leaves the observation to say which process it is.
    return { identity: recorded ?? observed.incarnation };
  }

  /** One Service's turn, under the epoch rule with `since` taken before the read `component` came from: find its process,
   * check it once it may be checked, record what changed, and return the restart the result calls for. Each await below
   * (the two process reads around each observation, the run-record read for a new process, the probe) may let a
   * transition through; every write after it is compared with `since` then, so one that came through discards it. */
  async function check(
    target: TargetRecord,
    component: ManagedComponent,
    policy: HealthPolicy,
    since: number,
  ): Promise<Verdict | undefined> {
    const service = component.name;
    const key = keyOf(target.id, service);
    // The Target may have become busy while this waited for a slot: nothing is checked while it starts or stops.
    if (paused(target, service, since)) return undefined;
    // Await: the process, with the check it belongs to, from one snapshot of state.
    const before = await runningProcess(target, component, policy.timeoutMs);
    if (before === undefined) return undefined;
    let state = states.get(key) ?? NEW_HEALTH;
    if (before === "stopped") {
      // Not running: starting it again is automatic restart's work. The stretch goes on until a check passes.
      const { eligibleSince: _gone, incarnation: _was, ...rest } = state;
      write(target.id, service, since, { ...rest, failures: 0 });
      return undefined;
    }
    const { identity } = before;
    const check = checkIdentity(component);
    if (identity !== state.incarnation || check !== state.check) {
      // A new process, or the same one checked another way, starts afresh and continues the stretch only when its record
      // says so. Await: that record.
      const saved = (await deps.store.read()).targets.find(
        (t) => t.id === target.id,
      );
      state = {
        ...seeded(saved ?? target, service),
        ...(identity !== undefined ? { incarnation: identity } : {}),
        check,
        eligibleSince: deps.now(),
      };
      if (!write(target.id, service, since, state)) return undefined;
    } else if (state.eligibleSince === undefined) {
      // Seen with its Target free: its start check has passed, so it may be checked from now.
      state = { ...state, eligibleSince: deps.now() };
      if (!write(target.id, service, since, state)) return undefined;
    }
    if (deps.now() < nextCheckAt(state, policy)!) return undefined;
    if (paused(target, service, since)) return undefined;
    // Await: the probe itself, bounded by the healthcheck's timeout and aborted by stop.
    const result = await withinTimeout(
      (signal) => deps.observations.health(target, component, signal),
      policy.timeoutMs,
    );
    // The answer speaks only for the process it asked: one an Operation began to stop or replace meanwhile, or that ended
    // on its own before supervision recorded it, is not what runs now.
    if (paused(target, service, since)) return undefined;
    // Await: the process and check recorded after the probe; both must be what the probe asked.
    const after = await runningProcess(target, component, policy.timeoutMs);
    if (
      after === undefined ||
      after === "stopped" ||
      after.identity !== identity ||
      paused(target, service, since)
    )
      return undefined;
    // Decision point, with no await until the cache is written: the epoch rule, and the cached state still about this
    // probe's check and process.
    const cached = states.get(key);
    if (
      !cached ||
      !current(target.id, service, since) ||
      cached.check !== check ||
      cached.incarnation !== identity
    )
      return undefined;
    const at = deps.now();
    const outcome = recordCheck(
      cached,
      result === undefined
        ? {
            passed: false,
            output: `The check did not answer within ${policy.timeoutMs / 1000}s.`,
          }
        : "ready" in result && result.ready
          ? { passed: true }
          : {
              passed: false,
              output: "reason" in result ? result.reason : "failed",
            },
      at,
      policy,
    );
    if (!write(target.id, service, since, outcome.state)) return undefined;
    // The cache was written, so its change may be recorded; each record is compared with `since` again as it is applied.
    if (outcome.event === "unhealthy")
      await record(target, service, since, {
        action: "health",
        outcome: "failed",
        message: `${service} is unhealthy: ${outcome.state.failures} health ${outcome.state.failures === 1 ? "check" : "checks"} in a row failed (${outcome.state.output ?? "no output"}). ${
          policy.onFailure !== "restart"
            ? "Its healthcheck's on_failure is report, so Rig only reports it."
            : outcome.state.incarnation === undefined
              ? `Rig cannot restart it for its health, since a rigd too old to record which process it is started it; run rig restart ${target.name} once.`
              : "Rig restarts it."
        }`,
      });
    if (outcome.event === "recovered") {
      await record(target, service, since, {
        action: "health",
        outcome: "unchanged",
        message: `${service} is healthy again: its health check passed.`,
      });
      await forgetStretch(target, service, since, identity);
    }
    const action = actionFor(outcome.state, policy, at);
    return isDue(action)
      ? { action, since, check, incarnation: identity }
      : undefined;
  }

  /** Restarts the Service as `verdict` says, under the epoch rule with the verdict's `since`, when the recorded plan still
   * makes the verdict's check, under a policy that restarts, of the verdict's process. The request names that check and
   * process, never whatever is cached by then, so the restart's own guard under the Target's lock refuses it once either
   * changed. */
  async function act(
    targetId: string,
    service: string,
    verdict: Verdict,
  ): Promise<void> {
    const key = keyOf(targetId, service);
    // Await: the plan and run record as they are now.
    const now = await checked(targetId, service);
    // Decision point, with no await until the request is built.
    const state = states.get(key);
    if (verdict.start) {
      // A start the back-off calls for: the record must still name the process whose health start failed, and the plan
      // still make the check, under a policy that restarts.
      const run = now && currentRun(now.target, service);
      const stretch = run?.healthStretch;
      if (
        !now ||
        !current(targetId, service, verdict.since) ||
        now.policy.onFailure !== "restart" ||
        checkIdentity(now.component) !== verdict.check ||
        run?.incarnation !== verdict.incarnation ||
        !healthStartPending(run) ||
        stretch === undefined ||
        deps.now() < healthRestartDueAt(stretch)
      )
        return;
      // Await: the start, an Operation that waits for the Target. Its start is a transition; what it means reaches the
      // cache through `started` or, when it fails again, through the record it writes.
      await deps.restart({
        targetId,
        service,
        check: verdict.check!,
        incarnation: verdict.incarnation!,
        start: true,
        attempt: stretch.restarts.length + 1,
        failures: 0,
        ...(state?.output !== undefined ? { output: state.output } : {}),
        since: stretch.since,
        restarts: stretch.restarts,
      });
      return;
    }
    if (
      !now ||
      !state ||
      !current(targetId, service, verdict.since) ||
      verdict.check === undefined ||
      checkIdentity(now.component) !== verdict.check ||
      currentRun(now.target, service)?.incarnation !== verdict.incarnation ||
      state.check !== verdict.check ||
      state.incarnation !== verdict.incarnation
    )
      return;
    const stretch = state.stretch;
    const action = actionFor(state, now.policy, deps.now());
    if (!stretch || !isDue(action)) return;
    // Await: the restart, an Operation that waits for the Target. Its stop and start are transitions, so what it means for
    // the back-off reaches the cache from the run record it writes, through the next pass, when it did either.
    const result = await deps.restart({
      targetId,
      service,
      check: verdict.check,
      ...(verdict.incarnation !== undefined
        ? { incarnation: verdict.incarnation }
        : {}),
      attempt: action.attempt,
      failures: state.failures,
      ...(state.output !== undefined ? { output: state.output } : {}),
      since: stretch.since,
      restarts: stretch.restarts,
    });
    const after = states.get(key) ?? state;
    if (!("at" in result)) {
      if (result.outcome === "deferred") return;
      // The process that was judged is gone or was replaced meanwhile: the next pass looks at what runs now, afresh.
      const { incarnation: _gone, eligibleSince: _next, ...rest } = after;
      write(targetId, service, verdict.since, { ...rest, failures: 0 });
      return;
    }
    // A failed restart counts for the back-off too, so a Service that cannot start is not asked again at once.
    write(targetId, service, verdict.since, restarted(after, result.at));
  }

  /** Runs `observe`, aborted after `timeoutMs`: its answer, a failure as a failed check, or undefined when it did not
   * answer in time. */
  async function withinTimeout<T>(
    observe: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
  ): Promise<T | { ready: false; reason: string } | undefined> {
    if (stopped) return undefined;
    const controller = new AbortController();
    probes.add(controller);
    let cancel = () => {};
    const late = new Promise<undefined>((resolve) => {
      cancel = deps.schedule(timeoutMs, () => {
        controller.abort();
        resolve(undefined);
      });
    });
    try {
      return await Promise.race([
        observe(controller.signal).catch((error: unknown) =>
          controller.signal.aborted
            ? undefined
            : { ready: false as const, reason: failureReason(error) },
        ),
        late,
        // A stop aborts the probe and answers at once, whether or not the probe heeds its signal.
        new Promise<undefined>((resolve) =>
          controller.signal.addEventListener(
            "abort",
            () => resolve(undefined),
            { once: true },
          ),
        ),
      ]);
    } finally {
      cancel();
      probes.delete(controller);
    }
  }

  /** A stretch that ended: the record no longer carries it, so a new rigd does not continue it. Under the epoch rule. */
  async function forgetStretch(
    target: TargetRecord,
    service: string,
    since: number,
    incarnation: string | undefined,
  ): Promise<void> {
    if (!current(target.id, service, since)) return;
    await deps.store.update((state) => {
      if (!current(target.id, service, since)) return;
      const run = state.targets.find((t) => t.id === target.id)?.services?.[
        service
      ];
      if (run?.healthStretch && run.incarnation === incarnation)
        delete run.healthStretch;
    });
  }

  /** One Activity entry about the Service, under the epoch rule. */
  async function record(
    target: TargetRecord,
    service: string,
    since: number,
    entry: Pick<OperationRecord, "action" | "outcome" | "message">,
  ): Promise<void> {
    if (!current(target.id, service, since)) return;
    await deps.store.update((state) => {
      if (!current(target.id, service, since)) return;
      recordActivity(state, {
        id: deps.id(),
        projectId: target.projectId,
        project: state.projects.find((p) => p.id === target.projectId)?.name,
        target: target.name,
        occurredAt: new Date(deps.now()).toISOString(),
        ...entry,
      });
    });
  }
}
