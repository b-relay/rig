import type { RuntimeState, StateStore, TargetRecord } from "../domain/runtime";

/** Where the runtime reports lifecycle transitions to the health monitor (its epoch rule, in health-monitor.ts). */
export interface HealthTransitions {
  /** One Service's transition, or with no Service the whole Target's. Synchronous. */
  invalidate(targetId: string, service?: string): void;
}

/** What of a Target its health checks depend on beyond its Services' processes: the plan they check, whether it is meant
 * to run, and whether a deployment transition or a destruction is pending. */
function targetShape(target: TargetRecord): string {
  return JSON.stringify([
    target.plan,
    target.desired,
    target.recovery ?? null,
    target.destructionPending ?? false,
  ]);
}
function snapshot(
  state: RuntimeState,
): Map<string, { shape: string; processes: Map<string, string | undefined> }> {
  return new Map(
    state.targets.map((target) => [
      target.id,
      {
        shape: targetShape(target),
        processes: new Map(
          Object.entries(target.services ?? {}).map(([service, run]) => [
            service,
            run.incarnation,
          ]),
        ),
      },
    ]),
  );
}

/** `store`, telling `transitions` about every lifecycle transition a write makes, as the write is applied and so while the
 * Operation that makes it still holds its Target: a Target whose plan, desired state, recovery or pending destruction
 * changes, or that is removed, is invalidated as a whole; a Service whose record names another process (a start was
 * journalled) is invalidated alone. Starts and stops are also reported by the lifecycle itself as they begin. */
export function reportingTransitions(
  store: StateStore,
  transitions: HealthTransitions,
): StateStore {
  return {
    read: () => store.read(),
    update: (change) =>
      store.update(async (state) => {
        const before = snapshot(state);
        await change(state);
        const after = snapshot(state);
        for (const [targetId, was] of before) {
          const now = after.get(targetId);
          if (!now || now.shape !== was.shape) {
            transitions.invalidate(targetId);
            continue;
          }
          for (const service of new Set([
            ...was.processes.keys(),
            ...now.processes.keys(),
          ]))
            if (was.processes.get(service) !== now.processes.get(service))
              transitions.invalidate(targetId, service);
        }
      }),
  };
}
