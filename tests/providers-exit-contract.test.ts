import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChildSupervisor } from "../src/providers/child-supervisor";
import { runCommand } from "../src/providers/command-runner";
import type {
  ManagedProcess,
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import { readExitRecord, writeExitRecord } from "../src/providers/exit-record";
import {
  createProcessInspection,
  platformKill,
} from "../src/providers/process-inspection";
import { createProcessTiming } from "../src/providers/process-timing";

/** The child supervisor and the processes it manages. */
interface World {
  /** Where this world's supervisors keep exit records. */
  readonly root: string;
  /** Another supervisor over the same root and the same processes, as the next daemon would build it. */
  supervisor(): Supervisor;
  /** A process that runs until `exit()` and then ends by itself with `exitCode`. */
  request(incarnation: string, exitCode: number): ManagedProcess;
  /** Lets the running process end by itself while its holder is there to record how. */
  exit(): Promise<void>;
  /** Ends the running process with SIGKILL from outside while its holder is there to record how. */
  kill(pid: number): Promise<void>;
  /** Ends the running process with nobody there to record how. */
  vanish(pid: number): Promise<void>;
  /** How many times an application was started in this world. */
  starts(): Promise<number>;
  cleanup(): Promise<void>;
}

const key = "target-1:web";

/** Real short-lived processes under the child supervisor, which holds their handles and records their exits itself. */
async function childWorld(): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "rig-exit-contract-child-"));
  const trigger = join(root, "exit-now");
  const started = join(root, "starts");
  const supervisors: Supervisor[] = [];
  const pids: number[] = [];
  const gone = async (pid: number) => {
    for (let i = 0; i < 500; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await Bun.sleep(10);
    }
    throw new Error(`process ${pid} did not end`);
  };
  return {
    root,
    supervisor() {
      const supervisor = createChildSupervisor({
        stateRoot: root,
        timing: createProcessTiming(),
        processInspection: createProcessInspection({
          run: runCommand,
          kill: platformKill,
        }),
      });
      supervisors.push({
        ...supervisor,
        ensureRunning: async (request) => {
          const result = await supervisor.ensureRunning(request);
          if (result.pid) pids.push(result.pid);
          return result;
        },
      });
      return supervisors.at(-1)!;
    },
    request: (incarnation, exitCode) => ({
      key,
      componentName: "web",
      command: [
        "/bin/sh",
        "-c",
        `echo started >> "$0"; while [ ! -e "$1" ]; do sleep 0.02; done; exit ${exitCode}`,
        started,
        trigger,
      ],
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
      logRoot: join(root, "logs"),
      incarnation,
    }),
    exit: () => Bun.write(trigger, "").then(() => {}),
    async kill(pid) {
      process.kill(pid, "SIGKILL");
    },
    async vanish(pid) {
      // Nobody holds the child handle any more, so nothing can record this exit.
      for (const supervisor of supervisors) await supervisor.detach();
      process.kill(pid, "SIGKILL");
      await gone(pid);
    },
    async starts() {
      for (let i = 0; i < 200; i++) {
        const lines = (await readFile(started, "utf8").catch(() => ""))
          .split("\n")
          .filter(Boolean).length;
        if (lines) return lines;
        await Bun.sleep(10);
      }
      return 0;
    },
    async cleanup() {
      for (const supervisor of supervisors) await supervisor.shutdown();
      for (const pid of pids)
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function untilStopped(
  supervisor: Supervisor,
): Promise<ProcessObservation> {
  for (let i = 0; i < 500; i++) {
    const observation = await supervisor.observe(key);
    if (observation.state !== "running") return observation;
    await Bun.sleep(10);
  }
  throw new Error("the process did not end");
}
const exitRecords = (root: string) =>
  readdir(join(root, "process-exits")).catch(() => [] as string[]);

describe("child supervisor exit contract", () => {
  const worlds: World[] = [];
  const world = async () => {
    worlds.push(await childWorld());
    return worlds.at(-1)!;
  };
  afterEach(async () => {
    for (const created of worlds.splice(0)) await created.cleanup();
  });

  test("a process that exits with 0 is stopped with exit code 0 and the incarnation it was started as", async () => {
    const w = await world();
    const supervisor = w.supervisor();
    await supervisor.ensureRunning(w.request("start-1", 0));
    await w.exit();
    expect(await untilStopped(supervisor)).toEqual({
      state: "stopped",
      exitCode: 0,
      incarnation: "start-1",
    });
  });

  test("a process that exits with 3 is stopped with exit code 3, and nothing starts it again", async () => {
    const w = await world();
    const supervisor = w.supervisor();
    await supervisor.ensureRunning(w.request("start-1", 3));
    await w.exit();
    const stopped: ProcessObservation = {
      state: "stopped",
      exitCode: 3,
      incarnation: "start-1",
    };
    expect(await untilStopped(supervisor)).toEqual(stopped);
    await Bun.sleep(100);
    expect(await supervisor.observe(key)).toEqual(stopped);
    expect(await w.starts()).toBe(1);
  });

  test("a process killed from outside is stopped with the signal and no exit code", async () => {
    const w = await world();
    const supervisor = w.supervisor();
    const started = await supervisor.ensureRunning(w.request("start-1", 0));
    await w.kill(started.pid!);
    expect(await untilStopped(supervisor)).toEqual({
      state: "stopped",
      signal: "SIGKILL",
      incarnation: "start-1",
    });
  });

  test("a process that is gone with no exit record is a bare stop: no exit code, signal, or incarnation is invented", async () => {
    const w = await world();
    const started = await w.supervisor().ensureRunning(w.request("start-1", 0));
    await w.vanish(started.pid!);
    expect(await w.supervisor().observe(key)).toEqual({ state: "stopped" });
    expect(await exitRecords(w.root)).toEqual([]);
  });

  test("stopping a running process is a bare stop afterwards and leaves no exit record", async () => {
    const w = await world();
    const supervisor = w.supervisor();
    await supervisor.ensureRunning(w.request("start-1", 0));
    expect(await supervisor.stop(key, { graceMs: 1500 })).toEqual({
      outcome: "stopped",
    });
    expect(await supervisor.observe(key)).toEqual({ state: "stopped" });
    expect(await w.supervisor().observe(key)).toEqual({ state: "stopped" });
    expect(await readExitRecord(w.root, key)).toBeUndefined();
    expect(await exitRecords(w.root)).toEqual([]);
  });

  test("a process that outlives its supervisor is running for the next one with the same pid and incarnation, and is not started twice", async () => {
    const w = await world();
    const first = w.supervisor();
    const request = w.request("start-1", 0);
    const started = await first.ensureRunning(request);
    expect(started.outcome).toBe("started");
    await first.detach();
    const second = w.supervisor();
    expect(await second.observe(key)).toEqual({
      state: "running",
      pid: started.pid,
      incarnation: "start-1",
    });
    expect(
      await second.ensureRunning({ ...request, incarnation: "start-2" }),
    ).toEqual({ outcome: "unchanged", pid: started.pid });
    expect(await second.observe(key)).toMatchObject({
      state: "running",
      incarnation: "start-1",
    });
    expect(await w.starts()).toBe(1);
    expect(await second.stop(key, { graceMs: 1500 })).toEqual({
      outcome: "stopped",
    });
    expect(await second.observe(key)).toEqual({ state: "stopped" });
  });

  test("an exit record left by an earlier incarnation is removed by the next start and never explains its end", async () => {
    const w = await world();
    const supervisor = w.supervisor();
    await writeExitRecord(w.root, {
      key,
      incarnation: "old",
      exitCode: 1,
      at: new Date().toISOString(),
    });
    expect(await supervisor.observe(key)).toEqual({
      state: "stopped",
      exitCode: 1,
      incarnation: "old",
    });
    const started = await supervisor.ensureRunning(w.request("new", 3));
    expect(await readExitRecord(w.root, key)).toBeUndefined();
    expect(await supervisor.observe(key)).toEqual({
      state: "running",
      pid: started.pid,
      incarnation: "new",
    });
    await w.exit();
    expect(await untilStopped(supervisor)).toEqual({
      state: "stopped",
      exitCode: 3,
      incarnation: "new",
    });
    expect(await readExitRecord(w.root, key)).toMatchObject({
      key,
      incarnation: "new",
      exitCode: 3,
    });
  });
});
