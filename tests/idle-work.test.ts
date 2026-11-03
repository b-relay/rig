import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  observeUntilStopped,
  wakeablePause,
} from "../src/providers/captured-process";
import { changePublisher } from "../src/providers/capture-observation";
import { createChildSupervisor } from "../src/providers/child-supervisor";
import { runCommand } from "../src/providers/command-runner";
import type { CommandRunner } from "../src/providers/contracts";
import {
  lstartText,
  nativeProcessStart,
} from "../src/providers/native-process-start";
import {
  createProcessIdentityReader,
  type ProcessIdentityReader,
} from "../src/providers/process-identity";
import {
  createProcessInspection,
  platformInspection,
  platformKill,
} from "../src/providers/process-inspection";
import { processLeasePath } from "../src/providers/process-lease";
import { createProcessTiming } from "../src/providers/process-timing";
import { runtimeStateSchema, STATE_VERSION } from "../src/runtime/state-schema";
import { FileStateStore } from "../src/runtime/state-store";
import { parseProjectConfig } from "../src/config";
import { runtimeWorld } from "./support/runtime-world";
import type { StateStore } from "../src/domain/runtime";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const tempRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-idle-"));
  roots.push(root);
  return root;
};
/** A `run` that fails a test by counting: identity on the kernel's start times never gets here. */
const countingRun = () => {
  const commands: string[][] = [];
  const run: CommandRunner = async ({ command }) => {
    commands.push([...command]);
    return { exitCode: 1, stdout: "", stderr: "" };
  };
  return { commands, run };
};

describe("a process's start time", () => {
  test("reads as ps prints it, with a single-digit day padded, in UTC or in the process's zone", () => {
    const at = Date.UTC(2026, 9, 5, 7, 8, 9) / 1000;
    expect(lstartText(at, "utc")).toBe("Mon Oct  5 07:08:09 2026");
    expect(lstartText(Date.UTC(2026, 9, 12, 10, 0, 0) / 1000, "utc")).toBe(
      "Mon Oct 12 10:00:00 2026",
    );
    const local = new Date(at * 1000);
    expect(lstartText(at, "local")).toContain(
      `${String(local.getMinutes()).padStart(2, "0")}:${String(local.getSeconds()).padStart(2, "0")}`,
    );
  });

  test.skipIf(process.platform !== "darwin")(
    "from the kernel makes the identity ps makes, for this process and for another user's, so a saved lease still reads, and starts no process",
    async () => {
      const start = (await nativeProcessStart())!;
      const byPs = createProcessIdentityReader(runCommand);
      const { commands, run } = countingRun();
      const native = createProcessIdentityReader(run, start);
      for (const pid of [process.pid, 1]) {
        expect(await native(pid)).toBe((await byPs(pid))!);
        expect(await native(pid)).toHaveLength(64);
      }
      expect(await native(2147483647)).toBeUndefined();
      expect(commands).toEqual([]);
    },
  );

  test("told apart by the second makes another identity: a reused pid is never the old process", async () => {
    const { run } = countingRun();
    let started: number | undefined = 1000;
    const identity = createProcessIdentityReader(run, () => started);
    const first = await identity(42);
    started = 1001;
    expect(await identity(42)).not.toBe(first!);
    started = undefined;
    expect(await identity(42)).toBeUndefined();
  });

  test("that the kernel will not give is an inspection failure, never a process that is gone", async () => {
    const { commands, run } = countingRun();
    const identity = createProcessIdentityReader(run, () => {
      throw new Error("refused");
    });
    await expect(identity(42)).rejects.toMatchObject({
      code: "PROCESS_INSPECT",
    });
    expect(commands).toEqual([]);
  });

  test.skipIf(process.platform !== "darwin")(
    "a daemon's and a wrapper's inspection reads it from the kernel",
    async () => {
      const { commands, run } = countingRun();
      const inspection = createProcessInspection(await platformInspection(run));
      expect(await inspection.identity(process.pid)).toHaveLength(64);
      expect(commands).toEqual([]);
    },
  );
});

describe("observing a recovered process", () => {
  const KEY = "t1:web";
  /** A supervisor that finds `KEY` only from its lease, as a daemon does after a restart. */
  async function recovered(identity: ProcessIdentityReader) {
    const root = await tempRoot();
    const lease = processLeasePath(root, KEY);
    await mkdir(dirname(lease), { recursive: true });
    await writeFile(
      lease,
      JSON.stringify({
        key: KEY,
        pid: process.pid,
        identity: await identity(process.pid),
      }),
    );
    return root;
  }

  test("starts no process and checks the start time at every observation, so a pid reused between two is seen", async () => {
    const { commands, run } = countingRun();
    let started = 1000;
    let checks = 0;
    const start = () => {
      checks++;
      return started;
    };
    const root = await recovered(createProcessIdentityReader(run, start));
    checks = 0;
    const supervisor = createChildSupervisor({
      stateRoot: root,
      timing: createProcessTiming(),
      processInspection: createProcessInspection({
        run,
        kill: platformKill,
        start,
      }),
    });
    for (let i = 0; i < 10; i++)
      expect(await supervisor.observe(KEY)).toMatchObject({
        state: "running",
        pid: process.pid,
      });
    expect(commands).toEqual([]);
    expect(checks).toBeGreaterThanOrEqual(10);
    started = 1001;
    expect((await supervisor.observe(KEY)).state).toBe("stopped");
    expect(commands).toEqual([]);
    await supervisor.detach();
  });
});

describe("the runtime state", () => {
  const write = (root: string, state: unknown) =>
    writeFile(
      join(root, "runtime", "state.json"),
      `${JSON.stringify(state, null, 2)}\n`,
    );
  const empty = {
    version: STATE_VERSION,
    projects: [],
    targets: [],
    activity: [],
  };
  async function storeWith(state: unknown) {
    const root = await tempRoot();
    await mkdir(join(root, "runtime"), { recursive: true });
    await write(root, state);
    return { root, store: new FileStateStore(root) };
  }

  test("is validated once however often it is read while it does not change, and again as soon as it does", async () => {
    const { root, store } = await storeWith(empty);
    // The schema's own `parse` is an accessor spyOn cannot wrap.
    const parse = runtimeStateSchema.parse.bind(runtimeStateSchema);
    let validations = 0;
    Object.defineProperty(runtimeStateSchema, "parse", {
      configurable: true,
      value: (input: unknown) => {
        validations++;
        return parse(input);
      },
    });
    try {
      for (let i = 0; i < 20; i++) await store.read();
      expect(validations).toBe(1);
      await write(root, { ...empty, extra: 1 });
      await store.read();
      expect(validations).toBe(2);
    } finally {
      delete (runtimeStateSchema as { parse?: unknown }).parse;
    }
  });

  test("written invalid after a good read is refused, whatever the size of the change, and stays refused", async () => {
    const { root, store } = await storeWith({ ...empty, activity: [] });
    await store.read();
    const path = join(root, "runtime", "state.json");
    const text = await readFile(path, "utf8");
    // The same number of bytes: `targets` no longer holds a list.
    await writeFile(path, text.replace(`"targets": []`, `"targets": 1 `));
    for (let i = 0; i < 2; i++)
      await expect(store.read()).rejects.toMatchObject({
        code: "STATE_CORRUPT",
      });
  });

  test("handed to one reader is that reader's alone: what it changes is not what the next one reads", async () => {
    const { store } = await storeWith(empty);
    const first = await store.read();
    first.projects.push({ id: "p" } as never);
    expect((await store.read()).projects).toEqual([]);
  });

  test("has a new revision after each write and the same one until then", async () => {
    const { store } = await storeWith(empty);
    const before = await store.revision();
    expect(before).toBeString();
    expect(await store.revision()).toBe(before!);
    await store.update(() => {});
    expect(await store.revision()).not.toBe(before!);
    expect(await new FileStateStore(await tempRoot()).revision()).toBe(
      undefined,
    );
  });

  describe("in a supervision pass", () => {
    /** One running Target under a runtime whose store counts reads and answers `revision` as the test says. */
    async function pass(revision: StateStore["revision"]) {
      let reads = 0;
      const world = await runtimeWorld({
        name: "idle-pass",
        config: parseProjectConfig({
          name: "idle",
          services: { web: { command: "server", ports: { http: 3070 } } },
          targets: { working: true },
        }),
        supervisor: () => ({
          observe: async () => ({ state: "running", pid: 1 }),
          ensureRunning: async () => ({ outcome: "started", pid: 1 }),
          stop: async () => ({ outcome: "stopped" }),
          shutdown: async () => {},
          detach: async () => {},
        }),
        startsAt: "2026-09-17T00:00:00.000Z",
        readinessDeadlineMs: 250,
        dependencies: ({ store }) => ({
          store: {
            read() {
              reads++;
              return store.read();
            },
            update: (change) => store.update(change),
            ...(revision ? { revision } : {}),
          },
        }),
      });
      roots.push(world.root);
      const runtime = world.open();
      await runtime.command({ action: "init", repoPath: world.repo });
      await runtime.command({ action: "up", project: "idle" });
      reads = 0;
      await runtime.supervise();
      return reads;
    }

    test("is read once for every Target while nothing is written", async () => {
      expect(await pass(async () => "same")).toBe(1);
    });
    test("is read again for a Target when a write landed since", async () => {
      let revision = 0;
      expect(await pass(async () => String(++revision))).toBe(2);
    });
    test("is read again for a Target when no revision can be told", async () => {
      expect(await pass(undefined)).toBe(2);
      expect(await pass(async () => undefined)).toBe(2);
    });
  });
});

describe("the capture wrapper", () => {
  test("looks once per pause and writes only what changed, so a running application costs no file", async () => {
    let looks = 0;
    let pauses = 0;
    const written: unknown[] = [];
    const publish = changePublisher(async (observation) => {
      written.push(observation);
    });
    const code = await observeUntilStopped({
      supervisor: {
        observe: async () => {
          looks++;
          return looks > 50
            ? { state: "stopped", exitCode: 3 }
            : { state: "running", pid: 7 };
        },
      },
      key: "t1:web",
      inspect: async () => "identity",
      publish,
      stopping: () => undefined,
      pause: async () => {
        pauses++;
      },
    });
    expect(code).toBe(3);
    expect(looks).toBe(pauses + 1);
    expect(written).toEqual([
      { state: "running", pid: 7 },
      { state: "stopped", exitCode: 3 },
    ]);
  });

  test("a stop ends the pause at once, and a wake with nothing paused is kept for the next pause", async () => {
    const pause = wakeablePause();
    let ended = false;
    const waiting = pause.wait(60_000).then(() => {
      ended = true;
    });
    expect(ended).toBe(false);
    pause.wake();
    await waiting;
    expect(ended).toBe(true);
    pause.wake();
    await pause.wait(60_000);
  });
});
