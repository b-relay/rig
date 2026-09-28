import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createChildSupervisor } from "../src/providers/child-supervisor";
import { runCommand } from "../src/providers/command-runner";
import {
  createProcessInspection,
  platformKill,
} from "../src/providers/process-inspection";
import { createProcessTiming } from "../src/providers/process-timing";
import { createProcessIdentityReader } from "../src/providers/process-identity";

const roots: string[] = [];
/** Process groups a test started that may still run, with their leader's birth identity: cleanup never signals a reused id. */
const groups: { pid: number; identity: string }[] = [];
const identityOf = createProcessIdentityReader(runCommand);
/** Records `pid`'s group for cleanup, while its leader still runs. */
async function track(pid: number): Promise<void> {
  const identity = await identityOf(pid);
  if (identity) groups.push({ pid, identity });
}
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
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(10);
  return !alive(pid);
}
const src = (path: string) => JSON.stringify(resolve("src/providers", path));

/** A supervisor process that is killed by SIGKILL at its first identity read of another process: the moment it has spawned
 * a process and not yet leased it. It writes the pid it was asked about first, so the test can follow that process. With
 * `captureCommand` it is rigd starting a capture wrapper, killed before it leased that wrapper. */
async function killedInSpawnWindow(
  root: string,
  command: readonly string[],
  captureCommand?: readonly string[],
) {
  const spawned = join(root, "spawned.pid");
  const script = join(root, "supervisor.ts");
  await writeFile(
    script,
    `import {createChildSupervisor} from ${src("child-supervisor.ts")};
import {createProcessInspection, platformKill} from ${src("process-inspection.ts")};
import {createProcessTiming} from ${src("process-timing.ts")};
import {runCommand} from ${src("command-runner.ts")};
import {writeFileSync} from "node:fs";
const platform = createProcessInspection({ run: runCommand, kill: platformKill });
const supervisor = createChildSupervisor({
  stateRoot: ${JSON.stringify(root)},
  ${captureCommand ? `captureCommand: ${JSON.stringify(captureCommand)},` : ""}
  timing: createProcessTiming(),
  processInspection: { ...platform, identity: async (pid) => {
    if (pid !== process.pid) {
      writeFileSync(${JSON.stringify(spawned)}, String(pid));
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => {});
    }
    return platform.identity(pid);
  } },
});
await supervisor.ensureRunning(${JSON.stringify({
      key: "window",
      componentName: "web",
      command,
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
      logRoot: join(root, "logs"),
      incarnation: "start-1",
    })});`,
  );
  const supervisor = Bun.spawn([process.execPath, script], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await supervisor.exited;
  return {
    signal: supervisor.signalCode,
    spawned: Number(await readFile(spawned, "utf8")),
  };
}

test("a supervisor killed between spawning a process and leasing it leaves nothing running: the command never started", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-start-gate-"));
  roots.push(root);
  const starts = join(root, "starts");
  const { signal, spawned } = await killedInSpawnWindow(root, [
    "/bin/sh",
    "-c",
    `echo $$ >> ${starts}; exec sleep 30`,
  ]);
  expect(signal).toBe("SIGKILL");
  // The process the supervisor spawned waited to be released, and ended once its supervisor was gone.
  const ended = await gone(spawned);
  if (!ended) await track(spawned);
  expect(ended).toBe(true);
  expect(await readFile(starts, "utf8").catch(() => "")).toBe("");
  // Nothing names it, and nothing needs to: a later supervisor starts the one and only copy.
  const later = createChildSupervisor({
    stateRoot: root,
    timing: createProcessTiming(),
    processInspection: createProcessInspection({
      run: runCommand,
      kill: platformKill,
    }),
  });
  try {
    expect(await later.observe("window")).toEqual({ state: "stopped" });
    const started = await later.ensureRunning({
      key: "window",
      componentName: "web",
      command: ["/bin/sh", "-c", `echo $$ >> ${starts}; exec sleep 30`],
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
      logRoot: join(root, "logs"),
      incarnation: "start-2",
    });
    await track(started.pid!);
    for (let i = 0; i < 100; i++) {
      if ((await readFile(starts, "utf8").catch(() => "")).trim()) break;
      await Bun.sleep(10);
    }
    expect((await readFile(starts, "utf8")).trim().split("\n")).toEqual([
      String(started.pid),
    ]);
  } finally {
    await later.shutdown();
  }
});

test("rigd killed between spawning a capture wrapper and leasing it leaves nothing running: the wrapper never ran, nor its application", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-start-gate-"));
  roots.push(root);
  const starts = join(root, "starts");
  const wrapper = join(root, "capture.ts");
  await writeFile(
    wrapper,
    `import {runCapturedProcess} from ${src("captured-process.ts")}; process.exitCode = await runCapturedProcess(process.argv[2]!);`,
  );
  const { signal, spawned } = await killedInSpawnWindow(
    root,
    ["/bin/sh", "-c", `echo $$ >> ${starts}; exec sleep 30`],
    [process.execPath, wrapper],
  );
  expect(signal).toBe("SIGKILL");
  const ended = await gone(spawned);
  if (!ended) await track(spawned);
  expect(ended).toBe(true);
  // The wrapper never ran: it wrote no status and started no application.
  await Bun.sleep(200);
  const applications = (await readFile(starts, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean);
  // Should one have started after all, it runs in its own group: cleanup ends that too.
  for (const application of applications) await track(Number(application));
  expect(applications).toEqual([]);
  const capture = join(
    root,
    "capture",
    `${createHash("sha256").update("window").digest("hex")}.json`,
  );
  await expect(readFile(`${capture}.status.json`)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("a started process keeps the pid and birth identity its lease recorded before it was released, and its own argv", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-start-gate-"));
  roots.push(root);
  const inspection = createProcessInspection({
    run: runCommand,
    kill: platformKill,
  });
  const supervisor = createChildSupervisor({
    stateRoot: root,
    timing: createProcessTiming(),
    processInspection: inspection,
  });
  try {
    const started = await supervisor.ensureRunning({
      key: "identity",
      componentName: "web",
      command: ["sleep", "30"],
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
      logRoot: root,
      incarnation: "start-1",
    });
    await track(started.pid!);
    const lease = JSON.parse(
      await readFile(
        join(
          root,
          "process-leases",
          `${createHash("sha256").update("identity").digest("hex")}.json`,
        ),
        "utf8",
      ),
    );
    expect(lease.pid).toBe(started.pid);
    // Once released, the gate has become the command itself: same pid and birth time, the command's own argv.
    let args = "";
    for (let i = 0; i < 100; i++) {
      args = (
        await runCommand({
          command: ["/bin/ps", "-o", "args=", "-p", String(started.pid)],
        })
      ).stdout.trim();
      if (args === "sleep 30") break;
      await Bun.sleep(10);
    }
    expect(args).toBe("sleep 30");
    expect(await inspection.identity(started.pid!)).toBe(lease.identity);
  } finally {
    await supervisor.shutdown();
  }
});

test("a command that cannot be found still fails the start as PROCESS_START, and nothing is left running or leased", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-start-gate-"));
  roots.push(root);
  const supervisor = createChildSupervisor({
    stateRoot: root,
    timing: createProcessTiming(),
    processInspection: createProcessInspection({
      run: runCommand,
      kill: platformKill,
    }),
  });
  for (const command of ["rig-test-missing-command", "./missing", "/missing/x"])
    await expect(
      supervisor.ensureRunning({
        key: "missing",
        componentName: "web",
        command: [command],
        cwd: root,
        env: { PATH: "/usr/bin:/bin" },
        logRoot: root,
        incarnation: "start-1",
      }),
    ).rejects.toMatchObject({ code: "PROCESS_START" });
  expect(await supervisor.observe("missing")).toEqual({ state: "stopped" });
  await supervisor.shutdown();
});

/** A supervisor over the platform whose first identity read of another process, the one its lease would record, is
 * `inspectSpawned`; it remembers the pid that read was about. */
function scriptedSpawnRead(
  root: string,
  inspectSpawned: (
    pid: number,
    real: (pid: number) => Promise<string | undefined>,
  ) => Promise<string | undefined>,
) {
  const platform = createProcessInspection({
    run: runCommand,
    kill: platformKill,
  });
  const world = { spawned: 0 };
  const supervisor = createChildSupervisor({
    stateRoot: root,
    timing: createProcessTiming(),
    processInspection: {
      ...platform,
      identity: (pid) => {
        if (world.spawned || pid === process.pid) return platform.identity(pid);
        world.spawned = pid;
        return inspectSpawned(pid, platform.identity);
      },
    },
  });
  return Object.assign(world, { supervisor });
}
const gatedRequest = (root: string) => ({
  key: "gated",
  componentName: "web",
  command: [
    "/bin/sh",
    "-c",
    `echo $$ >> ${join(root, "starts")}; exec sleep 30`,
  ],
  cwd: root,
  env: { PATH: "/usr/bin:/bin" },
  logRoot: root,
  incarnation: "start-1",
});

test("a spawned process whose identity cannot be read is never released: the start fails as PROCESS_START, nothing is leased, and its command never runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-start-gate-"));
  roots.push(root);
  const world = scriptedSpawnRead(root, async () => undefined);
  try {
    await expect(
      world.supervisor.ensureRunning(gatedRequest(root)),
    ).rejects.toMatchObject({ code: "PROCESS_START" });
    const ended = await gone(world.spawned);
    if (!ended) await track(world.spawned);
    expect(ended).toBe(true);
    expect(await readFile(join(root, "starts"), "utf8").catch(() => "")).toBe(
      "",
    );
    expect(await world.supervisor.observe("gated")).toEqual({
      state: "stopped",
    });
    await expect(
      readFile(
        join(
          root,
          "process-leases",
          `${createHash("sha256").update("gated").digest("hex")}.json`,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await world.supervisor.shutdown();
  }
});

test("a spawned process killed before its release never runs its command, and reads as stopped by that signal", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-start-gate-"));
  roots.push(root);
  const world = scriptedSpawnRead(root, async (pid, real) => {
    const identity = await real(pid);
    process.kill(-pid, "SIGKILL");
    await gone(pid);
    return identity;
  });
  try {
    // A release into a gate that is already gone may or may not be refused; either way nothing of the command runs.
    await world.supervisor.ensureRunning(gatedRequest(root)).catch((error) => {
      expect(error).toMatchObject({ code: "PROCESS_START" });
    });
    expect(await readFile(join(root, "starts"), "utf8").catch(() => "")).toBe(
      "",
    );
    expect(await world.supervisor.observe("gated")).toMatchObject({
      state: "stopped",
      signal: "SIGKILL",
    });
  } finally {
    await world.supervisor.shutdown();
  }
});
