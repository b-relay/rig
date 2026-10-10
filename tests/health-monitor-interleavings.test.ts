import { expect, test } from "bun:test";
import type { ManagedComponent } from "../src/config/types";
import type { RuntimeState } from "../src/domain/runtime";
import {
  checkIdentity,
  createHealthMonitor,
  type HealthMonitor,
  type HealthRestartRequest,
} from "../src/runtime/health-monitor";

/** The interleaving harness for the health monitor's epoch rule (src/runtime/health-monitor.ts). One stable Target runs
 * `web`, checked every 5 s with retries 1 and on_failure: restart, under a fake clock. Every await the monitor makes on
 * its dependencies (a state read or write, a process observation, a probe, a restart) is a yield point; each schedule
 * injects one lifecycle event, made as the runtime makes it (state written, hooks called), at one yield point, and then
 * checks the invariants:
 * - Activity about web's health is justified by a probe of the process and test recorded now, made after the last
 *   transition;
 * - a restart is asked only for the process and check recorded now, after a failed probe of exactly those;
 * - what status reads about web after a transition reflects that transition or a probe made after it, never an older
 *   result;
 * - a stopped or destroyed Target leaves nothing behind in the monitor. */

type Event =
  | "deploy"
  | "automatic restart with a stretch"
  | "explicit start clearing a stretch"
  | "stop"
  | "destroy"
  | "turn the Target off"
  | "Host restart";
const EVENTS: readonly Event[] = [
  "deploy",
  "automatic restart with a stretch",
  "explicit start clearing a stretch",
  "stop",
  "destroy",
  "turn the Target off",
  "Host restart",
];
/** warm: rigd has checked web for a while. cold: a new rigd's first pass, over a record that carries an unhealthy stretch. */
type Scenario = "warm" | "cold";
/** How a probe answers: of the process and test that ran before the event, and of what runs after it. */
type Answer = `old ${"passes" | "fails"}, new ${"passes" | "fails"}`;
const ANSWERS: readonly Answer[] = [
  "old passes, new passes",
  "old passes, new fails",
  "old fails, new passes",
  "old fails, new fails",
];
const SECOND = 1000;
const LEGACY = "http://127.0.0.1:4000/legacy";
const NEW = "http://127.0.0.1:4000/new";

/** What a health restart does: `deferred` asks again without acting; `start fails` stops the process and its start fails
 * the start check, as when readiness is gone, so the Service waits, stopped, for the next health restart. */
type Restarts =
  | "deferred"
  | "start fails"
  | "start fails, replacement survives"
  /** A record an earlier rigd left: pendingStart, though the replacement runs. */
  | "start fails, replacement survives, record says failed";
function world(
  scenario: Scenario,
  answer: Answer,
  restartsDo: Restarts,
  /** Faults in what the monitor depends on: every third state write is refused, and every fourth process observation
   * cannot tell whether anything runs. */
  faults = false,
) {
  let writes = 0,
    observations = 0;
  let now = 0;
  const timers: { at: number; fire: () => void }[] = [];
  const component: ManagedComponent = {
    kind: "managed",
    name: "web",
    command: "serve web",
    env: {},
    dependsOn: [],
    readyTimeout: 30,
    health: LEGACY,
    healthcheck: { interval: 5, timeout: 5, retries: 1, onFailure: "restart" },
  };
  const state = {
    version: 6,
    projects: [
      {
        id: "p1",
        name: "demo",
        repoPath: "/repo",
        configPath: "/repo/rig.yaml",
        createdAt: "",
      },
    ],
    targets: [
      {
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
          components: [component],
          preparedComponents: [],
        },
        services: {
          web: {
            deployment: "/work",
            intent: "running",
            incarnation: "web-1",
            attempts: [],
            ...(scenario === "cold"
              ? { healthStretch: { since: 0, restarts: [0] } }
              : {}),
          },
        },
      },
    ],
    activity: [],
  } as unknown as RuntimeState;
  const target = () => state.targets.find((t) => t.id === "t1");
  const web = () =>
    target()?.plan.components.find(
      (c): c is ManagedComponent => c.kind === "managed" && c.name === "web",
    );
  /** The process and test recorded now; undefined once the Target is gone or meant to stop. */
  const pair = () => {
    const t = target();
    const entry = web();
    return t && entry && t.desired === "running"
      ? {
          check: checkIdentity(entry),
          test: entry.health,
          incarnation: t.services?.web?.incarnation,
        }
      : undefined;
  };
  let processRunning = true;
  /** Health restarts whose start failed so far. */
  let failedStarts = 0;
  /** Every probe answer that is about one process and test throughout: the process recorded when it began is still
   * recorded, and the plan's test is still the probed one, when it answers. `after` counts transitions before it. */
  const probes: {
    check: string;
    incarnation?: string;
    passed: boolean;
    after: number;
  }[] = [];
  /** Transitions made so far; a probe counts after a transition when it began after it. */
  let transitions = 0;
  /** What the last transition said status should show until a probe of the current pair answers. */
  let expected: "healthy" | "unhealthy" | "nothing" | "stopped" | undefined;
  const violations: string[] = [];
  const restarts: HealthRestartRequest[] = [];

  // The yield point: every dependency the monitor awaits passes here, and the armed event runs at the chosen one.
  let points = 0;
  let armed: { at: number; event: Event } | undefined;
  let fired = false;
  let scheduled = false;
  /** Judges the cache at every yield point after the event, so a stale write is caught even when a later probe would
   * have overwritten it. */
  let judge = () => {};
  const point = () => {
    points++;
    if (armed && points === armed.at) {
      const { event } = armed;
      armed = undefined;
      fired = true;
      happen(event);
    } else if (fired) judge();
  };

  let monitor: HealthMonitor;
  /** The event, made as the runtime makes it under the Target's lock: the state writes (each reported, as the runtime's
   * store does) and the lifecycle's own hooks. */
  const happen = (event: Event) => {
    const t = target()!;
    const startWeb2 = (stretch?: { since: number; restarts: number[] }) => {
      monitor.invalidate("t1", "web"); // the lifecycle: the stop begins
      monitor.invalidate("t1", "web"); // the lifecycle: the start begins
      t.services!.web = {
        deployment: "/work",
        intent: "running",
        incarnation: "web-2",
        attempts: [],
        ...(stretch ? { healthStretch: stretch } : {}),
      };
      processRunning = true;
      monitor.invalidate("t1", "web"); // the store: another process recorded
      transitions++;
      monitor.started(structuredClone(t), "web", "web-2");
      expected = stretch ? "unhealthy" : "healthy";
    };
    switch (event) {
      case "deploy":
        web()!.health = NEW;
        monitor.invalidate("t1"); // the store: the plan changed
        startWeb2();
        return;
      case "automatic restart with a stretch":
        startWeb2({ since: now, restarts: [now] });
        return;
      case "explicit start clearing a stretch":
        startWeb2();
        return;
      case "stop":
        t.desired = "stopped";
        monitor.invalidate("t1"); // the store: no longer meant to run
        monitor.invalidate("t1", "web"); // the lifecycle: the stop begins
        processRunning = false;
        transitions++;
        expected = "nothing";
        return;
      case "destroy":
        monitor.invalidate("t1", "web"); // the lifecycle: the stop begins
        processRunning = false;
        state.targets = state.targets.filter((x) => x.id !== "t1");
        monitor.invalidate("t1"); // the store: the Target removed
        transitions++;
        expected = "nothing";
        return;
      case "turn the Target off":
        // ADR 0010: a Target turned off in rig.yaml keeps running until rig down, so nothing changes for its checks.
        return;
      case "Host restart":
        // The Host restarts: rigd and everything it ran end, and the rigd that comes back up records the Target's Services
        // as stopped by the restart, as it does a working Target's or a Preview's, so only an explicit start runs them
        // again. Its health monitor is a new one.
        void monitor.stop(0);
        monitor = daemon();
        processRunning = false;
        if (t.services?.web)
          t.services.web = {
            ...t.services.web,
            outcome: { kind: "unknown", hostRestart: "reboot", at: "" },
          };
        transitions++;
        expected = "stopped";
        return;
    }
  };

  /** A daemon's health monitor; a Host restart replaces it, as the rigd that comes back up has a new one. */
  const daemon = () =>
    createHealthMonitor({
      store: {
        async read() {
          const snapshot = structuredClone(state);
          point();
          return snapshot;
        },
        async update(change) {
          point();
          if (faults && ++writes % 3 === 0) throw new Error("disk full");
          const before = state.activity.length;
          const current = pair();
          await change(state);
          for (const entry of state.activity.slice(before)) {
            const message = entry.message ?? "";
            const passed = message.includes("healthy again");
            const justified =
              current !== undefined &&
              probes.some(
                (p) =>
                  p.check === current.check &&
                  p.incarnation === current.incarnation &&
                  p.passed === passed &&
                  p.after === transitions,
              );
            if (!justified)
              violations.push(`stale Activity at point ${points}: ${message}`);
          }
        },
      },
      observations: {
        async process() {
          point();
          if (faults && ++observations % 4 === 0)
            return { state: "unknown" as const, reason: "no answer" };
          return processRunning
            ? {
                state: "running",
                pid: 7,
                incarnation: target()?.services?.web?.incarnation,
              }
            : { state: "stopped" };
        },
        async health(_target, probed) {
          const began = pair();
          const after = transitions;
          const isOld = after === 0;
          // Before the schedule is armed (the warm scenario's first check) every probe passes.
          const passed =
            !scheduled || answer.includes(isOld ? "old passes" : "new passes");
          point();
          const ended = pair();
          if (
            began &&
            ended &&
            began.check === ended.check &&
            began.incarnation === ended.incarnation &&
            checkIdentity(probed) === began.check
          )
            probes.push({
              check: began.check,
              ...(began.incarnation ? { incarnation: began.incarnation } : {}),
              passed,
              after,
            });
          return passed
            ? { ready: true }
            : {
                ready: false,
                reason: `fail ${probed.health}@${began?.incarnation ?? "?"}`,
              };
        },
      },
      now: () => now,
      id: () => `id${Math.random()}`,
      busy: () => false,
      async restart(request) {
        // Judged as it is asked; a transition from here on is the runtime's to refuse under the Target's lock.
        restarts.push(request);
        const current = pair();
        const run = target()?.services?.web;
        // A start is asked for the process whose health start failed, while it is still the one recorded; a restart for the
        // process and check a failed probe judged since the last transition.
        const justified =
          current !== undefined &&
          request.check === current.check &&
          request.incarnation === current.incarnation &&
          (request.start
            ? run?.healthStretch?.pendingStart !== undefined &&
              !processRunning &&
              !(run.outcome?.kind === "unknown" && run.outcome.hostRestart)
            : probes.some(
                (p) =>
                  p.check === request.check &&
                  p.incarnation === request.incarnation &&
                  !p.passed &&
                  p.after === transitions,
              ));
        if (!justified)
          violations.push(
            `stale restart at point ${points} of ${request.incarnation}`,
          );
        point();
        if (restartsDo === "deferred" || !justified)
          return { outcome: "deferred" };
        // As the runtime runs it under the Target's lock: the stop and start begin (each a transition), the start is
        // journalled, and its start check fails, so the record says the next health restart is the monitor's.
        const t = target()!;
        if (!request.start) monitor.invalidate("t1", "web");
        monitor.invalidate("t1", "web");
        failedStarts++;
        // Its rollback stops the replacement, or, when that fails, the replacement runs on and is the recorded process.
        const survives = restartsDo.startsWith(
          "start fails, replacement survives",
        );
        const saysFailed =
          !survives || restartsDo.endsWith("record says failed");
        t.services!.web = {
          deployment: "/work",
          intent: "running",
          incarnation: `web-f${failedStarts}`,
          attempts: [],
          ...(survives
            ? {}
            : {
                outcome: {
                  kind: "start-failed" as const,
                  errorCode: "HEALTH_FAILED",
                  at: "",
                },
              }),
          healthStretch: {
            since: request.since,
            restarts: [...request.restarts, now],
            ...(saysFailed ? { pendingStart: now } : {}),
          },
        };
        monitor.invalidate("t1", "web"); // the store: another process recorded
        processRunning = survives;
        transitions++;
        expected = "unhealthy";
        return { outcome: "failed", at: now };
      },
      schedule(delayMs, fire) {
        const timer = { at: now + delayMs, fire };
        timers.push(timer);
        return () => timers.splice(timers.indexOf(timer), 1);
      },
      async diagnostic() {},
    });
  monitor = daemon();
  const settle = async () => {
    for (let round = 0; round < 5; round++)
      await new Promise((resolve) => setImmediate(resolve));
  };
  const runUntil = async (until: number) => {
    while (now < until) {
      now += 1000;
      for (const timer of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.fire();
      }
      await settle();
      await monitor.pass();
      await settle();
      await monitor.idle();
    }
  };
  judge = checkCache;
  return {
    get monitor() {
      return monitor;
    },
    runUntil,
    /** Runs passes for `seconds` more. */
    more: (seconds: number) => runUntil(now + seconds * SECOND),
    violations,
    restarts,
    /** The incarnations probes asked about, in order. */
    probed: () => probes.map((p) => p.incarnation),
    /** The event at the `at`-th yield point from now. */
    arm(at: number, event: Event) {
      points = 0;
      fired = false;
      scheduled = true;
      armed = { at, event };
    },
    points: () => points,
    fired: () => fired,
    /** What status reads about web now, against what the last transition and the probes since allow. */
    checkCache,
    expectsNothingLeft: () => expected === "nothing",
  };
  function checkCache() {
    const result = monitor.results({ id: "t1" }, "web");
    const current = pair();
    if (expected === "nothing" || expected === "stopped") return;
    if (
      result?.output &&
      current &&
      !result.output.includes(`@${current.incarnation}`)
    )
      violations.push(`cached output of another process: ${result.output}`);
    if (expected === undefined || !result || !current) return;
    const probedSince = probes.filter(
      (p) =>
        p.check === current.check &&
        p.incarnation === current.incarnation &&
        p.after === transitions,
    );
    // What the transition said, or what a probe of the current process and test said since: the cache may lag a probe that
    // answered and is not recorded yet, but never shows what neither the transition nor such a probe said.
    const allowed =
      result.status === "starting" ||
      result.status === expected ||
      probedSince.some((p) => p.passed === (result.status === "healthy"));
    if (!allowed)
      violations.push(
        `cached ${result.status} after the transition (expected ${expected}, ${probedSince.length} probes since)`,
      );
  }
}

/** Yield points of the pass under test and the ones after it that a schedule injects at. */
const POINTS = 24;

/** Runs every schedule of the cross product given, and says how many ran and what broke an invariant. */
async function runSchedules(dimensions: {
  scenarios: readonly Scenario[];
  answers: readonly Answer[];
  faults: boolean;
}): Promise<{ schedules: number; failures: string[] }> {
  let schedules = 0;
  const failures: string[] = [];
  for (const scenario of dimensions.scenarios)
    for (const answer of dimensions.answers)
      for (const restartsDo of [
        "deferred",
        "start fails",
        "start fails, replacement survives",
      ] as const)
        for (const event of EVENTS)
          for (let at = 1; at <= POINTS; at++) {
            const w = world(scenario, answer, restartsDo, dimensions.faults);
            // warm: rigd has seen web pass at 1 s; the next check is due at 6 s. cold: the first pass, at 1 s, is the one.
            if (scenario === "warm") await w.runUntil(1 * SECOND);
            w.arm(at, event);
            await w.runUntil((scenario === "warm" ? 6 : 1) * SECOND);
            w.checkCache();
            // The passes the event lands in, if it lands after the first, then two more, which forget what is no longer
            // monitored; the cache is judged after each.
            for (let pass = 0; pass < 12 && !w.fired(); pass++) {
              await w.more(1);
              w.checkCache();
            }
            await w.more(2);
            w.checkCache();
            if (w.expectsNothingLeft() && w.monitor.retained() !== 0)
              w.violations.push(
                `${w.monitor.retained()} entries kept for a Target that stopped or is gone`,
              );
            if (!w.fired()) continue;
            schedules++;
            for (const violation of w.violations)
              failures.push(
                `${scenario}, ${answer}, restarts ${restartsDo}, ${event} at point ${at}: ${violation}`,
              );
          }
  return { schedules, failures };
}

test("the interleaving harness: at every yield point of a pass, a check and a restart, every lifecycle event keeps the epoch rule's invariants", async () => {
  const { schedules, failures } = await runSchedules({
    scenarios: ["warm", "cold"],
    answers: ANSWERS,
    faults: false,
  });
  expect(failures).toEqual([]);
  // The whole cross product ran: 2 scenarios x 4 ways of answering x 3 kinds of restart x 7 events x 24 yield points,
  // each event injected.
  expect(schedules).toBe(2 * ANSWERS.length * 3 * EVENTS.length * POINTS);
  // Work, not waiting: the bound only keeps a loaded machine from failing it.
}, 60_000);

test("the interleaving harness under faults: with refused writes and unanswered observations, every event at every yield point keeps the invariants", async () => {
  // A smaller cross product, so the two together stay within a few seconds: the warm scenario, and the two answers in
  // which the process before the event and the one after it disagree.
  const answers: Answer[] = ["old passes, new fails", "old fails, new passes"];
  const { schedules, failures } = await runSchedules({
    scenarios: ["warm"],
    answers,
    faults: true,
  });
  expect(failures).toEqual([]);
  expect(schedules).toBe(answers.length * 3 * EVENTS.length * POINTS);
}, 60_000);

test("a health restart whose start failed is started again by the monitor on the back-off, never given up", async () => {
  for (const scenario of ["warm", "cold"] as const)
    for (const answer of ANSWERS.filter((a) => a.startsWith("old fails"))) {
      const w = world(scenario, answer, "start fails");
      w.arm(1, "turn the Target off");
      // cold: the recorded stretch puts the first restart at 60 s, and its failed start the next one 5 minutes later.
      await w.runUntil(400 * SECOND);
      const failed = w.restarts.findIndex((request) => !request.start);
      // Unhealthy, restarted, and the start failed; at the next step of the back-off the monitor starts it again.
      expect(failed).toBeGreaterThanOrEqual(0);
      expect(
        w.restarts.slice(failed + 1).some((request) => request.start),
      ).toBe(true);
      expect(w.violations).toEqual([]);
    }
}, 60_000);

test("a replacement that survives its failed start is judged by its ongoing checks, even when its record says its start failed", async () => {
  for (const restartsDo of [
    "start fails, replacement survives",
    "start fails, replacement survives, record says failed",
  ] as const) {
    const w = world("warm", "old fails, new passes", restartsDo);
    w.arm(1, "turn the Target off");
    await w.runUntil(30 * SECOND);
    // The replacement is checked, passes, and nothing waits for a start that is not needed.
    expect(w.probed()).toContain("web-f1");
    expect(w.monitor.results({ id: "t1" }, "web")).toMatchObject({
      status: "healthy",
    });
    expect(w.restarts.filter((request) => request.start)).toEqual([]);
    expect(w.violations).toEqual([]);
  }
}, 60_000);
