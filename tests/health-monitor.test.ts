import { expect, test } from "bun:test";
import type { HealthMonitorPlan, ManagedComponent } from "../src/config/types";
import { HEALTH_RESTART_BACKOFF_MS } from "../src/domain/health-policy";
import type { RuntimeState, TargetRecord } from "../src/domain/runtime";
import {
  createHealthMonitor,
  type HealthMonitorDependencies,
  type HealthRestartResult,
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
  /** What the next restarts do: start a new process, fail to stop the old one, or find it already replaced. */
  let restartOutcome: HealthRestartResult["outcome"] = "restarted";
  /** How long a restart waits for its Target's lock before it is attempted (fake milliseconds). */
  let lockWait = 0;
  /** An observation that answers with this process whatever runs: a stale snapshot. */
  let staleProcess: string | undefined;
  /** Observations that name no process, as leases from before incarnations did. */
  let anonymous = false;
  /** Whether the process is running, as observed. */
  let processState: "running" | "stopped" = "running";
  const dependencies: HealthMonitorDependencies = {
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
        if (processState === "stopped") return { state: "stopped" };
        return {
          state: "running",
          pid: 42,
          ...(anonymous
            ? {}
            : {
                incarnation:
                  staleProcess ??
                  `${component.name}-${incarnations.get(component.name)}`,
              }),
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
      if (restartOutcome === "skipped" || restartOutcome === "deferred")
        return { outcome: restartOutcome };
      if (restartOutcome === "failed")
        return { outcome: "failed", at: now + lockWait };
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
      return { outcome: "restarted", at: now };
    },
    schedule(delayMs, fire) {
      const timer = { at: now + delayMs, fire };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
    async diagnostic() {},
    ...(options.concurrency ? { concurrency: options.concurrency } : {}),
  };
  let monitorUnderTest = createHealthMonitor(dependencies);
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
    get monitor() {
      return monitorUnderTest;
    },
    /** A new rigd: nothing in memory, the same records. */
    restartDaemon() {
      monitorUnderTest = createHealthMonitor(dependencies);
    },
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
    set restartOutcome(value: HealthRestartResult["outcome"]) {
      restartOutcome = value;
    },
    set lockWait(value: number) {
      lockWait = value;
    },
    set staleProcess(value: string | undefined) {
      staleProcess = value;
    },
    set anonymous(value: boolean) {
      anonymous = value;
    },
    set processState(value: "running" | "stopped") {
      processState = value;
    },
    /** An operator's explicit restart: a new process, with a record that carries no unhealthy stretch. */
    replace(service: string) {
      const next = incarnations.get(service)! + 1;
      incarnations.set(service, next);
      state.targets[0]!.services![service] = {
        deployment: "/work",
        intent: "running",
        incarnation: `${service}-${next}`,
        attempts: [],
      };
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

test("a restart that could not stop the Service still counts for the back-off, and it stays marked until a check passes", async () => {
  const f = fixture({ interval: 5, failures: 1, onFailure: "restart" });
  f.answer = () => false;
  f.restartOutcome = "failed";
  await f.runUntil(200 * SECOND);
  const at = f.restarts.map((restart) => restart.at / SECOND);
  // Marked at 6 s; a stop that failed still counts, so the next attempt waits the minute.
  expect(at).toEqual([6, 66]);
  expect(f.monitor.results({ id: "t1" }, "web")).toMatchObject({
    status: "unhealthy",
    marked: true,
    restarts: 2,
  });
});

test("after a health restart the Service stays marked unhealthy while the new process has not passed a check", async () => {
  const f = fixture({ interval: 30, failures: 3, onFailure: "restart" });
  f.answer = () => false;
  await f.runUntil(92 * SECOND);
  expect(f.restarts).toHaveLength(1);
  // The new process has not been checked yet: still marked, so a Stable Target stays down and its alert timer runs on.
  expect(f.monitor.results({ id: "t1" }, "web")).toMatchObject({
    status: "unhealthy",
    marked: true,
    failures: 0,
    restarts: 1,
  });
  f.answer = () => true;
  await f.runUntil(130 * SECOND);
  expect(f.monitor.results({ id: "t1" }, "web")).toMatchObject({
    status: "healthy",
  });
  expect(f.monitor.results({ id: "t1" }, "web")).not.toHaveProperty("marked");
});

test("a restart that finds the process already replaced is dropped, and the new process is checked afresh", async () => {
  const f = fixture({ interval: 5, failures: 1, onFailure: "restart" });
  f.answer = () => false;
  f.restartOutcome = "skipped";
  await f.runUntil(6 * SECOND);
  expect(f.restarts).toHaveLength(1);
  // Meanwhile an operator restarted it: the next checks are of the new process, and the old stretch is over.
  f.replace("web");
  f.answer = () => true;
  await f.runUntil(30 * SECOND);
  expect(f.restarts).toHaveLength(1);
  expect(f.checks.at(-1)!.at).toBeGreaterThan(20 * SECOND);
  expect(f.monitor.results({ id: "t1" }, "web")).toMatchObject({
    status: "healthy",
  });
});

test("a check that waited for a slot does not run once its Target has become busy", async () => {
  const f = fixture(
    { interval: 5 },
    { services: ["api", "web"], concurrency: 1 },
  );
  let release!: () => void;
  f.answer = (service) =>
    service === "api"
      ? new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        })
      : true;
  await f.runUntil(6 * SECOND);
  // api holds the only slot; web waits for it.
  expect(f.checks.map((check) => check.service)).toEqual(["api"]);
  f.busy = true;
  release();
  await f.monitor.idle();
  expect(f.checks.map((check) => check.service)).toEqual(["api"]);
});

test("a restart that could not observe the process is asked again, without counting as a restart", async () => {
  const f = fixture({ interval: 5, failures: 1, onFailure: "restart" });
  f.answer = () => false;
  f.restartOutcome = "deferred";
  await f.runUntil(6 * SECOND);
  f.restartOutcome = "restarted";
  await f.runUntil(8 * SECOND);
  expect(
    f.restarts.map((restart) => [restart.at / SECOND, restart.attempt]),
  ).toEqual([
    [6, 1],
    [7, 1],
  ]);
});

test("a check's answer about a process that was replaced meanwhile is dropped", async () => {
  const f = fixture({ interval: 5, failures: 1 });
  let answer!: (passed: boolean) => void;
  f.answer = () => new Promise<boolean>((resolve) => (answer = resolve));
  await f.runUntil(6 * SECOND);
  expect(f.checks).toHaveLength(1);
  // An explicit restart finished while the check was out.
  f.replace("web");
  answer(false);
  await f.monitor.idle();
  expect(f.monitor.results({ id: "t1" }, "web")).not.toMatchObject({
    status: "unhealthy",
  });
  expect(f.activity()).toEqual([]);
});

test("an explicit restart clears the old process's result at the next pass, without waiting for its next check", async () => {
  const f = fixture({ interval: 3600, failures: 1 });
  f.answer = () => false;
  await f.runUntil(3602 * SECOND);
  expect(f.monitor.results({ id: "t1" }, "web")).toMatchObject({
    status: "unhealthy",
    marked: true,
  });
  f.replace("web");
  await f.runUntil(3603 * SECOND);
  expect(f.monitor.results({ id: "t1" }, "web")).toMatchObject({
    status: "pending",
  });
  expect(f.monitor.results({ id: "t1" }, "web")).not.toHaveProperty("output");
});

test("retry_for is judged while the Service stays unhealthy, not only when a new process fails again", async () => {
  const f = fixture({
    interval: 3600,
    failures: 1,
    onFailure: "restart",
    retryFor: 600,
  });
  f.answer = () => false;
  await f.runUntil(5000 * SECOND);
  // Marked and restarted at 3601 s; it gives up at 4201 s, long before the new process's first check at about 7200 s.
  expect(f.restarts.map((restart) => restart.at / SECOND)).toEqual([3601]);
  expect(f.monitor.results({ id: "t1" }, "web")).toMatchObject({
    gaveUp: true,
  });
  expect(f.state.activity.at(-1)?.occurredAt).toBe(
    new Date(4201 * SECOND).toISOString(),
  );
});

test("a new rigd remembers that Rig gave up: it neither restarts the Service again nor says so twice", async () => {
  const f = fixture({
    interval: 5,
    failures: 1,
    onFailure: "restart",
    retryFor: 600,
  });
  f.answer = () => false;
  await f.runUntil(700 * SECOND);
  const restarts = f.restarts.length;
  const gaveUp = () =>
    f.activity().filter((message) => message.includes("stopped restarting"));
  expect(gaveUp()).toHaveLength(1);
  f.restartDaemon();
  await f.runUntil(2000 * SECOND);
  expect(f.restarts).toHaveLength(restarts);
  expect(gaveUp()).toHaveLength(1);
  expect(f.monitor.results({ id: "t1" }, "web")).toMatchObject({
    status: "unhealthy",
    marked: true,
    gaveUp: true,
  });
});

test("giving up is recorded even when no restart could be made, so a new rigd keeps it", async () => {
  const f = fixture({
    interval: 5,
    failures: 1,
    onFailure: "restart",
    retryFor: 600,
  });
  f.answer = () => false;
  f.restartOutcome = "deferred";
  await f.runUntil(700 * SECOND);
  expect(f.state.targets[0]!.services!.web!.healthRestarts).toMatchObject({
    since: 6 * SECOND,
    gaveUp: 606 * SECOND,
  });
  const asked = f.restarts.length;
  f.restartDaemon();
  await f.runUntil(900 * SECOND);
  expect(f.restarts).toHaveLength(asked);
  expect(f.monitor.results({ id: "t1" }, "web")).toMatchObject({
    gaveUp: true,
  });
});

test("an answer is dropped when the record names another process, even if an observation still shows the old one", async () => {
  const f = fixture({ interval: 5, failures: 1 });
  let answer!: (passed: boolean) => void;
  f.answer = () => new Promise<boolean>((resolve) => (answer = resolve));
  await f.runUntil(6 * SECOND);
  f.staleProcess = "web-1";
  f.replace("web");
  answer(false);
  await f.monitor.idle();
  expect(f.monitor.results({ id: "t1" }, "web")).not.toMatchObject({
    status: "unhealthy",
  });
  expect(f.activity()).toEqual([]);
});

test("the back-off counts from when a restart was attempted, after it waited for its Target", async () => {
  const f = fixture({ interval: 5, failures: 1, onFailure: "restart" });
  f.answer = () => false;
  f.restartOutcome = "failed";
  // Asked at 6 s, the restart waited 5 minutes for its Target before its stop failed.
  f.lockWait = 300 * SECOND;
  await f.runUntil(400 * SECOND);
  expect(f.restarts.map((restart) => restart.at / SECOND)).toEqual([6, 366]);
});

test("with observations that name no process, the run record says which process a check asked", async () => {
  const f = fixture({ interval: 5, failures: 1 });
  f.anonymous = true;
  let answer!: (passed: boolean) => void;
  f.answer = () => new Promise<boolean>((resolve) => (answer = resolve));
  await f.runUntil(6 * SECOND);
  expect(f.checks).toHaveLength(1);
  f.replace("web");
  answer(false);
  await f.monitor.idle();
  expect(f.monitor.results({ id: "t1" }, "web")).not.toMatchObject({
    status: "unhealthy",
  });
  expect(f.activity()).toEqual([]);
});

test("an answer from a process that ended during the check is dropped, and its recorded stretch stays", async () => {
  // A long timeout, so the check is still out when the process ends.
  const f = fixture({
    interval: 5,
    timeout: 60,
    failures: 1,
    onFailure: "restart",
  });
  f.answer = () => false;
  await f.runUntil(6 * SECOND);
  expect(f.restarts).toHaveLength(1);
  const stretch = f.state.targets[0]!.services!.web!.healthRestarts;
  expect(stretch).toBeDefined();
  let answer!: (passed: boolean) => void;
  f.answer = () => new Promise<boolean>((resolve) => (answer = resolve));
  await f.runUntil(20 * SECOND);
  // The new process ends while its check is out; supervision has not recorded it yet. The late pass says nothing.
  f.processState = "stopped";
  answer(true);
  await f.monitor.idle();
  expect(f.activity()).not.toContain("web passes its health check again.");
  expect(f.state.targets[0]!.services!.web!.healthRestarts).toEqual(stretch);
});
