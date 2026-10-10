import { expect, test } from "bun:test";
import type { PlanJob } from "../src/config/types";
import type {
  JobRecord,
  RuntimeState,
  StateStore,
  TargetRecord,
} from "../src/domain/runtime";
import type { ProcessObservation } from "../src/providers/contracts";
import {
  JOB_CHECKOUT_RETRY_MS,
  JOB_LATE_LIMIT_MS,
  createJobScheduler,
  pastTimeout,
  type ScheduledRunRequest,
  type ScheduledRunResult,
} from "../src/runtime/job-scheduler";
import { jobReports } from "../src/runtime/job-status";
import {
  recordSkippedRun,
  settleJobRun,
  startJobRun,
  stopJobRun,
} from "../src/runtime/jobs";
import { logComponents } from "../src/runtime/log-services";

const ZONE = "America/Chicago";
const at = (iso: string) => Date.parse(iso);

/** A state file in memory: reads and writes copy, and writes are applied one at a time, each to the state as the one
 * before it left it, as the file store's are. */
function memoryStore(
  state: RuntimeState,
): StateStore & { state: RuntimeState } {
  let queue: Promise<void> = Promise.resolve();
  const store = {
    state,
    async read() {
      return structuredClone(store.state);
    },
    update(change: (state: RuntimeState) => void | Promise<void>) {
      const next = queue.then(async () => {
        const draft = structuredClone(store.state);
        await change(draft);
        store.state = draft;
      });
      queue = next.catch(() => {});
      return next;
    },
  };
  return store;
}
function stableTarget(
  jobs: PlanJob[],
  extra: Partial<TargetRecord> = {},
): TargetRecord {
  return {
    id: "t1",
    projectId: "p1",
    name: "stable",
    kind: "stable",
    desired: "running",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    logRoot: "/rig/logs",
    sourceRoot: "/rig/targets/p1/t1/revisions",
    plan: {
      project: "melody",
      target: "stable",
      workspacePath: "/rig/targets/p1/t1/revisions/r2",
      dataRoot: "/rig/data",
      deploymentName: "stable",
      branchSlug: "stable",
      subdomain: "stable",
      providers: { processSupervisor: "rigd" },
      components: [],
      preparedComponents: [],
      jobs,
    },
    ...extra,
  };
}
const job = (
  name: string,
  schedule: string,
  extra: Partial<PlanJob> = {},
): PlanJob => ({
  name,
  command: `run ${name}`,
  env: {},
  schedule,
  timeZone: ZONE,
  ...extra,
});

/** A scheduler over one Target whose runtime side (`start`, `settle`, `releaseCheckouts`) runs the real run journal against
 * the in-memory state, as rigd's runtime does under the Target's lease, with scripted processes: a started run stays
 * running until the test ends it. `restart` stands for a new rigd: a fresh scheduler, the same state and processes. */
function world(target: TargetRecord, jobs: JobRecord[] = []) {
  const store = memoryStore({
    version: 6,
    projects: [
      {
        id: "p1",
        name: "melody",
        repoPath: "/src/melody",
        configPath: "/src/melody/rig.yaml",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ],
    targets: [target],
    activity: [],
    jobs,
  });
  const clock = { ms: 0 };
  const processes = new Map<string, ProcessObservation>();
  const started: { job: string; id: string }[] = [];
  const stops: string[] = [];
  const released: string[] = [];
  const offChecks: string[] = [];
  const requests: ScheduledRunRequest[] = [];
  let ids = 0;
  let busy = false;
  let deferring = false;
  let releasing = true;
  const now = () => new Date(clock.ms).toISOString();
  const lifecycle = {
    async startJob(
      _target: TargetRecord,
      planned: PlanJob,
      incarnation: string,
    ) {
      started.push({ job: planned.name, id: incarnation });
      processes.set(planned.name, { state: "running", incarnation });
    },
    async observeJob(_target: TargetRecord, name: string) {
      return processes.get(name) ?? { state: "stopped" as const };
    },
    async stopJob(_target: TargetRecord, planned: Pick<PlanJob, "name">) {
      // As the supervisor does, a job with nothing running is left alone, unannounced.
      if (processes.get(planned.name)?.state !== "running")
        return { outcome: "unchanged" as const };
      stops.push(planned.name);
      processes.set(planned.name, { state: "stopped" });
      return { outcome: "stopped" as const };
    },
  };
  const runDeps = { store, lifecycle, now };
  const recorded = async () =>
    (await store.read()).targets.find((t) => t.id === "t1")!;
  const scheduler = () =>
    createJobScheduler({
      store,
      lifecycle,
      clock: { now: () => clock.ms, timeZone: () => "UTC" },
      id: () => `id${++ids}`,
      busy: () => busy,
      async start(request): Promise<ScheduledRunResult> {
        requests.push(request);
        if (deferring) return "deferred";
        const target = await recorded();
        const planned = target.plan.jobs!.find((j) => j.name === request.job)!;
        try {
          await startJobRun(
            target,
            planned,
            {
              id: request.id,
              trigger: "schedule",
              scheduledFor: request.scheduledFor,
            },
            runDeps,
          );
          return "started";
        } catch (error) {
          if ((error as { code?: string }).code !== "JOB_RUNNING") throw error;
          await recordSkippedRun(
            target,
            planned.name,
            request.scheduledFor,
            `skip${++ids}`,
            runDeps,
          );
          return "skipped";
        }
      },
      async settle(request) {
        const target = await recorded();
        const run = (await store.read()).jobs?.find(
          (r) => r.job === request.job,
        )?.running;
        if (run?.id !== request.runId) return;
        if (pastTimeout(run, clock.ms))
          await stopJobRun(target, request.job, run, "timed-out", runDeps);
        else await settleJobRun(target, request.job, run.id, runDeps);
      },
      async releaseCheckouts(targetId) {
        if (!releasing) return;
        const kept = (await store.read()).jobCheckouts ?? [];
        released.push(
          ...kept.filter((k) => k.target === targetId).map((k) => k.workspace),
        );
        await store.update((state) => {
          state.jobCheckouts = state.jobCheckouts?.filter(
            (k) => k.target !== targetId,
          );
        });
      },
      async stopJobsIfOff(targetId) {
        offChecks.push(targetId);
      },
      async diagnostic() {},
    });
  let current = scheduler();
  const pass = async (iso?: string) => {
    if (iso) clock.ms = at(iso);
    await current.pass();
    await current.idle();
  };
  return {
    store,
    clock,
    processes,
    started,
    stops,
    released,
    offChecks,
    requests,
    pass,
    restart() {
      current = scheduler();
    },
    end(name: string, exitCode: number) {
      const running = processes.get(name);
      processes.set(name, {
        state: "stopped",
        incarnation: running?.incarnation,
        exitCode,
      });
    },
    setBusy(value: boolean) {
      busy = value;
    },
    setDeferring(value: boolean) {
      deferring = value;
    },
    setReleasing(value: boolean) {
      releasing = value;
    },
    record: (name: string) => store.state.jobs?.find((r) => r.job === name),
  };
}

test("a due time starts one run, which is recorded as it ends with its exit, and Activity says so", async () => {
  const w = world(stableTarget([job("link-resolver", "17 */6 * * *")]));
  await w.pass("2026-10-10T17:16:00Z"); // 12:16 in Chicago: first sight, nothing due
  await w.pass("2026-10-10T17:16:59Z");
  expect(w.started).toEqual([]);
  await w.pass("2026-10-10T17:17:00.500Z");
  await w.pass("2026-10-10T17:17:01Z");
  expect(w.started).toEqual([{ job: "link-resolver", id: "id1" }]);
  expect(w.record("link-resolver")).toMatchObject({
    running: {
      id: "id1",
      trigger: "schedule",
      scheduledFor: "2026-10-10T17:17:00.000Z",
      workspace: "/rig/targets/p1/t1/revisions/r2",
    },
    lastScheduled: "2026-10-10T17:17:00.000Z",
  });
  w.end("link-resolver", 0);
  await w.pass("2026-10-10T17:20:12Z");
  expect(w.record("link-resolver")).toEqual({
    target: "t1",
    job: "link-resolver",
    watchedFrom: "2026-10-10T17:16:00.000Z",
    lastScheduled: "2026-10-10T17:17:00.000Z",
    last: expect.objectContaining({
      id: "id1",
      outcome: "succeeded",
      exitCode: 0,
      finishedAt: "2026-10-10T17:20:12.000Z",
    }),
  });
  expect(w.store.state.activity).toEqual([
    expect.objectContaining({
      id: "id1",
      project: "melody",
      target: "stable",
      action: "job",
      outcome: "succeeded",
      message: "link-resolver: succeeded in 3m12s",
    }),
  ]);
  // Status shows the last run and counts the next from now, in the job's zone.
  const [report] = jobReports(
    w.store.state.targets[0]!,
    w.store.state.jobs,
    at("2026-10-10T17:21:00Z"),
    { timeZone: () => "UTC" },
    true,
  )!;
  expect(report).toMatchObject({
    name: "link-resolver",
    timeZone: ZONE,
    state: "idle",
    scheduled: true,
    nextRunAt: "2026-10-10T23:17:00.000Z",
    last: { outcome: "succeeded", durationMs: 191500, exitCode: 0 },
  });
});

test("a time due while the run before it still goes is skipped and recorded once per run, then counted", async () => {
  const w = world(stableTarget([job("artist-images", "*/10 * * * *")]));
  await w.pass("2026-10-10T17:05:00Z");
  await w.pass("2026-10-10T17:10:00Z");
  await w.pass("2026-10-10T17:20:00Z");
  await w.pass("2026-10-10T17:30:00Z");
  expect(w.started.length).toBe(1);
  expect(w.record("artist-images")!.running).toMatchObject({ skipped: 2 });
  expect(w.store.state.activity.map((a) => a.outcome)).toEqual(["skipped"]);
  expect(w.store.state.activity[0]!.message).toContain(
    "skipped the run scheduled for 2026-10-10T17:20:00.000Z",
  );
  w.end("artist-images", 1);
  await w.pass("2026-10-10T17:31:00Z");
  expect(w.store.state.activity.at(-1)).toMatchObject({
    outcome: "failed",
    message:
      "artist-images: failed in 21m00s: exit 1; skipped 2 scheduled times while it ran",
  });
  // The next time runs again.
  await w.pass("2026-10-10T17:40:00Z");
  expect(w.started.length).toBe(2);
});

test("missed times are not caught up: a long sleep runs at most the latest time within the late limit", async () => {
  const w = world(stableTarget([job("tick", "* * * * *")]));
  await w.pass("2026-10-10T12:00:30Z");
  // The Mac slept for eight hours: hundreds of minutes passed, one run starts, for the latest minute.
  await w.pass("2026-10-10T20:00:30Z");
  expect(w.requests.map((r) => new Date(r.scheduledFor).toISOString())).toEqual(
    ["2026-10-10T20:00:00.000Z"],
  );
  // A weekly job whose time passed more than the late limit ago does not run at all.
  const weekly = world(stableTarget([job("mb-mirror", "0 7 * * 3,6")]));
  await weekly.pass("2026-10-14T11:00:00Z");
  await weekly.pass("2026-10-14T12:00:00Z"); // 07:00 Chicago, due now
  expect(weekly.requests.length).toBe(1);
  const slept = world(stableTarget([job("mb-mirror", "0 7 * * 3,6")]));
  await slept.pass("2026-10-14T11:00:00Z");
  await slept.pass(
    new Date(
      at("2026-10-14T12:00:00Z") + JOB_LATE_LIMIT_MS + 1000,
    ).toISOString(),
  );
  expect(slept.requests).toEqual([]);
});

test("a new rigd runs a time a short restart missed, never one a run already had, and nothing for a new job", async () => {
  const target = stableTarget([job("catalog-etl", "0 11 * * 3,6")]);
  // rigd went down at 15:59 UTC and starts again at 16:02; 11:00 Chicago (16:00 UTC) passed while it was down.
  const restarted = world(target, [
    {
      target: "t1",
      job: "catalog-etl",
      lastScheduled: "2026-10-10T16:00:00.000Z",
    },
  ]);
  await restarted.pass("2026-10-14T16:02:00Z");
  expect(
    restarted.requests.map((r) => new Date(r.scheduledFor).toISOString()),
  ).toEqual(["2026-10-14T16:00:00.000Z"]);
  const alreadyRan = world(target, [
    {
      target: "t1",
      job: "catalog-etl",
      lastScheduled: "2026-10-14T16:00:00.000Z",
    },
  ]);
  await alreadyRan.pass("2026-10-14T16:02:00Z");
  expect(alreadyRan.requests).toEqual([]);
  const fresh = world(target);
  await fresh.pass("2026-10-14T16:02:00Z");
  expect(fresh.requests).toEqual([]);
});

test("the first time rigd sees a job is recorded, so a restart just after a time it would have run still runs it", async () => {
  // The mirror runs at 07:00 Chicago (12:00 UTC) on Wednesdays; rigd first sees it at 06:59 and restarts at 07:02.
  const w = world(stableTarget([job("mb-mirror", "0 7 * * 3,6")]));
  await w.pass("2026-10-14T11:59:00Z");
  expect(w.record("mb-mirror")).toEqual({
    target: "t1",
    job: "mb-mirror",
    watchedFrom: "2026-10-14T11:59:00.000Z",
  });
  w.restart();
  await w.pass("2026-10-14T12:02:00Z");
  expect(w.requests.map((r) => new Date(r.scheduledFor).toISOString())).toEqual(
    ["2026-10-14T12:00:00.000Z"],
  );
  expect(w.started.length).toBe(1);
});

test("a job its targets do not name here is never scheduled, though a run of it is still settled", async () => {
  const w = world(
    stableTarget([job("palettes", "* * * * *", { scheduled: false })]),
  );
  await w.pass("2026-10-10T12:00:30Z");
  await w.pass("2026-10-10T12:05:30Z");
  expect(w.requests).toEqual([]);
  expect(w.record("palettes")).toBeUndefined();
});

test("a stop Rig decided on before a restart is recorded with its cause by the next rigd", async () => {
  // rigd recorded that the run timed out, signalled it, and stopped before it recorded the end; the process's own exit
  // record survived, saying SIGTERM.
  const w = world(stableTarget([job("mb-mirror", "0 7 * * 3,6")]), [
    {
      target: "t1",
      job: "mb-mirror",
      running: {
        id: "run-1",
        trigger: "schedule",
        startedAt: "2026-10-14T12:00:00.000Z",
        timeout: 3600,
        stopping: { cause: "timed-out", at: "2026-10-14T13:00:00.000Z" },
      },
    },
  ]);
  w.processes.set("mb-mirror", {
    state: "stopped",
    incarnation: "run-1",
    signal: "SIGTERM",
  });
  await w.pass("2026-10-14T13:00:30Z");
  expect(w.record("mb-mirror")!.last).toMatchObject({
    id: "run-1",
    outcome: "timed-out",
    signal: "SIGTERM",
  });
  expect(w.record("mb-mirror")!.last).not.toHaveProperty("stopping");
});

test("a Target not meant to run passes its times over and records that it did, so a restart after rig up never runs one", async () => {
  const stopped = world(
    stableTarget([job("tick", "* * * * *")], { desired: "stopped" }),
  );
  await stopped.pass("2026-10-10T12:00:30Z");
  await stopped.pass("2026-10-10T12:01:30Z");
  expect(stopped.requests).toEqual([]);
  expect(stopped.record("tick")).toEqual({
    target: "t1",
    job: "tick",
    watchedFrom: "2026-10-10T12:00:30.000Z",
    lastScheduled: "2026-10-10T12:01:00.000Z",
  });
  // rig up, then rigd restarts within the late limit: 12:01 was passed over, not missed.
  stopped.store.state.targets[0]!.desired = "running";
  stopped.restart();
  await stopped.pass("2026-10-10T12:01:40Z");
  expect(stopped.requests).toEqual([]);
});

test("a deferred time is tried again", async () => {
  const w = world(stableTarget([job("tick", "* * * * *")]));
  await w.pass("2026-10-10T12:00:30Z");
  w.setDeferring(true);
  await w.pass("2026-10-10T12:01:01Z");
  w.setDeferring(false);
  await w.pass("2026-10-10T12:01:02Z");
  expect(w.requests.map((r) => r.scheduledFor)).toEqual([
    at("2026-10-10T12:01:00Z"),
    at("2026-10-10T12:01:00Z"),
  ]);
  expect(w.started.length).toBe(1);
});

test("a run past its timeout is stopped and recorded as timed out; none is settled while its Target is busy", async () => {
  const w = world(
    stableTarget([
      job("mb-mirror", "0 7 * * 3,6", { timeout: 3600, stopTimeout: 30 }),
    ]),
  );
  await w.pass("2026-10-14T11:59:00Z");
  await w.pass("2026-10-14T12:00:00Z");
  expect(w.record("mb-mirror")!.running).toMatchObject({
    timeout: 3600,
    stopTimeout: 30,
  });
  w.setBusy(true);
  await w.pass("2026-10-14T13:00:01Z");
  expect(w.stops).toEqual([]);
  w.setBusy(false);
  await w.pass("2026-10-14T13:00:02Z");
  expect(w.stops).toEqual(["mb-mirror"]);
  expect(w.record("mb-mirror")!.last).toMatchObject({ outcome: "timed-out" });
  expect(w.store.state.activity.at(-1)).toMatchObject({
    outcome: "failed",
    message: "mb-mirror: timed out in 1h00m and was stopped",
  });
});

test("a run that ended on its own before its timeout was noticed keeps its own exit", async () => {
  const w = world(
    stableTarget([job("palettes", "43 4 * * *", { timeout: 1800 })]),
  );
  await w.pass("2026-10-10T09:42:00Z");
  await w.pass("2026-10-10T09:43:00Z");
  // It exits at 29 minutes while a deploy holds the Target, which is free again past its deadline.
  w.setBusy(true);
  w.end("palettes", 0);
  await w.pass("2026-10-10T10:12:00Z");
  w.setBusy(false);
  await w.pass("2026-10-10T10:20:00Z");
  expect(w.stops).toEqual([]);
  expect(w.record("palettes")!.last).toMatchObject({
    outcome: "succeeded",
    exitCode: 0,
  });
});

test("a run a deploy left on its earlier checkout ends there, even when the new plan dropped the job, and the checkout is given back", async () => {
  const target = stableTarget([job("tick", "0 0 1 1 *")]);
  const w = world(target, [
    {
      target: "t1",
      job: "removed",
      running: {
        id: "old",
        trigger: "manual",
        startedAt: "2026-10-10T12:00:00.000Z",
        workspace: "/rig/targets/p1/t1/revisions/r1",
      },
    },
  ]);
  w.processes.set("removed", { state: "running", incarnation: "old" });
  await w.pass("2026-10-10T12:30:00Z");
  expect(w.record("removed")!.running).toBeDefined();
  expect(w.offChecks).toEqual(["t1"]);
  w.end("removed", 0);
  await w.pass("2026-10-10T12:31:00Z");
  // The checkout is recorded with the run's end, in the same write, and offered back by the next pass.
  expect(w.store.state.jobCheckouts).toEqual([
    {
      target: "t1",
      project: "p1",
      workspace: "/rig/targets/p1/t1/revisions/r1",
    },
  ]);
  expect(w.record("removed")!.last).toMatchObject({ outcome: "succeeded" });
  await w.pass("2026-10-10T12:31:01Z");
  expect(w.released).toEqual(["/rig/targets/p1/t1/revisions/r1"]);
  expect(w.store.state.jobCheckouts).toEqual([]);
  // Its record goes once it ended, since no plan runs the job any more.
  expect(w.record("removed")).toBeUndefined();
  expect(w.store.state.activity.at(-1)).toMatchObject({
    outcome: "succeeded",
    message: "removed: succeeded in 31m00s (rig run)",
  });
});

test("a kept checkout that could not be given back is offered again, by this rigd and by the next", async () => {
  const w = world(stableTarget([job("tick", "0 0 1 1 *")]));
  w.store.state.jobCheckouts = [
    {
      target: "t1",
      project: "p1",
      workspace: "/rig/targets/p1/t1/revisions/r1",
    },
  ];
  w.setReleasing(false);
  await w.pass("2026-10-10T12:00:00Z");
  await w.pass("2026-10-10T12:00:10Z");
  expect(w.released).toEqual([]);
  // rigd stops before it could give it back; the next one finds the record and offers it at once.
  w.setReleasing(true);
  w.restart();
  await w.pass("2026-10-10T12:00:11Z");
  expect(w.released).toEqual(["/rig/targets/p1/t1/revisions/r1"]);
  // Without a restart, an offer that did not take is repeated after the retry interval.
  const again = world(stableTarget([job("tick", "0 0 1 1 *")]));
  again.store.state.jobCheckouts = [
    {
      target: "t1",
      project: "p1",
      workspace: "/rig/targets/p1/t1/revisions/r1",
    },
  ];
  again.setReleasing(false);
  await again.pass("2026-10-10T12:00:00Z");
  again.setReleasing(true);
  await again.pass("2026-10-10T12:00:10Z");
  expect(again.released).toEqual([]);
  await again.pass(
    new Date(at("2026-10-10T12:00:00Z") + JOB_CHECKOUT_RETRY_MS).toISOString(),
  );
  expect(again.released).toEqual(["/rig/targets/p1/t1/revisions/r1"]);
});

test("status and logs keep a run whose job a deploy removed, unscheduled", () => {
  const target = stableTarget([job("tick", "0 0 1 1 *")]);
  const records: JobRecord[] = [
    {
      target: "t1",
      job: "removed",
      running: {
        id: "old",
        trigger: "schedule",
        startedAt: "2026-10-10T12:00:00.000Z",
        workspace: "/rig/targets/p1/t1/revisions/r1",
      },
    },
  ];
  const reports = jobReports(
    target,
    records,
    at("2026-10-10T12:30:00Z"),
    { timeZone: () => "UTC" },
    true,
  )!;
  expect(reports.map((report) => report.name)).toEqual(["tick", "removed"]);
  expect(reports[1]).toMatchObject({
    name: "removed",
    state: "running",
    scheduled: false,
    removed: true,
    running: { startedAt: "2026-10-10T12:00:00.000Z" },
  });
  expect(reports[1]).not.toHaveProperty("nextRunAt");
  expect(logComponents(target, records)).toEqual(["removed", "tick", "setup"]);
  // A job planned here but not named by its targets is reported as rig run only.
  const manual = jobReports(
    stableTarget([job("palettes", "43 4 * * *", { scheduled: false })]),
    [],
    at("2026-10-10T12:30:00Z"),
    { timeZone: () => "UTC" },
    true,
  )!;
  expect(manual[0]).toMatchObject({
    scheduled: false,
    reason:
      "jobs.palettes.targets does not name stable, so only rig run runs it here.",
  });
  expect(manual[0]).not.toHaveProperty("nextRunAt");
});
