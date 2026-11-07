import { expect, test } from "bun:test";
import type { ManagedComponent } from "../src/config/types";
import type { RuntimeState, TargetRecord } from "../src/domain/runtime";
import { createHealthCache } from "../src/runtime/health-cache";
import {
  UNWRITTEN_HEALTH_LIMIT,
  createHealthRecords,
} from "../src/runtime/health-records";
import { createHealthWork } from "../src/runtime/health-work";
import { trackedWorkReport } from "../src/runtime/work-report";

const web = {
  kind: "managed",
  name: "web",
  health: "http://127.0.0.1:3000/health",
  healthcheck: { interval: 5, timeout: 2, retries: 1, onFailure: "restart" },
} as ManagedComponent;
const target = {
  id: "t1",
  projectId: "p1",
  name: "stable",
  plan: { project: "demo", workspacePath: "/work", components: [web] },
  services: {
    web: {
      deployment: "/work",
      intent: "running",
      incarnation: "i1",
      attempts: [],
    },
  },
} as unknown as TargetRecord;
const clock = (now = { wall: 1_000_000, elapsed: 5_000 }) => ({
  now: () => now.wall,
  elapsed: () => now.elapsed,
});
/** A fake timer queue: `fire` runs every timer due by `ms`. */
function timers() {
  let now = 0;
  const queue: { at: number; fire: () => void }[] = [];
  return {
    schedule(delayMs: number, fire: () => void) {
      const timer = { at: now + delayMs, fire };
      queue.push(timer);
      return () => void queue.splice(queue.indexOf(timer) >>> 0, 1);
    },
    advance(ms: number) {
      now += ms;
      for (const timer of queue.filter((t) => t.at <= now)) {
        queue.splice(queue.indexOf(timer), 1);
        timer.fire();
      }
    },
  };
}

test("a cache write is applied only while no transition came after the read it derives from", () => {
  const cache = createHealthCache(clock());
  const since = cache.epoch();
  expect(cache.write("t1", "web", since, { failures: 1 })).toBe(true);
  expect(cache.state("t1", "web")).toEqual({ failures: 1 });
  // The Service's own transition drops its cache and refuses what was read before it.
  cache.invalidate("t1", "web");
  expect(cache.state("t1", "web")).toBeUndefined();
  expect(cache.current("t1", "web", since)).toBe(false);
  expect(cache.write("t1", "web", since, { failures: 2 })).toBe(false);
  // Another Service's is not this one's.
  expect(cache.current("t1", "api", since)).toBe(true);
  // A Target's transition refuses every Service of it, but keeps what is cached.
  const later = cache.epoch();
  cache.write("t1", "api", later, { failures: 3 });
  cache.invalidate("t1");
  expect(cache.current("t1", "api", later)).toBe(false);
  expect(cache.state("t1", "api")).toEqual({ failures: 3 });
  expect(cache.current("t2", "api", later)).toBe(true);
  cache.stop();
  expect(cache.current("t2", "api", cache.epoch())).toBe(false);
  expect(cache.stopped()).toBe(true);
});

test("a policy is cached under the same rule", () => {
  const cache = createHealthCache(clock());
  const since = cache.epoch();
  cache.invalidate("t1", "web");
  const policy = {
    intervalMs: 1,
    timeoutMs: 1,
    retries: 1,
    onFailure: "report",
  } as const;
  expect(cache.policy("t1", "web", since, policy)).toBe(false);
  expect(cache.policy("t1", "web", cache.epoch(), policy)).toBe(true);
});

test("started caches a healthy result at once, or keeps a stretch the start carries on unhealthy", () => {
  const cache = createHealthCache(clock());
  const before = cache.epoch();
  expect(cache.started(target, "web", "i1")).toBe(true);
  expect(cache.current("t1", "web", before)).toBe(false);
  expect(cache.results(target, "web")).toEqual({
    status: "healthy",
    checkedAt: new Date(1_000_000).toISOString(),
    failures: 0,
    retries: 1,
    restarts: 0,
  });
  const carried = {
    ...target,
    services: {
      web: {
        ...target.services!.web!,
        healthStretch: { since: 1, restarts: [2] },
      },
    },
  } as TargetRecord;
  cache.started(carried, "web", "i2");
  expect(cache.results(target, "web")).toMatchObject({
    status: "unhealthy",
    restarts: 1,
  });
  // A Service with no healthcheck is not monitored.
  cache.started(
    { ...target, plan: { ...target.plan, components: [] } },
    "web",
    "i3",
  );
  expect(cache.results(target, "web")).toBeUndefined();
  cache.stop();
  expect(cache.started(target, "web", "i4")).toBe(false);
});

test("the back-off counts from the restart the monitor saw made, else the record's, placed by age", () => {
  const now = { wall: 1_000_000, elapsed: 5_000 };
  const cache = createHealthCache(clock(now));
  const stretch = { since: 900_000, restarts: [990_000] };
  expect(cache.sinceRestart("t1", "web", undefined)).toBe(0);
  expect(cache.sinceRestart("t1", "web", stretch)).toBe(10_000);
  cache.madeRestart("t1", "web", stretch, 4_000);
  expect(
    cache.sinceRestart("t1", "web", { ...stretch, restarts: [990_000, 1] }),
  ).toBe(1_000);
  cache.forgetRestart("t1", "web");
  expect(
    cache.sinceRestart("t1", "web", {
      ...stretch,
      restarts: [990_000, 999_000],
    }),
  ).toBe(1_000);
});

test("forget lets go of Services untouched since the read that nothing keeps, and of their Target", () => {
  const cache = createHealthCache(clock());
  cache.started(target, "web", "i1");
  cache.invalidate("t2");
  expect(cache.retained()).toBe(4);
  const since = cache.epoch();
  // web is kept; t2 has nothing left, so its mark goes.
  cache.forget(since, (key) => key === "t1:web");
  expect(cache.retained()).toBe(3);
  // Touched after the read: kept, though nothing keeps it.
  cache.invalidate("t1", "web");
  expect(cache.retained()).toBe(2);
  cache.forget(since, () => false);
  expect(cache.retained()).toBe(2);
  cache.forget(cache.epoch(), () => false);
  expect(cache.retained()).toBe(0);
});

test("checks share the slots: one waits for another to release", async () => {
  const work = createHealthWork({
    schedule: timers().schedule,
    concurrency: 1,
  });
  await work.slot();
  let second = false;
  const waiting = work.slot().then(() => {
    second = true;
  });
  await Promise.resolve();
  expect(second).toBe(false);
  work.release();
  await waiting;
  expect(second).toBe(true);
});

test("a probe answers, fails as a failed check, times out, or is cut short by stop", async () => {
  const clockwork = timers();
  const work = createHealthWork({
    schedule: clockwork.schedule,
    concurrency: 4,
  });
  expect(await work.withinTimeout(async () => "up", 100)).toBe("up");
  expect(
    await work.withinTimeout(async () => {
      throw new Error("refused");
    }, 100),
  ).toEqual({ ready: false, reason: "refused." });
  let aborted = false;
  const late = work.withinTimeout(
    (signal) =>
      new Promise(() =>
        signal.addEventListener("abort", () => (aborted = true)),
      ),
    100,
  );
  clockwork.advance(100);
  expect(await late).toBeUndefined();
  expect(aborted).toBe(true);
  const hung = work.withinTimeout(() => new Promise(() => {}), 100);
  const job = hung.then(() => {});
  work.track(job);
  const stopping = work.stop(5000);
  expect(await hung).toBeUndefined();
  await stopping;
  expect(await work.withinTimeout(async () => "up", 100)).toBeUndefined();
});

test("stop waits for the jobs in flight at most its bound", async () => {
  const clockwork = timers();
  const work = createHealthWork({
    schedule: clockwork.schedule,
    concurrency: 4,
  });
  work.track(new Promise(() => {}));
  let done = false;
  const stopping = work.stop(5000).then(() => (done = true));
  await Promise.resolve();
  expect(done).toBe(false);
  clockwork.advance(5000);
  await stopping;
  expect(done).toBe(true);
});

/** The records over an in-memory state whose writes can be refused. */
function recordsFixture() {
  const state = {
    projects: [{ id: "p1", name: "demo" }],
    targets: [
      {
        ...target,
        services: {
          web: {
            ...target.services!.web!,
            healthStretch: { since: 1, restarts: [] },
          },
        },
      },
    ],
    activity: [],
  } as unknown as RuntimeState;
  let refuse = false;
  const failures: string[] = [];
  const cache = createHealthCache(clock());
  let ids = 0;
  const records = createHealthRecords({
    store: {
      async update(change) {
        if (refuse) throw new Error("disk full");
        await change(state);
      },
    },
    clock: clock(),
    id: () => `id${++ids}`,
    cache,
    report: trackedWorkReport(),
    async failed(work, about) {
      failures.push(`${work}: ${about}`);
    },
  });
  return {
    state,
    cache,
    records,
    failures,
    refuse: (on: boolean) => (refuse = on),
  };
}
const entry = (n: number) => ({
  action: "health" as const,
  outcome: "failed" as const,
  message: `change ${n}`,
});

test("health records are written in order while current, and kept while the store refuses", async () => {
  const f = recordsFixture();
  const since = f.cache.epoch();
  await f.records.activity(target, "web", since, entry(1));
  expect(f.state.activity.map((a) => a.message)).toEqual(["change 1"]);
  f.refuse(true);
  await f.records.activity(target, "web", since, entry(2));
  await f.records.stretchEnded(target, "web", since, "i1");
  await f.records.stretchEnded(target, "web", since, "i1");
  expect(f.records.retained()).toBe(2);
  expect(f.records.waiting()).toEqual(["t1:web"]);
  expect(f.failures.at(-1)).toBe(
    "t1:web/record: Recording the changes of health of web on stable of demo (2 changes waiting)",
  );
  f.refuse(false);
  await f.records.write("t1:web");
  expect(f.state.activity.map((a) => a.message)).toEqual([
    "change 1",
    "change 2",
  ]);
  expect(f.state.targets[0]!.services!.web!.healthStretch).toBeUndefined();
  expect(f.records.has("t1:web")).toBe(false);
});

test("a health record a transition made stale is not written, nor queued", async () => {
  const f = recordsFixture();
  const since = f.cache.epoch();
  f.refuse(true);
  await f.records.activity(target, "web", since, entry(1));
  f.cache.invalidate("t1", "web");
  f.refuse(false);
  await f.records.write("t1:web");
  await f.records.activity(target, "web", since, entry(2));
  expect(f.state.activity).toEqual([]);
  expect(f.records.retained()).toBe(0);
});

test("past the limit the oldest Activity is dropped, and the next write says how many", async () => {
  const f = recordsFixture();
  const since = f.cache.epoch();
  f.refuse(true);
  for (let n = 1; n <= UNWRITTEN_HEALTH_LIMIT + 2; n++)
    await f.records.activity(target, "web", since, entry(n));
  expect(f.records.retained()).toBe(UNWRITTEN_HEALTH_LIMIT);
  f.refuse(false);
  await f.records.write("t1:web");
  expect(f.state.activity[0]!.message).toBe(
    "web: 2 earlier changes of health were not recorded, as Rig could not write its state.",
  );
  expect(f.state.activity.slice(1).map((a) => a.message)).toEqual(
    Array.from({ length: UNWRITTEN_HEALTH_LIMIT }, (_, i) => `change ${i + 3}`),
  );
});
