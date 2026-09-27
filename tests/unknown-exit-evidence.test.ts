import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createChildSupervisor } from "../src/providers/child-supervisor";
import { runCommand } from "../src/providers/command-runner";
import type {
  CommandRunner,
  ManagedProcess,
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import { wrapperExitEvidence } from "../src/providers/exit-record";
import { parseLaunchdJobExit } from "../src/providers/launchd-job-exit";
import {
  createLaunchdSupervisor,
  createLaunchdTiming,
} from "../src/providers/launchd-supervisor";
import { createProcessIdentityReader } from "../src/providers/process-identity";
import {
  createProcessInspection,
  platformKill,
} from "../src/providers/process-inspection";
import { createProcessTiming } from "../src/providers/process-timing";

const fixture = (name: string) =>
  readFile(join(import.meta.dir, "fixtures", "launchctl-print", name), "utf8");

describe("launchd's record of a job, read from real launchctl print output", () => {
  for (const [name, expected] of [
    ["exited-0.txt", { exitCode: 0 }],
    ["exited-3.txt", { exitCode: 3 }],
    ["wrapper-ended-by-sigterm.txt", { signal: "SIGTERM" }],
    ["wrapper-killed-by-sigkill.txt", { signal: "SIGKILL" }],
    ["ended-by-sighup.txt", { signal: "SIGHUP" }],
    ["running.txt", undefined],
    ["never-exited.txt", undefined],
  ] as const)
    test(`${name} reads as ${JSON.stringify(expected)}`, async () => {
      expect(parseLaunchdJobExit(await fixture(name))).toEqual(expected);
    });

  test("a sysexits code launchd names after its number reads as that code", async () => {
    // Real launchd prints `last exit code = 78: EX_CONFIG` and `64: EX_USAGE`, but a plain number for 1, 126 or 255.
    for (const [line, exitCode] of [
      ["78: EX_CONFIG", 78],
      ["64: EX_USAGE", 64],
    ] as const)
      expect(
        parseLaunchdJobExit(
          (await fixture("exited-3.txt")).replace(
            "\tlast exit code = 3\n",
            `\tlast exit code = ${line}\n`,
          ),
        ),
      ).toEqual({ exitCode });
  });

  test("a nested line that looks like an end, such as an environment entry, is never read as one", async () => {
    const printed = (await fixture("never-exited.txt")).replace(
      "\tenvironment = {\n",
      "\tenvironment = {\n\t\tlast exit code = 5\n\t\tlast terminating signal = Killed: 9\n",
    );
    expect(printed).toContain("\t\tlast exit code = 5");
    expect(parseLaunchdJobExit(printed)).toBeUndefined();
  });

  test("a wrapper's clean exit is not evidence of its application's end; a signal or a failure is", () => {
    expect(wrapperExitEvidence({ exitCode: 0 })).toBeUndefined();
    expect(wrapperExitEvidence({})).toBeUndefined();
    expect(wrapperExitEvidence({ exitCode: 3 })).toEqual({ exitCode: 3 });
    expect(wrapperExitEvidence({ signal: "SIGTERM" })).toEqual({
      signal: "SIGTERM",
    });
  });
});

/** An application that takes a moment to stop after SIGTERM, as a server draining its connections does: the wrapper finds it
 * still running when it stops it, so the application's own exit record is removed as a requested stop. */
const SLOW_TO_STOP = `trap 'sleep 0.3; exit 0' TERM; while :; do sleep 0.05; done`;

/** The application pid a capture wrapper last published for its request at `requestPath`. */
async function applicationPid(requestPath: string): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const evidence = await readFile(`${requestPath}.observation.json`, "utf8")
      .then((raw) => JSON.parse(raw))
      .catch(() => undefined);
    if (evidence?.observation?.pid) return evidence.observation.pid;
    await Bun.sleep(10);
  }
  throw new Error("the wrapper never published its application");
}
const digest = (key: string) => createHash("sha256").update(key).digest("hex");

/** The real capture wrapper as a script the supervisors can run. */
async function wrapperScript(root: string): Promise<string> {
  const path = join(root, "capture.ts");
  await writeFile(
    path,
    `import {runCapturedProcess} from ${JSON.stringify(resolve("src/providers/captured-process.ts"))}; process.exitCode=await runCapturedProcess(process.argv[2]!);`,
  );
  return path;
}

function request(root: string, incarnation: string): ManagedProcess {
  return {
    key: "target-1:web",
    componentName: "web",
    command: ["/bin/sh", "-c", SLOW_TO_STOP],
    cwd: root,
    env: { PATH: "/usr/bin:/bin" },
    logRoot: join(root, "logs"),
    incarnation,
  };
}

async function until(
  supervisor: Supervisor,
  key: string,
  done: (observation: ProcessObservation) => boolean,
): Promise<ProcessObservation> {
  for (let i = 0; i < 500; i++) {
    const observation = await supervisor.observe(key);
    if (done(observation)) return observation;
    await Bun.sleep(10);
  }
  throw new Error("the expected observation never came");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

/** The launchd supervisor over the real capture wrapper; only launchctl is scripted, and it reports the wrapper's real end
 * in the format real launchd prints (see the fixtures). */
async function launchdWorld() {
  const root = await mkdtemp(join(tmpdir(), "rig-unknown-exit-launchd-"));
  roots.push(root);
  const wrapper = await wrapperScript(root);
  const template = await fixture("never-exited.txt");
  let job: ReturnType<typeof Bun.spawn> | undefined;
  const run: CommandRunner = async ({ command }) => {
    if (command[1] === "bootstrap") {
      job = Bun.spawn(
        [process.execPath, wrapper, command[3]!.replace(/\.plist$/, ".json")],
        { stdout: "ignore", stderr: "ignore" },
      );
      pids.push(job.pid);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command[1] === "bootout") {
      job?.kill("SIGTERM");
      await job?.exited;
      job = undefined;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (!job)
      return { exitCode: 113, stdout: "", stderr: "Could not find service" };
    if (job.exitCode === null && job.signalCode === null)
      return {
        exitCode: 0,
        stdout: template.replace(
          "\tlast exit code = (never exited)",
          `\tpid = ${job.pid}\n\tlast exit code = (never exited)`,
        ),
        stderr: "",
      };
    const { constants } = await import("node:os");
    return {
      exitCode: 0,
      stdout: template.replace(
        "\tlast exit code = (never exited)",
        job.signalCode
          ? `\tlast terminating signal = Signalled: ${constants.signals[job.signalCode as keyof typeof constants.signals]}`
          : `\tlast exit code = ${job.exitCode}`,
      ),
      stderr: "",
    };
  };
  const supervisor = () =>
    createLaunchdSupervisor({
      root,
      domain: "gui/99999",
      labelPrefix: "test.unknown-exit",
      captureCommand: [process.execPath, wrapper],
      run,
      groupExists: createProcessInspection({
        run: runCommand,
        kill: platformKill,
      }).groupExists,
      inspect: createProcessIdentityReader(runCommand),
      timing: createLaunchdTiming(),
    });
  return {
    root,
    supervisor,
    wrapperPid: () => job!.pid,
    requestPath: (key: string) =>
      join(root, `test.unknown-exit.${digest(key).slice(0, 24)}.json`),
    applicationPid: (key: string) =>
      applicationPid(
        join(root, `test.unknown-exit.${digest(key).slice(0, 24)}.json`),
      ),
    /** launchd unloads the job, as a logout does: nothing is left to say how it ended. */
    unload: () => {
      job = undefined;
    },
    wrapperGone: async () => {
      await job?.exited;
    },
  };
}

/** The rigd supervisor over the real capture wrapper, holding the wrapper as its child. */
async function rigdWorld() {
  const root = await mkdtemp(join(tmpdir(), "rig-unknown-exit-rigd-"));
  roots.push(root);
  const wrapper = await wrapperScript(root);
  const supervisors: Supervisor[] = [];
  let wrapperPid = 0;
  const supervisor = () => {
    const created = createChildSupervisor({
      stateRoot: root,
      captureCommand: [process.execPath, wrapper],
      timing: createProcessTiming(),
      processInspection: createProcessInspection({
        run: runCommand,
        kill: platformKill,
      }),
    });
    supervisors.push(created);
    return {
      ...created,
      async ensureRunning(request: ManagedProcess) {
        const result = await created.ensureRunning(request);
        const lease = JSON.parse(
          await readFile(
            join(
              root,
              "process-leases",
              `${createHash("sha256").update(request.key).digest("hex")}.json`,
            ),
            "utf8",
          ),
        );
        wrapperPid = lease.pid;
        pids.push(wrapperPid);
        return result;
      },
    } satisfies Supervisor;
  };
  return {
    root,
    supervisor,
    wrapperPid: () => wrapperPid,
    requestPath: (key: string) => join(root, "capture", `${digest(key)}.json`),
    applicationPid: (key: string) =>
      applicationPid(join(root, "capture", `${digest(key)}.json`)),
    /** Every supervisor lets go of its handles, as a daemon restart does. */
    detach: async () => {
      for (const created of supervisors) await created.detach();
    },
    cleanup: async () => {
      for (const created of supervisors) await created.shutdown();
    },
  };
}

for (const [name, witness] of [
  ["launchd", "launchd"],
  ["rigd", "rigd"],
] as const)
  describe(`${name} supervisor: a capture wrapper killed together with its application`, () => {
    const world = () => (name === "launchd" ? launchdWorld() : rigdWorld());

    test(`an external SIGTERM to the wrapper and its application leaves no application record, and ${witness}'s record of the wrapper names the signal and the start`, async () => {
      const w = await world();
      const supervisor = w.supervisor();
      try {
        const key = request(w.root, "start-1").key;
        await supervisor.ensureRunning(request(w.root, "start-1"));
        const application = await w.applicationPid(key);
        pids.push(application);
        // One SIGTERM reaches both process groups at once, as when every process of the user is ended. (The scripted
        // launchd runs its wrapper inside this test's own group, which only the wrapper itself may be signalled in.)
        process.kill(
          name === "rigd" ? -w.wrapperPid() : w.wrapperPid(),
          "SIGTERM",
        );
        process.kill(-application, "SIGTERM");
        expect(
          await until(supervisor, key, (o) => o.state === "stopped"),
        ).toEqual({
          state: "stopped",
          signal: "SIGTERM",
          incarnation: "start-1",
          recordedBy: witness,
        });
        expect(alive(application)).toBe(false);
        // The application's own record is gone: only the wrapper's end says how it ended.
        expect(
          (
            await readdir(join(w.root, "capture", "process-exits")).catch(
              (): string[] => [],
            )
          ).concat(
            await readdir(join(w.root, "process-exits")).catch(() => []),
          ),
        ).toEqual([]);
        // The evidence is on disk, so the next daemon reads the same.
        expect(await w.supervisor().observe(key)).toEqual({
          state: "stopped",
          signal: "SIGTERM",
          incarnation: "start-1",
          recordedBy: witness,
        });
        // A new start clears it: it never explains the next start's end.
        const again = await supervisor.ensureRunning(
          request(w.root, "start-2"),
        );
        pids.push(again.pid!);
        expect(await supervisor.observe(key)).toMatchObject({
          state: "running",
          incarnation: "start-2",
        });
        expect(await supervisor.stop(key)).toEqual({ outcome: "stopped" });
        expect(await supervisor.observe(key)).toEqual({ state: "stopped" });
      } finally {
        if ("cleanup" in w) await w.cleanup();
      }
    }, 20_000);

    test("a wrapper killed alone leaves its application running: that is unknown, never stopped, and no start is made beside it", async () => {
      const w = await world();
      const supervisor = w.supervisor();
      try {
        const req = request(w.root, "start-1");
        await supervisor.ensureRunning(req);
        const application = await w.applicationPid(req.key);
        pids.push(application);
        process.kill(w.wrapperPid(), "SIGKILL");
        const orphaned = await until(
          supervisor,
          req.key,
          (o) => o.reason?.includes("without its capture wrapper") ?? false,
        );
        expect(orphaned.state).toBe("unknown");
        expect(orphaned.reason).toContain(`pid ${application}`);
        await expect(
          supervisor.ensureRunning({ ...req, incarnation: "start-2" }),
        ).rejects.toMatchObject({
          code: expect.stringMatching(/UNKNOWN$/),
        });
        expect(alive(application)).toBe(true);
        // A stop releases what it owns but neither signals the survivor nor forgets it: a start is still refused.
        await supervisor.stop(req.key);
        expect(alive(application)).toBe(true);
        expect(await supervisor.observe(req.key)).toMatchObject({
          state: "unknown",
        });
        await expect(
          supervisor.ensureRunning({ ...req, incarnation: "start-3" }),
        ).rejects.toMatchObject({
          code: expect.stringMatching(/UNKNOWN$/),
        });
        // Once it is gone the Service reads as stopped. rigd still has its record of the wrapper's SIGKILL; launchd's
        // record left with the job the stop booted out.
        process.kill(application, "SIGKILL");
        expect(
          await until(supervisor, req.key, (o) => o.state === "stopped"),
        ).toEqual(
          witness === "rigd"
            ? {
                state: "stopped",
                signal: "SIGKILL",
                incarnation: "start-1",
                recordedBy: "rigd",
              }
            : { state: "stopped" },
        );
      } finally {
        if ("cleanup" in w) await w.cleanup();
      }
    }, 20_000);

    test("a wrapper killed before it published any observation still leaves its application unknown, through the application's lease", async () => {
      const w = await world();
      const supervisor = w.supervisor();
      try {
        const req = request(w.root, "start-1");
        await supervisor.ensureRunning(req);
        const application = await w.applicationPid(req.key);
        pids.push(application);
        process.kill(w.wrapperPid(), "SIGKILL");
        if ("wrapperGone" in w) await w.wrapperGone();
        for (let i = 0; i < 100 && alive(w.wrapperPid()); i++)
          await Bun.sleep(10);
        // The state a wrapper killed between starting its application and its first observation leaves: the lease its own
        // supervisor wrote when it spawned the application, and no observation.
        await rm(`${w.requestPath(req.key)}.observation.json`, { force: true });
        const orphaned = await until(
          supervisor,
          req.key,
          (o) => o.state !== "running",
        );
        expect(orphaned.state).toBe("unknown");
        expect(orphaned.reason).toContain(`pid ${application}`);
        await expect(
          supervisor.ensureRunning({ ...req, incarnation: "start-2" }),
        ).rejects.toMatchObject({
          code: expect.stringMatching(/UNKNOWN$/),
        });
        expect(alive(application)).toBe(true);
        // Once it is gone, the wrapper's end is evidence again.
        process.kill(application, "SIGKILL");
        expect(
          await until(supervisor, req.key, (o) => o.state === "stopped"),
        ).toMatchObject({ state: "stopped", signal: "SIGKILL" });
      } finally {
        if ("cleanup" in w) await w.cleanup();
      }
    }, 20_000);

    test("an application whose leader died but whose process group still runs is unknown, and no start is made beside it", async () => {
      const w = await world();
      const supervisor = w.supervisor();
      let group = 0;
      try {
        // The leader shell keeps a member of its group running, as a server's worker processes do.
        const req = {
          ...request(w.root, "start-1"),
          command: ["/bin/sh", "-c", "sleep 60 & wait"],
        };
        await supervisor.ensureRunning(req);
        const application = await w.applicationPid(req.key);
        group = application;
        pids.push(application);
        process.kill(w.wrapperPid(), "SIGKILL");
        if ("wrapperGone" in w) await w.wrapperGone();
        for (let i = 0; i < 100 && alive(w.wrapperPid()); i++)
          await Bun.sleep(10);
        process.kill(application, "SIGKILL");
        for (let i = 0; i < 100 && alive(application); i++) await Bun.sleep(10);
        expect(alive(application)).toBe(false);
        const orphaned = await until(
          supervisor,
          req.key,
          (o) => o.state !== "running",
        );
        expect(orphaned.state).toBe("unknown");
        expect(orphaned.reason).toContain(`${application}`);
        await expect(
          supervisor.ensureRunning({ ...req, incarnation: "start-2" }),
        ).rejects.toMatchObject({
          code: expect.stringMatching(/UNKNOWN$/),
        });
        // Once the whole group is gone, the wrapper's end is evidence again.
        process.kill(-group, "SIGKILL");
        expect(
          await until(supervisor, req.key, (o) => o.state === "stopped"),
        ).toMatchObject({ state: "stopped", signal: "SIGKILL" });
      } finally {
        if (group)
          try {
            process.kill(-group, "SIGKILL");
          } catch {
            /* already gone */
          }
        if ("cleanup" in w) await w.cleanup();
      }
    }, 20_000);

    test("an application lease that cannot be read leaves the Service unknown rather than proving its application gone", async () => {
      const w = await world();
      const supervisor = w.supervisor();
      try {
        const req = request(w.root, "start-1");
        await supervisor.ensureRunning(req);
        const application = await w.applicationPid(req.key);
        pids.push(application);
        process.kill(w.wrapperPid(), "SIGKILL");
        if ("wrapperGone" in w) await w.wrapperGone();
        for (let i = 0; i < 100 && alive(w.wrapperPid()); i++)
          await Bun.sleep(10);
        await rm(`${w.requestPath(req.key)}.observation.json`, { force: true });
        await writeFile(
          join(
            dirname(w.requestPath(req.key)),
            "process-leases",
            `${digest(req.key)}.json`,
          ),
          "{not json",
        );
        const uncertain = await until(
          supervisor,
          req.key,
          (o) => o.state !== "running",
        );
        expect(uncertain.state).toBe("unknown");
        expect(uncertain.reason).toContain("could not be verified");
        await expect(
          supervisor.ensureRunning({ ...req, incarnation: "start-2" }),
        ).rejects.toMatchObject({
          code: expect.stringMatching(/UNKNOWN$/),
        });
        expect(alive(application)).toBe(true);
      } finally {
        if ("cleanup" in w) await w.cleanup();
      }
    }, 20_000);

    test("with no record anywhere the stop is bare: no exit code, signal or start is invented", async () => {
      const w = await world();
      const supervisor = w.supervisor();
      try {
        const req = request(w.root, "start-1");
        await supervisor.ensureRunning(req);
        const application = await w.applicationPid(req.key);
        pids.push(application);
        const wrapperPid = w.wrapperPid();
        if ("detach" in w) await w.detach();
        process.kill(wrapperPid, "SIGKILL");
        process.kill(application, "SIGKILL");
        if ("unload" in w) {
          await w.wrapperGone();
          w.unload();
        }
        for (let i = 0; i < 100 && alive(wrapperPid); i++) await Bun.sleep(10);
        expect(
          await until(w.supervisor(), req.key, (o) => o.state === "stopped"),
        ).toEqual({ state: "stopped" });
        const records = await readdir(join(w.root, "capture", "wrapper"), {
          recursive: true,
        }).catch(() => []);
        expect(records.filter((file) => file.endsWith(".json"))).toEqual([]);
      } finally {
        if ("cleanup" in w) await w.cleanup();
      }
    }, 20_000);
  });
