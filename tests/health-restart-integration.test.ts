import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectConfig } from "../src/config";
import { healthSummary } from "../src/domain/project-status";
import type {
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import {
  createHealthMonitor,
  type HealthMonitor,
} from "../src/runtime/health-monitor";
import { runtimeWorld } from "./support/runtime-world";

/** A health restart whose start fails, end to end: the real runtime, lifecycle hooks, state-write transitions,
 * health-restart and supervision, with the real health monitor over a scripted supervisor and a fake clock. The check and
 * the start gate are the same shell test, `test -f <ready>`, so removing the file makes web unhealthy and makes its start
 * fail; putting it back lets the next health restart start it. */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function world(restart: "no" | "always") {
  const scratch = await mkdtemp(join(tmpdir(), "rig-health-restart-it-"));
  roots.push(scratch);
  const ready = join(scratch, "ready");
  await writeFile(ready, "");
  const config = parseProjectConfig({
    name: "demo",
    services: {
      web: {
        command: "serve",
        restart,
        healthcheck: {
          test: `test -f '${ready}'`,
          interval: "5s",
          retries: 1,
          start_period: "1s",
          on_failure: "restart",
        },
      },
    },
  });
  const processes = new Map<string, ProcessObservation>();
  const spawns: number[] = [];
  const supervisor: Supervisor = {
    async observe(key) {
      return processes.get(key) ?? { state: "stopped" };
    },
    async ensureRunning(request) {
      if (processes.get(request.key)?.state === "running")
        return { outcome: "unchanged" };
      spawns.push(clock.ms);
      processes.set(request.key, {
        state: "running",
        pid: 5000 + spawns.length,
        incarnation: request.incarnation,
      });
      return { outcome: "started" };
    },
    async stop(key) {
      const running = processes.get(key)?.state === "running";
      processes.delete(key);
      return { outcome: running ? "stopped" : "unchanged" };
    },
    async shutdown() {},
    async detach() {},
  };
  let monitor: HealthMonitor | undefined;
  const timers: { at: number; fire: () => void }[] = [];
  const w = await runtimeWorld({
    name: "health-restart-it",
    config,
    supervisor: () => supervisor,
    startsAt: "2026-10-05T08:00:00.000Z",
    // A start check that does not pass gives up after this much real time.
    readinessDeadlineMs: 150,
    lifecycleObserver: {
      changing: (target, service) => monitor?.invalidate(target.id, service),
      activated: (target, service, incarnation) =>
        monitor?.started(target, service, incarnation),
    },
    dependencies: () => ({
      healthTransitions: {
        invalidate: (targetId: string, service?: string) =>
          monitor?.invalidate(targetId, service),
      },
      healthResults: (target: { id: string }, service: string) =>
        monitor?.results(target, service),
    }),
  });
  roots.push(w.root);
  const clock = w.clock;
  const runtime = w.open();
  monitor = createHealthMonitor({
    store: w.store,
    observations: w.deps.observations,
    now: () => clock.ms,
    id: () => `h${Math.random()}`,
    busy: runtime.targetBusy,
    restart: runtime.restartUnhealthy,
    schedule(delayMs, fire) {
      const timer = { at: clock.ms + delayMs, fire };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
    async diagnostic() {},
  });
  await runtime.command({ action: "init", repoPath: w.repo });
  const status = async () =>
    (await runtime.status({ project: "demo", target: "working" })).targets[0]!
      .components[0]!;
  return {
    runtime,
    monitor,
    clock,
    ready,
    spawns,
    status,
    /** One second of fake time per step: rigd's supervision pass and the health monitor's pass, each settled. */
    async advance(seconds: number) {
      for (let i = 0; i < seconds; i++) {
        clock.ms += 1000;
        for (const timer of timers.filter((t) => t.at <= clock.ms)) {
          timers.splice(timers.indexOf(timer), 1);
          timer.fire();
        }
        await runtime.supervise();
        await monitor!.pass();
        await monitor!.idle();
      }
    },
    running: () =>
      [...processes.values()].some((process) => process.state === "running"),
    /** web's run record. */
    run: async () => (await w.store.read()).targets[0]!.services!.web!,
    activity: async () =>
      (await w.store.read()).activity
        .filter((entry) => entry.action === "health-restart")
        .map((entry) => entry.message ?? ""),
  };
}

for (const restart of ["no", "always"] as const)
  test(`with restart: ${restart}, a health restart whose start fails stays on the health back-off and starts web once it can`, async () => {
    const w = await world(restart);
    await w.runtime.command({
      action: "up",
      project: "demo",
      target: "working",
    });
    expect(w.running()).toBe(true);
    expect(w.monitor.results({ id: (await w.status()).name }, "web")).toBe(
      undefined,
    );
    // web stops passing: its next check fails, it is unhealthy, and the health restart's start fails its start check.
    await rm(w.ready);
    await w.advance(6);
    expect(w.running()).toBe(false);
    const first = await w.status();
    expect(first).toMatchObject({
      state: "unhealthy",
      health: { restartFailed: true, restarts: 1 },
    });
    // The health restart was a second ago: the next one is due a minute after it.
    expect(healthSummary(first, new Date(w.clock.ms))).toBe(
      "unhealthy · restart failed its start check · next attempt in 59s",
    );
    expect((await w.activity()).at(-1)).toContain(
      "its start failed its start check",
    );
    // Neither restart: nor the crash budget decides it: nothing starts web until the next health restart, a minute on, and
    // that start fails too.
    const spawned = w.spawns.length;
    await w.advance(55);
    expect(w.spawns.length).toBe(spawned);
    // Not a single automatic attempt was spent on it, so nothing can exhaust a budget.
    expect(await w.run()).toMatchObject({ attempts: [] });
    expect(await w.run()).not.toHaveProperty("exhausted");
    await w.advance(10);
    expect(w.spawns.length).toBe(spawned + 1);
    expect(w.running()).toBe(false);
    expect((await w.status()).health).toMatchObject({ restarts: 2 });
    // Readiness comes back. The next health restart, 5 minutes after the last, starts web and its checks pass again.
    await writeFile(w.ready, "");
    await w.advance(240);
    expect(w.running()).toBe(false);
    await w.advance(70);
    expect(w.running()).toBe(true);
    await w.advance(6);
    expect(await w.status()).toMatchObject({
      state: "healthy",
      health: { status: "healthy" },
    });
    expect(
      (await w.runtime.command({ action: "activity", project: "demo" })) as {
        operations: { message?: string }[];
      },
    ).toMatchObject({
      operations: expect.arrayContaining([
        expect.objectContaining({
          message: "web is healthy again: its health check passed.",
        }),
      ]),
    });
  }, 30_000);

test("an explicit restart starts a Service waiting for its next health restart at once, and down stops the retries", async () => {
  const w = await world("no");
  await w.runtime.command({ action: "up", project: "demo", target: "working" });
  await rm(w.ready);
  await w.advance(6);
  expect(w.running()).toBe(false);
  await writeFile(w.ready, "");
  await w.runtime.command({
    action: "restart",
    project: "demo",
    target: "working",
  });
  expect(w.running()).toBe(true);
  // The explicit start ended the stretch: healthy, with no health restart counted.
  expect(await w.status()).toMatchObject({
    state: "healthy",
    health: { restarts: 0 },
  });
  // Unhealthy and stuck again, then rig down: nothing starts it after that.
  await rm(w.ready);
  await w.advance(6);
  expect(w.running()).toBe(false);
  await w.runtime.command({
    action: "down",
    project: "demo",
    target: "working",
  });
  const spawned = w.spawns.length;
  await writeFile(w.ready, "");
  await w.advance(400);
  expect(w.spawns.length).toBe(spawned);
  expect(w.running()).toBe(false);
}, 30_000);
