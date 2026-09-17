import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCommand } from "../src/providers/command-runner";
import { readExitRecord } from "../src/providers/exit-record";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
test("the launchd capture entrypoint preserves the real app exit code and stream identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-capture-"));
  roots.push(root);
  const requestPath = join(root, "request.json");
  await writeFile(
    requestPath,
    JSON.stringify({
      key: "capture",
      componentName: "web",
      command: [
        process.execPath,
        "-e",
        "process.stdout.write('hello\\n'); process.stderr.write('bad\\n'); process.exit(7)",
      ],
      cwd: root,
      env: {},
      logRoot: root,
      incarnation: "start-1",
    }),
  );
  const script = `import {runCapturedProcess} from ${JSON.stringify(resolve("src/providers/captured-process.ts"))}; process.exitCode=await runCapturedProcess(process.argv[1]);`;
  const result = await runCommand({
    command: [process.execPath, "-e", script, requestPath],
  });
  expect(result.exitCode).toBe(7);
  const logs = (await readFile(join(root, "target.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(logs.map((log) => [log.stream, log.line])).toContainEqual([
    "stdout",
    "hello",
  ]);
  expect(logs.map((log) => [log.stream, log.line])).toContainEqual([
    "stderr",
    "bad",
  ]);
});
test("capture runs a failing application once, exits with its code, and leaves its exit record and final observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-capture-budget-"));
  roots.push(root);
  const requestPath = join(root, "request.json");
  await writeFile(
    requestPath,
    JSON.stringify({
      key: "budget",
      componentName: "web",
      command: [
        process.execPath,
        "-e",
        "process.stdout.write('attempt\\n');process.exit(9)",
      ],
      cwd: root,
      env: {},
      logRoot: root,
      incarnation: "start-1",
    }),
  );
  const script = `import {runCapturedProcess} from ${JSON.stringify(resolve("src/providers/captured-process.ts"))};process.exitCode=await runCapturedProcess(process.argv[1]);`;
  const result = await runCommand({
    command: [process.execPath, "-e", script, requestPath],
    timeoutMs: 10000,
  });
  expect(result.exitCode).toBe(9);
  const logs = (await readFile(join(root, "target.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(logs.filter((log) => log.line === "attempt")).toHaveLength(1);
  expect(await readExitRecord(root, "budget")).toEqual({
    key: "budget",
    incarnation: "start-1",
    exitCode: 9,
    at: expect.any(String),
  });
  const published = JSON.parse(
    await readFile(`${requestPath}.observation.json`, "utf8"),
  );
  expect(published.observation).toEqual({
    state: "stopped",
    exitCode: 9,
    incarnation: "start-1",
  });
}, 12000);
test("an observation failure after startup stops the running component deliberately and never reports a start failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-capture-observe-"));
  roots.push(root);
  const requestPath = join(root, "request.json");
  const pidFile = join(root, "child.pid");
  await writeFile(
    requestPath,
    JSON.stringify({
      key: "observe",
      componentName: "web",
      command: [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ],
      cwd: root,
      env: {},
      logRoot: root,
      incarnation: "start-1",
    }),
  );
  const script = `import {runCapturedProcess} from ${JSON.stringify(resolve("src/providers/captured-process.ts"))};
import {createProcessIdentityReader} from ${JSON.stringify(resolve("src/providers/process-identity.ts"))};
import {runCommand} from ${JSON.stringify(resolve("src/providers/command-runner.ts"))};
import {existsSync} from "node:fs";
const real = createProcessIdentityReader(runCommand); let calls = 0;
process.exitCode = await runCapturedProcess(process.argv[1], { inspect: async (pid) => {
  if (++calls !== 2) return real(pid);
  while (!existsSync(${JSON.stringify(pidFile)})) await Bun.sleep(20);
  throw new Error("ps failed transiently");
} });`;
  const result = await runCommand({
    command: [process.execPath, "-e", script, requestPath],
    timeoutMs: 8000,
  });
  expect(result.exitCode).toBe(1);
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
  const status = JSON.parse(await readFile(`${requestPath}.status.json`, "utf8"));
  expect(status.state).not.toBe("failed");
  expect(status).toMatchObject({ state: "stopped", pid });
  expect(status.message).not.toContain("could not start");
  expect(status.message).toContain("stopped");
  const observation = JSON.parse(await readFile(`${requestPath}.observation.json`, "utf8"));
  expect(observation.observation.state).toBe("stopped");
  expect(observation.observation.reason).toContain("stopped");
}, 12000);
