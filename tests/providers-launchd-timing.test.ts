import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLaunchdSupervisor,
  type LaunchdTiming,
} from "../src/providers/launchd-supervisor";
import type { CommandRunner } from "../src/providers/contracts";
import { writeCaptureRequest } from "../src/providers/capture-request";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** A clock the supervisor advances only through its own pauses, so budgets expire without real time. */
function scriptedTiming(): LaunchdTiming & { pauses: number[] } {
  let clock = 0;
  const pauses: number[] = [];
  return {
    pauses,
    now: () => clock,
    wait: async (ms) => {
      pauses.push(ms);
      clock += ms;
    },
    applicationStartMs: 300,
    // A 300 ms grace sizes ExitTimeOut at its 1 s floor, and the unload wait at that plus the kill wait and headroom.
    stopTimings: { killWaitMs: 100, headroomMs: 100 },
  };
}

test("launchd start and unload waits run on the injected clock and budgets: a late application, a job that appears on the third poll, and a job that never unloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-launchd-timing-"));
  roots.push(root);
  const request = {
    key: "target-1:web",
    componentName: "web",
    command: ["/bin/sh", "-c", "serve"],
    cwd: root,
    env: {},
    logRoot: root,
    incarnation: "start-1",
  };
  let prints = 0;
  let pidAfterPrints = Infinity;
  let loaded = false;
  const run: CommandRunner = async ({ command }) => {
    const action = command[1];
    if (action === "bootstrap") loaded = true;
    if (action !== "print") return { exitCode: 0, stdout: "", stderr: "" };
    if (!loaded)
      return { exitCode: 113, stdout: "", stderr: "Could not find service" };
    prints += 1;
    return {
      exitCode: 0,
      stdout:
        prints >= pidAfterPrints
          ? "state = running\n\tpid = 4242\n"
          : "state = running\n",
      stderr: "",
    };
  };
  const timing = scriptedTiming();
  const started = performance.now();
  const supervisor = createLaunchdSupervisor({
    root,
    domain: "gui/99999",
    labelPrefix: "test.timing",
    run,
    groupExists: async () => false,
    inspect: async () => undefined,
    timing,
  });

  await expect(supervisor.ensureRunning(request)).rejects.toMatchObject({
    code: "LAUNCHD_START",
  });
  expect(timing.pauses).toEqual([100, 100, 100]);

  timing.pauses.length = 0;
  prints = 0;
  pidAfterPrints = 5; // the running-job check and the `existing` print before bootstrap, then three application polls
  expect(await supervisor.ensureRunning(request)).toEqual({
    outcome: "started",
    pid: 4242,
  });
  expect(timing.pauses).toEqual([100, 100]);

  timing.pauses.length = 0;
  await expect(
    supervisor.stop(request.key, { graceMs: 300 }),
  ).rejects.toMatchObject({
    code: "LAUNCHD_STOP",
    message: expect.stringContaining("did not unload within 1.2 s."),
  });
  expect(timing.pauses).toEqual(Array(12).fill(100));
  expect(performance.now() - started).toBeLessThan(500);
});

test("a detached unload wait ends at the next poll, however long the grace, and never kills the job", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-launchd-timing-"));
  roots.push(root);
  const detach = new AbortController();
  const commands: string[] = [];
  let prints = 0;
  const run: CommandRunner = async ({ command }) => {
    commands.push(command[1]!);
    if (command[1] === "print" && ++prints === 3) detach.abort();
    return { exitCode: 0, stdout: "state = running\n", stderr: "" };
  };
  const timing = scriptedTiming();
  const supervisor = createLaunchdSupervisor({
    root,
    domain: "gui/99999",
    labelPrefix: "test.timing",
    run,
    inspect: async () => undefined,
    groupExists: async () => false,
    timing,
  });
  await expect(
    supervisor.stop("target-1:web", {
      graceMs: 3_600_000,
      detach: detach.signal,
    }),
  ).rejects.toMatchObject({ code: "STOP_DETACHED" });
  expect(commands).toEqual(["print", "bootout", "print", "print"]);
  expect(timing.pauses).toEqual([100, 100]);
});

/** A launchd supervisor with a capture wrapper whose running start asked for `stopGraceMs`, over a scripted launchctl. */
async function capturedJob(
  run: CommandRunner,
  stopGraceMs = 3_600_000,
): Promise<{ supervisor: ReturnType<typeof createLaunchdSupervisor> }> {
  const root = await mkdtemp(join(tmpdir(), "rig-launchd-timing-"));
  roots.push(root);
  const key = "target-1:web";
  const label = `test.timing.${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
  await writeCaptureRequest(join(root, `${label}.json`), {
    key,
    componentName: "web",
    command: ["/bin/sh", "-c", "serve"],
    cwd: root,
    env: {},
    logRoot: root,
    incarnation: "start-1",
    stopGraceMs,
  });
  return {
    supervisor: createLaunchdSupervisor({
      root,
      domain: "gui/99999",
      labelPrefix: "test.timing",
      run,
      inspect: async () => undefined,
      groupExists: async () => false,
      timing: scriptedTiming(),
      captureCommand: ["/usr/local/bin/rigd", "capture"],
    }),
  };
}

test("a kill launchctl could not deliver is asked again at the next poll, and the long grace stands until it is delivered", async () => {
  const commands: string[] = [];
  let kills = 0;
  let unloadIn: number | undefined;
  const run: CommandRunner = async ({ command }) => {
    commands.push(command.slice(1, 3).join(" "));
    if (command[1] === "kill")
      return ++kills === 1
        ? { exitCode: 3, stdout: "", stderr: "kill failed" }
        : ((unloadIn = 2), { exitCode: 0, stdout: "", stderr: "" });
    if (command[1] === "print" && unloadIn !== undefined && --unloadIn < 0)
      return { exitCode: 113, stdout: "", stderr: "Could not find service" };
    return { exitCode: 0, stdout: "state = running\n", stderr: "" };
  };
  const { supervisor } = await capturedJob(run);
  const kill = new AbortController();
  kill.abort();
  expect(
    await supervisor.stop("target-1:web", {
      graceMs: 3_600_000,
      kill: kill.signal,
    }),
  ).toMatchObject({ outcome: "stopped" });
  expect(commands.filter((command) => command.startsWith("kill"))).toEqual([
    "kill SIGUSR2",
    "kill SIGUSR2",
  ]);
});

test("a kill or a detach asked while launchctl bootout hangs goes on at once, not after bootout's own timeout", async () => {
  for (const ask of ["kill", "detach"] as const) {
    const commands: string[] = [];
    let unloadIn: number | undefined;
    const signal = new AbortController();
    const run: CommandRunner = async ({ command }) => {
      commands.push(command[1]!);
      if (command[1] === "bootout") {
        // launchctl hangs; the stop is asked to go on meanwhile.
        setTimeout(() => signal.abort(), 1);
        return await new Promise(() => {});
      }
      if (command[1] === "kill") {
        unloadIn = 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command[1] === "print" && unloadIn !== undefined && --unloadIn < 0)
        return { exitCode: 113, stdout: "", stderr: "Could not find service" };
      return { exitCode: 0, stdout: "state = running\n", stderr: "" };
    };
    const { supervisor } = await capturedJob(run);
    const stopping = supervisor.stop("target-1:web", {
      graceMs: 3_600_000,
      [ask]: signal.signal,
    });
    if (ask === "kill")
      expect(await stopping).toMatchObject({ outcome: "stopped" });
    else
      await expect(stopping).rejects.toMatchObject({ code: "STOP_DETACHED" });
    expect(commands.includes("kill")).toBe(ask === "kill");
  }
});
