import { expect, test } from "bun:test";
import type { HealthMonitorPlan, ManagedComponent } from "../src/config/types";
import { HEALTH_RESTART_BACKOFF_MS } from "../src/domain/health-policy";
import type { RuntimeState, TargetRecord } from "../src/domain/runtime";
import {
  createHealthMonitor,
  type HealthRestartRequest,
} from "../src/runtime/health-monitor";

/** One Stable Target with Services under a fake clock: the monitor runs a pass every second of fake time, every check
 * answers as `answer` says, and each restart starts a new process. */
function fixture(
  /** The Services' ongoing check policy; null for Services checked only at start. */
  monitor: Partial<HealthMonitorPlan> | null = {},
  options: { services?: string[]; concurrency?: number } = {},
) {
  let now = 0;
  const timers: { at: number; fire: () => void }[] = [];
  const services = options.services ?? ["web"];
  const component = (name: string): ManagedComponent => ({
    kind: "managed",
    name,
    command: `serve ${name}`,
    env: {},
    dependsOn: [],
    readyTimeout: 30,
    health: `http://127.0.0.1:4000/${name}`,
    ...(monitor
      ? {
          healthMonitor: {
            interval: 30,
            timeout: 5,
            failures: 3,
            onFailure: "report",
            ...monitor,
          },
        }
      : {}),
  });
  const target = {
    id: "t1",
    projectId: "p1",
    name: "live",
    kind: "live",
    desired: "running",
    createdAt: "",
    updatedAt: "",
    logRoot: "/logs",
    plan: {
      project: "demo",
      target: "live",
      workspacePath: "/work",
      dataRoot: "/data",
      deploymentName: "live",
      branchSlug: "live",
      subdomain: "live",
      providers: { processSupervisor: "rigd" },
      components: services.map(component),
      preparedComponents: [],
    },
    services: Object.fromEntries(
      services.map((name) => [
        name,
        {
          deployment: "/work",
          intent: "running",
          incarnation: `${name}-1`,
          attempts: [],
        },
      ]),
    ),
  } as unknown as TargetRecord;
  const state: RuntimeState = {
    version: 4,
    projects: [
      {
        id: "p1",
        name: "demo",
        repoPath: "/repo",
        configPath: "/repo/rig.yaml",
        createdAt: "",
      },
    ],
    targets: [target],
    activity: [],
  };
  const incarnations = new Map(services.map((name) => [name, 1]));
  const checks: { service: string; at: number }[] = [];
  const restarts: (HealthRestartRequest & { at: number })[] = [];
  let answer: (service: string) => Promise<boolean> | boolean = () => true;
  let busy = false;
  const monitorUnderTest = createHealthMonitor({
    store: {
      async read() {
        return structuredClone(state);
      },
      async update(change) {
        await change(state);
      },
    },
    observations: {
      async process(_target, component) {
        return {
          state: "running",
          pid: 42,
          incarnation: `${component.name}-${incarnations.get(component.name)}`,
        };
      },
      async health(_target, component) {
        checks.push({ service: component.name, at: now });
        return (await answer(component.name))
          ? { ready: true }
          : { ready: false, reason: "HTTP 503" };
      },
    },
    now: () => now,
    id: () => `id${Math.random()}`,
    busy: () => busy,
    async restart(request) {
      restarts.push({ ...request, at: now });
      const next = incarnations.get(request.service)! + 1;
      incarnations.set(request.service, next);
      // As the restart's journal records it on the Service.
      state.targets[0]!.services![request.service] = {
        deployment: "/work",
        intent: "running",
        incarnation: `${request.service}-${next}`,
        attempts: [],
        healthRestarts: {
          since: request.since,
          at: [...request.restarts, now],
        },
      };
      return "restarted";
    },
    schedule(delayMs, fire) {
      const timer = { at: now + delayMs, fire };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
    async diagnostic() {},
    ...(options.concurrency ? { concurrency: options.concurrency } : {}),
  });
  /** Runs one pass per second of fake time up to `until` (milliseconds), letting each pass's work settle. */
  const runUntil = async (until: number) => {
    while (now < until) {
      now += 1000;
      for (const timer of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.fire();
      }
      await monitorUnderTest.pass();
      await settle();
    }
  };
  return {
    monitor: monitorUnderTest,
    state,
    checks,
    restarts,
    runUntil,
    now: () => now,
    set answer(value: (service: string) => Promise<boolean> | boolean) {
      answer = value;
    },
    set busy(value: boolean) {
      busy = value;
    },
    activity: () => state.activity.map((entry) => entry.message ?? ""),
  };
}
const SECOND = 1000;
/** Lets every piece of work that waits on nothing but other promises finish; a check that hangs keeps hanging. */
async function settle() {
  for (let round = 0; round < 5; round++)
    await new Promise((resolve) => setImmediate(resolve));
}

test("a Service whose checks keep failing is restarted after failures × interval, and Activity names why", async () => {
  const f = fixture({ onFailure: "restart" });
  await f.runUntil(1 * SECOND);
  f.answer = () => false;
  await f.runUntil(200 * SECOND);
  // Seen at 1 s; checks at 31, 61 and 91 s fail; the third marks it unhealthy and it is restarted at once.
  expect(f.checks.slice(0, 3).map((check) => check.at / SECOND)).toEqual([
    31, 61, 91,
  ]);
  expect(f.restarts[0]).toMatchObject({
    service: "web",
    at: 91 * SECOND,
    attempt: 1,
    failures: 3,
    output: "HTTP 503",
    incarnation: "web-1",
  });
  expect(f.activity()).toContain(
    "web failed 3 health checks in a row (HTTP 503). Rig restarts it.",
  );
});

test("health restarts back off about 1 min, 5 min, 15 min, then hourly while the Service stays unhealthy", async () => {
  const f = fixture({ interval: 5, failures: 1, onFailure: "restart" });
  f.answer = () => false;
  await f.runUntil(9000 * SECOND);
  const at = f.restarts.map((restart) => restart.at / SECOND);
  const gaps = at.slice(1).map((time, index) => time - at[index]!);
  expect(gaps.slice(0, 5)).toEqual([60, 300, 900, 3600, 3600]);
  expect(HEALTH_RESTART_BACKOFF_MS).toEqual([
    60_000, 300_000, 900_000, 3_600_000,
  ]);
  expect(f.restarts.map((restart) => restart.attempt)).toEqual(
    at.map((_, index) => index + 1),
  );
  // Each restart after the first carries the stretch on: when it began and the restarts before it.
  expect(f.restarts[2]).toMatchObject({
    since: f.restarts[0]!.at,
    restarts: [f.restarts[0]!.at, f.restarts[1]!.at],
  });
});

test("once retry_for has passed Rig stops restarting, keeps it running as it is, and status says it gave up", async () => {
  const f = fixture({
    interval: 5,
    failures: 1,
    onFailure: "restart",
    retryFor: 600,
  });
  f.answer = () => false;
  await f.runUntil(5000 * SECOND);
  // Marked at 6 s, restarted then and 1 min and 6 min later; the next one would be at 21 min, past the 10 min it may try.
  expect(f.restarts.map((restart) => restart.at / SECOND)).toEqual([
    6, 66, 366,
  ]);
  expect(f.monitor.results({ id: "t1" }, "web")).toMatchObject({
    status: "unhealthy",
    gaveUp: true,
    restarts: 3,
  });
  expect(
    f.activity().filter((message) => message.includes("stopped restarting")),
  ).toEqual([
    "web has been unhealthy for 10 min, longer than its health.retry_for, so Rig stopped restarting it. It stays as it is and is reported unhealthy. Run rig restart live once the cause is fixed.",
  ]);
  // It keeps being checked and reported.
  expect(f.checks.at(-1)!.at).toBeGreaterThan(4990 * SECOND);
  // A passing check ends the stretch: it is healthy again, and a later failure starts a new one.
  f.answer = () => true;
  await f.runUntil(5010 * SECOND);
  expect(f.monitor.results({ id: "t1" }, "web")).toMatchObject({
    status: "healthy",
    restarts: 0,
  });
  expect(f.monitor.results({ id: "t1" }, "web")).not.toHaveProperty("gaveUp");
  expect(f.activity()).toContain("web passes its health check again.");
});

test("on_failure: report marks the Service unhealthy and never restarts it", async () => {
  const f = fixture({ onFailure: "report" });
  f.answer = () => false;
  await f.runUntil(2000 * SECOND);
  expect(f.restarts).toEqual([]);
  expect(f.monitor.results({ id: "t1" }, "web")).toMatchObject({
    status: "unhealthy",
    threshold: 3,
    output: "HTTP 503",
  });
  expect(f.monitor.results({ id: "t1" }, "web")!.failures).toBeGreaterThan(60);
  expect(
    f
      .activity()
      .filter((message) => message.includes("health checks in a row")),
  ).toEqual([
    "web failed 3 health checks in a row (HTTP 503). health.on_failure is report, so Rig only reports it.",
  ]);
});

test("no check runs while the Target is starting or stopping, and checks resume a full interval after it is free", async () => {
  const f = fixture();
  f.busy = true;
  await f.runUntil(100 * SECOND);
  expect(f.checks).toEqual([]);
  expect(f.monitor.results({ id: "t1" }, "web")).toMatchObject({
    status: "pending",
  });
  f.busy = false;
  await f.runUntil(200 * SECOND);
  expect(f.checks.map((check) => check.at / SECOND)).toEqual([131, 161, 191]);
  // Busy again between two checks: the one due is not run, and the next comes an interval after it is free again.
  f.busy = true;
  await f.runUntil(250 * SECOND);
  f.busy = false;
  await f.runUntil(300 * SECOND);
  expect(f.checks.map((check) => check.at / SECOND)).toEqual([
    131, 161, 191, 281,
  ]);
});

test("a check that hangs is never overlapped, fails after its timeout, and does not hold up the pass or other Services' checks", async () => {
  const f = fixture({ interval: 5, timeout: 5 }, { services: ["api", "web"] });
  f.answer = (service) =>
    service === "api" ? new Promise<boolean>(() => {}) : true;
  await f.runUntil(60 * SECOND);
  const api = f.checks.filter((check) => check.service === "api");
  const web = f.checks.filter((check) => check.service === "web");
  // api: checks at 6 s, then each 5 s after the last one timed out at +5 s, never two at once.
  expect(api.map((check) => check.at / SECOND)).toEqual([
    6, 16, 26, 36, 46, 56,
  ]);
  expect(web.length).toBeGreaterThan(api.length);
  expect(f.monitor.results({ id: "t1" }, "api")).toMatchObject({
    status: "unhealthy",
    output: "The check did not answer within 5 s.",
  });
});

test("at most the configured number of checks run at once across the Host", async () => {
  const services = Array.from({ length: 6 }, (_, index) => `s${index}`);
  const f = fixture({ interval: 5 }, { services, concurrency: 2 });
  let running = 0,
    most = 0;
  const release: (() => void)[] = [];
  f.answer = () => {
    running++;
    most = Math.max(most, running);
    return new Promise<boolean>((resolve) =>
      release.push(() => {
        running--;
        resolve(true);
      }),
    );
  };
  await f.runUntil(6 * SECOND);
  // Six Services are due; two checks run and four wait for a slot.
  expect(running).toBe(2);
  while (release.length) {
    release.shift()!();
    await settle();
  }
  await f.monitor.idle();
  expect(most).toBe(2);
  expect(new Set(f.checks.map((check) => check.service)).size).toBe(6);
});

test("a Service without health.interval is never checked by the monitor", async () => {
  const f = fixture(null);
  f.answer = () => false;
  await f.runUntil(300 * SECOND);
  expect(f.checks).toEqual([]);
  expect(f.monitor.results({ id: "t1" }, "web")).toBeUndefined();
});

test("a new rigd continues the unhealthy stretch a health restart recorded, and an explicit start ends it", async () => {
  const f = fixture({ interval: 5, failures: 1, onFailure: "restart" });
  f.state.targets[0]!.services!.web!.healthRestarts = {
    since: 0,
    at: [0],
  };
  f.answer = () => false;
  await f.runUntil(30 * SECOND);
  // The recorded restart at 0 s puts the next one a minute later, not at the first failure.
  expect(f.restarts).toEqual([]);
  await f.runUntil(61 * SECOND);
  expect(
    f.restarts.map((restart) => [restart.at / SECOND, restart.attempt]),
  ).toEqual([[60, 2]]);
});
