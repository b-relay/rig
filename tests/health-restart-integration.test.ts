import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectConfig } from "../src/config";
import type { HostSession } from "../src/domain/host-session";
import { healthSummary } from "../src/domain/project-status";
import type {
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import type { RigRuntime } from "../src/runtime/application";
import {
  createHealthMonitor,
  type HealthMonitor,
} from "../src/runtime/health-monitor";
import { runtimeWorld } from "./support/runtime-world";

/** A health restart whose start fails, end to end: the real runtime, lifecycle hooks, state-write transitions,
 * health-restart, supervision and Host-restart handling, with the real health monitor over a scripted supervisor and a
 * fake clock. The check and the start gate are the same shell test, `test -f <ready>`, so removing the file makes web
 * unhealthy and makes its start fail; putting it back lets the next health restart start it. A start check's deadline is
 * decided by the file, not by real time: with the file there it is a generous 10 s, without it the start check gives up at
 * once, so no test depends on how fast this machine runs a shell. */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function world(
  restart: "no" | "always",
  targets: { working: true; stable?: true } = { working: true },
) {
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
    targets,
  });
  const processes = new Map<string, ProcessObservation>();
  const spawns: number[] = [];
  /** Stops of a process that ignore it and keep it running, as a stop that cannot be confirmed. */
  const stopping: { refuse?: (count: number) => boolean; count: number } = {
    count: 0,
  };
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
      stopping.count++;
      if (stopping.refuse?.(stopping.count))
        throw new Error("the process ignored its stop");
      const running = processes.get(key)?.state === "running";
      processes.delete(key);
      return { outcome: running ? "stopped" : "unchanged" };
    },
    async shutdown() {},
    async detach() {},
  };
  const host: { session: HostSession } = {
    session: {
      boot: "BOOT-1",
      bootedAt: "2026-10-05T07:00:00.000Z",
      login: "100002",
    },
  };
  let monitor: HealthMonitor | undefined;
  const timers: { at: number; fire: () => void }[] = [];
  const w = await runtimeWorld({
    name: "health-restart-it",
    config,
    supervisor: () => supervisor,
    startsAt: "2026-10-05T08:00:00.000Z",
    readinessDeadlineMs: 10_000,
    timing: {
      schedule(delayMs, fire) {
        // Polls come at once; a start check's deadline comes when its outcome is already decided by the file.
        const timer = setTimeout(
          fire,
          delayMs < 1000 ? 0 : existsSync(ready) ? 10_000 : 0,
        );
        return () => clearTimeout(timer);
      },
      startGraceMs: 0,
    },
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
      sources: {
        async preflight(input: { branch: string }) {
          return { commit: `c-${input.branch}`, warnings: [] };
        },
        async prepare(request: { destination: string }) {
          await mkdir(request.destination, { recursive: true });
          return { workspacePath: request.destination, commit: "c1" };
        },
        async resolve() {
          return "c1";
        },
        async currentBranch() {
          return "main";
        },
        async release() {},
      },
      hostSession: {
        async current() {
          return { ...host.session };
        },
      },
    }),
  });
  roots.push(w.root);
  const clock = w.clock;
  let runtime!: RigRuntime;
  /** A daemon: the runtime and its health monitor, wired as rigd wires them. A new one stands for a restarted rigd. */
  const open = () => {
    runtime = w.open();
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
  };
  open();
  // The first daemon's first pass records the Host session a later one compares with.
  await runtime.reconcile();
  await runtime.command({ action: "init", repoPath: w.repo });
  const targetOf = async (kind: "working" | "stable") =>
    (await w.store.read()).targets.find((t) => t.kind === kind)!;
  const status = async (kind: "working" | "stable" = "working") =>
    (await runtime.status({ project: "demo", target: kind })).targets[0]!
      .components[0]!;
  return {
    get runtime() {
      return runtime;
    },
    get monitor() {
      return monitor!;
    },
    clock,
    ready,
    spawns,
    stopping,
    status,
    /** The Host restarts: nothing survives, the boot changes, and a new rigd reconciles what it finds. */
    async reboot() {
      processes.clear();
      host.session = {
        boot: "BOOT-2",
        bootedAt: new Date(clock.ms).toISOString(),
        login: "100002",
      };
      open();
      await runtime.reconcile();
    },
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
    /** Whether web of `kind` runs. */
    running: async (kind: "working" | "stable" = "working") => {
      const id = (await targetOf(kind)).id;
      return processes.get(`${id}:web`)?.state === "running";
    },
    /** web's run record. */
    run: async (kind: "working" | "stable" = "working") =>
      (await targetOf(kind)).services!.web!,
    store: w.store,
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
    expect(await w.running()).toBe(true);
    // web stops passing: its next check fails, it is unhealthy, and the health restart's start fails its start check.
    await rm(w.ready);
    await w.advance(6);
    expect(await w.running()).toBe(false);
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
    expect(await w.running()).toBe(false);
    expect((await w.status()).health).toMatchObject({ restarts: 2 });
    // Readiness comes back. The next health restart, 5 minutes after the last, starts web and its checks pass again.
    await writeFile(w.ready, "");
    await w.advance(240);
    expect(await w.running()).toBe(false);
    await w.advance(70);
    expect(await w.running()).toBe(true);
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
  expect(await w.running()).toBe(false);
  await writeFile(w.ready, "");
  await w.runtime.command({
    action: "restart",
    project: "demo",
    target: "working",
  });
  expect(await w.running()).toBe(true);
  // The explicit start ended the stretch: healthy, with no health restart counted.
  expect(await w.status()).toMatchObject({
    state: "healthy",
    health: { restarts: 0 },
  });
  // Unhealthy and stuck again, then rig down: nothing starts it after that.
  await rm(w.ready);
  await w.advance(6);
  expect(await w.running()).toBe(false);
  await w.runtime.command({
    action: "down",
    project: "demo",
    target: "working",
  });
  const spawned = w.spawns.length;
  await writeFile(w.ready, "");
  await w.advance(400);
  expect(w.spawns.length).toBe(spawned);
  expect(await w.running()).toBe(false);
}, 30_000);

test("a health restart whose replacement cannot be confirmed stopped after its failed start check is checked as the running process, and recovers", async () => {
  const w = await world("no");
  await w.runtime.command({ action: "up", project: "demo", target: "working" });
  // The health restart's stop of the unhealthy process works; the rollback stop of its failed replacement does not.
  w.stopping.refuse = (count) => count >= 2;
  await rm(w.ready);
  await w.advance(6);
  expect(await w.running()).toBe(true);
  const run = await w.run();
  expect(run.healthStretch).toMatchObject({ restarts: [expect.any(Number)] });
  expect(run.healthStretch).not.toHaveProperty("failedStart");
  expect((await w.activity()).at(-1)).toContain(
    "could not be confirmed stopped",
  );
  // Readiness comes back: the replacement's ongoing checks pass, and the stretch ends.
  await writeFile(w.ready, "");
  await w.advance(10);
  expect(await w.status()).toMatchObject({
    state: "healthy",
    health: { status: "healthy" },
  });
  expect(await w.run()).not.toHaveProperty("healthStretch");
}, 30_000);

test("a process running while its record says its health start failed is checked as a running process, not left waiting for a start", async () => {
  const w = await world("no");
  await w.runtime.command({ action: "up", project: "demo", target: "working" });
  // A record a daemon left behind: failedStart, though the process it names runs.
  await w.store.update((state) => {
    const web = state.targets[0]!.services!.web!;
    web.healthStretch = {
      since: w.clock.ms,
      restarts: [w.clock.ms],
      failedStart: w.clock.ms,
    };
  });
  const spawned = w.spawns.length;
  await w.advance(10);
  expect(await w.running()).toBe(true);
  expect(w.spawns.length).toBe(spawned);
  expect(await w.status()).toMatchObject({ state: "healthy" });
  expect(await w.run()).not.toHaveProperty("healthStretch");
}, 30_000);

test("after a Host restart a working Target waiting for its next health restart stays stopped until rig up, whatever its restart policy", async () => {
  const w = await world("no");
  await w.runtime.command({ action: "up", project: "demo", target: "working" });
  await rm(w.ready);
  await w.advance(6);
  expect(await w.run()).toMatchObject({
    healthStretch: { failedStart: expect.any(Number) },
  });
  await w.reboot();
  await writeFile(w.ready, "");
  const spawned = w.spawns.length;
  await w.advance(400);
  // No health restart started it: the Host restart holds it stopped, as it holds every working Target.
  expect(w.spawns.length).toBe(spawned);
  expect(await w.running()).toBe(false);
  expect(await w.run()).toMatchObject({
    outcome: { kind: "unknown", hostRestart: "reboot" },
  });
  expect((await w.status()).state).toBe("stopped");
  await w.runtime.command({ action: "up", project: "demo", target: "working" });
  expect(await w.running()).toBe(true);
  expect(await w.run()).not.toHaveProperty("healthStretch");
}, 30_000);

test("after a Host restart a stable Target waiting for its next health restart is started by rigd, as every stable Target is, and its stretch ends", async () => {
  const w = await world("no", { working: true, stable: true });
  await w.runtime.command({
    action: "deploy",
    project: "demo",
    target: "stable",
  });
  expect(await w.running("stable")).toBe(true);
  await rm(w.ready);
  await w.advance(6);
  expect(await w.running("stable")).toBe(false);
  expect(await w.run("stable")).toMatchObject({
    healthStretch: { failedStart: expect.any(Number) },
  });
  await writeFile(w.ready, "");
  const spawned = w.spawns.length;
  await w.reboot();
  // rigd's start after the Host restart is an explicit start: web runs at once, and the stretch is over.
  expect(await w.running("stable")).toBe(true);
  expect(w.spawns.length).toBe(spawned + 1);
  expect(await w.run("stable")).not.toHaveProperty("healthStretch");
  await w.advance(6);
  expect(await w.status("stable")).toMatchObject({ state: "healthy" });
}, 30_000);
