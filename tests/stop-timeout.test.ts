import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createChildSupervisor } from "../src/providers/child-supervisor";
import { runCommand } from "../src/providers/command-runner";
import type { ManagedProcess, Supervisor } from "../src/providers/contracts";
import {
  createProcessInspection,
  platformKill,
} from "../src/providers/process-inspection";
import { createProcessTiming } from "../src/providers/process-timing";

/** Real processes under the real capture wrapper, with short graces instead of minutes: an application that traps SIGTERM
 * and needs a while to exit, under rigd's child supervisor. */
const roots: string[] = [];
const pids: number[] = [];
afterEach(async () => {
  for (const pid of pids.splice(0))
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** An application that needs `seconds` to exit after SIGTERM. Once its trap is set it creates `trapping` in its working
 * directory: a stop sent before then would end it at once. */
const exitsAfter = (seconds: number) =>
  `trap 'sleep ${seconds}; exit 0' TERM; : > trapping; while :; do sleep 0.05; done`;

/** Starts `request` and returns once its application traps SIGTERM. */
async function startTrapping(w: World, request: ManagedProcess) {
  const started = await w.supervisor.ensureRunning(request);
  for (let i = 0; i < 200; i++) {
    if (await Bun.file(join(request.cwd, "trapping")).exists()) return started;
    await Bun.sleep(10);
  }
  throw new Error("the application never set its SIGTERM trap");
}

async function wrapperScript(root: string): Promise<string> {
  const path = join(root, "capture.ts");
  await writeFile(
    path,
    `import {runCapturedProcess} from ${JSON.stringify(resolve("src/providers/captured-process.ts"))}; process.exitCode=await runCapturedProcess(process.argv[2]!);`,
  );
  return path;
}

function request(
  root: string,
  command: string,
  stopGraceMs: number,
): ManagedProcess {
  return {
    key: "target-1:worker",
    componentName: "worker",
    command: ["/bin/sh", "-c", command],
    cwd: root,
    env: { PATH: "/usr/bin:/bin" },
    logRoot: join(root, "logs"),
    incarnation: "start-1",
    stopGraceMs,
  };
}

interface World {
  root: string;
  supervisor: Supervisor;
}

async function rigdWorld(): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "rig-stop-timeout-rigd-"));
  roots.push(root);
  const wrapper = await wrapperScript(root);
  const created = createChildSupervisor({
    stateRoot: root,
    captureCommand: [process.execPath, wrapper],
    timing: createProcessTiming(),
    processInspection: createProcessInspection({
      run: runCommand,
      kill: platformKill,
    }),
  });
  return {
    root,
    supervisor: {
      ...created,
      async ensureRunning(request) {
        const started = await created.ensureRunning(request);
        if (started.pid) pids.push(started.pid);
        return started;
      },
    },
  };
}

describe("rigd supervisor with the capture wrapper", () => {
  test("an application that exits within its stop_timeout is not killed, and its stop reads as requested", async () => {
    const w = await rigdWorld();
    const started = await startTrapping(
      w,
      request(w.root, exitsAfter(1.2), 2000),
    );
    expect(started.outcome).toBe("started");
    const at = performance.now();
    expect(
      await w.supervisor.stop("target-1:worker", { graceMs: 2000 }),
    ).toEqual({ outcome: "stopped" });
    const elapsed = performance.now() - at;
    // It had its 1.2 s: longer than the old 1.5 s cap would have mattered for a 2 s grace, and nothing cut it short.
    expect(elapsed).toBeGreaterThanOrEqual(1200);
    expect(elapsed).toBeLessThan(2000);
    // A requested stop leaves no exit to explain.
    expect(await w.supervisor.observe("target-1:worker")).toEqual({
      state: "stopped",
    });
  }, 20_000);

  test("an application still running when its stop_timeout ends is SIGKILLed then, and the stop says the grace ran out", async () => {
    const w = await rigdWorld();
    await startTrapping(w, request(w.root, exitsAfter(30), 1000));
    const at = performance.now();
    expect(
      await w.supervisor.stop("target-1:worker", { graceMs: 1000 }),
    ).toEqual({ outcome: "stopped", killed: "timeout" });
    const elapsed = performance.now() - at;
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(3500);
  }, 20_000);

  test("a kill cuts a long grace to the kill wait", async () => {
    const w = await rigdWorld();
    await startTrapping(w, request(w.root, exitsAfter(30), 60_000));
    const kill = new AbortController();
    setTimeout(() => kill.abort(), 300);
    const at = performance.now();
    expect(
      await w.supervisor.stop("target-1:worker", {
        graceMs: 60_000,
        kill: kill.signal,
      }),
    ).toEqual({ outcome: "stopped", killed: "request" });
    // SIGKILL 1.5 s after the kill, not after 60 s.
    expect(performance.now() - at).toBeLessThan(5000);
  }, 20_000);
});
