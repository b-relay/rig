import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { parseProjectConfig } from "../src/config";
import { createClock } from "../src/domain/clock";
import type {
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import { createRuntime } from "../src/runtime/application";
import { RESTART_LIMIT } from "../src/runtime/supervision";
import { runtimeWorld } from "./support/runtime-world";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const HOUR = 3_600_000;

/** One `restart: always` Service under the real runtime, over a scripted supervisor and two clocks: time passing (`wait`)
 * moves both, a correction of the Mac's clock (`step`) only the wall clock. `restartDaemon` is a new rigd: a new runtime
 * over the same state, whose clock remembers nothing. */
async function fixture() {
  const processes = new Map<string, ProcessObservation>();
  const starts: string[] = [];
  const supervisor: Supervisor = {
    async observe(key) {
      return processes.get(key) ?? { state: "stopped" };
    },
    async ensureRunning(request) {
      starts.push(request.key);
      processes.set(request.key, {
        state: "running",
        pid: 424242,
        incarnation: request.incarnation,
      });
      return { outcome: "started" };
    },
    async stop(key) {
      processes.delete(key);
      return { outcome: "stopped" };
    },
    async shutdown() {},
    async detach() {},
  };
  let elapsed = 0;
  const daemonClock = () =>
    createClock({ wall: () => world.clock.ms, elapsed: () => elapsed });
  const world = await runtimeWorld({
    name: "supervision-clock",
    config: parseProjectConfig({
      name: "demo",
      services: { web: { command: "serve", restart: "always" } },
      targets: { working: true },
    }),
    supervisor: () => supervisor,
    startsAt: "2026-10-13T12:00:00Z",
    readinessDeadlineMs: 250,
  });
  roots.push(world.root);
  let runtime = createRuntime({ ...world.deps, clock: daemonClock() });
  await runtime.command({ action: "init", repoPath: world.repo });
  await runtime.command({ action: "up", project: "demo" });
  const web = async () => (await world.store.read()).targets[0]!;
  return {
    starts,
    /** The running process exits with code 1. */
    async crash() {
      const target = await web();
      const key = `${target.id}:web`;
      processes.set(key, {
        state: "stopped",
        exitCode: 1,
        incarnation: processes.get(key)!.incarnation,
      });
    },
    supervise: () => runtime.supervise(),
    wait(ms: number) {
      elapsed += ms;
      world.clock.ms += ms;
    },
    step(ms: number) {
      world.clock.ms += ms;
    },
    async restartDaemon() {
      await runtime.drain();
      runtime = createRuntime({ ...world.deps, clock: daemonClock() });
      await runtime.reconcile();
    },
    run: async () => (await web()).services!.web!,
  };
}

test("correcting the clock back neither delays a crashed Service's restart nor, across a daemon restart, holds it stopped", async () => {
  const f = await fixture();
  expect(f.starts).toHaveLength(1);
  await f.crash();
  await f.supervise();
  expect((await f.run()).retryAt).toBeDefined();
  // The clock is set back an hour; 200 ms pass, past the 100 ms delay.
  f.step(-HOUR);
  f.wait(200);
  await f.supervise();
  expect(f.starts).toHaveLength(2);
  // Again, with rigd restarting while the clock is behind the recorded exit: it waits at most the delay.
  await f.crash();
  await f.supervise();
  f.step(-HOUR);
  await f.restartDaemon();
  f.wait(50);
  await f.supervise();
  expect(f.starts).toHaveLength(2);
  f.wait(200);
  await f.supervise();
  expect(f.starts).toHaveLength(3);
});

test("correcting the clock forward neither hastens a restart nor gives a crashing Service a fresh budget", async () => {
  const f = await fixture();
  await f.crash();
  await f.supervise();
  f.step(HOUR);
  await f.supervise();
  // Its 100 ms delay has not elapsed, whatever the clock says.
  expect(f.starts).toHaveLength(1);
  f.wait(100);
  await f.supervise();
  expect(f.starts).toHaveLength(2);
  // It keeps crashing within a minute: the budget is spent, and a forward correction does not age its attempts out.
  for (let attempt = 2; attempt <= RESTART_LIMIT; attempt++) {
    await f.crash();
    await f.supervise();
    f.wait(10_000);
    await f.supervise();
  }
  expect(f.starts).toHaveLength(RESTART_LIMIT + 1);
  await f.crash();
  f.step(HOUR);
  await f.supervise();
  f.wait(10_000);
  await f.supervise();
  expect(f.starts).toHaveLength(RESTART_LIMIT + 1);
  expect((await f.run()).exhausted).toBe(true);
});
