import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { parseProjectConfig } from "../src/config";
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
 * over the same state, which remembers nothing of the one before. */
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
  const clock = { now: () => world.clock.ms, elapsed: () => elapsed };
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
  let runtime = createRuntime({ ...world.deps, clock });
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
    /** The running process is gone, with nothing to say how: an unknown exit. */
    async vanish() {
      processes.delete(`${(await web()).id}:web`);
    },
    supervise: () => runtime.supervise(),
    wait(ms: number) {
      elapsed += ms;
      world.clock.ms += ms;
    },
    step(ms: number) {
      world.clock.ms += ms;
    },
    /** The wall clock now. */
    now: () => world.clock.ms,
    async restartDaemon() {
      await runtime.drain();
      runtime = createRuntime({ ...world.deps, clock });
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

test("restart attempts long past their window still count as old after the clock is set back near them", async () => {
  const f = await fixture();
  // Five automatic restarts, 20 s apart: never five within a minute.
  for (let attempt = 1; attempt <= 5; attempt++) {
    await f.crash();
    await f.supervise();
    f.wait(2000);
    await f.supervise();
    f.wait(18_000);
  }
  expect(f.starts).toHaveLength(6);
  // Three healthy hours, then the clock is set back to just after those attempts.
  f.wait(3 * HOUR);
  f.step(-3 * HOUR);
  await f.crash();
  await f.supervise();
  f.wait(100);
  await f.supervise();
  expect((await f.run()).exhausted).toBeUndefined();
  expect(f.starts).toHaveLength(7);
});

test("an attempt made at the same wall-clock time as an expired one, after the clock is set back, still counts against the budget", async () => {
  const f = await fixture();
  // A first automatic restart, at wall-clock time `first`.
  await f.crash();
  await f.supervise();
  f.wait(100);
  const first = f.now();
  await f.supervise();
  expect((await f.run()).attempts).toEqual([first]);
  // A healthy minute: that attempt leaves the window, and the next crash drops it from the record.
  f.wait(61_000);
  await f.crash();
  await f.supervise();
  expect((await f.run()).attempts).toEqual([]);
  // The clock is set back so the next attempt lands on that same wall-clock time.
  f.step(first - f.now() - 100);
  f.wait(100);
  await f.supervise();
  expect((await f.run()).attempts).toEqual([first]);
  // Crashing at once from then on: the budget's five attempts are spent, and the next crash exhausts it.
  for (let crash = 0; crash < 10 && !(await f.run()).exhausted; crash++) {
    await f.crash();
    await f.supervise();
    f.wait(5000);
    await f.supervise();
  }
  expect((await f.run()).exhausted).toBe(true);
  // The initial start, the first restart, and five in the window.
  expect(f.starts).toHaveLength(RESTART_LIMIT + 2);
});

/** An exit, then supervision, `ms`, and supervision again. */
async function restart(
  f: Awaited<ReturnType<typeof fixture>>,
  exit: "crash" | "vanish",
  ms: number,
) {
  await f[exit]();
  await f.supervise();
  f.wait(ms);
  await f.supervise();
}

test("a known-exit budget keeps its attempts' ages across an unknown-exit retry when the clock is set back", async () => {
  // Back: five known-exit restarts 20 s apart, one unknown-exit restart, three healthy hours, the clock set back three hours.
  const back = await fixture();
  for (let attempt = 1; attempt <= 5; attempt++) {
    await restart(back, "crash", 2000);
    back.wait(18_000);
  }
  await restart(back, "vanish", 6000);
  expect(back.starts).toHaveLength(7);
  back.wait(3 * HOUR);
  back.step(-3 * HOUR);
  await restart(back, "crash", 100);
  expect((await back.run()).exhausted).toBeUndefined();
  expect(back.starts).toHaveLength(8);
});

test("a known-exit budget keeps its attempts' ages across an unknown-exit retry when the clock is moved forward", async () => {
  // Forward: four known-exit restarts at once, one unknown-exit restart, the clock moved an hour on. The four still count:
  // the next restart waits the fifth step of the back-off, and the crash after it spends the budget.
  const forward = await fixture();
  for (let attempt = 1; attempt <= 4; attempt++)
    await restart(forward, "crash", 1000);
  await restart(forward, "vanish", 6000);
  expect(forward.starts).toHaveLength(6);
  forward.step(HOUR);
  await restart(forward, "crash", 1500);
  expect(forward.starts).toHaveLength(6);
  forward.wait(100);
  await forward.supervise();
  expect(forward.starts).toHaveLength(7);
  await forward.crash();
  await forward.supervise();
  expect((await forward.run()).exhausted).toBe(true);
});
