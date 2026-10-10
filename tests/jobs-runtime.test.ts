import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { parseProjectConfig } from "../src/config";
import type { ProjectConfig } from "../src/config/types";
import type {
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import { JOB_LATE_LIMIT_MS } from "../src/runtime/job-scheduler";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import type { RuntimeState } from "../src/domain/runtime";
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
        timeout: "1h",
        targets: ["working"],
      },
      // Scheduled in the stable Target only; rig run still runs it in the working Target.
      palettes: { command: "palettes", schedule: "43 4 * * *" },
    },
    targets: { working: true },
  });
  const processes = new Map<string, ProcessObservation>();
  /** Each stop, with what the state file said about the run when the signal went out. */
  const signalled: { key: string; state: RuntimeState }[] = [];
  /** Checkouts the mirror was asked to drop; `failReleases` makes the next ones fail. */
  const released: string[] = [];
  const failReleases = { count: 0 };
  // The world is made below; a stop reads its state file then.
  let readState = async (): Promise<RuntimeState> => {
    throw new Error("no world yet");
  };
  let starts = 0;
  let failStarts = false;
  const supervisor: Supervisor = {
    async observe(key) {
      return processes.get(key) ?? { state: "stopped" };
    },
    async ensureRunning(request) {
      if (processes.get(request.key)?.state === "running")
        return { outcome: "unchanged" };
      starts++;
      if (failStarts) throw new Error("spawn failed");
      processes.set(request.key, {
        state: "running",
        pid: 4000 + processes.size,
        incarnation: request.incarnation,
      });
      return { outcome: "started" };
    },
    async stop(key) {
      signalled.push({ key, state: await readState() });
      const running = processes.get(key)?.state === "running";
      processes.set(key, { state: "stopped" });
      return { outcome: running ? "stopped" : "unchanged" };
    },
    async shutdown() {},
    async detach() {},
  };
  const world = await runtimeWorld({
    name: "jobs",
    config,
    supervisor: () => supervisor,
    startsAt: "2026-10-10T17:17:00.000Z",
    readinessDeadlineMs: 2000,
    dependencies: () => ({
      sources: {
        async release({ workspacePath }: { workspacePath: string }) {
          if (failReleases.count > 0) {
            failReleases.count--;
            throw new Error("disk busy");
          }
          released.push(workspacePath);
        },
      } as unknown as RuntimeDependencies["sources"],
    }),
  });
  readState = () => world.store.read();
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
  return {
    world,
    runtime,
    config,
    processes,
    scheduled,
    record,
    key,
    target,
    signalled,
    released,
    failReleases,
    starts: () => starts,
    failStarts(value: boolean) {
      failStarts = value;
    },
    /** Records the working Target as a deployed one whose plan moved on from `old`, the checkout its runs started in. */
    async deployedFrom(old: string) {
      await updateState(world, (state) => {
        const recorded = state.targets[0]!;
        recorded.sourceRoot = `${world.root}/revisions`;
        for (const record of state.jobs ?? [])
          if (record.running) record.running.workspace = old;
      });
    },
  };
}
async function updateState(
  world: {
    store: { update(change: (state: RuntimeState) => void): Promise<void> };
  },
  change: (state: RuntimeState) => void,
) {
  await world.store.update(change);
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
    hint: "Run one of: link-resolver, palettes.",
  });
});

test("a timeout judged for a run that ended is never applied to the run started after it", async () => {
  const f = await fixture();
  expect(await f.scheduled("run-a")).toBe("started");
  // Run A passes its one-hour timeout; the scheduler sees it still going and asks for it to be settled. Before that is
  // admitted, A exits on its own and rig run starts B under the same process key.
  f.world.clock.ms += 3600_000 + 1000;
  f.processes.set(f.key, {
    state: "stopped",
    incarnation: "run-a",
    exitCode: 0,
  });
  await f.runtime.command({
    action: "run",
    repoPath: f.world.repo,
    target: "working",
    job: "link-resolver",
    operationId: "run-b",
  });
  await f.runtime.settleJob({
    targetId: f.target.id,
    job: "link-resolver",
    runId: "run-a",
  });
  expect(f.signalled).toEqual([]);
  expect(f.processes.get(f.key)).toMatchObject({
    state: "running",
    incarnation: "run-b",
  });
  expect(await f.record()).toMatchObject({
    running: { id: "run-b" },
    last: { id: "run-a", outcome: "succeeded", exitCode: 0 },
  });
});

test("a run past its timeout is stopped under its Target's lease, its decision recorded before the signal", async () => {
  const f = await fixture();
  expect(await f.scheduled("run-a")).toBe("started");
  f.world.clock.ms += 3600_000 + 1000;
  await f.runtime.settleJob({
    targetId: f.target.id,
    job: "link-resolver",
    runId: "run-a",
  });
  expect(f.signalled.map((stop) => stop.key)).toEqual([f.key]);
  expect(
    f.signalled[0]!.state.jobs?.find((r) => r.job === "link-resolver")?.running
      ?.stopping,
  ).toMatchObject({ cause: "timed-out" });
  expect((await f.record())!.last).toMatchObject({
    id: "run-a",
    outcome: "timed-out",
  });
  // A request about a run that is not the recorded one does nothing.
  expect(await f.scheduled("run-c")).toBe("started");
  await f.runtime.settleJob({
    targetId: f.target.id,
    job: "link-resolver",
    runId: "run-a",
  });
  expect(f.signalled.length).toBe(1);
});

test("a rigd that restarts after deciding to stop a run records its end with that cause", async () => {
  const f = await fixture();
  expect(await f.scheduled("run-a")).toBe("started");
  // rigd recorded rig down's decision, signalled the run, and stopped; the run's exit record survived.
  await f.world.store.update((state) => {
    state.jobs!.find((r) => r.job === "link-resolver")!.running!.stopping = {
      cause: "stopped",
      at: new Date(f.world.clock.ms).toISOString(),
    };
  });
  f.processes.set(f.key, {
    state: "stopped",
    incarnation: "run-a",
    signal: "SIGTERM",
  });
  const next = f.world.open();
  await next.settleJob({
    targetId: f.target.id,
    job: "link-resolver",
    runId: "run-a",
  });
  expect((await f.record())!.last).toMatchObject({
    id: "run-a",
    outcome: "stopped",
    signal: "SIGTERM",
  });
});

test("a checkout a run kept is recorded with its end and given back, by the next rigd when this one could not", async () => {
  const f = await fixture();
  expect(await f.scheduled("run-a")).toBe("started");
  const old = `${f.world.root}/revisions/r1`;
  await f.deployedFrom(old);
  f.processes.set(f.key, {
    state: "stopped",
    incarnation: "run-a",
    exitCode: 0,
  });
  // The first attempt to give it back fails, as a rigd that stopped right after recording the end would leave it.
  f.failReleases.count = 1;
  await f.runtime.settleJob({
    targetId: f.target.id,
    job: "link-resolver",
    runId: "run-a",
  });
  const state = await f.world.store.read();
  expect(
    state.jobs!.find((r) => r.job === "link-resolver")!.last,
  ).toMatchObject({
    outcome: "succeeded",
  });
  expect(state.jobCheckouts).toEqual([
    { target: f.target.id, project: f.target.projectId, workspace: old },
  ]);
  expect(f.released).toEqual([]);
  await f.world.open().releaseJobCheckouts(f.target.id);
  expect(f.released).toEqual([old]);
  expect((await f.world.store.read()).jobCheckouts).toEqual([]);
});

test("a run settled by the next start keeps its checkout recorded even when that start fails", async () => {
  const f = await fixture();
  expect(await f.scheduled("run-a")).toBe("started");
  const old = `${f.world.root}/revisions/r1`;
  await f.deployedFrom(old);
  f.processes.set(f.key, {
    state: "stopped",
    incarnation: "run-a",
    exitCode: 1,
  });
  f.failStarts(true);
  f.failReleases.count = 99;
  await expect(
    f.runtime.command({
      action: "run",
      repoPath: f.world.repo,
      target: "working",
      job: "link-resolver",
    }),
  ).rejects.toThrow();
  const state = await f.world.store.read();
  expect(
    state.jobs!.find((r) => r.job === "link-resolver")!.last,
  ).toMatchObject({
    outcome: "start-failed",
  });
  expect(state.jobCheckouts).toEqual([
    { target: f.target.id, project: f.target.projectId, workspace: old },
  ]);
  f.failReleases.count = 0;
  await f.world.open().releaseJobCheckouts(f.target.id);
  expect(f.released).toEqual([old]);
});

test("rig run runs a job in any Target that is on and deployed, whatever its targets schedule", async () => {
  const f = await fixture();
  const result = (await f.runtime.command({
    action: "run",
    repoPath: f.world.repo,
    target: "working",
    job: "palettes",
  })) as { outcome: string; job: string };
  expect(result).toMatchObject({ outcome: "started", job: "palettes" });
  expect(f.processes.get(`${f.target.id}:job:palettes`)).toMatchObject({
    state: "running",
  });
  // The schedule never runs it here.
  expect(
    await f.runtime.runScheduledJob({
      targetId: f.target.id,
      job: "palettes",
      scheduledFor: f.world.clock.ms,
      id: "scheduled",
    }),
  ).toBe("passed");
});
