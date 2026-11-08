import type { ManagedComponent } from "../config/types";
import { placed, type Clock } from "../domain/clock";
import {
  checkIdentity,
  healthPolicy,
  isUnhealthy,
  seededHealth,
  type HealthPolicy,
  type HealthState,
  type HealthStretch,
} from "../domain/health-policy";
import type { ServiceHealth } from "../domain/project-status";
import type { TargetRecord } from "../domain/runtime";

/** The key the health monitor files a Service under. */
export const healthKey = (targetId: string, service: string) =>
  `${targetId}:${service}`;

/** What the health monitor knows of each Service, and the epochs that keep a stale observation out of it. Every lifecycle
 * transition of a Service or Target advances the epoch (`invalidate`, `started`); a unit of work takes `epoch()` before the
 * read its writes derive from, and each write is applied only while `current` still holds for it. `current` is synchronous:
 * callers compare and write with no await between. After `stop` nothing is current. See
 * docs/reviews/2026-11-07-health-monitor-epochs.md for how the runtime calls the transitions. */
export interface HealthCache {
  /** The epoch to take before a read. */
  epoch(): number;
  /** Whether a write derived from a read taken at `since` may still be applied for the Service. */
  current(targetId: string, service: string, since: number): boolean;
  /** A transition of one Service, or with no Service of the whole Target. A Service's own drops what was cached about the
   * process it replaced; a Target's keeps its Services' cache, so a write after a start does not undo what `started`
   * cached. */
  invalidate(targetId: string, service?: string): void;
  /** A start of the Service passed its start check: a transition whose result is cached unconditionally, healthy as of now
   * unless it carries an unhealthy stretch on. False, changing nothing, once stopped. */
  started(target: TargetRecord, service: string, incarnation: string): boolean;
  /** The cached state of the Service. */
  state(targetId: string, service: string): HealthState | undefined;
  /** Caches `state` while current; says whether it did. */
  write(
    targetId: string,
    service: string,
    since: number,
    state: HealthState,
  ): boolean;
  /** Caches `policy` while current; says whether it did. */
  policy(
    targetId: string,
    service: string,
    since: number,
    policy: HealthPolicy,
  ): boolean;
  /** The elapsed time since the latest health restart of `stretch`: the one the monitor saw made, else the one its record
   * names, placed by its wall-clock age. */
  sinceRestart(
    targetId: string,
    service: string,
    stretch: HealthStretch | undefined,
  ): number;
  /** A health restart of `stretch` was made at `elapsed`: the back-off before the next one counts from it. */
  madeRestart(
    targetId: string,
    service: string,
    stretch: HealthStretch,
    elapsed: number,
  ): void;
  /** The stretch ended: no health restart of it is remembered. */
  forgetRestart(targetId: string, service: string): void;
  /** Forgets, epochs included, every Service untouched since `since` that `keep` does not keep, and every Target none of
   * whose Services is left. Safe only from a pass, which runs alone, with `keep` keeping what is monitored or in flight. */
  forget(since: number, keep: (key: string, targetId: string) => boolean): void;
  /** The cached result as status shows it; undefined when nothing is known. */
  results(
    target: Pick<TargetRecord, "id">,
    service: string,
  ): ServiceHealth | undefined;
  /** How many entries are kept: states, policies and epoch marks. */
  retained(): number;
  /** Nothing is current from now on. */
  stop(): void;
  stopped(): boolean;
}

export function createHealthCache(clock: Clock): HealthCache {
  const states = new Map<string, HealthState>();
  const policies = new Map<string, HealthPolicy>();
  const restartMarks = new Map<
    string,
    { since: number; attempt: number; mark: number }
  >();
  let epoch = 0;
  /** The epoch at each Service's last transition, by key. */
  const serviceMarks = new Map<string, number>();
  /** The epoch at each Target's last transition, by Target id. */
  const targetMarks = new Map<string, number>();
  let stopped = false;

  const current = (targetId: string, service: string, since: number) =>
    !stopped &&
    Math.max(
      serviceMarks.get(healthKey(targetId, service)) ?? 0,
      targetMarks.get(targetId) ?? 0,
    ) <= since;
  const invalidate = (targetId: string, service?: string) => {
    epoch++;
    if (service === undefined) targetMarks.set(targetId, epoch);
    else {
      serviceMarks.set(healthKey(targetId, service), epoch);
      states.delete(healthKey(targetId, service));
    }
  };

  return {
    epoch: () => epoch,
    current,
    invalidate,
    started(target, service, incarnation) {
      if (stopped) return false;
      invalidate(target.id, service);
      const key = healthKey(target.id, service);
      const component = target.plan.components.find(
        (candidate): candidate is ManagedComponent =>
          candidate.kind === "managed" && candidate.name === service,
      );
      const policy = component && healthPolicy(component);
      if (!policy) {
        states.delete(key);
        policies.delete(key);
        return true;
      }
      policies.set(key, policy);
      const base = seededHealth(target, service);
      const elapsed = clock.elapsed();
      states.set(key, {
        ...base,
        incarnation,
        check: checkIdentity(component),
        eligibleSince: elapsed,
        ...(base.stretch
          ? {}
          : { checkedAt: clock.now(), checkedMark: elapsed, passed: true }),
      });
      return true;
    },
    state: (targetId, service) => states.get(healthKey(targetId, service)),
    write(targetId, service, since, state) {
      if (!current(targetId, service, since)) return false;
      states.set(healthKey(targetId, service), state);
      return true;
    },
    policy(targetId, service, since, policy) {
      if (!current(targetId, service, since)) return false;
      policies.set(healthKey(targetId, service), policy);
      return true;
    },
    sinceRestart(targetId, service, stretch) {
      if (!stretch) return 0;
      const key = healthKey(targetId, service);
      const attempt = stretch.restarts.length;
      let known = restartMarks.get(key);
      if (known?.since !== stretch.since || known.attempt !== attempt) {
        known = {
          since: stretch.since,
          attempt,
          mark: placed(clock, stretch.restarts.at(-1) ?? stretch.since),
        };
        restartMarks.set(key, known);
      }
      return clock.elapsed() - known.mark;
    },
    madeRestart(targetId, service, stretch, elapsed) {
      restartMarks.set(healthKey(targetId, service), {
        since: stretch.since,
        attempt: stretch.restarts.length + 1,
        mark: elapsed,
      });
    },
    forgetRestart(targetId, service) {
      restartMarks.delete(healthKey(targetId, service));
    },
    forget(since, keep) {
      const targetsKept = new Set<string>();
      for (const key of new Set([
        ...states.keys(),
        ...policies.keys(),
        ...serviceMarks.keys(),
      ])) {
        const split = key.lastIndexOf(":");
        const targetId = key.slice(0, split),
          service = key.slice(split + 1);
        if (keep(key, targetId) || !current(targetId, service, since)) {
          targetsKept.add(targetId);
          continue;
        }
        states.delete(key);
        policies.delete(key);
        serviceMarks.delete(key);
        restartMarks.delete(key);
      }
      for (const [targetId, mark] of targetMarks)
        if (!targetsKept.has(targetId) && !stopped && mark <= since)
          targetMarks.delete(targetId);
    },
    results(target, service) {
      const key = healthKey(target.id, service);
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
    stop() {
      stopped = true;
    },
    stopped: () => stopped,
  };
}
