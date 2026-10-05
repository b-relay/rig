import type { ManagedComponent } from "../config/types";
import { recordActivity } from "../domain/activity";
import { diagnosticErrorCode, failureReason } from "../domain/errors";
import {
  NEW_HEALTH,
  healthAction,
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
  StateStore,
  TargetRecord,
} from "../domain/runtime";
import type { RuntimeDependencies } from "./contracts";
import type { ObservationEffects } from "./status";
import { currentRun } from "./supervision";

/** How many ongoing checks run at once across the Host. */
export const HEALTH_CHECK_CONCURRENCY = 4;
/** How often rigd looks for checks that are due; a check runs at most this late. */
export const HEALTH_MONITOR_TICK_MS = 1000;

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

type Due = Extract<HealthAction, { kind: "restart" }>;
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
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };

  return {
    results(target, service) {
      const key = `${target.id}:${service}`;
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
    async idle() {
      while (work.size) await Promise.allSettled([...work]);
    },
    async pass() {
      const recorded = await deps.store.read();
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
          const key = `${target.id}:${component.name}`;
          monitored.add(key);
          policies.set(key, policy);
          if (inFlight.has(key)) continue;
          const known = states.get(key);
          const recordedIncarnation = currentRun(
            target,
            component.name,
          )?.incarnation;
          // Every start is recorded before it spawns: a process other than the one judged is a new one, whose checks start
          // afresh even before it is observed, so the old one's result never speaks for it.
          const state =
            known === undefined
              ? seeded(target, component.name)
              : known.incarnation !== undefined &&
                  recordedIncarnation !== undefined &&
                  recordedIncarnation !== known.incarnation
                ? fresh(target, component.name, known)
                : known;
          // Starting or stopping: no check, and the process is first seen afresh once the Target is free.
          if (deps.busy(target)) {
            const { eligibleSince: _paused, ...rest } = state;
            states.set(key, rest);
            continue;
          }
          states.set(key, state);
          const action = actionFor(state, policy, deps.now());
          const due = nextCheckAt(state, policy);
          if (!isDue(action) && due !== undefined && deps.now() < due) continue;
          inFlight.add(key);
          const job = (async () => {
            try {
              let next: Due | undefined = isDue(action) ? action : undefined;
              if (!next) {
                await slot();
                try {
                  next = await check(target, component, policy, key);
                } finally {
                  release();
                }
              }
              if (next) await act(target, component, key, next);
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
      // A Service no longer meant to run, or no longer checked, forgets what was known about it.
      for (const key of [...states.keys()])
        if (!monitored.has(key) && !inFlight.has(key)) {
          states.delete(key);
          policies.delete(key);
        }
    },
  };

  /** Whether the Target is busy, in which case the Service's checks pause until it is free again. */
  function paused(target: TargetRecord, key: string): boolean {
    if (!deps.busy(target)) return false;
    const state = states.get(key);
    if (state) {
      const { eligibleSince: _paused, ...rest } = state;
      states.set(key, rest);
    }
    return true;
  }
  /** The state of a new process of the Service: no result of its own, and the unhealthy stretch only when its record
   * carries one on (a health or automatic restart did); the last output stays with a stretch that goes on. */
  function fresh(
    target: TargetRecord,
    service: string,
    before: HealthState,
  ): HealthState {
    const base = seeded(target, service);
    return base.stretch && before.output !== undefined
      ? { ...base, output: before.output }
      : base;
  }
  /** The state a Service starts from: nothing known, with the unhealthy stretch its record says a health restart continued. */
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
    const recordedNow = async () => {
      const saved = (await deps.store.read()).targets.find(
        (t) => t.id === target.id,
      );
      return saved && currentRun(saved, component.name)?.incarnation;
    };
    const recorded = await recordedNow();
    const observed = await withinTimeout(
      (signal) => deps.observations.process(target, component, signal),
      timeoutMs,
    );
    if (observed === undefined || "ready" in observed) return undefined;
    // Only a stopped process is stopped: an unknown one decides nothing, and its count stays.
    if (observed.state === "stopped") return "stopped";
    if (observed.state !== "running") return undefined;
    // The record must name the same process on both sides of the observation, which may be an old snapshot.
    if (
      (await recordedNow()) !== recorded ||
      (recorded !== undefined &&
        observed.incarnation !== undefined &&
        observed.incarnation !== recorded)
    )
      return undefined;
    // A record from before incarnations were kept leaves the observation to say which process it is.
    return { identity: recorded ?? observed.incarnation };
  }

  /** One Service's turn: find its process, check it once it may be checked, record what changed, and return the restart the
   * result calls for. */
  async function check(
    target: TargetRecord,
    component: ManagedComponent,
    policy: HealthPolicy,
    key: string,
  ): Promise<Due | undefined> {
    const state = states.get(key) ?? NEW_HEALTH;
    // The Target may have become busy while this waited for a slot: nothing is checked while it starts or stops.
    if (paused(target, key)) return undefined;
    const before = await runningProcess(target, component, policy.timeoutMs);
    if (before === undefined) return undefined;
    if (before === "stopped") {
      // Not running: starting it again is automatic restart's work. The stretch goes on until a check passes.
      const { eligibleSince: _gone, incarnation: _was, ...rest } = state;
      states.set(key, { ...rest, failures: 0 });
      return undefined;
    }
    const { identity } = before;
    if (state.eligibleSince === undefined || identity !== state.incarnation) {
      // A process seen with its Target free: its start check has passed, so it may be checked from now. A new process
      // continues the stretch only when its record says so: an explicit start ends it.
      let base = state;
      if (identity !== state.incarnation) {
        const saved = (await deps.store.read()).targets.find(
          (t) => t.id === target.id,
        );
        base = fresh(saved ?? target, component.name, state);
      }
      states.set(key, {
        ...base,
        ...(identity !== undefined ? { incarnation: identity } : {}),
        eligibleSince: deps.now(),
      });
    }
    const current = states.get(key)!;
    if (deps.now() < nextCheckAt(current, policy)!) return undefined;
    if (paused(target, key)) return undefined;
    const result = await withinTimeout(
      (signal) => deps.observations.health(target, component, signal),
      policy.timeoutMs,
    );
    // The answer speaks only for the process it asked: one an Operation began to stop or replace meanwhile, or that ended
    // on its own before supervision recorded it, is not what runs now.
    if (paused(target, key)) return undefined;
    const after = await runningProcess(target, component, policy.timeoutMs);
    if (
      after === undefined ||
      after === "stopped" ||
      after.identity !== identity ||
      paused(target, key)
    )
      return undefined;
    const at = deps.now();
    const checked = recordCheck(
      states.get(key) ?? current,
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
    states.set(key, checked.state);
    if (checked.event === "unhealthy")
      await record(target, {
        action: "health",
        outcome: "failed",
        message: `${component.name} is unhealthy: ${checked.state.failures} health ${checked.state.failures === 1 ? "check" : "checks"} in a row failed (${checked.state.output ?? "no output"}). ${
          policy.onFailure !== "restart"
            ? "Its healthcheck's on_failure is report, so Rig only reports it."
            : checked.state.incarnation === undefined
              ? `Rig cannot restart it for its health, since a rigd too old to record which process it is started it; run rig restart ${target.name} once.`
              : "Rig restarts it."
        }`,
      });
    if (checked.event === "recovered") {
      await record(target, {
        action: "health",
        outcome: "unchanged",
        message: `${component.name} is healthy again: its health check passed.`,
      });
      await forgetStretch(target, component.name, identity);
    }
    const action = actionFor(checked.state, policy, at);
    return isDue(action) ? action : undefined;
  }

  /** Restarts the Service as `action` says. */
  async function act(
    target: TargetRecord,
    component: ManagedComponent,
    key: string,
    action: Due,
  ): Promise<void> {
    const state = states.get(key) ?? NEW_HEALTH;
    const stretch = state.stretch;
    if (!stretch) return;
    const result = await deps.restart({
      targetId: target.id,
      service: component.name,
      ...(state.incarnation !== undefined
        ? { incarnation: state.incarnation }
        : {}),
      attempt: action.attempt,
      failures: state.failures,
      ...(state.output !== undefined ? { output: state.output } : {}),
      since: stretch.since,
      restarts: stretch.restarts,
    });
    const current = states.get(key) ?? state;
    if (!("at" in result)) {
      if (result.outcome === "deferred") return;
      // The process that was judged is gone or was replaced meanwhile: the next pass looks at what runs now, afresh.
      const { incarnation: _gone, eligibleSince: _next, ...rest } = current;
      states.set(key, { ...rest, failures: 0 });
      return;
    }
    // A failed restart counts for the back-off too, so a Service that cannot start is not asked again at once.
    states.set(key, restarted(current, result.at));
  }

  /** Runs `observe`, aborted after `timeoutMs`: its answer, a failure as a failed check, or undefined when it did not
   * answer in time. */
  async function withinTimeout<T>(
    observe: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
  ): Promise<T | { ready: false; reason: string } | undefined> {
    const controller = new AbortController();
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
      ]);
    } finally {
      cancel();
    }
  }

  /** A stretch that ended: the record no longer carries it, so a new rigd does not continue it. */
  async function forgetStretch(
    target: TargetRecord,
    service: string,
    incarnation: string | undefined,
  ): Promise<void> {
    await deps.store.update((state) => {
      const run = state.targets.find((t) => t.id === target.id)?.services?.[
        service
      ];
      if (run?.healthStretch && run.incarnation === incarnation)
        delete run.healthStretch;
    });
  }

  async function record(
    target: TargetRecord,
    entry: Pick<OperationRecord, "action" | "outcome" | "message">,
  ): Promise<void> {
    await deps.store.update((state) =>
      recordActivity(state, {
        id: deps.id(),
        projectId: target.projectId,
        project: state.projects.find((p) => p.id === target.projectId)?.name,
        target: target.name,
        occurredAt: new Date(deps.now()).toISOString(),
        ...entry,
      }),
    );
  }
}
