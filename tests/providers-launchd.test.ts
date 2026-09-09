import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLaunchdSupervisor } from "../src/providers/launchd-supervisor";
import type { CommandRunner } from "../src/providers/contracts";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
test("launchd up does not restart a running job and stop checks that it is unloaded", async () => {
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
  });
  const request = {
    key: "stable-id/web",
    command: ["/bin/sh", "-c", 'printf "<&"'],
    componentName: "web",
    cwd: root,
    env: { PATH: "/usr/bin:/bin", VALUE: "<&" },
    logRoot: root,
    keepAlive: true,
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
  expect(plist).toContain("<key>KeepAlive</key><true/>");
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
