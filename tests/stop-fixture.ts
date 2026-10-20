import { loopbackListeners } from "./support/activation-doubles";
import type { TargetEffects } from "../src/runtime/lifecycle";
import { createTargetLifecycle } from "../src/runtime/lifecycle";
import type { ProcessObservation } from "../src/providers/contracts";

/** In-memory process boundary for shutdown tests; never starts Host processes. */
export function stopFixture(active: string[] = []) {
  const running = new Set(active);
  const stops: string[] = [];
  const observations = new Map<string, ProcessObservation | Error>();
  const stopFailures = new Set<string>();
  /** Each withholding asked of the route: the ports (none: every path), and how many stops came before it. */
  const withheld: { ports?: number[]; afterStops: number }[] = [];
  const routeFailure: { withhold?: Error } = {};
  const effects: TargetEffects = {
    async checkpoint(target) {
      return { targetId: target.id, async commit() {}, async rollback() {} };
    },
    async restoreEffects() {},
    async commitEffects() {},
    async retireSuperseded() {},
    async pruneCheckpoints() {
      return [];
    },
    async retireArtifacts() {},
    supervisor: () => ({
      async observe(key) {
        const observation = observations.get(key);
        if (observation instanceof Error) throw observation;
        return (
          observation ??
          (running.has(key)
            ? { state: "running", pid: 1 }
            : { state: "stopped" })
        );
      },
      async stop(key) {
        stops.push(key);
        if (stopFailures.has(key)) throw new Error(`Stop failed: ${key}`);
        return { outcome: running.delete(key) ? "stopped" : "unchanged" };
      },
      async ensureRunning(request) {
        const existed = running.has(request.key);
        running.add(request.key);
        return { outcome: existed ? "unchanged" : "started" };
      },
      async shutdown() {},
      async detach() {},
    }),
    async prepare() {},
    async environment() {
      return {};
    },
    async health() {
      return { ready: true };
    },
    async build() {},
    async install() {
      return { outcome: "unchanged" };
    },
    async route() {},
    async removeRoute() {},
    async withhold(_target, ports) {
      withheld.push({
        ...(ports ? { ports: [...ports].sort() } : {}),
        afterStops: stops.length,
      });
      if (routeFailure.withhold) throw routeFailure.withhold;
    },
    async withdrawRoute() {
      return undefined;
    },
    async pruneRoutes() {
      return [];
    },
    listeners: async (pid: number) =>
      loopbackListeners(pid, [4000, 4001, 4567]),
  };
  return {
    lifecycle: createTargetLifecycle(effects),
    running,
    stops,
    observations,
    stopFailures,
    withheld,
    routeFailure,
  };
}
