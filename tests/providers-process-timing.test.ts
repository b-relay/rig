import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChildSupervisor } from "../src/providers/child-supervisor";
import { createProcessInspection } from "../src/providers/process-inspection";
import type { ProcessTiming } from "../src/providers/process-timing";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const errno = (code: string) => Object.assign(new Error(code), { code });
const pid = 424242;
const identity = createHash("sha256").update(`${pid}:born`).digest("hex");

/** A clock that only moves when the supervisor waits, plus the timers it scheduled, which the test inspects. */
function virtualTiming(start = 1_700_000_000_000) {
  let clock = start;
  let next = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const timing: ProcessTiming = {
    now: () => new Date(clock),
    wait: async (ms) => {
      clock += ms;
      await Promise.resolve();
    },
    schedule: (ms, callback) => {
      const id = ++next;
      timers.set(id, { at: clock + ms, callback });
      return () => {
        timers.delete(id);
      };
    },
  };
  return {
    timing,
    elapsed: () => clock - start,
    pending: () => [...timers.values()].map((timer) => timer.at - start),
  };
}

/** A lease-recovered process (no child handle) whose presence the test scripts. */
async function recovered(options: {
  timing: ProcessTiming;
  present: () => boolean;
  identity?: () => string | undefined;
  killWaitMs?: number;
  /** Runs the recovered process as a capture wrapper, whose request says whether it understands a kill. */
  capture?: { understandsKill: boolean };
  /** Receives every signal sent to the group, in order; the test may also consult it from `present`. */
  signals?: Array<NodeJS.Signals | 0>;
}) {
  const root = await mkdtemp(join(tmpdir(), "rig-timing-"));
  roots.push(root);
  const stateRoot = join(root, ".rig");
  await mkdir(join(stateRoot, "process-leases"), { recursive: true });
  await writeFile(
    join(
      stateRoot,
      "process-leases",
      createHash("sha256").update("owned").digest("hex") + ".json",
    ),
    JSON.stringify({ key: "owned", pid, identity, incarnation: "start-1" }),
  );
  if (options.capture) {
    await mkdir(join(stateRoot, "capture"), { recursive: true });
    await writeFile(
      join(
        stateRoot,
        "capture",
        createHash("sha256").update("owned").digest("hex") + ".json",
      ),
      JSON.stringify({
        key: "owned",
        componentName: "web",
        command: ["serve"],
        cwd: root,
        env: {},
        logRoot: root,
        incarnation: "start-1",
        ...(options.capture.understandsKill ? { stopGraceMs: 60_000 } : {}),
      }),
    );
  }
  const signals = options.signals ?? [];
  const supervisor = createChildSupervisor({
    stateRoot,
    timing: options.timing,
    stopTimings: {
      killWaitMs: options.killWaitMs ?? 1500,
      headroomMs: options.capture ? 2000 : 0,
    },
    ...(options.capture ? { captureCommand: ["capture"] } : {}),
    processInspection: createProcessInspection({
      kill: (target, signal) => {
        // Only the kill request goes to the wrapper alone; every other signal goes to its group.
        expect(target).toBe(signal === "SIGUSR2" ? pid : -pid);
        if (signal !== 0) signals.push(signal);
        if (!options.present()) throw errno("ESRCH");
      },
      run: async (request) => ({
        exitCode: 0,
        stdout: request.command.includes("lstart=")
          ? options.identity
            ? (options.identity() ?? "")
            : "born"
          : "",
        stderr: "",
      }),
    }),
  });
  return { supervisor, signals };
}

test("stop escalates to SIGKILL exactly when the TERM grace elapses, without a platform sleep", async () => {
  const clock = virtualTiming();
  const signals: Array<NodeJS.Signals | 0> = [];
  // The group ignores SIGTERM and disappears 40 ms after SIGKILL.
  const { supervisor } = await recovered({
    timing: clock.timing,
    signals,
    present: () => !(signals.includes("SIGKILL") && clock.elapsed() >= 3040),
  });
  expect(await supervisor.stop("owned", { graceMs: 3000 })).toEqual({
    outcome: "stopped",
    killed: "timeout",
  });
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(clock.elapsed()).toBeGreaterThanOrEqual(3040);
  expect(clock.elapsed()).toBeLessThan(3100);
});

test("a group that leaves on SIGTERM is never killed and stop returns as soon as it is gone", async () => {
  const clock = virtualTiming();
  const signals: Array<NodeJS.Signals | 0> = [];
  const { supervisor } = await recovered({
    timing: clock.timing,
    signals,
    present: () => !(signals.includes("SIGTERM") && clock.elapsed() >= 60),
  });
  expect(await supervisor.stop("owned", { graceMs: 3000 })).toEqual({
    outcome: "stopped",
  });
  expect(signals).toEqual(["SIGTERM"]);
  expect(clock.elapsed()).toBeLessThan(200);
});

test("a group that survives SIGKILL fails as STOP_TIMEOUT after the TERM grace plus the configured kill wait", async () => {
  const clock = virtualTiming();
  const { supervisor, signals } = await recovered({
    timing: clock.timing,
    killWaitMs: 250,
    present: () => true,
  });
  await expect(
    supervisor.stop("owned", { graceMs: 500 }),
  ).rejects.toMatchObject({
    code: "STOP_TIMEOUT",
  });
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(clock.elapsed()).toBeGreaterThanOrEqual(750);
  expect(clock.elapsed()).toBeLessThan(800);
});

test("a recovered process that is gone is a bare stop: no restart is scheduled and stop has nothing to signal", async () => {
  const clock = virtualTiming();
  let alive = true;
  const { supervisor, signals } = await recovered({
    timing: clock.timing,
    present: () => false,
    identity: () => (alive ? "born" : undefined),
  });
  expect(await supervisor.observe("owned")).toEqual({
    state: "running",
    pid,
    incarnation: "start-1",
  });
  alive = false;
  expect(await supervisor.observe("owned")).toEqual({ state: "stopped" });
  expect(clock.pending()).toEqual([]);
  expect(await supervisor.stop("owned", { graceMs: 1500 })).toEqual({
    outcome: "unchanged",
  });
  expect(signals).toEqual([]);
  expect(await supervisor.observe("owned")).toEqual({ state: "stopped" });
  await supervisor.shutdown();
});

test("a kill during the grace cuts it to the kill wait: SIGKILL follows the kill by the kill wait, and the stop says it was asked for", async () => {
  const clock = virtualTiming();
  const signals: Array<NodeJS.Signals | 0> = [];
  const kill = new AbortController();
  const { supervisor } = await recovered({
    timing: clock.timing,
    killWaitMs: 1500,
    signals,
    present: () => {
      // The operator runs rig down --kill ten seconds into a two-minute grace.
      if (clock.elapsed() >= 10_000) kill.abort();
      return !signals.includes("SIGKILL");
    },
  });
  expect(
    await supervisor.stop("owned", { graceMs: 120_000, kill: kill.signal }),
  ).toEqual({ outcome: "stopped", killed: "request" });
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(clock.elapsed()).toBeGreaterThanOrEqual(11_500);
  expect(clock.elapsed()).toBeLessThan(11_600);
});

test("a kill asked before the stop starts is SIGTERM, then SIGKILL after the kill wait; a group that leaves on SIGTERM is not killed", async () => {
  const clock = virtualTiming();
  const signals: Array<NodeJS.Signals | 0> = [];
  const kill = new AbortController();
  kill.abort();
  const { supervisor } = await recovered({
    timing: clock.timing,
    killWaitMs: 1500,
    signals,
    present: () => !signals.includes("SIGKILL"),
  });
  expect(
    await supervisor.stop("owned", { graceMs: 600_000, kill: kill.signal }),
  ).toEqual({ outcome: "stopped", killed: "request" });
  expect(clock.elapsed()).toBeGreaterThanOrEqual(1500);
  expect(clock.elapsed()).toBeLessThan(1600);
  const polite = virtualTiming();
  const quiet: Array<NodeJS.Signals | 0> = [];
  const { supervisor: second } = await recovered({
    timing: polite.timing,
    signals: quiet,
    present: () => polite.elapsed() < 200,
  });
  expect(
    await second.stop("owned", { graceMs: 600_000, kill: kill.signal }),
  ).toEqual({ outcome: "stopped" });
  expect(quiet).toEqual(["SIGTERM"]);
});

test("a capture wrapper is waited for through its application's grace, kill wait and headroom before it is killed, so its grace always finishes", async () => {
  const clock = virtualTiming();
  const signals: Array<NodeJS.Signals | 0> = [];
  const { supervisor } = await recovered({
    timing: clock.timing,
    killWaitMs: 1500,
    capture: { understandsKill: true },
    signals,
    present: () => !signals.includes("SIGKILL"),
  });
  expect(await supervisor.stop("owned", { graceMs: 120_000 })).toEqual({
    outcome: "stopped",
    killed: "timeout",
  });
  // 120 s grace + 1.5 s kill wait + 2 s headroom before rigd kills the wrapper.
  expect(clock.elapsed()).toBeGreaterThanOrEqual(123_500);
  expect(clock.elapsed()).toBeLessThan(123_600);
});

test("a kill tells a capture wrapper that understands it to cut its application's grace, and one written by an older rigd is never sent the signal", async () => {
  for (const understandsKill of [true, false]) {
    const clock = virtualTiming();
    const signals: Array<NodeJS.Signals | 0> = [];
    const kill = new AbortController();
    kill.abort();
    const { supervisor } = await recovered({
      timing: clock.timing,
      capture: { understandsKill },
      signals,
      // The wrapper ends 1.6 s after it was told to kill; the older one only after its own short grace.
      present: () => clock.elapsed() < 1600,
    });
    expect(
      await supervisor.stop("owned", { graceMs: 60_000, kill: kill.signal }),
    ).toEqual({ outcome: "stopped" });
    expect(signals).toEqual(
      understandsKill ? ["SIGTERM", "SIGUSR2"] : ["SIGTERM"],
    );
  }
});

test("a detached stop stops waiting at once: STOP_DETACHED, no SIGKILL, and the process stays owned for the next stop", async () => {
  const clock = virtualTiming();
  const signals: Array<NodeJS.Signals | 0> = [];
  const detach = new AbortController();
  const { supervisor } = await recovered({
    timing: clock.timing,
    signals,
    present: () => {
      if (clock.elapsed() >= 5000) detach.abort();
      return true;
    },
  });
  await expect(
    supervisor.stop("owned", { graceMs: 3_600_000, detach: detach.signal }),
  ).rejects.toMatchObject({ code: "STOP_DETACHED" });
  expect(signals).toEqual(["SIGTERM"]);
  expect(clock.elapsed()).toBeLessThan(5100);
  expect((await supervisor.observe("owned")).state).toBe("running");
});

test("a wrapper started with a longer grace than the stop now asks for is still given that grace", async () => {
  const clock = virtualTiming();
  const signals: Array<NodeJS.Signals | 0> = [];
  // Its request was written with a 60 s grace; the plan now says 1 s.
  const { supervisor } = await recovered({
    timing: clock.timing,
    killWaitMs: 1500,
    capture: { understandsKill: true },
    signals,
    present: () => !signals.includes("SIGKILL"),
  });
  await supervisor.stop("owned", { graceMs: 1000 });
  expect(clock.elapsed()).toBeGreaterThanOrEqual(63_500);
});
