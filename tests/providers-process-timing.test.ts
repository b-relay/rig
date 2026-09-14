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

/** A clock that only moves when the supervisor waits, plus timers the test fires or inspects by hand. */
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
    advance: (ms: number) => {
      clock += ms;
    },
    pending: () => [...timers.values()].map((timer) => timer.at - start),
    /** Runs every due timer, as the platform would once their delay elapsed. */
    fire: () => {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, timer] of due) timer.callback();
    },
  };
}

/** A lease-recovered process (no child handle) whose presence the test scripts. */
async function recovered(options: {
  timing: ProcessTiming;
  present: () => boolean;
  identity?: () => string | undefined;
  stopTimeoutMs?: number;
  killWaitMs?: number;
  keepAlive?: boolean;
  /** Receives every signal sent to the group, in order; the test may also consult it from `present`. */
  signals?: Array<NodeJS.Signals | 0>;
}) {
  const root = await mkdtemp(join(tmpdir(), "rig-timing-"));
  roots.push(root);
  const stateRoot = join(root, ".rig");
  await mkdir(join(stateRoot, "process-leases"), { recursive: true });
  const request = {
    key: "owned",
    componentName: "web",
    command: [
      "/bin/sh",
      "-c",
      `touch ${JSON.stringify(join(root, "revived"))}`,
    ],
    cwd: root,
    env: {},
    logRoot: root,
    keepAlive: options.keepAlive ?? false,
  };
  await writeFile(
    join(
      stateRoot,
      "process-leases",
      createHash("sha256").update("owned").digest("hex") + ".json",
    ),
    JSON.stringify({ key: "owned", pid, identity, request }),
  );
  const signals = options.signals ?? [];
  const supervisor = createChildSupervisor({
    stateRoot,
    timing: options.timing,
    stopTimeoutMs: options.stopTimeoutMs,
    killWaitMs: options.killWaitMs,
    restartBackoffMs: 100,
    processInspection: createProcessInspection({
      kill: (target, signal) => {
        expect(target).toBe(-pid);
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
  return { supervisor, signals, root, request };
}

test("stop escalates to SIGKILL exactly when the TERM grace elapses, without a platform sleep", async () => {
  const clock = virtualTiming();
  const signals: Array<NodeJS.Signals | 0> = [];
  // The group ignores SIGTERM and disappears 40 ms after SIGKILL.
  const { supervisor } = await recovered({
    timing: clock.timing,
    stopTimeoutMs: 3000,
    signals,
    present: () => !(signals.includes("SIGKILL") && clock.elapsed() >= 3040),
  });
  expect(await supervisor.stop("owned")).toEqual({ outcome: "stopped" });
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(clock.elapsed()).toBeGreaterThanOrEqual(3040);
  expect(clock.elapsed()).toBeLessThan(3100);
});

test("a group that leaves on SIGTERM is never killed and stop returns as soon as it is gone", async () => {
  const clock = virtualTiming();
  const signals: Array<NodeJS.Signals | 0> = [];
  const { supervisor } = await recovered({
    timing: clock.timing,
    stopTimeoutMs: 3000,
    signals,
    present: () => !(signals.includes("SIGTERM") && clock.elapsed() >= 60),
  });
  expect(await supervisor.stop("owned")).toEqual({ outcome: "stopped" });
  expect(signals).toEqual(["SIGTERM"]);
  expect(clock.elapsed()).toBeLessThan(200);
});

test("a group that survives SIGKILL fails as STOP_TIMEOUT after the TERM grace plus the configured kill wait", async () => {
  const clock = virtualTiming();
  const { supervisor, signals } = await recovered({
    timing: clock.timing,
    stopTimeoutMs: 500,
    killWaitMs: 250,
    present: () => true,
  });
  await expect(supervisor.stop("owned")).rejects.toMatchObject({
    code: "STOP_TIMEOUT",
  });
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(clock.elapsed()).toBeGreaterThanOrEqual(750);
  expect(clock.elapsed()).toBeLessThan(800);
});

test("stop cancels a pending restart and a late timer callback cannot revive the process", async () => {
  const clock = virtualTiming();
  let alive = true;
  const { supervisor, root } = await recovered({
    timing: clock.timing,
    keepAlive: true,
    present: () => false,
    identity: () => (alive ? "born" : undefined),
  });
  expect(await supervisor.observe("owned")).toEqual({ state: "running", pid });
  alive = false;
  expect(await supervisor.observe("owned")).toEqual({
    state: "stopped",
    restartPending: true,
    restartAt: clock.timing.now().getTime() + 100,
  });
  expect(clock.pending()).toEqual([100]);
  expect(await supervisor.stop("owned")).toEqual({ outcome: "unchanged" });
  expect(clock.pending()).toEqual([]);
  // A callback the platform had already queued when the timer was cancelled.
  const late = clock.timing.schedule(0, () => {});
  late();
  clock.fire();
  await Bun.sleep(20);
  expect(await supervisor.observe("owned")).toEqual({ state: "stopped" });
  expect(await Bun.file(join(root, "revived")).exists()).toBe(false);
  await supervisor.shutdown();
});

test("the restart budget is a sliding window on the supplied clock: exhausted attempts return once the window has passed", async () => {
  const clock = virtualTiming();
  const root = await mkdtemp(join(tmpdir(), "rig-timing-"));
  roots.push(root);
  const supervisor = createChildSupervisor({
    stateRoot: join(root, ".rig"),
    timing: clock.timing,
    restartLimit: 2,
    restartWindowMs: 1000,
    restartBackoffMs: 100,
  });
  const request = {
    key: "flaky",
    componentName: "web",
    command: ["/usr/bin/true"],
    cwd: root,
    env: {},
    logRoot: root,
    keepAlive: true,
  };
  const untilStopped = async () => {
    for (let i = 0; i < 500; i++) {
      const observation = await supervisor.observe("flaky");
      if (observation.state === "stopped") return observation;
      await Bun.sleep(2);
    }
    throw new Error("the process did not exit");
  };
  try {
    await supervisor.ensureRunning(request);
    expect(await untilStopped()).toMatchObject({
      restartPending: true,
      restartAt: clock.timing.now().getTime() + 100,
    });
    clock.fire();
    await Bun.sleep(20);
    expect(await untilStopped()).toMatchObject({
      restartPending: true,
      restartAt: clock.timing.now().getTime() + 200,
    });
    clock.fire();
    await Bun.sleep(20);
    expect(await untilStopped()).toEqual({ state: "stopped", exitCode: 0 });
    expect(clock.pending()).toEqual([]);
    clock.advance(1001);
    await supervisor.ensureRunning(request);
    expect(await untilStopped()).toMatchObject({
      restartPending: true,
      restartAt: clock.timing.now().getTime() + 100,
    });
  } finally {
    await supervisor.shutdown();
  }
});

test("a scheduled restart that cannot start ends the pending restart instead of failing silently forever", async () => {
  const clock = virtualTiming();
  const base = await mkdtemp(join(tmpdir(), "rig-timing-"));
  roots.push(base);
  const cwd = join(base, "workdir");
  await mkdir(cwd);
  const supervisor = createChildSupervisor({
    stateRoot: join(base, ".rig"),
    timing: clock.timing,
    restartBackoffMs: 100,
  });
  const request = {
    key: "gone",
    componentName: "web",
    command: ["/usr/bin/true"],
    cwd,
    env: {},
    logRoot: base,
    keepAlive: true,
  };
  try {
    await supervisor.ensureRunning(request);
    for (
      let i = 0;
      i < 500 && !(await supervisor.observe("gone")).restartPending;
      i++
    )
      await Bun.sleep(2);
    expect(clock.pending()).toEqual([100]);
    await rm(cwd, { recursive: true });
    clock.fire();
    await Bun.sleep(50);
    expect(await supervisor.observe("gone")).toEqual({
      state: "stopped",
      exitCode: 0,
    });
    expect(clock.pending()).toEqual([]);
  } finally {
    await supervisor.shutdown();
  }
});
