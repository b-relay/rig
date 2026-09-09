import type { TargetEffects } from "../src/runtime/lifecycle";
import { createTargetLifecycle } from "../src/runtime/lifecycle";
import type { ProcessObservation } from "../src/providers/contracts";

/** In-memory process and hook boundary; never starts Host processes. */
export function stopHookFixture(active: string[] = []) {
  const running = new Set(active);
  const hooks: string[] = [];
  const stops: string[] = [];
  const observations = new Map<string, ProcessObservation | Error>();
  const hookFailures = new Set<string>();
  const stopFailures = new Set<string>();
  const effects: TargetEffects = {
    async checkpoint(target) {
      return { targetId: target.id, async commit() {}, async rollback() {} };
    },
    async restoreEffects() {},
    async commitEffects() {},
    async retireSuperseded() {},
    async retireArtifacts() {},
    supervisor: () => ({
      async observe(key) {
        const observation = observations.get(key);
        if (observation instanceof Error) throw observation;
        return observation ?? { state: running.has(key) ? "running" : "stopped" };
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
    }),
    async prepare() {},
    async environment() { return {}; },
    async hook(command) {
      hooks.push(command);
      if (hookFailures.has(command)) throw new Error(`Hook failed: ${command}`);
    },
    async health() { return true; },
    async install() { return { outcome: "unchanged" }; },
    async route() {},
    async removeRoute() {},
  };
  return { lifecycle: createTargetLifecycle(effects), running, hooks, stops, observations, hookFailures, stopFailures };
}
