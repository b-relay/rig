import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { parseProjectConfig } from "../src/config";
import type { ProjectConfig } from "../src/config/types";
import type {
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import { JOB_LATE_LIMIT_MS } from "../src/runtime/job-scheduler";
import { createJobStopMarks } from "../src/runtime/jobs";
import { runtimeWorld } from "./support/runtime-world";

/** Scheduled runs as Operations of the real runtime: what it checks before a run starts, and how a run is stopped. */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const config: ProjectConfig = parseProjectConfig({
    name: "melody",
    services: { api: { command: "serve" } },
    jobs: {
      "link-resolver": {
        command: "resolve-links",
        schedule: "17 */6 * * *",
        targets: ["working"],
      },
    },
    targets: { working: true },
  });
  const processes = new Map<string, ProcessObservation>();
  const supervisor: Supervisor = {
    async observe(key) {
      return processes.get(key) ?? { state: "stopped" };
    },
    async ensureRunning(request) {
      if (processes.get(request.key)?.state === "running")
        return { outcome: "unchanged" };
      processes.set(request.key, {
        state: "running",
        pid: 4000 + processes.size,
        incarnation: request.incarnation,
      });
      return { outcome: "started" };
    },
    async stop(key) {
      const running = processes.get(key)?.state === "running";
      processes.set(key, { state: "stopped" });
      return { outcome: running ? "stopped" : "unchanged" };
    },
    async shutdown() {},
    async detach() {},
  };
  const marks = createJobStopMarks();
  // The marks are taken on the world's scripted clock, once it exists.
  let now = () => 0;
  const world = await runtimeWorld({
    name: "jobs",
    config,
    supervisor: () => supervisor,
    startsAt: "2026-10-10T17:17:00.000Z",
    readinessDeadlineMs: 2000,
    lifecycleObserver: {
      changing() {},
      activated() {},
      stoppingJob: (target, job) => marks.mark(target.id, job, now()),
    },
    dependencies: () => ({ jobStops: marks }),
  });
  now = () => world.clock.ms;
  roots.push(world.root);
  const runtime = world.open();
  await runtime.command({ action: "init", repoPath: world.repo });
  await runtime.command({
    action: "up",
    repoPath: world.repo,
    target: "working",
  });
  const target = (await world.store.read()).targets[0]!;
  const scheduled = (id: string, scheduledFor = world.clock.ms) =>
    runtime.runScheduledJob({
      targetId: target.id,
      job: "link-resolver",
      scheduledFor,
      id,
    });
  const record = async () =>
    (await world.store.read()).jobs?.find((r) => r.job === "link-resolver");
  const key = `${target.id}:job:link-resolver`;
  return { world, runtime, config, processes, scheduled, record, key, target };
}

test("a scheduled time starts a run, a time while it goes is skipped, and the next start settles the run that ended", async () => {
  const f = await fixture();
  expect(await f.scheduled("run-1")).toBe("started");
  expect(f.processes.get(f.key)).toMatchObject({
    state: "running",
    incarnation: "run-1",
  });
  f.world.clock.ms += 6 * 3600_000;
  expect(await f.scheduled("run-2")).toBe("skipped");
  expect(await f.record()).toMatchObject({
    running: { id: "run-1", skipped: 1 },
    lastScheduled: "2026-10-10T23:17:00.000Z",
  });
  f.processes.set(f.key, {
    state: "stopped",
    incarnation: "run-1",
    exitCode: 0,
  });
  f.world.clock.ms += 6 * 3600_000;
  expect(await f.scheduled("run-3")).toBe("started");
  expect(await f.record()).toMatchObject({
    running: { id: "run-3" },
    last: { id: "run-1", outcome: "succeeded", exitCode: 0, skipped: 1 },
  });
  const activity = (await f.world.store.read()).activity.filter(
    (entry) => entry.action === "job",
  );
  expect(activity.map((entry) => entry.outcome)).toEqual([
    "skipped",
    "succeeded",
  ]);
});

test("a time is passed over when the Target is stopped, turned off in rig.yaml, or reached past the late limit", async () => {
  const f = await fixture();
  expect(
    await f.scheduled("late", f.world.clock.ms - JOB_LATE_LIMIT_MS - 1000),
  ).toBe("passed");
  f.config.targets = { working: false };
  expect(await f.scheduled("off")).toBe("passed");
  f.config.targets = { working: true };
  await f.runtime.command({
    action: "down",
    repoPath: f.world.repo,
    target: "working",
  });
  expect(await f.scheduled("stopped")).toBe("passed");
  expect(await f.record()).toBeUndefined();
});

test("turning the Target off stops its run in progress, and rig down does too, each recorded as stopped by Rig", async () => {
  const f = await fixture();
  expect(await f.scheduled("run-1")).toBe("started");
  // Still on: nothing is stopped.
  await f.runtime.stopJobsIfOff(f.target.id);
  expect(f.processes.get(f.key)?.state).toBe("running");
  f.config.targets = { working: false };
  await f.runtime.stopJobsIfOff(f.target.id);
  expect(f.processes.get(f.key)?.state).toBe("stopped");
  expect(await f.record()).toMatchObject({
    last: { id: "run-1", outcome: "stopped" },
  });
  f.config.targets = { working: true };
  const manual = (await f.runtime.command({
    action: "run",
    repoPath: f.world.repo,
    target: "working",
    job: "link-resolver",
  })) as { outcome: string; job: string };
  expect(manual).toMatchObject({ outcome: "started", job: "link-resolver" });
  await f.runtime.command({
    action: "down",
    repoPath: f.world.repo,
    target: "working",
  });
  expect(await f.record()).toMatchObject({
    last: { trigger: "manual", outcome: "stopped" },
  });
  expect(
    (await f.world.store.read()).activity.find(
      (entry) => entry.action === "job" && entry.outcome === "stopped",
    )?.message,
  ).toContain("link-resolver: stopped by Rig");
});

test("rig run refuses a stopped Target, whose next rigd would stop the run again", async () => {
  const f = await fixture();
  await f.runtime.command({
    action: "down",
    repoPath: f.world.repo,
    target: "working",
  });
  await expect(
    f.runtime.command({
      action: "run",
      repoPath: f.world.repo,
      target: "working",
      job: "link-resolver",
    }),
  ).rejects.toMatchObject({
    code: "JOB_UNAVAILABLE",
    hint: "Run rig up working first.",
  });
  expect(f.processes.get(f.key)).toBeUndefined();
});

test("rig run refuses a job the Target does not run and names what it does run", async () => {
  const f = await fixture();
  await expect(
    f.runtime.command({
      action: "run",
      repoPath: f.world.repo,
      target: "working",
      job: "missing",
    }),
  ).rejects.toMatchObject({
    code: "JOB_UNKNOWN",
    hint: "Run one of: link-resolver.",
  });
});
