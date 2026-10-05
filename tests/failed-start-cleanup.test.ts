import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChildSupervisor } from "../src/providers/child-supervisor";
import { createProcessIdentityReader } from "../src/providers/process-identity";
import { runCommand } from "../src/providers/command-runner";
import type {
  ManagedProcess,
  StartControl,
  StopResult,
} from "../src/providers/contracts";
import {
  createProcessInspection,
  platformKill,
} from "../src/providers/process-inspection";
import {
  createProcessTiming,
  type ProcessTiming,
} from "../src/providers/process-timing";

/** A start whose capture wrapper never reports that its application started, under rigd: the start is cleaned
 * up within the Service's grace, shown as a stop, cut short by a kill, and left to finish on its own once rigd shuts down. */
const roots: string[] = [];
const identityOf = createProcessIdentityReader(runCommand);
/** Process groups a test started, with their leader's birth identity read while it was known to run: cleanup signals a
 * group only while that identity still matches, never a reused id. */
const groups: { pid: number; identity: string }[] = [];
afterEach(async () => {
  for (const group of groups.splice(0))
    if ((await identityOf(group.pid)) === group.identity)
      try {
        process.kill(-group.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

function request(root: string, stopGraceMs: number): ManagedProcess {
  return {
    key: "target-1:web",
    componentName: "web",
    command: ["/bin/sh", "-c", "serve"],
    cwd: root,
    env: { PATH: "/usr/bin:/bin" },
    logRoot: join(root, "logs"),
    incarnation: "start-1",
    stopGraceMs,
  };
}

/** What a start's control heard of its clean-up, in order. */
function recordingControl(kill?: AbortSignal) {
  const heard: Array<["stopping", number] | ["stopped", unknown]> = [];
  const control: StartControl = {
    ...(kill ? { kill } : {}),
    observer: {
      stopping: (graceMs) => heard.push(["stopping", graceMs]),
      stopped: (ended) => heard.push(["stopped", ended]),
    },
  };
  return { control, heard };
}

describe("rigd supervisor", () => {
  /** Real time, except that from the moment `ready` exists until the first signal is sent every wait passes at once: the
   * start's five-second wait for its wrapper is over immediately, and the clean-up stop that follows runs in real time. */
  function fastUntilSignalled(ready: string, lease: string) {
    let skew = 0;
    let signalled = false;
    let registered = false;
    const timing: ProcessTiming = {
      now: () => new Date(Date.now() + skew),
      wait: async (ms) => {
        if (signalled || !existsSync(ready)) return await Bun.sleep(ms);
        // The wrapper runs, so its lease (pid and birth identity, written before its release) names it: cleanup ends it
        // whether or not the supervisor ever signals it.
        if (!registered) {
          registered = true;
          groups.push(JSON.parse(readFileSync(lease, "utf8")));
        }
        skew += ms;
        await Promise.resolve();
      },
      schedule: (ms, callback) => {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    };
    const platform = createProcessInspection({
      run: runCommand,
      kill: platformKill,
    });
    const signals: Array<[number, NodeJS.Signals]> = [];
    return {
      timing,
      signals,
      processInspection: {
        ...platform,
        signalGroup: async (pid: number, signal: NodeJS.Signals) => {
          signalled = true;
          signals.push([pid, signal]);
          await platform.signalGroup(pid, signal);
        },
      },
    };
  }

  /** A child supervisor whose capture wrapper ignores SIGTERM and the kill request, and never reports its start. */
  async function neverReports() {
    const root = await mkdtemp(join(tmpdir(), "rig-failed-start-rigd-"));
    roots.push(root);
    // The wrapper's trap must be set before any SIGTERM reaches it.
    const clock = fastUntilSignalled(
      join(root, "trapping"),
      join(
        root,
        "process-leases",
        `${createHash("sha256").update("target-1:web").digest("hex")}.json`,
      ),
    );
    const shutdown = new AbortController();
    const supervisor = createChildSupervisor({
      stateRoot: root,
      captureCommand: [
        "/bin/sh",
        "-c",
        "trap '' TERM USR2; : > trapping; while :; do sleep 0.05; done",
      ],
      timing: clock.timing,
      processInspection: clock.processInspection,
      stopTimings: { killWaitMs: 100, headroomMs: 100 },
      shutdown: shutdown.signal,
    });
    return { root, supervisor, shutdown, signals: clock.signals };
  }

  test("a capture start that never reports is stopped within the Service's grace, shown as a stop, before the start fails", async () => {
    const w = await neverReports();
    const { control, heard } = recordingControl();
    const at = performance.now();
    await expect(
      w.supervisor.ensureRunning(request(w.root, 300), control),
    ).rejects.toMatchObject({ code: "PROCESS_START_TIMEOUT" });
    // The wrapper ignores SIGTERM: it is SIGKILLed once its budget (grace, kill wait and headroom) is over.
    expect(w.signals.map(([, signal]) => signal)).toEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
    expect(performance.now() - at).toBeGreaterThanOrEqual(500);
    expect(heard).toEqual([
      ["stopping", 300],
      ["stopped", { outcome: "stopped", killed: "timeout" }],
    ]);
    expect(await w.supervisor.observe("target-1:web")).toEqual({
      state: "stopped",
    });
  });

  test("rigd's shutdown ends that stop at once with STOP_DETACHED, however long the grace, and the wrapper stays owned and stopping", async () => {
    const w = await neverReports();
    const { control, heard } = recordingControl();
    const starting = w.supervisor.ensureRunning(
      request(w.root, 3_600_000),
      control,
    );
    for (let i = 0; i < 500 && !w.signals.length; i++) await Bun.sleep(10);
    const wrapper = w.signals[0]![0];
    const at = performance.now();
    w.shutdown.abort();
    await expect(starting).rejects.toMatchObject({ code: "STOP_DETACHED" });
    expect(performance.now() - at).toBeLessThan(1000);
    expect(w.signals.map(([, signal]) => signal)).toEqual(["SIGTERM"]);
    expect(heard).toEqual([
      ["stopping", 3_600_000],
      ["stopped", { outcome: "failed" }],
    ]);
    expect(await w.supervisor.observe("target-1:web")).toMatchObject({
      state: "running",
      pid: wrapper,
    });
  });

  test("a kill cuts that stop short: the wrapper is SIGKILLed after the kill wait, and the stop says it was asked for", async () => {
    const w = await neverReports();
    const kill = new AbortController();
    const { control, heard } = recordingControl(kill.signal);
    const starting = w.supervisor.ensureRunning(
      request(w.root, 3_600_000),
      control,
    );
    for (let i = 0; i < 500 && !w.signals.length; i++) await Bun.sleep(10);
    kill.abort();
    await expect(starting).rejects.toMatchObject({
      code: "PROCESS_START_TIMEOUT",
    });
    expect(heard.at(-1)).toEqual([
      "stopped",
      { outcome: "stopped", killed: "request" } satisfies StopResult,
    ]);
  });

  test("a shutdown that began before the clean-up still asks the wrapper to stop, then stops waiting, and names the start's failure", async () => {
    const w = await neverReports();
    w.shutdown.abort();
    const failure = await w.supervisor
      .ensureRunning(request(w.root, 3_600_000))
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "STOP_DETACHED",
      details: {
        startFailure: expect.stringContaining("PROCESS_START_TIMEOUT"),
      },
    });
    expect(w.signals.map(([, signal]) => signal)).toEqual(["SIGTERM"]);
  });

  test("once shutdown began, a Service whose earlier process ended still starts: only a failed start's clean-up detaches on it", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-failed-start-rigd-"));
    roots.push(root);
    const shutdown = new AbortController();
    const supervisor = createChildSupervisor({
      stateRoot: root,
      timing: createProcessTiming(),
      processInspection: createProcessInspection({
        run: runCommand,
        kill: platformKill,
      }),
      shutdown: shutdown.signal,
    });
    const exits = {
      ...request(root, 1000),
      command: ["/bin/sh", "-c", "exit 3"],
    };
    await supervisor.ensureRunning(exits);
    for (let i = 0; i < 200; i++) {
      if ((await supervisor.observe(exits.key)).state === "stopped") break;
      await Bun.sleep(10);
    }
    shutdown.abort();
    const again = await supervisor.ensureRunning({
      ...exits,
      incarnation: "start-2",
      command: ["/bin/sh", "-c", "exec sleep 30"],
    });
    const identity = await identityOf(again.pid!);
    if (identity) groups.push({ pid: again.pid!, identity });
    expect(again.outcome).toBe("started");
    await supervisor.shutdown();
  });
});
