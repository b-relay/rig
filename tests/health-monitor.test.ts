import { expect, test } from "bun:test";
import type { Clock } from "../src/domain/clock";
import type { HealthcheckPlan, ManagedComponent } from "../src/config/types";
import { HEALTH_RESTART_BACKOFF_MS } from "../src/domain/health-policy";
import type { RuntimeState, TargetRecord } from "../src/domain/runtime";
import {
  UNWRITTEN_HEALTH_LIMIT,
  checkIdentity,
  createHealthMonitor,
  type HealthMonitorDependencies,
  type HealthRestartRequest,
  type HealthRestartResult,
} from "../src/runtime/health-monitor";
import { STATE_VERSION } from "../src/runtime/state-schema";
import {
  HEALTH_MONITOR,
  createNoticeBoard,
  workReport,
} from "../src/daemon/notices";

/** One stable Target with Services under a fake clock: the monitor runs a pass every second of fake time, every check
 * answers as `answer` says, and each restart starts a new process. */
function fixture(
  /** The Services' healthcheck; null for Services whose plan has none, as a plan recorded before healthcheck. */
  healthcheck: Partial<HealthcheckPlan> | null = {},
  options: { services?: string[]; concurrency?: number } = {},
) {
  /** The wall clock, and the elapsed one: time passing moves both, a correction of the clock (`step`) only the wall clock. */
  let now = 0;
  let elapsed = 0;
  const clock: Clock = { now: () => now, elapsed: () => elapsed };
  /** Timers, by when they fire on the elapsed clock. */
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
    version: STATE_VERSION,
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
  /** When each check and each restart was asked, on the elapsed clock. */
  const elapsedAt = { checks: [] as number[], restarts: [] as number[] };
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
  /** Runs once, just after the `left`-th read of state from when it was armed has taken its snapshot. */
  let afterRead: { left: number; run: () => void } | undefined;
  /** Every state write fails with this while set, as on a full disk. */
  let writeFailure: Error | undefined;
  /** Every state read fails with this while set. */
  let readFailure: Error | undefined;
  /** What a check says of its evidence that could not be written to the Target log, while set. */
  let unrecorded: string | undefined;
  /** The notices rigd's doctor would report, as composition wires them. */
  const board = createNoticeBoard(() => new Date(now).toISOString());
  const dependencies: HealthMonitorDependencies = {
    store: {
      async read() {
        if (readFailure) throw readFailure;
        const snapshot = structuredClone(state);
        if (afterRead && --afterRead.left === 0) {
          const { run } = afterRead;
          afterRead = undefined;
          run();
        }
        return snapshot;
      },
      async update(change) {
        writes.push(now);
        if (writeFailure) throw writeFailure;
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
        elapsedAt.checks.push(elapsed);
        checks.push({
          service: component.name,
          at: now,
          ...(component.health ? { test: component.health } : {}),
        });
        signals.push(signal);
        const check = (await answer(component.name))
          ? { ready: true as const }
          : { ready: false as const, reason };
        return unrecorded ? { ...check, unrecorded } : check;
      },
    },
    clock,
    id: () => `id${Math.random()}`,
    busy: () => busy,
    async restart(request) {
      restarts.push({ ...request, at: now });
      elapsedAt.restarts.push(elapsed);
      if (restartHangs) return await new Promise<never>(() => {});
      if (restartOutcome === "skipped" || restartOutcome === "deferred")
        return { outcome: restartOutcome };
      if (restartOutcome === "failed") {
        // It waited for its Target's lock, then was attempted.
        now += lockWait;
        elapsed += lockWait;
        return { outcome: "failed", at: now, elapsed };
      }
      const next = incarnations.get(request.service)! + 1;
      incarnations.set(request.service, next);
      const at = now;
      // As the restart's journal records it on the Service.
      state.targets[0]!.services![request.service] = {
        deployment: "/work",
        intent: "running",
        incarnation: `${request.service}-${next}`,
        attempts: [],
        healthStretch: {
          since: request.since,
          restarts: [...request.restarts, at],
        },
      };
      return { outcome: "restarted", at, elapsed };
    },
    schedule(delayMs, fire) {
      const timer = { at: elapsed + delayMs, fire };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
    async diagnostic() {},
    report: workReport(board, HEALTH_MONITOR),
    ...(options.concurrency ? { concurrency: options.concurrency } : {}),
  };
  let monitorUnderTest = createHealthMonitor(dependencies);
  /** Runs one pass per second of fake time up to `until` (milliseconds), letting each pass's work settle. */
  const runUntil = async (until: number) => {
    while (now < until) {
      now += 1000;
      elapsed += 1000;
      for (const timer of timers.filter((t) => t.at <= elapsed)) {
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
    notices: () => board.list(),
    set writeFailure(value: Error | undefined) {
      writeFailure = value;
    },
    set readFailure(value: Error | undefined) {
      readFailure = value;
    },
    set unrecorded(value: string | undefined) {
      unrecorded = value;
    },
    /** Changes state right after the `count`-th read from now, as an Operation finishing between two reads would. */
    afterReads(count: number, run: () => void) {
      afterRead = { left: count, run };
    },
    /** Moves the fake clock without a pass, firing the timers that come due. */
    tick(ms: number) {
      now += ms;
      elapsed += ms;
      for (const timer of timers.filter((t) => t.at <= elapsed)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.fire();
      }
    },
    /** The wall clock is corrected by `ms`, forwards or back; no time passes. */
    step(ms: number) {
      now += ms;
    },
    /** Runs a pass per second for `ms` more. */
    runFor: (ms: number) => runUntil(now + ms),
    /** The wall clock now. */
    get now() {
      return now;
    },
    /** A new rigd: nothing in memory, the same records. */
    restartDaemon() {
      monitorUnderTest = createHealthMonitor(dependencies);
    },
    state,
    checks,
    restarts,
    elapsedAt,
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
    records: () => state.activity,
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
  expect(f.records().map((entry) => entry.component)).toEqual(
    f.records().map(() => ({ kind: "service", name: "web" })),
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
    "web is unhealthy: 1 health check in a row failed (HTTP 503). Rig cannot restart it for its health, since a rigd too old to record which process it is started it; run rig restart stable --project demo once.",
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

test("a passing start check stands through a pass that reads the Target before its Operation records it meant to run", async () => {
  // rig up records the Target meant to run once its Services started; a deploy ends its recovery then.
  for (const before of [
    { desired: "stopped" as const },
    { recovery: { stage: "pending" } },
  ]) {
    const f = fixture({ interval: 30 });
    Object.assign(f.state.targets[0]!, before);
    f.busy = true;
    f.monitor.started(f.state.targets[0]!, "web", "web-1");
    await f.runFor(1 * SECOND);
    expect(f.result()).toMatchObject({ status: "healthy" });
    f.state.targets[0]!.desired = "running";
    delete f.state.targets[0]!.recovery;
    f.monitor.invalidate("t1");
    f.busy = false;
    await f.runFor(1 * SECOND);
    expect(f.result()).toMatchObject({
      status: "healthy",
      checkedAt: new Date(0).toISOString(),
    });
    expect(f.checks).toEqual([]);
  }
});

test("a Target its Operation leaves not meant to run forgets the result of a start it made", async () => {
  const f = fixture({ interval: 30 });
  f.state.targets[0]!.desired = "stopped";
  f.busy = true;
  f.monitor.started(f.state.targets[0]!, "web", "web-1");
  await f.runFor(1 * SECOND);
  f.busy = false;
  await f.runFor(1 * SECOND);
  expect(f.result()).toBeUndefined();
  expect(f.monitor.retained()).toBe(0);
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

test("a deploy that lands between reading the plan and reading the process is not judged by the old test: nothing is probed or restarted", async () => {
  const f = fixture({ interval: 5, retries: 1, onFailure: "restart" });
  const web = () =>
    f.state.targets[0]!.plan.components[0]! as { health?: string };
  web().health = "http://127.0.0.1:4000/legacy";
  // /legacy passes until the deploy, then fails; /new passes.
  let deployed = false;
  f.answer = () =>
    !(deployed && f.checks.at(-1)!.test === "http://127.0.0.1:4000/legacy");
  await f.runUntil(5 * SECOND);
  expect(f.checks.map((check) => check.at / SECOND)).toEqual([1]);
  // The pass at 6 s reads state, then the due check reads the plan (still /legacy); the deploy lands right after that
  // read, before the check reads which process runs: web-2, whose test is /new.
  f.afterReads(2, () => {
    deployed = true;
    web().health = "http://127.0.0.1:4000/new";
    f.replace("web");
  });
  await f.runUntil(6 * SECOND);
  expect(deployed).toBe(true);
  // The old test never ran against the new process, and nothing was restarted.
  expect(
    f.checks.filter((check) => check.test === "http://127.0.0.1:4000/legacy"),
  ).toHaveLength(1);
  expect(f.restarts).toEqual([]);
  // The next pass checks web-2 with its own test.
  await f.runUntil(7 * SECOND);
  expect(f.checks.at(-1)).toEqual({
    service: "web",
    at: 7 * SECOND,
    test: "http://127.0.0.1:4000/new",
  });
  expect(f.restarts).toEqual([]);
  expect(f.result()).toMatchObject({ status: "healthy" });
});

test("a restart request names the check that judged the process, and a check the plan makes another way starts afresh", async () => {
  const f = fixture({ interval: 5, retries: 2, onFailure: "restart" });
  f.answer = () => false;
  f.restartOutcome = "failed";
  await f.runUntil(6 * SECOND);
  expect(f.restarts).toHaveLength(1);
  const component = () =>
    f.state.targets[0]!.plan.components[0]! as ManagedComponent;
  expect(f.restarts[0]!.check).toBe(checkIdentity(component()));
  // An edit gives the same process another test: its result starts from a fresh count, so one failure of the new test
  // is not yet unhealthy and asks for nothing, although the old test's stretch was due for its next restart.
  (component() as { health?: string }).health = "http://127.0.0.1:4000/other";
  await f.runUntil(70 * SECOND);
  // The new test fails at 7 s and 12 s; only at retries is a restart asked, naming the new check, as the first of a new
  // stretch.
  expect(f.restarts[1]).toMatchObject({
    at: 12 * SECOND,
    attempt: 1,
    check: checkIdentity(component()),
  });
});

// A check of web makes six reads of state at its pass: the pass itself, the check's read of the plan, then a read before
// and after each of the two process observations around the probe. A deploy can land after any of them.
test.each([2, 3, 4, 5, 6])(
  "a deploy that starts another process after read %i of a failing check's pass never has that failure recorded against it, nor a restart asked",
  async (reads) => {
    const f = fixture({ interval: 5, retries: 1, onFailure: "restart" });
    const component = () =>
      f.state.targets[0]!.plan.components[0]! as ManagedComponent & {
        health?: string;
      };
    component().health = "http://127.0.0.1:4000/legacy";
    await f.runUntil(5 * SECOND);
    expect(f.checks.map((check) => check.at / SECOND)).toEqual([1]);
    // The check at 6 s fails. Meanwhile a deploy starts web-2 with the test /new, its start check passes and tells the
    // monitor, and the Target is free again, all while one of the check's reads is out: that read answers with the state
    // from before the deploy.
    f.answer = () => false;
    f.afterReads(reads, () => {
      component().health = "http://127.0.0.1:4000/new";
      f.replace("web");
      f.monitor.started(structuredClone(f.state.targets[0]!), "web", "web-2");
    });
    await f.runUntil(6 * SECOND);
    await f.monitor.idle();
    expect(component().health).toBe("http://127.0.0.1:4000/new");
    // What is known of web is what its own start said: healthy, with no failure of the old test counted against it.
    expect(f.result()).toEqual({
      status: "healthy",
      checkedAt: new Date(6 * SECOND).toISOString(),
      failures: 0,
      retries: 1,
      restarts: 0,
    });
    expect(f.restarts).toEqual([]);
    expect(f.activity()).toEqual([]);
  },
);

test("a change of health Activity could not take is reported, written once when storage recovers, and never duplicated", async () => {
  const f = fixture({ retries: 1 });
  await f.runUntil(1 * SECOND);
  f.answer = () => false;
  f.writeFailure = new Error("ENOSPC: no space left on device");
  await f.runUntil(32 * SECOND);
  // The check found it unhealthy; only its Activity entry is missing, and the health notice says so.
  expect(f.result()).toMatchObject({ status: "unhealthy", failures: 1 });
  expect(f.activity()).toEqual([]);
  expect(f.notices()).toEqual([
    expect.objectContaining({
      channel: "health",
      message:
        "Recording the changes of health of web on stable of demo (1 change waiting) failed: ENOSPC: no space left on device",
    }),
  ]);
  // Later checks fail the same way, which is no new change: the one entry is all that is owed.
  await f.runUntil(70 * SECOND);
  expect(f.notices()).toHaveLength(1);
  f.writeFailure = undefined;
  await f.runUntil(72 * SECOND);
  expect(f.activity()).toEqual([
    "web is unhealthy: 1 health check in a row failed (HTTP 503). Its healthcheck's on_failure is report, so Rig only reports it.",
  ]);
  // It is recorded at the time the check found it.
  expect(f.records()[0]!.occurredAt).toBe(new Date(31 * SECOND).toISOString());
  expect(f.notices()).toEqual([]);
  await f.runUntil(100 * SECOND);
  expect(f.activity()).toHaveLength(1);
  // Its recovery is recorded the same way.
  f.answer = () => true;
  f.writeFailure = new Error("ENOSPC: no space left on device");
  await f.runUntil(122 * SECOND);
  expect(f.result()).toMatchObject({ status: "healthy" });
  f.writeFailure = undefined;
  await f.runUntil(124 * SECOND);
  expect(f.activity()).toEqual([
    expect.stringContaining("web is unhealthy"),
    "web is healthy again: its health check passed.",
  ]);
  expect(f.notices()).toEqual([]);
});

test("a change of health not yet in Activity is dropped once the process is replaced, and its notice goes with it", async () => {
  const f = fixture({ retries: 1 });
  await f.runUntil(1 * SECOND);
  f.answer = () => false;
  f.writeFailure = new Error("ENOSPC: no space left on device");
  await f.runUntil(32 * SECOND);
  expect(f.notices()).toHaveLength(1);
  // An explicit restart replaces the process: what was found of the old one is not recorded about the new one.
  f.replace("web");
  f.monitor.invalidate("t1", "web");
  f.answer = () => true;
  f.writeFailure = undefined;
  await f.runUntil(34 * SECOND);
  expect(f.activity()).toEqual([]);
  expect(f.notices()).toEqual([]);
});

test("a health check's evidence the Target log cannot take never fails the check: the Service stays healthy and is not restarted, and the failure is reported until the log takes it", async () => {
  const f = fixture({ retries: 1, onFailure: "restart" });
  f.unrecorded = "EACCES: permission denied, open '/logs/target.jsonl'.";
  await f.runUntil(62 * SECOND);
  expect(f.result()).toMatchObject({ status: "healthy", failures: 0 });
  expect(f.restarts).toEqual([]);
  expect(f.activity()).toEqual([]);
  expect(f.notices()).toEqual([
    expect.objectContaining({
      channel: "health",
      message:
        "Writing the health check evidence of web on stable of demo to its Target log failed: EACCES: permission denied, open '/logs/target.jsonl'.",
    }),
  ]);
  f.unrecorded = undefined;
  await f.runUntil(92 * SECOND);
  expect(f.notices()).toEqual([]);
});

test("a check that cannot run is reported under its Service, and only a check of it that runs again clears that", async () => {
  const f = fixture();
  await f.runUntil(30 * SECOND);
  // The pass at 31 s reads state, then every read after it fails: the check it starts cannot read the plan.
  f.afterReads(1, () => {
    f.readFailure = new Error("EIO: state.json could not be read");
  });
  await f.runUntil(31 * SECOND);
  expect(f.notices()).toEqual([
    expect.objectContaining({
      channel: "health",
      message:
        "Checking the health of web on stable of demo failed: EIO: state.json could not be read",
    }),
  ]);
  f.readFailure = undefined;
  await f.runUntil(32 * SECOND);
  expect(f.checks.map((check) => check.at / SECOND)).toEqual([1, 32]);
  expect(f.notices()).toEqual([]);
});

test("a Service that flaps through a long storage outage keeps a bounded queue of health changes, says how many it dropped, and writes the rest in order once storage recovers", async () => {
  const f = fixture({ interval: 5, retries: 1 });
  await f.runUntil(1 * SECOND);
  const retained = f.monitor.retained();
  let checks = 0;
  f.answer = () => checks++ % 2 === 1;
  f.writeFailure = new Error("ENOSPC: no space left on device");
  // About two hundred checks, each a change of health.
  await f.runUntil(1000 * SECOND);
  expect(f.activity()).toEqual([]);
  expect(f.monitor.retained()).toBeLessThanOrEqual(
    retained + UNWRITTEN_HEALTH_LIMIT,
  );
  expect(f.notices()).toEqual([
    expect.objectContaining({
      channel: "health",
      message: expect.stringMatching(
        /^Recording the changes of health of web on stable of demo \(8 changes waiting, \d+ older dropped\) failed: ENOSPC/,
      ),
    }),
  ]);
  f.writeFailure = undefined;
  f.answer = () => true;
  await f.runUntil(1002 * SECOND);
  const activity = f.activity();
  expect(activity[0]).toMatch(
    /^web: \d+ earlier changes of health were not recorded, as Rig could not write its state\.$/,
  );
  expect(activity.length).toBeLessThanOrEqual(UNWRITTEN_HEALTH_LIMIT + 2);
  // What was kept is the newest, in the order it happened.
  const times = f.records().map((entry) => Date.parse(entry.occurredAt));
  expect(times).toEqual([...times].sort((a, b) => a - b));
  expect(f.notices()).toEqual([]);
  expect(f.monitor.retained()).toBe(retained);
});

test("correcting the clock never suspends checks or keeps a stale result: they follow their interval in elapsed time", async () => {
  for (const jump of [-3_600_000, 3_600_000]) {
    const f = fixture({ interval: 5, retries: 3 });
    await f.runFor(10 * SECOND);
    expect(f.result()).toMatchObject({ status: "healthy" });
    f.answer = () => false;
    f.step(jump);
    const before = f.elapsedAt.checks.length;
    await f.runFor(60 * SECOND);
    const after = f.elapsedAt.checks.slice(before);
    // Every 5 s, as before the correction, and the result follows them.
    expect(after.length).toBe(12);
    expect(after.slice(1).map((at, index) => at - after[index]!)).toEqual(
      Array(11).fill(5 * SECOND),
    );
    expect(f.result()).toMatchObject({ status: "unhealthy", failures: 12 });
    expect(f.result()!.checkedAt).toBe(
      new Date(f.checks.at(-1)!.at).toISOString(),
    );
  }
});

test("correcting the clock neither delays nor hastens a health restart: the back-off is elapsed time", async () => {
  for (const jump of [-3_600_000, 3_600_000]) {
    const f = fixture({ interval: 5, retries: 1, onFailure: "restart" });
    f.answer = () => false;
    await f.runFor(10 * SECOND);
    expect(f.elapsedAt.restarts).toEqual([1 * SECOND]);
    f.step(jump);
    await f.runFor(120 * SECOND);
    // 1 min after the first, then 5 min after that.
    expect(f.elapsedAt.restarts).toEqual([1 * SECOND, 61 * SECOND]);
    await f.runFor(300 * SECOND);
    expect(f.elapsedAt.restarts).toEqual([
      1 * SECOND,
      61 * SECOND,
      361 * SECOND,
    ]);
  }
});

test("a new rigd after the clock was set back continues a recorded unhealthy stretch within its back-off, not after the correction", async () => {
  const f = fixture({ interval: 5, retries: 1, onFailure: "restart" });
  f.answer = () => false;
  await f.runFor(10 * SECOND);
  expect(f.elapsedAt.restarts).toEqual([1 * SECOND]);
  // rigd restarts while the clock is set back an hour: the recorded restart lies in the new clock's future.
  f.step(-3_600_000);
  f.restartDaemon();
  await f.runFor(70 * SECOND);
  // At most the 1 min back-off after the new rigd first measured it, not an hour.
  expect(f.elapsedAt.restarts).toEqual([1 * SECOND, 71 * SECOND]);
  expect(f.restarts[1]).toMatchObject({ attempt: 2 });
});

test("time the Mac sleeps does not count toward a check's interval: checks resume where they were", async () => {
  const f = fixture({ interval: 30 });
  await f.runFor(1 * SECOND);
  expect(f.elapsedAt.checks).toEqual([1 * SECOND]);
  await f.runFor(9 * SECOND);
  // An hour asleep: the wall clock moves on, elapsed time does not.
  f.step(3_600_000);
  await f.runFor(20 * SECOND);
  expect(f.elapsedAt.checks).toEqual([1 * SECOND]);
  await f.runFor(1 * SECOND);
  expect(f.elapsedAt.checks).toEqual([1 * SECOND, 31 * SECOND]);
});
