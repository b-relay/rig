import { afterEach, expect, test } from "bun:test";
import { RigError } from "../src/domain/errors";
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
  const ownership = { refuse: false };
  /** Checkouts the mirror was asked to drop; `failReleases` makes the next ones fail. */
  const released: string[] = [];
  const failReleases = { count: 0 };
  // The world is made below; a stop reads its state file then.
  let readState = async (): Promise<RuntimeState> => {
    throw new Error("no world yet");
  };
  let starts = 0;
  let failStarts = false;
  /** Set by `holdNextStart`: the next spawn says it was reached, then waits for the test to let it finish. */
  let hold: { reached(): void; released: Promise<void> } | undefined;
  const supervisor: Supervisor = {
    async observe(key) {
      return processes.get(key) ?? { state: "stopped" };
    },
    async ensureRunning(request) {
      if (processes.get(request.key)?.state === "running")
        return { outcome: "unchanged" };
      starts++;
      if (failStarts) throw new Error("spawn failed");
      const held = hold;
      hold = undefined;
      if (held) {
        held.reached();
        await held.released;
      }
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
      // Ports as declared, and a Preview deletion that changes nothing on disk.
      files: {
        async selectPorts(input: {
          requests: { name: string; preferred?: number }[];
        }) {
          return Object.fromEntries(
            input.requests.map((request) => [request.name, request.preferred!]),
          );
        },
        async inspectPreviewDeletion() {
          if (ownership.refuse)
            throw new RigError("DESTROY_OWNERSHIP", "Not Rig's", "Check it");
        },
        async destroyPreview() {},
      } as unknown as RuntimeDependencies["files"],
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
    ownership,
    released,
    failReleases,
    starts: () => starts,
    failStarts(value: boolean) {
      failStarts = value;
    },
    /** Holds the next spawn open: `reached` resolves once it began, and it finishes when `release` is called. */
    holdNextStart() {
      let reached!: () => void, release!: () => void;
      const reachedPromise = new Promise<void>(
        (resolve) => (reached = resolve),
      );
      const released = new Promise<void>((resolve) => (release = resolve));
      hold = { reached, released };
      return { reached: reachedPromise, release };
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
/** Records the fixture's working Target as the Preview feat-1a2b3c4d and destroys it through rig down --destroy. */
async function destroyPreviewOf(
  world: Awaited<ReturnType<typeof fixture>>["world"],
  target: { id: string },
) {
  await world.store.update((state) => {
    const recorded = state.targets.find((t) => t.id === target.id)!;
    recorded.kind = "preview";
    recorded.name = "feat-1a2b3c4d";
    recorded.plan.target = "preview";
    recorded.plan.deploymentName = "feat-1a2b3c4d";
  });
  return await world.open().command({
    action: "destroy",
    repoPath: world.repo,
    target: "preview",
    deployment: "feat-1a2b3c4d",
  });
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

test("a time is passed over, and recorded so under the lease, when the Target is stopped, turned off in rig.yaml, or reached past the late limit", async () => {
  const f = await fixture();
  const lastScheduled = async () => (await f.record())?.lastScheduled;
  const late = f.world.clock.ms - JOB_LATE_LIMIT_MS - 1000;
  expect(await f.scheduled("late", late)).toBe("passed");
  expect(await lastScheduled()).toBe(new Date(late).toISOString());
  // Turned off in rig.yaml while the time waited: 12:01 is passed over, and a rigd started at 12:01:10 counts from it.
  f.config.targets = { working: false };
  f.world.clock.ms += 60_000;
  expect(await f.scheduled("off")).toBe("passed");
  expect(await lastScheduled()).toBe(new Date(f.world.clock.ms).toISOString());
  f.config.targets = { working: true };
  await f.runtime.command({
    action: "down",
    repoPath: f.world.repo,
    target: "working",
  });
  f.world.clock.ms += 60_000;
  expect(await f.scheduled("stopped")).toBe("passed");
  expect(await lastScheduled()).toBe(new Date(f.world.clock.ms).toISOString());
  expect((await f.record())?.running).toBeUndefined();
  expect(f.processes.get(f.key)).toBeUndefined();
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

test("a timeout request queued behind the Target's lease while run A exits and run B starts never touches B", async () => {
  const f = await fixture();
  expect(await f.scheduled("run-a")).toBe("started");
  f.world.clock.ms += 3600_000 + 1000;
  // rig run of B holds the Target: A has exited, and B's spawn is held open until the test lets it finish.
  f.processes.set(f.key, {
    state: "stopped",
    incarnation: "run-a",
    exitCode: 0,
  });
  const spawn = f.holdNextStart();
  const runB = f.runtime.command({
    action: "run",
    repoPath: f.world.repo,
    target: "working",
    job: "link-resolver",
    operationId: "run-b",
  });
  await spawn.reached;
  // The scheduler judged A past its timeout before it exited; its request now waits for the Target.
  let settled = false;
  const timeout = f.runtime
    .settleJob({ targetId: f.target.id, job: "link-resolver", runId: "run-a" })
    .then(() => {
      settled = true;
    });
  await Bun.sleep(20);
  expect(settled).toBe(false);
  spawn.release();
  await runB;
  await timeout;
  expect(f.signalled).toEqual([]);
  expect(f.processes.get(f.key)).toMatchObject({
    state: "running",
    incarnation: "run-b",
  });
  expect(await f.record()).toMatchObject({
    running: { id: "run-b" },
    last: { id: "run-a", outcome: "succeeded" },
  });
});

test("a run whose process names no run is never signalled, and rig down reports it while still stopping the Services", async () => {
  const f = await fixture();
  expect(await f.scheduled("run-a")).toBe("started");
  // Adopted from a lease that recorded no incarnation: it cannot be shown to be run A.
  f.processes.set(f.key, { state: "running", pid: 4321 });
  f.world.clock.ms += 3600_000 + 1000;
  await f.runtime.settleJob({
    targetId: f.target.id,
    job: "link-resolver",
    runId: "run-a",
  });
  expect(f.signalled).toEqual([]);
  await expect(
    f.runtime.command({
      action: "down",
      repoPath: f.world.repo,
      target: "working",
    }),
  ).rejects.toMatchObject({ code: "JOB_STOP_UNVERIFIED" });
  expect(f.signalled.map((stop) => stop.key)).toEqual([`${f.target.id}:api`]);
  expect(f.processes.get(`${f.target.id}:api`)?.state).toBe("stopped");
  expect((await f.record())?.running).toMatchObject({ id: "run-a" });
});

test("a run that cannot be confirmed stopped keeps a Preview from being destroyed", async () => {
  const f = await fixture();
  expect(await f.scheduled("run-a")).toBe("started");
  f.processes.set(f.key, { state: "unknown" });
  // The working Target stands in for a Preview: destroy's first step is the job stop.
  const target = (await f.world.store.read()).targets[0]!;
  await expect(destroyPreviewOf(f.world, target)).rejects.toMatchObject({
    code: "JOB_STOP_UNVERIFIED",
  });
  const after = (await f.world.store.read()).targets[0]!;
  expect(after.destructionPending).toBeUndefined();
  expect(after.desired).toBe("running");
});

test("a Preview with a recovery to settle keeps its recovery and Services when a run cannot be confirmed stopped", async () => {
  const f = await fixture();
  expect(await f.scheduled("run-a")).toBe("started");
  f.processes.set(f.key, { state: "unknown" });
  await f.world.store.update((state) => {
    const recorded = state.targets[0]!;
    recorded.recovery = {
      plan: recorded.plan,
      desired: "running",
      stage: "blocked",
    };
  });
  const target = (await f.world.store.read()).targets[0]!;
  await expect(destroyPreviewOf(f.world, target)).rejects.toMatchObject({
    code: "JOB_STOP_UNVERIFIED",
  });
  const after = (await f.world.store.read()).targets[0]!;
  expect(after.recovery).toMatchObject({ stage: "blocked" });
  expect(after.desired).toBe("running");
  expect(after.destructionPending).toBeUndefined();
  expect(f.signalled.map((stop) => stop.key)).not.toContain(
    `${f.target.id}:api`,
  );
});

test.each([false, true])(
  "a Preview whose storage is not Rig's to delete keeps its job run going (recovery to settle: %p)",
  async (withRecovery) => {
    const f = await fixture();
    expect(await f.scheduled("run-a")).toBe("started");
    f.ownership.refuse = true;
    if (withRecovery)
      await f.world.store.update((state) => {
        const recorded = state.targets[0]!;
        recorded.recovery = {
          plan: recorded.plan,
          desired: "running",
          stage: "blocked",
        };
      });
    const target = (await f.world.store.read()).targets[0]!;
    await expect(destroyPreviewOf(f.world, target)).rejects.toMatchObject({
      code: "DESTROY_OWNERSHIP",
    });
    expect(f.signalled).toEqual([]);
    expect((await f.record())?.running).toMatchObject({ id: "run-a" });
    expect((await f.world.store.read()).targets[0]!.desired).toBe("running");
  },
);

test("a removed Target's kept checkouts are forgotten only once given back", async () => {
  const f = await fixture();
  await f.world.store.update((state) => {
    state.jobCheckouts = [
      { target: "gone", project: "p", workspace: "/rig/revisions/r1" },
      { target: "gone", project: "p", workspace: "/rig/revisions/r2" },
    ];
  });
  f.failReleases.count = 1;
  await f.runtime.releaseJobCheckouts("gone");
  expect(f.released).toEqual(["/rig/revisions/r2"]);
  expect((await f.world.store.read()).jobCheckouts).toEqual([
    { target: "gone", project: "p", workspace: "/rig/revisions/r1" },
  ]);
  await f.runtime.releaseJobCheckouts("gone");
  expect(f.released).toEqual(["/rig/revisions/r2", "/rig/revisions/r1"]);
  expect((await f.world.store.read()).jobCheckouts).toEqual([]);
});
