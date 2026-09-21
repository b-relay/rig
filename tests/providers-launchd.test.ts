import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLaunchdSupervisor,
  createLaunchdTiming,
} from "../src/providers/launchd-supervisor";
import type { CommandRunner } from "../src/providers/contracts";
import { runCommand } from "../src/providers/command-runner";
import { createProcessIdentityReader } from "../src/providers/process-identity";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
test("launchd up does not restart a running job, never asks launchd to respawn it, and stop checks that it is unloaded", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-launchd-"));
  roots.push(root);
  const calls: string[][] = [];
  let running = false;
  const run: CommandRunner = async ({ command }) => {
    calls.push([...command]);
    const action = command[1];
    if (action === "bootstrap") running = true;
    if (action === "bootout") running = false;
    return action === "print"
      ? {
          exitCode: running ? 0 : 113,
          stdout: running ? "state = running\n\tpid = 1234\n" : "",
          stderr: running ? "" : "Could not find service",
        }
      : { exitCode: 0, stdout: "", stderr: "" };
  };
  const supervisor = createLaunchdSupervisor({
    root,
    domain: "gui/99999",
    labelPrefix: "test.rig",
    run,
    inspect: async () => undefined,
    timing: createLaunchdTiming(),
  });
  const request = {
    key: "stable-id/web",
    command: ["/bin/sh", "-c", 'printf "<&"'],
    componentName: "web",
    cwd: root,
    env: { PATH: "/usr/bin:/bin", VALUE: "<&" },
    logRoot: root,
    incarnation: "start-1",
  };
  expect(await supervisor.ensureRunning(request)).toEqual({
    outcome: "started",
    pid: 1234,
  });
  expect(await supervisor.ensureRunning(request)).toEqual({
    outcome: "unchanged",
    pid: 1234,
  });
  expect(calls.filter((call) => call[1] === "bootstrap")).toHaveLength(1);
  expect(calls.filter((call) => call[1] === "bootout")).toHaveLength(0);
  const bootstrap = calls.find((call) => call[1] === "bootstrap")!;
  const plist = await readFile(bootstrap[3]!, "utf8");
  expect(plist).toContain("&lt;&amp;");
  expect(plist).toContain("<key>KeepAlive</key><false/>");
  await supervisor.stop(request.key);
  expect((await supervisor.observe(request.key)).state).toBe("stopped");
});
test("real launchd capture stops its managed child and retains stdout and stderr logs", async () => {
  if (process.platform !== "darwin") return;
  const { randomUUID } = await import("node:crypto");
  const { writeFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "rig-launchd-live-"));
  roots.push(root);
  const wrapper = join(root, "capture.ts");
  await writeFile(
    wrapper,
    `import {runCapturedProcess} from ${JSON.stringify(resolve("src/providers/captured-process.ts"))};process.exitCode=await runCapturedProcess(process.argv[2]!);`,
  );
  const supervisor = createLaunchdSupervisor({
    root,
    domain: `gui/${process.getuid!()}`,
    labelPrefix: `test.rig.${randomUUID()}`,
    captureCommand: [process.execPath, wrapper],
    // This test bootstraps a real launchd job, so it runs the real launchctl and reads real process identities.
    run: runCommand,
    inspect: createProcessIdentityReader(runCommand),
    timing: createLaunchdTiming(),
  });
  const request = {
    key: "actual-job",
    componentName: "web",
    command: [
      process.execPath,
      "-e",
      "process.stdout.write(String(process.pid)+'\\n');process.stderr.write('app stderr\\n');setInterval(()=>{},1000)",
    ],
    cwd: root,
    env: { PATH: "/usr/bin:/bin" },
    logRoot: root,
    incarnation: "start-1",
  };
  let appPid = 0;
  try {
    const started = await supervisor.ensureRunning(request);
    expect(started.outcome).toBe("started");
    for (let i = 0; i < 100; i++) {
      const raw = await readFile(join(root, "target.jsonl"), "utf8").catch(
        () => "",
      );
      const entries = raw.trim()
        ? raw
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
      appPid = Number(
        entries.find((entry) => entry.stream === "stdout")?.line ?? 0,
      );
      if (appPid && entries.some((entry) => entry.line === "app stderr")) break;
      await Bun.sleep(30);
    }
    expect(appPid).toBeGreaterThan(0);
    expect((await supervisor.ensureRunning(request)).pid).toBe(started.pid);
    await supervisor.stop(request.key);
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(appPid, 0);
      } catch {
        break;
      }
      await Bun.sleep(30);
    }
    expect(() => process.kill(appPid, 0)).toThrow();
    expect((await supervisor.observe(request.key)).state).toBe("stopped");
  } finally {
    await supervisor.stop(request.key);
  }
}, 15000);

test("real launchd capture records its application's exit against the start it belonged to, leaves it stopped, and the next start recovers it", async () => {
  if (process.platform !== "darwin") return;
  const { randomUUID } = await import("node:crypto");
  const { writeFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "rig-launchd-live-"));
  roots.push(root);
  const wrapper = join(root, "capture.ts");
  await writeFile(
    wrapper,
    `import {runCapturedProcess} from ${JSON.stringify(resolve("src/providers/captured-process.ts"))};process.exitCode=await runCapturedProcess(process.argv[2]!);`,
  );
  const supervisor = createLaunchdSupervisor({
    root,
    domain: `gui/${process.getuid!()}`,
    labelPrefix: `test.rig.${randomUUID()}`,
    captureCommand: [process.execPath, wrapper],
    // This test bootstraps a real launchd job, so it runs the real launchctl and reads real process identities.
    run: runCommand,
    inspect: createProcessIdentityReader(runCommand),
    timing: createLaunchdTiming(),
  });
  const trigger = join(root, "exit-now");
  const request = (incarnation: string) => ({
    key: "recovered-job",
    componentName: "web",
    command: [
      process.execPath,
      "-e",
      `setInterval(()=>{if(require("node:fs").existsSync(${JSON.stringify(trigger)}))process.exit(7)},25)`,
    ],
    cwd: root,
    env: { PATH: "/usr/bin:/bin" },
    logRoot: root,
    incarnation,
  });
  const until = async (state: string) => {
    for (let i = 0; i < 200; i++) {
      const seen = await supervisor.observe("recovered-job");
      if (seen.state === state) return seen;
      await Bun.sleep(30);
    }
    return supervisor.observe("recovered-job");
  };
  try {
    expect((await supervisor.ensureRunning(request("start-1"))).outcome).toBe(
      "started",
    );
    expect(await until("running")).toMatchObject({ incarnation: "start-1" });
    await writeFile(trigger, "");
    expect(await until("stopped")).toEqual({
      state: "stopped",
      exitCode: 7,
      incarnation: "start-1",
    });
    await Bun.sleep(300);
    expect((await supervisor.observe("recovered-job")).state).toBe("stopped");
    await rm(trigger);
    expect((await supervisor.ensureRunning(request("start-2"))).outcome).toBe(
      "started",
    );
    expect(await until("running")).toMatchObject({ incarnation: "start-2" });
  } finally {
    await supervisor.stop("recovered-job");
  }
}, 20000);

test("ensureRunning replaces a loaded job whose application has ended instead of waiting for it to come back", async () => {
  const { createHash } = await import("node:crypto");
  const { writeFile } = await import("node:fs/promises");
  const { writeCaptureStatus } =
    await import("../src/providers/capture-status");
  const root = await mkdtemp(join(tmpdir(), "rig-launchd-"));
  roots.push(root);
  const key = "stable-id/web";
  const requestPath = join(
    root,
    `test.rig.${createHash("sha256").update(key).digest("hex").slice(0, 24)}.json`,
  );
  const wrapper = { pid: 77, identity: "w".repeat(64) };
  const application = { pid: 88, identity: "a".repeat(64) };
  let clock = 0;
  let replaced = false;
  const calls: string[] = [];
  const run: CommandRunner = async ({ command }) => {
    calls.push(command[1]!);
    if (command[1] === "bootstrap") {
      replaced = true;
      await writeCaptureStatus(requestPath, {
        state: "running",
        pid: application.pid,
      });
    }
    if (command[1] !== "print") return { exitCode: 0, stdout: "", stderr: "" };
    clock += 100;
    await writeFile(
      `${requestPath}.observation.json`,
      JSON.stringify({
        wrapperPid: wrapper.pid,
        wrapperIdentity: wrapper.identity,
        observedAt: clock,
        ...(replaced ? { applicationIdentity: application.identity } : {}),
        observation: replaced
          ? { state: "running", pid: application.pid, incarnation: "start-2" }
          : { state: "stopped", exitCode: 1, incarnation: "start-1" },
      }),
    );
    return {
      exitCode: 0,
      stdout: `state = running\n\tpid = ${wrapper.pid}\n`,
      stderr: "",
    };
  };
  const supervisor = createLaunchdSupervisor({
    root,
    domain: "gui/99999",
    labelPrefix: "test.rig",
    captureCommand: ["/bin/true"],
    run,
    timing: { ...createLaunchdTiming(), now: () => clock },
    inspect: async (pid) =>
      pid === wrapper.pid
        ? wrapper.identity
        : pid === application.pid
          ? application.identity
          : "x".repeat(64),
  });
  expect(await supervisor.observe(key)).toEqual({
    state: "stopped",
    exitCode: 1,
    incarnation: "start-1",
  });
  expect(
    await supervisor.ensureRunning({
      key,
      command: ["/bin/sh", "-c", "serve"],
      componentName: "web",
      cwd: root,
      env: {},
      logRoot: root,
      incarnation: "start-2",
    }),
  ).toEqual({ outcome: "started", pid: application.pid });
  expect(calls.filter((action) => action !== "print")).toEqual([
    "bootout",
    "bootstrap",
  ]);
  expect(await supervisor.observe(key)).toEqual({
    state: "running",
    pid: application.pid,
    incarnation: "start-2",
  });
});

test("launchd stop and a failed bootstrap remove every job file, a vanished job is cleaned as unchanged, and unloading may take the wrapper's whole shutdown budget", async () => {
  const { createHash } = await import("node:crypto");
  const { readdir, writeFile } = await import("node:fs/promises");
  const { writeCaptureStatus } =
    await import("../src/providers/capture-status");
  const { writeCaptureObservation } =
    await import("../src/providers/capture-observation");
  const root = await mkdtemp(join(tmpdir(), "rig-launchd-"));
  roots.push(root);
  const key = "target-1:web";
  const jobLabel = `test.rig.${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
  const requestPath = join(root, `${jobLabel}.json`);
  const wrapper = { pid: 4242, identity: "w".repeat(64) };
  const application = { pid: 5000, identity: "a".repeat(64) };
  let loaded = false;
  let bootstrapExit = 0;
  let unloadPrints = 0;
  const run: CommandRunner = async ({ command }) => {
    const action = command[1];
    if (action === "bootstrap") {
      if (bootstrapExit)
        return {
          exitCode: bootstrapExit,
          stdout: "",
          stderr: "Bootstrap failed: 5: Input/output error",
        };
      loaded = true;
      await writeCaptureStatus(requestPath, {
        state: "running",
        pid: application.pid,
      });
      await writeCaptureObservation(requestPath, {
        wrapperPid: wrapper.pid,
        wrapperIdentity: wrapper.identity,
        observedAt: Date.now(),
        applicationIdentity: application.identity,
        observation: { state: "running", pid: application.pid },
      });
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (action === "bootout") {
      unloadPrints = 40;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (unloadPrints > 0 && --unloadPrints === 0) loaded = false;
    return loaded
      ? {
          exitCode: 0,
          stdout: `\tstate = running\n\tpid = ${wrapper.pid}\n`,
          stderr: "",
        }
      : {
          exitCode: 113,
          stdout: "",
          stderr: 'Could not find service "x" in domain for user gui: 502',
        };
  };
  const supervisor = createLaunchdSupervisor({
    root,
    domain: "gui/99999",
    labelPrefix: "test.rig",
    captureCommand: ["/fake/rigd", "capture"],
    run,
    timing: createLaunchdTiming(),
    inspect: async (pid) =>
      pid === wrapper.pid
        ? wrapper.identity
        : pid === application.pid
          ? application.identity
          : undefined,
  });
  const request = {
    key,
    componentName: "web",
    command: ["/bin/sh", "-c", "serve"],
    cwd: root,
    env: { SECRET: "s3cret" },
    logRoot: root,
    incarnation: "start-1",
  };
  const files = async () =>
    (await readdir(root)).filter((name) => name.startsWith(jobLabel)).sort();

  expect((await supervisor.ensureRunning(request)).outcome).toBe("started");
  expect(await files()).toEqual([
    `${jobLabel}.json`,
    `${jobLabel}.json.observation.json`,
    `${jobLabel}.json.status.json`,
    `${jobLabel}.plist`,
  ]);
  // The wrapper needs 40 polls (about 4 s) to finish its SIGTERM then SIGKILL shutdown; the unload wait must cover it.
  expect(await supervisor.stop(key)).toEqual({ outcome: "stopped" });
  expect(await files()).toEqual([]);

  expect((await supervisor.ensureRunning(request)).outcome).toBe("started");
  loaded = false; // logout: jobs bootstrapped from a private plist are gone
  expect(await supervisor.stop(key)).toEqual({ outcome: "unchanged" });
  expect(await files()).toEqual([]);

  bootstrapExit = 5;
  await expect(supervisor.ensureRunning(request)).rejects.toMatchObject({
    code: "LAUNCHD_FAILED",
    details: { action: "bootstrap", label: jobLabel, exitCode: 5 },
  });
  expect(await files()).toEqual([]);
  await writeFile(join(root, "unrelated"), "");
}, 20000);
