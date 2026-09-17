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
  stopTimeoutMs?: number;
  killWaitMs?: number;
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
  const signals = options.signals ?? [];
  const supervisor = createChildSupervisor({
    stateRoot,
    timing: options.timing,
    stopTimeoutMs: options.stopTimeoutMs,
    killWaitMs: options.killWaitMs,
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
  return { supervisor, signals };
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
  expect(await supervisor.stop("owned")).toEqual({ outcome: "unchanged" });
  expect(signals).toEqual([]);
  expect(await supervisor.observe("owned")).toEqual({ state: "stopped" });
  await supervisor.shutdown();
});
