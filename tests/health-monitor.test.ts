import { expect, test } from "bun:test";
import type { HealthcheckPlan, ManagedComponent } from "../src/config/types";
import { HEALTH_RESTART_BACKOFF_MS } from "../src/domain/health-policy";
import type { RuntimeState, TargetRecord } from "../src/domain/runtime";
import {
  createHealthMonitor,
  type HealthMonitorDependencies,
  type HealthRestartRequest,
  type HealthRestartResult,
} from "../src/runtime/health-monitor";

/** One stable Target with Services under a fake clock: the monitor runs a pass every second of fake time, every check
 * answers as `answer` says, and each restart starts a new process. */
function fixture(
  /** The Services' healthcheck; null for Services whose plan has none, as a plan recorded before healthcheck. */
  healthcheck: Partial<HealthcheckPlan> | null = {},
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
    ...(healthcheck
      ? {
          healthcheck: {
            interval: 30,
            timeout: 5,
            retries: 3,
            onFailure: "report",
            ...healthcheck,
          },
        }
      : {}),
  });
  const target = {
    id: "t1",
    projectId: "p1",
    name: "stable",
    kind: "stable",
    desired: "running",
    createdAt: "",
    updatedAt: "",
    logRoot: "/logs",
    plan: {
      project: "demo",
      target: "stable",
      workspacePath: "/work",
      dataRoot: "/data",
      deploymentName: "stable",
      branchSlug: "stable",
      subdomain: "stable",
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
  const state = {
    version: 5,
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
  } as unknown as RuntimeState;
  const incarnations = new Map(services.map((name) => [name, 1]));
  const checks: { service: string; at: number; test?: string }[] = [];
  /** Every write the monitor asked of the store, by when it was asked. */
  const writes: number[] = [];
  /** The signal of each health probe asked, in order. */
  const signals: AbortSignal[] = [];
  const restarts: (HealthRestartRequest & { at: number })[] = [];
  let answer: (service: string) => Promise<boolean> | boolean = () => true;
  /** What a failed check says. */
  let reason = "HTTP 503";
  let busy = false;
  /** What the next restarts do: start a new process, fail to stop the old one, or find it already replaced. */
  let restartOutcome: HealthRestartResult["outcome"] = "restarted";
  /** How long a restart waits for its Target's lock before it is attempted (fake milliseconds). */
  let lockWait = 0;
  /** The next restarts never end, as one waiting out a long stop_timeout. */
  let restartHangs = false;
  /** An observation that answers with this process whatever runs: a stale snapshot. */
  let staleProcess: string | undefined;
  /** Observations that name no process, as leases from before incarnations did. */
  let anonymous = false;
  /** Whether the process is running, as observed. */
  let processState: "running" | "stopped" | "unknown" = "running";
  /** Runs while an observation is out, before it answers. */
  let duringObservation: (() => void) | undefined;
  const dependencies: HealthMonitorDependencies = {
    store: {
      async read() {
        return structuredClone(state);
      },
      async update(change) {
        writes.push(now);
        await change(state);
      },
    },
    observations: {
      async process(_target, component) {
        const answering = incarnations.get(component.name);
        duringObservation?.();
        if (processState !== "running") return { state: processState };
        return {
          state: "running",
          pid: 42,
          ...(anonymous
            ? {}
            : {
                incarnation: staleProcess ?? `${component.name}-${answering}`,
              }),
        };
      },
      async health(_target, component, signal) {
        checks.push({
          service: component.name,
          at: now,
          ...(component.health ? { test: component.health } : {}),
        });
        signals.push(signal);
        return (await answer(component.name))
          ? { ready: true }
          : { ready: false, reason };
      },
    },
    now: () => now,
    id: () => `id${Math.random()}`,
    busy: () => busy,
    async restart(request) {
      restarts.push({ ...request, at: now });
      if (restartHangs) return await new Promise<never>(() => {});
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
        healthStretch: {
          since: request.since,
          restarts: [...request.restarts, now],
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
      await settle();
      await monitorUnderTest.pass();
      await settle();
    }
  };
  return {
    get monitor() {
      return monitorUnderTest;
    },
    writes,
    signals,
    /** Moves the fake clock without a pass, firing the timers that come due. */
    tick(ms: number) {
      now += ms;
      for (const timer of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.fire();
      }
    },
    /** A new rigd: nothing in memory, the same records. */
    restartDaemon() {
      monitorUnderTest = createHealthMonitor(dependencies);
    },
    state,
    checks,
    restarts,
    runUntil,
    result: () => monitorUnderTest.results({ id: "t1" }, "web"),
    set answer(value: (service: string) => Promise<boolean> | boolean) {
      answer = value;
    },
    set busy(value: boolean) {
      busy = value;
    },
    set reason(value: string) {
      reason = value;
    },
    set restartOutcome(value: HealthRestartResult["outcome"]) {
      restartOutcome = value;
    },
    set lockWait(value: number) {
      lockWait = value;
    },
    set restartHangs(value: boolean) {
      restartHangs = value;
    },
    set staleProcess(value: string | undefined) {
      staleProcess = value;
    },
    set anonymous(value: boolean) {
      anonymous = value;
    },
    set processState(value: "running" | "stopped" | "unknown") {
      processState = value;
    },
    set duringObservation(value: (() => void) | undefined) {
      duringObservation = value;
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

test("a running process is checked as soon as Rig sees it with its Target free, then at its interval, and status reads the cached result", async () => {
  const f = fixture();
  await f.runUntil(1 * SECOND);
  expect(f.result()).toEqual({
    status: "healthy",
    checkedAt: new Date(1 * SECOND).toISOString(),
    failures: 0,
    retries: 3,
    restarts: 0,
  });
  await f.runUntil(100 * SECOND);
  expect(f.checks.map((check) => check.at / SECOND)).toEqual([1, 31, 61, 91]);
});

test("a Service whose checks keep failing is unhealthy after retries × interval and restarted at once with on_failure: restart, and Activity says why", async () => {
  const f = fixture({ onFailure: "restart" });
  await f.runUntil(1 * SECOND);
  f.answer = () => false;
  await f.runUntil(200 * SECOND);
  // Passed at 1 s; the checks at 31, 61 and 91 s fail, the third makes it unhealthy, and it is restarted then.
  expect(f.checks.slice(0, 4).map((check) => check.at / SECOND)).toEqual([
    1, 31, 61, 91,
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
    "web is unhealthy: 3 health checks in a row failed (HTTP 503). Rig restarts it.",
  );
});

test("health restarts back off 1 min, 5 min, 15 min, then hourly while the Service stays unhealthy", async () => {
  const f = fixture({ interval: 5, retries: 1, onFailure: "restart" });
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
  // Every restart is Rig's to record; the monitor itself records only that the Service became unhealthy, once.
  expect(
    f.activity().filter((message) => message.includes("is unhealthy")),
  ).toHaveLength(1);
});

test("on_failure: report makes the Service unhealthy and never restarts it; one passing check makes it healthy again", async () => {
  const f = fixture({ onFailure: "report" });
  f.answer = () => false;
  await f.runUntil(2000 * SECOND);
  expect(f.restarts).toEqual([]);
  expect(f.result()).toMatchObject({
    status: "unhealthy",
    retries: 3,
    output: "HTTP 503",
  });
  expect(f.result()!.failures).toBeGreaterThan(60);
  f.answer = () => true;
  await f.runUntil(2030 * SECOND);
  expect(f.result()).toMatchObject({ status: "healthy", failures: 0 });
  expect(f.result()).not.toHaveProperty("output");
  expect(f.activity()).toEqual([
    "web is unhealthy: 3 health checks in a row failed (HTTP 503). Its healthcheck's on_failure is report, so Rig only reports it.",
    "web is healthy again: its health check passed.",
  ]);
});

test("fewer failures in a row than retries leave the Service healthy, with the count and the output in its result", async () => {
  const f = fixture({ interval: 5 });
  f.answer = () => false;
  await f.runUntil(6 * SECOND);
  // Its start check passed, and Compose too calls a container healthy until `retries` checks in a row failed.
  expect(f.result()).toMatchObject({
    status: "healthy",
    failures: 2,
    output: "HTTP 503",
  });
  f.answer = () => true;
  await f.runUntil(11 * SECOND);
  f.answer = () => false;
  await f.runUntil(16 * SECOND);
  expect(f.result()).toMatchObject({ status: "healthy", failures: 1 });
  expect(f.activity()).toEqual([]);
});

test("a check's output is kept, shown and recorded as one line of at most 200 characters", async () => {
  const f = fixture({ retries: 1 });
  f.answer = () => false;
  f.reason = `exit code 1: line one\n${"x".repeat(400)}`;
  await f.runUntil(1 * SECOND);
  const output = f.result()!.output!;
  expect(output).toHaveLength(200);
  expect(output.startsWith("exit code 1: line one xxx")).toBe(true);
  expect(output.endsWith("…")).toBe(true);
  expect(f.activity()[0]).toContain(`(${output})`);
});

test("no check runs while an Operation holds or waits for the Target; once it is free a process overdue for a check is checked", async () => {
  const f = fixture();
  f.busy = true;
  await f.runUntil(100 * SECOND);
  expect(f.checks).toEqual([]);
  expect(f.result()).toMatchObject({ status: "starting" });
  f.busy = false;
  await f.runUntil(200 * SECOND);
  expect(f.checks.map((check) => check.at / SECOND)).toEqual([
    101, 131, 161, 191,
  ]);
  // Busy across the check due at 221 s: it waits for the Target to be free at 251 s.
  f.busy = true;
  await f.runUntil(250 * SECOND);
  f.busy = false;
  await f.runUntil(300 * SECOND);
  expect(f.checks.map((check) => check.at / SECOND)).toEqual([
    101, 131, 161, 191, 251, 281,
  ]);
});

test("a check that hangs is never overlapped, fails after its timeout, and does not hold up the pass or other Services' checks", async () => {
  const f = fixture({ interval: 5, timeout: 5 }, { services: ["api", "web"] });
  f.answer = (service) =>
    service === "api" ? new Promise<boolean>(() => {}) : true;
  await f.runUntil(60 * SECOND);
  const api = f.checks.filter((check) => check.service === "api");
  const web = f.checks.filter((check) => check.service === "web");
  // api: a check at 1 s times out at 6 s; the next is due 5 s after that, never two at once.
  expect(api.map((check) => check.at / SECOND)).toEqual([
    1, 11, 21, 31, 41, 51,
  ]);
  expect(web.length).toBeGreaterThan(api.length);
  expect(f.monitor.results({ id: "t1" }, "api")).toMatchObject({
    status: "unhealthy",
    output: "The check did not answer within 5s.",
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
  await f.runUntil(1 * SECOND);
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

test("a Service without a healthcheck, as every plan recorded before healthcheck, is never checked by the monitor", async () => {
  const f = fixture(null);
  f.answer = () => false;
  await f.runUntil(300 * SECOND);
  expect(f.checks).toEqual([]);
  expect(f.result()).toBeUndefined();
});

test("a new rigd continues the unhealthy stretch a health restart recorded, and its back-off", async () => {
  const f = fixture({ interval: 5, retries: 1, onFailure: "restart" });
  f.state.targets[0]!.services!.web!.healthStretch = {
    since: 0,
    restarts: [0],
  };
  f.answer = () => false;
  await f.runUntil(30 * SECOND);
  // The recorded restart at 0 s puts the next one a minute later, not at the first failure.
  expect(f.restarts).toEqual([]);
  expect(f.result()).toMatchObject({ status: "unhealthy", restarts: 1 });
  await f.runUntil(61 * SECOND);
  expect(
    f.restarts.map((restart) => [restart.at / SECOND, restart.attempt]),
  ).toEqual([[60, 2]]);
});

test("a restart that could not stop the Service still counts for the back-off, and it stays unhealthy until a check passes", async () => {
  const f = fixture({ interval: 5, retries: 1, onFailure: "restart" });
  f.answer = () => false;
  f.restartOutcome = "failed";
  await f.runUntil(100 * SECOND);
  expect(f.restarts.map((restart) => restart.at / SECOND)).toEqual([1, 61]);
  expect(f.result()).toMatchObject({ status: "unhealthy", restarts: 2 });
});

test("after a health restart the Service stays unhealthy until the new process passes a check, which ends the recorded stretch", async () => {
  const f = fixture({ interval: 30, retries: 3, onFailure: "restart" });
  f.answer = () => false;
  await f.runUntil(61 * SECOND);
  expect(f.restarts.map((restart) => restart.at / SECOND)).toEqual([61]);
  expect(f.result()).toMatchObject({
    status: "unhealthy",
    failures: 0,
    restarts: 1,
    output: "HTTP 503",
  });
  expect(f.state.targets[0]!.services!.web!.healthStretch).toEqual({
    since: 61 * SECOND,
    restarts: [61 * SECOND],
  });
  f.answer = () => true;
  await f.runUntil(62 * SECOND);
  expect(f.result()).toMatchObject({ status: "healthy", restarts: 0 });
  expect(f.activity().at(-1)).toBe(
    "web is healthy again: its health check passed.",
  );
  expect(f.state.targets[0]!.services!.web).not.toHaveProperty("healthStretch");
});

test("a restart that finds the process already replaced is dropped, and the new process is checked afresh", async () => {
  const f = fixture({ interval: 5, retries: 1, onFailure: "restart" });
  f.answer = () => false;
  f.restartOutcome = "skipped";
  await f.runUntil(1 * SECOND);
  expect(f.restarts).toHaveLength(1);
  // Meanwhile an operator restarted it: the next checks are of the new process, and the old stretch is over.
  f.replace("web");
  f.answer = () => true;
  await f.runUntil(30 * SECOND);
  expect(f.restarts).toHaveLength(1);
  expect(f.result()).toMatchObject({ status: "healthy", restarts: 0 });
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
  await f.runUntil(1 * SECOND);
  // api holds the only slot; web waits for it.
  expect(f.checks.map((check) => check.service)).toEqual(["api"]);
  f.busy = true;
  release();
  await f.monitor.idle();
  expect(f.checks.map((check) => check.service)).toEqual(["api"]);
});

test("a restart that could not observe the process is asked again, without counting as a restart", async () => {
  const f = fixture({ interval: 5, retries: 1, onFailure: "restart" });
  f.answer = () => false;
  f.restartOutcome = "deferred";
  await f.runUntil(1 * SECOND);
  f.restartOutcome = "restarted";
  await f.runUntil(3 * SECOND);
  expect(
    f.restarts.map((restart) => [restart.at / SECOND, restart.attempt]),
  ).toEqual([
    [1, 1],
    [2, 1],
  ]);
});

test("a check's answer about a process that was replaced meanwhile is dropped", async () => {
  const f = fixture({ interval: 5, retries: 1 });
  let answer!: (passed: boolean) => void;
  f.answer = () => new Promise<boolean>((resolve) => (answer = resolve));
  await f.runUntil(1 * SECOND);
  expect(f.checks).toHaveLength(1);
  // An explicit restart finished while the check was out.
  f.replace("web");
  answer(false);
  await f.monitor.idle();
  expect(f.result()).not.toMatchObject({ status: "unhealthy" });
  expect(f.activity()).toEqual([]);
});

test("an explicit restart clears the old process's result at the next pass", async () => {
  const f = fixture({ interval: 3600, retries: 1 });
  f.answer = () => false;
  await f.runUntil(1 * SECOND);
  expect(f.result()).toMatchObject({ status: "unhealthy" });
  f.replace("web");
  // The new process's first check is still out: its result is its own, not the old one's.
  f.answer = () => new Promise<boolean>(() => {});
  await f.runUntil(2 * SECOND);
  expect(f.result()).toMatchObject({ status: "starting", failures: 0 });
  expect(f.result()).not.toHaveProperty("output");
});

test("an answer is dropped when the record names another process, even if an observation still shows the old one", async () => {
  const f = fixture({ interval: 5, retries: 1 });
  let answer!: (passed: boolean) => void;
  f.answer = () => new Promise<boolean>((resolve) => (answer = resolve));
  await f.runUntil(1 * SECOND);
  f.staleProcess = "web-1";
  f.replace("web");
  answer(false);
  await f.monitor.idle();
  expect(f.result()).not.toMatchObject({ status: "unhealthy" });
  expect(f.activity()).toEqual([]);
});

test("the back-off counts from when a restart was attempted, after it waited for its Target", async () => {
  const f = fixture({ interval: 5, retries: 1, onFailure: "restart" });
  f.answer = () => false;
  f.restartOutcome = "failed";
  // Asked at 1 s, the restart waited 5 minutes for its Target before its stop failed.
  f.lockWait = 300 * SECOND;
  await f.runUntil(400 * SECOND);
  expect(f.restarts.map((restart) => restart.at / SECOND)).toEqual([1, 361]);
});

test("with observations that name no process, the run record says which process a check asked", async () => {
  const f = fixture({ interval: 5, retries: 1 });
  f.anonymous = true;
  let answer!: (passed: boolean) => void;
  f.answer = () => new Promise<boolean>((resolve) => (answer = resolve));
  await f.runUntil(1 * SECOND);
  expect(f.checks).toHaveLength(1);
  f.replace("web");
  answer(false);
  await f.monitor.idle();
  expect(f.result()).not.toMatchObject({ status: "unhealthy" });
  expect(f.activity()).toEqual([]);
});

test("an answer from a process that ended during the check is dropped, and its recorded stretch stays", async () => {
  // A long timeout, so the check is still out when the process ends.
  const f = fixture({
    interval: 5,
    timeout: 60,
    retries: 1,
    onFailure: "restart",
  });
  f.answer = () => false;
  await f.runUntil(1 * SECOND);
  expect(f.restarts).toHaveLength(1);
  const stretch = f.state.targets[0]!.services!.web!.healthStretch;
  expect(stretch).toBeDefined();
  let answer!: (passed: boolean) => void;
  f.answer = () => new Promise<boolean>((resolve) => (answer = resolve));
  await f.runUntil(20 * SECOND);
  // The new process ends while its check is out; supervision has not recorded it yet. The late pass says nothing.
  f.processState = "stopped";
  answer(true);
  await f.monitor.idle();
  expect(f.activity()).not.toContain(
    "web is healthy again: its health check passed.",
  );
  expect(f.state.targets[0]!.services!.web!.healthStretch).toEqual(stretch);
});

test("an answer is dropped when an explicit restart completes while the observation after the check is out", async () => {
  const f = fixture({ interval: 5, retries: 1 });
  let answer!: (passed: boolean) => void;
  f.answer = () => new Promise<boolean>((resolve) => (answer = resolve));
  await f.runUntil(1 * SECOND);
  // The observation after the check answers with the old process, but the restart was recorded while it was out.
  f.duringObservation = () => {
    f.duringObservation = undefined;
    f.replace("web");
  };
  answer(false);
  await f.monitor.idle();
  expect(f.result()).not.toMatchObject({ status: "unhealthy" });
  expect(f.activity()).toEqual([]);
});

test("an observation that cannot tell whether the process runs keeps the count of failed checks", async () => {
  const f = fixture({ interval: 5, retries: 3 });
  f.answer = () => false;
  await f.runUntil(6 * SECOND);
  expect(f.result()).toMatchObject({ failures: 2 });
  f.processState = "unknown";
  await f.runUntil(14 * SECOND);
  f.processState = "running";
  await f.runUntil(15 * SECOND);
  expect(f.result()).toMatchObject({ failures: 3, status: "unhealthy" });
});

test("a process nothing identifies keeps being checked and reported, is never restarted, and Activity does not promise a restart", async () => {
  const f = fixture({ interval: 5, retries: 1, onFailure: "restart" });
  // Adopted from a rigd that kept no incarnations: neither the record nor the observation names it.
  delete f.state.targets[0]!.services!.web!.incarnation;
  f.anonymous = true;
  f.answer = () => false;
  await f.runUntil(20 * SECOND);
  expect(f.restarts).toEqual([]);
  expect(f.activity()).toEqual([
    "web is unhealthy: 1 health check in a row failed (HTTP 503). Rig cannot restart it for its health, since a rigd too old to record which process it is started it; run rig restart stable once.",
  ]);
  f.answer = () => true;
  await f.runUntil(30 * SECOND);
  expect(f.restarts).toEqual([]);
  expect(f.result()).toMatchObject({ status: "healthy" });
});

test("a Target that is not meant to run, or a Service whose healthcheck is gone, is no longer checked and forgets its result", async () => {
  const f = fixture({ interval: 5 });
  await f.runUntil(1 * SECOND);
  expect(f.result()).toMatchObject({ status: "healthy" });
  f.state.targets[0]!.desired = "stopped";
  await f.runUntil(20 * SECOND);
  expect(f.checks).toHaveLength(1);
  expect(f.result()).toBeUndefined();
});

test("a passing start check is the first passing check: the Service is healthy at once and next checked an interval later", async () => {
  const f = fixture({ interval: 30 });
  f.monitor.started(f.state.targets[0]!, "web", "web-1");
  expect(f.result()).toEqual({
    status: "healthy",
    checkedAt: new Date(0).toISOString(),
    failures: 0,
    retries: 3,
    restarts: 0,
  });
  await f.runUntil(40 * SECOND);
  expect(f.checks.map((check) => check.at / SECOND)).toEqual([30]);
});

test("a process a health restart started stays unhealthy after its start check, until an ongoing check passes", async () => {
  const f = fixture({ interval: 5, retries: 1, onFailure: "restart" });
  f.answer = () => false;
  await f.runUntil(1 * SECOND);
  expect(f.restarts).toHaveLength(1);
  // The restart's start check passed; the stretch it continues is on the new process's record.
  f.monitor.started(f.state.targets[0]!, "web", "web-2");
  expect(f.result()).toMatchObject({ status: "unhealthy", restarts: 1 });
  // A Service without a healthcheck is not seeded at all.
  f.monitor.started(f.state.targets[0]!, "api", "api-1");
  expect(f.monitor.results({ id: "t1" }, "api")).toBeUndefined();
});

test("a check that waited for a slot judges the plan recorded now: a Service deployed without its healthcheck is neither checked nor restarted", async () => {
  const f = fixture(
    { interval: 5, retries: 1, onFailure: "restart" },
    { services: ["api", "web"], concurrency: 1 },
  );
  let release!: () => void;
  f.answer = (service) =>
    service === "api"
      ? new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        })
      : false;
  await f.runUntil(1 * SECOND);
  // api holds the only slot; web, whose old test would fail, waits for it.
  expect(f.checks.map((check) => check.service)).toEqual(["api"]);
  // Meanwhile web is deployed again without a healthcheck: a new plan entry and a new process.
  const target = f.state.targets[0]!;
  const web = target.plan.components.find((c) => c.name === "web")!;
  delete (web as { healthcheck?: unknown }).healthcheck;
  delete (web as { health?: unknown }).health;
  f.replace("web");
  release();
  await f.monitor.idle();
  expect(f.checks.map((check) => check.service)).toEqual(["api"]);
  expect(f.restarts).toEqual([]);
  f.answer = (service) => service === "api";
  await f.runUntil(30 * SECOND);
  expect(f.checks.filter((check) => check.service === "web")).toEqual([]);
  expect(f.restarts).toEqual([]);
});

test("a check that waited for a slot runs the test recorded now, against the process recorded now", async () => {
  const f = fixture(
    { interval: 5, retries: 1, onFailure: "restart" },
    { services: ["api", "web"], concurrency: 1 },
  );
  let release!: () => void;
  f.answer = (service) =>
    service === "api"
      ? new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        })
      : true;
  await f.runUntil(1 * SECOND);
  const web = f.state.targets[0]!.plan.components.find(
    (c) => c.name === "web",
  )!;
  (web as { health?: string }).health = "http://127.0.0.1:4000/new";
  f.replace("web");
  release();
  await f.monitor.idle();
  expect(f.checks.filter((check) => check.service === "web")).toEqual([
    { service: "web", at: 1 * SECOND, test: "http://127.0.0.1:4000/new" },
  ]);
});

test("a restart is asked only under the policy recorded now: a Service set to report while unhealthy is not restarted", async () => {
  const f = fixture({ interval: 5, retries: 1, onFailure: "restart" });
  f.answer = () => false;
  f.restartOutcome = "failed";
  await f.runUntil(1 * SECOND);
  expect(f.restarts).toHaveLength(1);
  // Before the back-off allows the next restart, the healthcheck is set to report.
  const web = f.state.targets[0]!.plan.components[0]! as {
    healthcheck: { onFailure: string };
  };
  web.healthcheck.onFailure = "report";
  await f.runUntil(200 * SECOND);
  expect(f.restarts).toHaveLength(1);
  expect(f.result()).toMatchObject({ status: "unhealthy" });
});

test("stop aborts the probes in flight, waits for them within its bound, and nothing is checked or written after it", async () => {
  const f = fixture({ interval: 5, retries: 1, timeout: 3600 });
  // A check that hangs for an hour unless its probe is aborted.
  f.answer = () =>
    new Promise<boolean>((resolve) =>
      f.signals.at(-1)!.addEventListener("abort", () => resolve(false)),
    );
  await f.runUntil(1 * SECOND);
  expect(f.checks).toHaveLength(1);
  const writesBefore = f.writes.length;
  await f.monitor.stop();
  expect(f.signals[0]!.aborted).toBe(true);
  // The aborted check failed nothing and recorded nothing.
  expect(f.writes).toHaveLength(writesBefore);
  expect(f.result()).not.toMatchObject({ status: "unhealthy" });
  await f.runUntil(60 * SECOND);
  expect(f.checks).toHaveLength(1);
  expect(f.writes).toHaveLength(writesBefore);
});

test("stop does not wait past its bound for a restart that never ends, and asks for no restart after it", async () => {
  const f = fixture({ interval: 5, retries: 1, onFailure: "restart" });
  f.answer = () => false;
  f.restartHangs = true;
  await f.runUntil(1 * SECOND);
  // The restart was asked and never ends.
  expect(f.restarts).toHaveLength(1);
  const asked = f.restarts.length;
  let stopped = false;
  const stopping = f.monitor.stop(5 * SECOND).then(() => {
    stopped = true;
  });
  await settle();
  expect(stopped).toBe(false);
  f.tick(5 * SECOND);
  await stopping;
  expect(stopped).toBe(true);
  f.restartHangs = false;
  await f.runUntil(120 * SECOND);
  expect(f.restarts).toHaveLength(asked);
});
