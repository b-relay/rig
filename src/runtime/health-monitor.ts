import type { ManagedComponent } from "../config/types";
import type { Clock } from "../domain/clock";
import { diagnosticErrorCode } from "../domain/errors";
import {
  NEW_HEALTH,
  checkDue,
  checkIdentity,
  checkResult,
  healthPolicy,
  healthRestartWait,
  healthStartPending,
  identifiedHealthAction,
  judgedHealth,
  recordCheck,
  restarted,
  seededHealth,
  type HealthAction,
  type HealthPolicy,
  type HealthStretch,
} from "../domain/health-policy";
import {
  checkingHealth,
  namedService,
  recoveredActivity,
  unhealthyActivity,
} from "../domain/health-wording";
import type { ServiceHealth } from "../domain/project-status";
import {
  currentRun,
  readOnlyState,
  type StateStore,
  type TargetRecord,
} from "../domain/runtime";
import type { RuntimeDependencies, WorkReport } from "./contracts";
import { createHealthCache, healthKey } from "./health-cache";
import { createHealthRecords } from "./health-records";
import { createHealthWork } from "./health-work";
import type { ObservationEffects } from "./status";
import { trackedWorkReport } from "./work-report";

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
  | ({
      /** When it was attempted, Unix milliseconds. */
      at: number;
      /** `at` on the elapsed clock of the process that made the restart, which is the monitor's own. */
      elapsed: number;
    } & ({ outcome: "restarted" } | { outcome: "failed"; error: unknown }))
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
  store: Pick<StateStore, "read" | "update" | "snapshot">;
  observations: Pick<ObservationEffects, "process" | "health">;
  /** Wall-clock time for what is recorded and shown, and the elapsed time every check interval and restart back-off is
   * waited in (`systemClock` in rigd, the clock `restart` reads too). */
  clock: Clock;
  id(): string;
  /** Whether an Operation holds or waits for the Target, so one of its Services may be starting or stopping. */
  busy(target: TargetRecord): boolean;
  /** Stops and starts one Service through the normal stop path, under its Target's lock; says how that ended. */
  restart(request: HealthRestartRequest): Promise<HealthRestartResult>;
  /** Calls `fire` once after `delayMs`; returns the cancellation. A test passes a fake clock's. */
  schedule(delayMs: number, fire: () => void): () => void;
  diagnostic: RuntimeDependencies["diagnostic"];
  /** Where each Service's checks (`<target id>:<service>`), the records of its changes of health (`…/record`: Activity, the
   * end of an unhealthy stretch), the evidence its checks write to the Target log (`…/evidence`) and its health restarts
   * (`…/restart`) say they failed, and later that they succeeded. */
  report: WorkReport;
  /** Checks that may run at once across the Host; HEALTH_CHECK_CONCURRENCY when absent. */
  concurrency?: number;
}
export interface HealthMonitor {
  /** Starts every check that is due, and every restart the policies call for, then returns without waiting for them. */
  pass(): Promise<void>;
  /** Resolves once every check and restart started so far has settled. */
  idle(): Promise<void>;
  /** A start of the Service passed its start check, the healthcheck's first passing check: a lifecycle transition, whose
   * result is cached as the newest thing known. It is healthy as of now and next checked one interval later, unless it
   * carries an unhealthy stretch on (an automatic or health restart), in which case it stays unhealthy until an ongoing
   * check passes, so its back-off holds. */
  started(target: TargetRecord, service: string, incarnation: string): void;
  /** A lifecycle transition of one Service, or with no Service of the whole Target: anything a pass, check or restart
   * read before it is not applied. The runtime calls it, while it holds the Target, as a start or stop begins and on every
   * state write that changes a Target's plan, desired state, recovery or destruction, removes it, or records another
   * process for a Service. */
  invalidate(targetId: string, service?: string): void;
  /** How many entries the monitor keeps: cached results, policies, epoch marks and changes of health not written yet. Zero
   * once nothing is monitored. */
  retained(): number;
  /** Ends the monitor: no pass starts anything after it, every probe in flight is aborted (a command probe's process group
   * is killed), nothing is written to state any more, and it resolves once the work in flight settled or `boundMs`
   * (HEALTH_MONITOR_STOP_MS when absent) passed, whichever comes first. */
  stop(boundMs?: number): Promise<void>;
  results: HealthResults;
}

type Due = Extract<HealthAction, { kind: "restart" }>;
/** A restart the policy calls for, and what it is about: the epoch taken before the read it was judged from, and the
 * check and process it judged. */
interface Verdict {
  action: Due;
  since: number;
  check: string | undefined;
  incarnation: string | undefined;
  /** The process is stopped because the last health restart's start failed: start it again. */
  start?: true;
}
const isDue = (action: HealthAction): action is Due =>
  action.kind === "restart";
/** A Service as recorded now: its Target, plan entry and policy. */
interface Recorded {
  target: TargetRecord;
  component: ManagedComponent;
  policy: HealthPolicy;
}

/** rigd's ongoing health checks (ADR 0012). Each pass reads the recorded Targets meant to run and checks each Service that
 * has a healthcheck once it is due. Checks run beside the operation queue, never in it: a pass takes no lock and never
 * waits for an Operation. A Target an Operation holds or waits for may be starting or stopping a Service, so its checks
 * pause, and a process is first checked once Rig sees it running with the Target free, which is after its start check
 * passed; later checks follow at its interval. Checks of one Service never overlap, and at most `concurrency` run across
 * the Host; a check that does not answer within its timeout failed. A Service is unhealthy after `retries` failures in a
 * row and healthy again after one pass; Activity records both. `restart` Services are handed to `restart` as the back-off
 * allows, and a restart holds no check slot while it waits for its Target. Results live in memory; a health restart
 * records the unhealthy stretch on the Service it starts, so a new rigd continues its back-off.
 * What is known, and when a write is still current, is `health-cache`'s; the jobs, slots and probes are `health-work`'s;
 * the writes to state are `health-records`'. */
export function createHealthMonitor(
  deps: HealthMonitorDependencies,
): HealthMonitor {
  const cache = createHealthCache(deps.clock);
  const work = createHealthWork({
    schedule: deps.schedule,
    concurrency: deps.concurrency ?? HEALTH_CHECK_CONCURRENCY,
  });
  /** Services with a check or restart in flight, which nothing else of them overlaps. */
  const inFlight = new Set<string>();
  const report = trackedWorkReport(deps.report);
  /** Reports `work` of the Service as failed, and records it in the diagnostic log. */
  const failed = async (
    work: string,
    about: string,
    target: Pick<TargetRecord, "name">,
    error: unknown,
  ) => {
    report.failed(work, about, error);
    await deps
      .diagnostic({
        operationId: deps.id(),
        action: "health",
        outcome: "failed",
        target: target.name,
        errorCode: diagnosticErrorCode(error),
      })
      .catch(() => {});
  };
  const records = createHealthRecords({
    store: deps.store,
    clock: deps.clock,
    id: deps.id,
    cache,
    report,
    failed,
  });

  return {
    results: cache.results,
    retained: () => cache.retained() + records.retained(),
    idle: work.idle,
    invalidate: cache.invalidate,
    stop(boundMs = HEALTH_MONITOR_STOP_MS) {
      cache.stop();
      return work.stop(boundMs);
    },
    started(target, service, incarnation) {
      if (cache.started(target, service, incarnation))
        report.succeeded(`${healthKey(target.id, service)}/restart`);
    },
    async pass() {
      if (cache.stopped()) return;
      // A Service's change of health that Activity could not take yet is written first; one with a check in flight is
      // written by that check.
      for (const key of records.waiting())
        if (!inFlight.has(key)) await records.write(key);
      const since = cache.epoch();
      const recorded = await readOnlyState(deps.store);
      if (cache.stopped()) return;
      const monitored = new Set<string>();
      /** Targets not meant to run that an Operation holds, whose Services keep what is known of them. */
      const held = new Set<string>();
      for (const target of recorded.targets) {
        if (
          target.desired !== "running" ||
          target.recovery ||
          target.destructionPending
        ) {
          if (deps.busy(target)) held.add(target.id);
          continue;
        }
        for (const component of target.plan.components) {
          if (component.kind !== "managed") continue;
          const policy = healthPolicy(component);
          if (!policy) continue;
          const key = healthKey(target.id, component.name);
          monitored.add(key);
          // Something happened to the Service after this read was taken: what the read says is not about it any more.
          if (!cache.policy(target.id, component.name, since, policy)) continue;
          if (inFlight.has(key)) continue;
          const state = judgedHealth(
            target,
            component,
            cache.state(target.id, component.name),
          );
          const run = currentRun(target, component.name);
          if (healthStartPending(run) && policy.onFailure === "restart") {
            cache.write(target.id, component.name, since, state);
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
            const job = pendingStart(
              target,
              component,
              policy,
              verdict,
              run.healthStretch,
            )
              .catch((error: unknown) =>
                failed(
                  key,
                  checkingHealth(target, component.name),
                  target,
                  error,
                ),
              )
              .finally(() => inFlight.delete(key));
            work.track(job);
            continue;
          }
          // Starting or stopping: no check, and the process is first seen afresh once the Target is free.
          if (deps.busy(target)) {
            const { eligibleSince: _paused, ...rest } = state;
            cache.write(target.id, component.name, since, rest);
            continue;
          }
          cache.write(target.id, component.name, since, state);
          const action = identifiedHealthAction(
            state,
            policy,
            cache.sinceRestart(target.id, component.name, state.stretch),
          );
          if (
            !isDue(action) &&
            state.eligibleSince !== undefined &&
            !checkDue(state, policy, deps.clock.elapsed())
          )
            continue;
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
              await failed(
                key,
                checkingHealth(target, component.name),
                target,
                error,
              );
            } finally {
              inFlight.delete(key);
            }
          })();
          work.track(job);
        }
      }
      // A Service no longer meant to run, or no longer checked, forgets what was known about it once nothing touched it
      // after this read and nothing of it is in flight. Not while an Operation holds its Target: an up or deploy records the
      // Target meant to run only after its Services passed their start checks, and what `started` cached must stand.
      cache.forget(
        since,
        (key, targetId) =>
          monitored.has(key) || inFlight.has(key) || held.has(targetId),
      );
      // A failure about a Service no longer checked, with nothing of it left to write, no longer stands.
      report.only((work) => {
        const key = work.replace(/\/(?:record|evidence|restart)$/, "");
        return monitored.has(key) || inFlight.has(key) || records.has(key);
      });
    },
  };

  /** The last health restart's start failed: the Service is stopped and unhealthy, and is started again at the next step of
   * the back-off, whatever its restart policy. Never given up on; an explicit start clears the stretch, and a down leaves
   * the Target meant to stop. A process the record says should be stopped but runs after all (a rollback that could not
   * stop it) is judged by its ongoing checks, as any running process. */
  async function pendingStart(
    target: TargetRecord,
    component: ManagedComponent,
    policy: HealthPolicy,
    verdict: Verdict,
    stretch: HealthStretch,
  ): Promise<void> {
    const seen = await work.withinTimeout(
      (signal) => deps.observations.process(target, component, signal),
      policy.timeoutMs,
    );
    if (seen !== undefined && "state" in seen) {
      if (seen.state === "running") await checkTurn(target, component);
      else if (
        seen.state === "stopped" &&
        healthRestartWait(
          stretch,
          cache.sinceRestart(target.id, component.name, stretch),
        ) <= 0
      )
        await act(target.id, component.name, verdict);
    }
  }

  /** One check of the Service with a probe slot held, and the restart it calls for. The check's own read comes with the
   * slot held: a deploy or restart while it waited is judged by what is recorded now, under the policy it has now. */
  async function checkTurn(
    target: TargetRecord,
    component: ManagedComponent,
  ): Promise<void> {
    let next: Verdict | undefined;
    await work.slot();
    try {
      const since = cache.epoch();
      const now = await recordedNow(target.id, component.name);
      if (now && cache.policy(target.id, component.name, since, now.policy))
        next = await check(now.target, now.component, now.policy, since);
    } finally {
      work.release();
    }
    if (next) await act(target.id, component.name, next);
  }
  /** The Service as recorded now; undefined when the Target is no longer meant to run, the Service is gone, or it has no
   * healthcheck any more, so nothing of it is checked or restarted. */
  async function recordedNow(
    targetId: string,
    service: string,
  ): Promise<Recorded | undefined> {
    if (cache.stopped()) return undefined;
    const target = (await deps.store.read()).targets.find(
      (candidate) => candidate.id === targetId,
    );
    if (
      cache.stopped() ||
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
    const state = cache.state(target.id, service);
    if (state) {
      const { eligibleSince: _paused, ...rest } = state;
      cache.write(target.id, service, since, rest);
    }
    return true;
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
    const snapshot = async () => {
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
    const before = await snapshot();
    if (before.check !== checkIdentity(component)) return undefined;
    const recorded = before.incarnation;
    const observed = await work.withinTimeout(
      (signal) => deps.observations.process(target, component, signal),
      timeoutMs,
    );
    if (observed === undefined || "ready" in observed) return undefined;
    // Only a stopped process is stopped: an unknown one decides nothing, and its count stays.
    if (observed.state === "stopped") return "stopped";
    if (observed.state !== "running") return undefined;
    // The record must name the same process on both sides of the observation, which may be an old snapshot.
    const again = await snapshot();
    if (
      again.check !== before.check ||
      again.incarnation !== recorded ||
      (recorded !== undefined &&
        observed.incarnation !== undefined &&
        observed.incarnation !== recorded)
    )
      return undefined;
    // A record from before incarnations were kept leaves the observation to say which process it is.
    return { identity: recorded ?? observed.incarnation };
  }

  /** One Service's turn, with `since` taken before the read `component` came from: find its process, check it once it may
   * be checked, record what changed, and return the restart the result calls for. Each await may let a transition
   * through, so every write after one is compared with `since` then. */
  async function check(
    target: TargetRecord,
    component: ManagedComponent,
    policy: HealthPolicy,
    since: number,
  ): Promise<Verdict | undefined> {
    const service = component.name;
    const key = healthKey(target.id, service);
    // The Target may have become busy while this waited for a slot: nothing is checked while it starts or stops.
    if (paused(target, service, since)) return undefined;
    const before = await runningProcess(target, component, policy.timeoutMs);
    if (before === undefined) return undefined;
    let state = cache.state(target.id, service) ?? NEW_HEALTH;
    if (before === "stopped") {
      // Not running: starting it again is automatic restart's work. The stretch goes on until a check passes.
      const { eligibleSince: _gone, incarnation: _was, ...rest } = state;
      cache.write(target.id, service, since, { ...rest, failures: 0 });
      return undefined;
    }
    const { identity } = before;
    const check = checkIdentity(component);
    if (identity !== state.incarnation || check !== state.check) {
      // A new process, or the same one checked another way, starts afresh and continues the stretch only when its record
      // says so.
      const saved = (await deps.store.read()).targets.find(
        (t) => t.id === target.id,
      );
      state = {
        ...seededHealth(saved ?? target, service),
        ...(identity !== undefined ? { incarnation: identity } : {}),
        check,
        eligibleSince: deps.clock.elapsed(),
      };
      if (!cache.write(target.id, service, since, state)) return undefined;
    } else if (state.eligibleSince === undefined) {
      // Seen with its Target free: its start check has passed, so it may be checked from now.
      state = { ...state, eligibleSince: deps.clock.elapsed() };
      if (!cache.write(target.id, service, since, state)) return undefined;
    }
    if (!checkDue(state, policy, deps.clock.elapsed())) return undefined;
    if (paused(target, service, since)) return undefined;
    // The probe itself, bounded by the healthcheck's timeout and aborted by stop.
    const result = await work.withinTimeout(
      (signal) => deps.observations.health(target, component, signal),
      policy.timeoutMs,
    );
    // Its evidence not reaching the Target log is reported, and never changes what the check found.
    if (result !== undefined && "unrecorded" in result && result.unrecorded)
      report.failed(
        `${key}/evidence`,
        `Writing the health check evidence of ${namedService(target, service)} to its Target log`,
        result.unrecorded,
      );
    else if (result !== undefined) report.succeeded(`${key}/evidence`);
    // The answer speaks only for the process it asked: one an Operation began to stop or replace meanwhile, or that ended
    // on its own before supervision recorded it, is not what runs now.
    if (paused(target, service, since)) return undefined;
    const after = await runningProcess(target, component, policy.timeoutMs);
    if (
      after === undefined ||
      after === "stopped" ||
      after.identity !== identity ||
      paused(target, service, since)
    )
      return undefined;
    // No await from here until the cache is written: still current, and the cached state still about this probe's check
    // and process.
    const cached = cache.state(target.id, service);
    if (
      !cached ||
      !cache.current(target.id, service, since) ||
      cached.check !== check ||
      cached.incarnation !== identity
    )
      return undefined;
    const at = { wall: deps.clock.now(), elapsed: deps.clock.elapsed() };
    const outcome = recordCheck(
      cached,
      checkResult(result, policy.timeoutMs),
      at,
      policy,
    );
    if (!cache.write(target.id, service, since, outcome.state))
      return undefined;
    // Activity about a change of health only once the cache took it; each record is compared again as it is applied.
    if (outcome.event === "unhealthy")
      await records.activity(
        target,
        service,
        since,
        unhealthyActivity(service, outcome.state, policy, target),
      );
    if (outcome.event === "recovered") {
      await records.activity(
        target,
        service,
        since,
        recoveredActivity(service),
      );
      await records.stretchEnded(target, service, since, identity);
      cache.forgetRestart(target.id, service);
      report.succeeded(`${key}/restart`);
    }
    report.succeeded(key);
    const action = identifiedHealthAction(
      outcome.state,
      policy,
      cache.sinceRestart(target.id, service, outcome.state.stretch),
    );
    return isDue(action)
      ? { action, since, check, incarnation: identity }
      : undefined;
  }

  /** Restarts the Service as `verdict` says, while a write from the verdict's `since` is current and the recorded plan
   * still makes the verdict's check, under a policy that restarts, of the verdict's process. The request names that check
   * and process, never whatever is cached by then, so the restart's own guard under the Target's lock refuses it once
   * either changed. */
  async function act(
    targetId: string,
    service: string,
    verdict: Verdict,
  ): Promise<void> {
    const key = healthKey(targetId, service);
    const now = await recordedNow(targetId, service);
    // No await from here until the request is built.
    const state = cache.state(targetId, service);
    if (verdict.start) {
      // A start the back-off calls for: the record must still name the process whose health start failed, and the plan
      // still make the check, under a policy that restarts.
      const run = now && currentRun(now.target, service);
      const stretch = run?.healthStretch;
      if (
        !now ||
        !cache.current(targetId, service, verdict.since) ||
        now.policy.onFailure !== "restart" ||
        checkIdentity(now.component) !== verdict.check ||
        run?.incarnation !== verdict.incarnation ||
        !healthStartPending(run) ||
        stretch === undefined ||
        healthRestartWait(
          stretch,
          cache.sinceRestart(targetId, service, stretch),
        ) > 0
      )
        return;
      // The start is a transition: what it means reaches the cache through `started` or, when it fails again, through the
      // record it writes.
      const started = await deps.restart({
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
      reportRestart(key, service, now.target, started);
      if ("at" in started)
        cache.madeRestart(targetId, service, stretch, started.elapsed);
      return;
    }
    if (
      !now ||
      !state ||
      !cache.current(targetId, service, verdict.since) ||
      verdict.check === undefined ||
      checkIdentity(now.component) !== verdict.check ||
      currentRun(now.target, service)?.incarnation !== verdict.incarnation ||
      state.check !== verdict.check ||
      state.incarnation !== verdict.incarnation
    )
      return;
    const stretch = state.stretch;
    const action = identifiedHealthAction(
      state,
      now.policy,
      cache.sinceRestart(targetId, service, stretch),
    );
    if (!stretch || !isDue(action)) return;
    // Its stop and start are transitions, so what it means for the back-off reaches the cache from the run record it
    // writes, through the next pass, when it did either.
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
    reportRestart(key, service, now.target, result);
    const after = cache.state(targetId, service) ?? state;
    if (!("at" in result)) {
      if (result.outcome === "deferred") return;
      // The process that was judged is gone or was replaced meanwhile: the next pass looks at what runs now, afresh.
      const { incarnation: _gone, eligibleSince: _next, ...rest } = after;
      cache.write(targetId, service, verdict.since, { ...rest, failures: 0 });
      return;
    }
    // A failed restart counts for the back-off too, so a Service that cannot start is not asked again at once.
    cache.madeRestart(targetId, service, stretch, result.elapsed);
    cache.write(targetId, service, verdict.since, restarted(after, result.at));
  }

  /** Raises the Service's notice with why its health restart failed, and clears it when one succeeds; a restart that was
   * skipped or deferred says nothing either way. */
  function reportRestart(
    key: string,
    service: string,
    target: Pick<TargetRecord, "name" | "plan">,
    result: HealthRestartResult,
  ): void {
    if (result.outcome === "failed")
      report.failed(
        `${key}/restart`,
        `Restarting ${namedService(target, service)} for its health`,
        result.error,
      );
    else if (result.outcome === "restarted") report.succeeded(`${key}/restart`);
  }
}
