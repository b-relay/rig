import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
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
  test("reads as ps prints it in UTC, with a single-digit day padded", () => {
    expect(lstartText(Date.UTC(2026, 9, 5, 7, 8, 9) / 1000)).toBe(
      "Mon Oct  5 07:08:09 2026",
    );
    expect(lstartText(Date.UTC(2026, 9, 12, 10, 0, 0) / 1000)).toBe(
      "Mon Oct 12 10:00:00 2026",
    );
  });

  test.skipIf(process.platform !== "darwin")(
    "from the kernel makes the identity ps makes, for this process and for another user's, so a saved lease still reads, and starts no process",
    async () => {
      const { start } = (await nativeProcessStart())!;
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

  test("is read from the file once while it does not change, and again as soon as it does", async () => {
    const { root } = await storeWith(empty);
    // Its own process: a named import binds readFile as it is when the importing module first loads.
    const script = `
const fs = require("node:fs/promises");
const readFile = fs.readFile;
const path = ${JSON.stringify(join(root, "runtime", "state.json"))};
let reads = 0;
fs.readFile = (file, ...rest) => {
  if (file === path) reads++;
  return readFile(file, ...rest);
};
require("node:module").syncBuiltinESMExports();
const { FileStateStore } = await import(${JSON.stringify(join(import.meta.dir, "../src/runtime/state-store.ts"))});
const store = new FileStateStore(${JSON.stringify(root)});
for (let i = 0; i < 20; i++) await store.read();
const unchanged = reads;
await Bun.write(path, JSON.stringify({ ...${JSON.stringify(empty)}, extra: 1 }));
await store.read();
await store.read();
process.stdout.write(JSON.stringify({ unchanged, changed: reads }));
`;
    const child = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
    });
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({
      unchanged: 1,
      changed: 2,
    });
  });

  // The same inode, size and time after a second write within one tick: HFS+ keeps whole seconds, exFAT ten milliseconds.
  test.each([
    ["HFS+", new Date(Date.UTC(2026, 9, 12, 10, 0, 0))],
    ["exFAT", new Date(Date.UTC(2026, 9, 12, 10, 0, 0, 250))],
  ])(
    "written in place within the coarse timestamp of %s has no revision, so the change is read and refused",
    async (_filesystem, tick) => {
      const { root, store } = await storeWith(empty);
      const path = join(root, "runtime", "state.json");
      await utimes(path, tick, tick);
      expect(await store.revision()).toBeUndefined();
      await store.read();
      const text = await readFile(path, "utf8");
      await writeFile(path, text.replace(`"targets": []`, `"targets": 1 `));
      await utimes(path, tick, tick);
      await expect(store.read()).rejects.toMatchObject({
        code: "STATE_CORRUPT",
      });
    },
  );

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

  test("an update's own write is read without reading the file or validating it again", async () => {
    const { store } = await storeWith(empty);
    await store.read();
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
      await store.update((state) => {
        state.projects.push({
          id: "p",
          name: "p",
          repoPath: "/repos/p",
          configPath: "/repos/p/rig.yaml",
          createdAt: "2026-11-07T00:00:00Z",
        });
      });
      // The update validates its change once; what it wrote is not validated again.
      expect(validations).toBe(1);
      expect((await store.read()).projects).toHaveLength(1);
      expect(validations).toBe(1);
    } finally {
      delete (runtimeStateSchema as { parse?: unknown }).parse;
    }
  });

  test("shared as one frozen snapshot while it does not change, and a new one as soon as it does", async () => {
    const { root, store } = await storeWith(empty);
    const [first, second] = await Promise.all([
      store.snapshot(),
      store.snapshot(),
    ]);
    expect(second).toBe(first);
    expect(await store.snapshot()).toBe(first);
    expect(() => first.projects.push({ id: "p" } as never)).toThrow();
    expect((await store.read()).projects).toEqual([]);
    await write(root, { ...empty, extra: 1 });
    const changed = await store.snapshot();
    expect(changed).not.toBe(first);
    expect((changed as unknown as { extra: number }).extra).toBe(1);
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

  /** A real wrapper over a real application, whose every pause lasts ten minutes unless something wakes it: `end` is given the
   * pids, the Rig root and a read of the wrapper's observation once the application runs, and the wrapper is expected to
   * end without that wait. The application runs the shell script `application` in the root, `exec /bin/sleep 600` when absent, and its output
   * goes to the root's `logs`. Answers the wrapper's exit code and the pause it asked for each time. */
  async function wrapperPausing(
    end: (running: {
      wrapper: number;
      application: number;
      root: string;
      observation: () => Promise<{ observation?: { reason?: string } }>;
    }) => unknown,
    application = "exec /bin/sleep 600",
  ) {
    const root = await tempRoot();
    await mkdir(join(root, "capture"), { recursive: true, mode: 0o700 });
    await mkdir(join(root, "logs"), { mode: 0o700 });
    const requestPath = join(root, "capture", "request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        key: "capture",
        componentName: "web",
        command: ["/bin/sh", "-c", application],
        cwd: root,
        env: {},
        logRoot: join(root, "logs"),
        incarnation: "start-1",
      }),
    );
    const script = `
import { runCapturedProcess, wakeablePause } from ${JSON.stringify(join(import.meta.dir, "../src/providers/captured-process.ts"))};
const pause = wakeablePause();
const asked = [];
const code = await runCapturedProcess(process.argv[1], {
  pause: { wake: pause.wake, wait: (ms) => { asked.push(ms); return pause.wait(600_000); } },
  endBy: () => {},
});
process.stdout.write(JSON.stringify({ code, asked }));
process.exit(0);
`;
    const wrapper = Bun.spawn([process.execPath, "-e", script, requestPath], {
      stdout: "pipe",
      stderr: "ignore",
    });
    let pid: number | undefined;
    const watchdog = setTimeout(() => {
      wrapper.kill("SIGKILL");
      if (pid) process.kill(pid, "SIGKILL");
    }, 30_000);
    const observation = () =>
      readFile(`${requestPath}.observation.json`, "utf8")
        .then((raw) => JSON.parse(raw))
        .catch(() => ({}));
    try {
      while (!pid) {
        pid = (await observation()).observation?.pid;
        if (!pid) await Bun.sleep(10);
      }
      await end({ wrapper: wrapper.pid, application: pid, root, observation });
      return JSON.parse(await new Response(wrapper.stdout).text()) as {
        code: number;
        asked: number[];
      };
    } finally {
      clearTimeout(watchdog);
    }
  }

  test("a running application sets the wrapper no timer: its exit ends the pause at once", async () => {
    const { code, asked } = await wrapperPausing(({ application }) =>
      process.kill(application, "SIGKILL"),
    );
    expect(code).toBe(1);
    expect(asked.length).toBeGreaterThan(0);
    // JSON gives an absent wait as null.
    for (const ms of asked) expect(ms).toBeNull();
  }, 60_000);

  test("output that cannot be recorded ends the pause at once, so the wrapper reports it without a timer", async () => {
    let reason: string | undefined;
    await wrapperPausing(async ({ application, root, observation }) => {
      // A regular file where the log directory was, so the line the application then prints cannot be written.
      await rm(join(root, "logs"), { recursive: true });
      await writeFile(join(root, "logs"), "");
      await writeFile(join(root, "go"), "");
      for (let i = 0; !reason && i < 2000; i++) {
        reason = (await observation()).observation?.reason;
        if (!reason) await Bun.sleep(10);
      }
      process.kill(application, "SIGKILL");
    }, "while [ ! -e go ]; do sleep 0.01; done; echo hello; exec /bin/sleep 600");
    expect(reason).toContain("Target output is not being recorded");
  }, 60_000);

  test("a stop ends the wrapper's pause at once", async () => {
    const { code } = await wrapperPausing(({ wrapper }) =>
      process.kill(wrapper, "SIGTERM"),
    );
    expect(code).toBe(0);
  }, 60_000);

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
