import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCommand } from "../src/providers/command-runner";
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
test("capture keeps the application restart budget alive and exits after that budget is exhausted", async () => {
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
      keepAlive: true,
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
  expect(logs.filter((log) => log.line === "attempt")).toHaveLength(6);
}, 12000);
