import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createChildSupervisor } from "../src/providers/child-supervisor";
import { runCommand } from "../src/providers/command-runner";
import type {
  ManagedProcess,
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import { wrapperExitEvidence } from "../src/providers/exit-record";
import { createProcessIdentityReader } from "../src/providers/process-identity";
import {
  createProcessInspection,
  platformKill,
} from "../src/providers/process-inspection";
import { createProcessTiming } from "../src/providers/process-timing";

test("a wrapper's clean exit is not evidence of its application's end; a signal or a failure is", () => {
  expect(wrapperExitEvidence({ exitCode: 0 })).toBeUndefined();
  expect(wrapperExitEvidence({})).toBeUndefined();
  expect(wrapperExitEvidence({ exitCode: 3 })).toEqual({ exitCode: 3 });
  expect(wrapperExitEvidence({ signal: "SIGTERM" })).toEqual({
    signal: "SIGTERM",
  });
});

/** An application that takes a moment to stop after SIGTERM, as a server draining its connections does: the wrapper finds it
 * still running when it stops it, so the application's own exit record is removed as a requested stop. */
const SLOW_TO_STOP = `trap 'sleep 0.3; exit 0' TERM; : > trapping; while :; do sleep 0.05; done`;

/** Waits until the SLOW_TO_STOP application running in `root` has set its trap: a SIGTERM before then ends it at once. */
async function trapping(root: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await Bun.file(join(root, "trapping")).exists()) return;
    await Bun.sleep(10);
  }
  throw new Error("the application never set its SIGTERM trap");
}

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

/** The real capture wrapper as a script the supervisors can run. While the file `armed` exists, the wrapper is killed by
 * SIGKILL at its first identity read of another process, the moment it has spawned its application and not yet leased it;
 * it removes the file first, so only one start is hit, and writes the pid it was asked about to `armed.pid`. */
async function wrapperScript(root: string, armed?: string): Promise<string> {
  const path = join(root, "capture.ts");
  const module = (name: string) =>
    JSON.stringify(resolve("src/providers", name));
  await writeFile(
    path,
    armed
      ? `import {runCapturedProcess} from ${module("captured-process.ts")};
import {createProcessInspection, platformKill} from ${module("process-inspection.ts")};
import {runCommand} from ${module("command-runner.ts")};
import {existsSync, rmSync, writeFileSync} from "node:fs";
const platform = createProcessInspection({ run: runCommand, kill: platformKill });
const armed = ${JSON.stringify(armed)};
process.exitCode = await runCapturedProcess(process.argv[2]!, { processInspection: { ...platform, identity: async (pid) => {
  if (pid !== process.pid && existsSync(armed)) {
    rmSync(armed);
    // Read while the gated process is known to wait at its gate, so the test can end it without ever signalling a reused pid.
    writeFileSync(armed + ".pid", JSON.stringify({ pid, identity: await platform.identity(pid) }));
    process.kill(process.pid, "SIGKILL");
    await new Promise(() => {});
  }
  return platform.identity(pid);
} } });`
      : `import {runCapturedProcess} from ${module("captured-process.ts")}; process.exitCode=await runCapturedProcess(process.argv[2]!);`,
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
const identityOf = createProcessIdentityReader(runCommand);
/** Processes a test started that may still run. Each is recorded with its birth identity as it is pushed, and cleanup
 * signals it only while that identity still matches: a pid seen gone may belong to another process by then. */
const tracked: Promise<{ pid: number; identity: string } | undefined>[] = [];
const pids = {
  /** Records `pid` with the birth identity read now; for a process the test knows is running. */
  push(pid: number): void {
    tracked.push(
      identityOf(pid).then(
        (identity) => (identity ? { pid, identity } : undefined),
        () => undefined,
      ),
    );
  },
  /** Records `pid` with a birth identity read while it was known to run. */
  known(pid: number, identity: string | undefined): void {
    if (identity) tracked.push(Promise.resolve({ pid, identity }));
  },
};
afterEach(async () => {
  for (const entry of await Promise.all(tracked.splice(0)))
    if (entry && (await identityOf(entry.pid)) === entry.identity)
      try {
        process.kill(entry.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** The rigd supervisor over the real capture wrapper, holding the wrapper as its child. */
async function rigdWorld(options: { armed?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "rig-unknown-exit-rigd-"));
  roots.push(root);
  const wrapper = await wrapperScript(
    root,
    options.armed ? join(root, "armed") : undefined,
  );
  const supervisors: Supervisor[] = [];
  let wrapperPid = 0;
  const supervisor = () => {
    const created = createChildSupervisor({
      stateRoot: root,
      captureCommand: [process.execPath, wrapper],
      // An armed wrapper dies before its application reports, so the start fails once this wait is over: long enough for
      // the wrapper to reach its application, not the platform's 5 s.
      ...(options.armed ? { captureStartMs: 3000 } : {}),
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

describe("rigd supervisor: a capture wrapper killed together with its application", () => {
  const world = rigdWorld;

  test("a wrapper killed between spawning its application and leasing it leaves no application behind, and the retry starts exactly one", async () => {
    const w = await world({ armed: true });
    const armed = join(w.root, "armed");
    await writeFile(armed, "");
    const supervisor = w.supervisor();
    const starts = join(w.root, "starts");
    try {
      const req = {
        ...request(w.root, "start-1"),
        command: ["/bin/sh", "-c", `echo $$ >> ${starts}; ${SLOW_TO_STOP}`],
      };
      // The wrapper never reports its start: the start fails once its wait is over.
      await expect(supervisor.ensureRunning(req)).rejects.toMatchObject({
        code: "PROCESS_START_TIMEOUT",
      });
      const gated: { pid: number; identity?: string } = JSON.parse(
        await readFile(`${armed}.pid`, "utf8"),
      );
      const spawned = gated.pid;
      pids.known(spawned, gated.identity);
      // What the wrapper spawned was never released to become the application, and ended with its wrapper.
      for (let i = 0; i < 100 && alive(spawned); i++) await Bun.sleep(10);
      expect(alive(spawned)).toBe(false);
      expect(await readFile(starts, "utf8").catch(() => "")).toBe("");
      // So the retry is the one and only application.
      await supervisor.ensureRunning({ ...req, incarnation: "start-2" });
      const application = await w.applicationPid(req.key);
      pids.push(application);
      // Its pid is known before its shell has written its line; wait for the line.
      const started = () => readFile(starts, "utf8").catch(() => "");
      for (let i = 0; i < 200 && !(await started()).trim(); i++)
        await Bun.sleep(10);
      expect((await started()).trim().split("\n")).toEqual([
        String(application),
      ]);
      expect(await supervisor.stop(req.key, { graceMs: 1500 })).toEqual({
        outcome: "stopped",
      });
      expect(alive(application)).toBe(false);
    } finally {
      await w.cleanup();
    }
  }, 20_000);

  test("an external SIGTERM to the wrapper and its application leaves no application record, and rigd's record of the wrapper names the signal and the start", async () => {
    const w = await world();
    const supervisor = w.supervisor();
    try {
      const key = request(w.root, "start-1").key;
      await supervisor.ensureRunning(request(w.root, "start-1"));
      const application = await w.applicationPid(key);
      pids.push(application);
      await trapping(w.root);
      // One SIGTERM reaches both process groups at once, as when every process of the user is ended.
      process.kill(-w.wrapperPid(), "SIGTERM");
      process.kill(-application, "SIGTERM");
      expect(
        await until(supervisor, key, (o) => o.state === "stopped"),
      ).toEqual({
        state: "stopped",
        signal: "SIGTERM",
        incarnation: "start-1",
        recordedBy: "rigd",
      });
      expect(alive(application)).toBe(false);
      // The application's own record is gone: only the wrapper's end says how it ended.
      expect(
        (
          await readdir(join(w.root, "capture", "process-exits")).catch(
            (): string[] => [],
          )
        ).concat(await readdir(join(w.root, "process-exits")).catch(() => [])),
      ).toEqual([]);
      // The evidence is on disk, so the next daemon reads the same.
      expect(await w.supervisor().observe(key)).toEqual({
        state: "stopped",
        signal: "SIGTERM",
        incarnation: "start-1",
        recordedBy: "rigd",
      });
      // A new start clears it: it never explains the next start's end.
      const again = await supervisor.ensureRunning(request(w.root, "start-2"));
      pids.push(again.pid!);
      expect(await supervisor.observe(key)).toMatchObject({
        state: "running",
        incarnation: "start-2",
      });
      expect(await supervisor.stop(key, { graceMs: 1500 })).toEqual({
        outcome: "stopped",
      });
      expect(await supervisor.observe(key)).toEqual({ state: "stopped" });
    } finally {
      await w.cleanup();
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
      await supervisor.stop(req.key, { graceMs: 1500 });
      expect(alive(application)).toBe(true);
      expect(await supervisor.observe(req.key)).toMatchObject({
        state: "unknown",
      });
      await expect(
        supervisor.ensureRunning({ ...req, incarnation: "start-3" }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/UNKNOWN$/),
      });
      // Once it is gone the Service reads as stopped, with rigd's record of the wrapper's SIGKILL.
      process.kill(application, "SIGKILL");
      expect(
        await until(supervisor, req.key, (o) => o.state === "stopped"),
      ).toEqual({
        state: "stopped",
        signal: "SIGKILL",
        incarnation: "start-1",
        recordedBy: "rigd",
      });
    } finally {
      await w.cleanup();
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
      await w.cleanup();
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
      await w.cleanup();
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
      await w.cleanup();
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
      await w.detach();
      process.kill(wrapperPid, "SIGKILL");
      process.kill(application, "SIGKILL");
      for (let i = 0; i < 100 && alive(wrapperPid); i++) await Bun.sleep(10);
      expect(
        await until(w.supervisor(), req.key, (o) => o.state === "stopped"),
      ).toEqual({ state: "stopped" });
      const records = await readdir(join(w.root, "capture", "wrapper"), {
        recursive: true,
      }).catch(() => []);
      expect(records.filter((file) => file.endsWith(".json"))).toEqual([]);
    } finally {
      await w.cleanup();
    }
  }, 20_000);
});
