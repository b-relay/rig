import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChildSupervisor } from "../src/providers/child-supervisor";
import { runCommand } from "../src/providers/command-runner";
import type {
  CommandRunner,
  ManagedProcess,
  StartControl,
  StopResult,
} from "../src/providers/contracts";
import {
  createLaunchdSupervisor,
  type LaunchdTiming,
} from "../src/providers/launchd-supervisor";
import {
  createProcessInspection,
  platformKill,
} from "../src/providers/process-inspection";
import type { ProcessTiming } from "../src/providers/process-timing";

/** A start whose capture wrapper never reports that its application started, under each supervisor: the start is cleaned
 * up within the Service's grace, shown as a stop, cut short by a kill, and left to finish on its own once rigd shuts down. */
const roots: string[] = [];
const groups: number[] = [];
afterEach(async () => {
  for (const group of groups.splice(0))
    try {
      process.kill(-group, "SIGKILL");
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

describe("launchd supervisor", () => {
  /** A clock the supervisor advances only through its own pauses, so budgets expire without real time. */
  function scriptedTiming(): LaunchdTiming {
    let clock = 0;
    return {
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
      applicationStartMs: 300,
      stopTimings: { killWaitMs: 100, headroomMs: 100 },
    };
  }

  /** A scripted launchctl whose job runs a capture wrapper that never reports its start. A bootout leaves the job loaded for
   * `unloadAfter` more prints, as a wrapper giving its application the grace does; `onPrint` sees each print after it. */
  async function neverReports(
    options: { unloadAfter?: number; onPrint?: (prints: number) => void } = {},
  ) {
    const root = await mkdtemp(join(tmpdir(), "rig-failed-start-launchd-"));
    roots.push(root);
    const commands: string[] = [];
    let loaded = false;
    let unloadIn: number | undefined;
    let printsAfterBootout = 0;
    const run: CommandRunner = async ({ command }) => {
      commands.push(command[1] === "kill" ? `kill ${command[2]}` : command[1]!);
      const action = command[1];
      if (action === "bootstrap") loaded = true;
      if (action === "bootout") unloadIn = options.unloadAfter ?? 0;
      if (action !== "print") return { exitCode: 0, stdout: "", stderr: "" };
      if (unloadIn !== undefined) {
        options.onPrint?.(++printsAfterBootout);
        if (unloadIn-- <= 0) loaded = false;
      }
      return loaded
        ? { exitCode: 0, stdout: "state = running\n\tpid = 4242\n", stderr: "" }
        : { exitCode: 113, stdout: "", stderr: "Could not find service" };
    };
    const shutdown = new AbortController();
    const supervisor = createLaunchdSupervisor({
      root,
      domain: "gui/99999",
      labelPrefix: "test.failed-start",
      run,
      inspect: async () => undefined,
      groupExists: async () => false,
      timing: scriptedTiming(),
      captureCommand: ["/usr/local/bin/rigd", "capture"],
      shutdown: shutdown.signal,
    });
    return { root, supervisor, commands, shutdown };
  }

  test("a capture start that never reports is booted out and waited for until the job leaves, shown as a stop, before the start fails", async () => {
    const w = await neverReports({ unloadAfter: 3 });
    const { control, heard } = recordingControl();
    await expect(
      w.supervisor.ensureRunning(request(w.root, 300), control),
    ).rejects.toMatchObject({ code: "PROCESS_START_TIMEOUT" });
    // The job is still loaded for three polls after its bootout; the start fails only once it has left.
    const after = w.commands.slice(w.commands.lastIndexOf("bootout"));
    expect(after).toEqual(["bootout", "print", "print", "print", "print"]);
    expect(heard).toEqual([
      ["stopping", 300],
      ["stopped", { outcome: "stopped" }],
    ]);
    // Nothing of the job is left for a retry to find.
    expect(
      (await readdir(w.root)).filter((file) =>
        file.startsWith("test.failed-start"),
      ),
    ).toEqual([]);
  });

  test("rigd's shutdown ends that wait at the next poll with STOP_DETACHED, however long the grace, and leaves the job to finish on its own", async () => {
    let w!: Awaited<ReturnType<typeof neverReports>>;
    w = await neverReports({
      unloadAfter: Infinity,
      onPrint: (prints) => {
        if (prints === 2) w.shutdown.abort();
      },
    });
    const { control, heard } = recordingControl();
    await expect(
      w.supervisor.ensureRunning(request(w.root, 3_600_000), control),
    ).rejects.toMatchObject({ code: "STOP_DETACHED" });
    const after = w.commands.slice(w.commands.lastIndexOf("bootout"));
    expect(after).toEqual(["bootout", "print", "print"]);
    expect(heard).toEqual([
      ["stopping", 3_600_000],
      ["stopped", { outcome: "failed" }],
    ]);
    // The job and its files stay for the next daemon's stop.
    expect(
      (await readdir(w.root)).some((file) => file.endsWith(".plist")),
    ).toBe(true);
  });

  test("a kill cuts that wait short: the wrapper is told to kill its application", async () => {
    const kill = new AbortController();
    let w!: Awaited<ReturnType<typeof neverReports>>;
    w = await neverReports({
      unloadAfter: Infinity,
      onPrint: (prints) => {
        if (prints === 1) kill.abort();
      },
    });
    const { control } = recordingControl(kill.signal);
    await expect(
      w.supervisor.ensureRunning(request(w.root, 3_600_000), control),
    ).rejects.toMatchObject({ code: "LAUNCHD_STOP" });
    expect(w.commands).toContain("kill SIGUSR2");
  });
});

describe("rigd supervisor", () => {
  /** Real time, except that from the moment `ready` exists until the first signal is sent every wait passes at once: the
   * start's five-second wait for its wrapper is over immediately, and the clean-up stop that follows runs in real time. */
  function fastUntilSignalled(ready: string) {
    let skew = 0;
    let signalled = false;
    const timing: ProcessTiming = {
      now: () => new Date(Date.now() + skew),
      wait: async (ms) => {
        if (signalled || !existsSync(ready)) return await Bun.sleep(ms);
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
    const clock = fastUntilSignalled(join(root, "trapping"));
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
    groups.push(w.signals[0]![0]);
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
    groups.push(wrapper);
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
    groups.push(w.signals[0]![0]);
    kill.abort();
    await expect(starting).rejects.toMatchObject({
      code: "PROCESS_START_TIMEOUT",
    });
    expect(heard.at(-1)).toEqual([
      "stopped",
      { outcome: "stopped", killed: "request" } satisfies StopResult,
    ]);
  });
});
