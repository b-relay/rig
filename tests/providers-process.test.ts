import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChildSupervisor } from "../src/providers/child-supervisor";
const roots: string[] = [];
const supervisors: ReturnType<typeof createChildSupervisor>[] = [];
afterEach(async () => {
  for (const s of supervisors.splice(0)) await s.shutdown();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
test("a repeated up preserves the process and down confirms its exit with captured output", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-process-"));
  roots.push(root);
  const supervisor = createChildSupervisor({ stateRoot: root });
  supervisors.push(supervisor);
  const request = {
    key: "target/web",
    componentName: "web",
    command: [
      process.execPath,
      "-e",
      "process.stdout.write('ready\\n'); process.stderr.write('warning\\n'); setInterval(()=>{},1000)",
    ],
    cwd: root,
    env: { ...process.env } as Record<string, string>,
    logRoot: root,
  };
  const started = await supervisor.ensureRunning(request);
  expect(started.outcome).toBe("started");
  expect(await supervisor.ensureRunning(request)).toEqual({
    outcome: "unchanged",
    pid: started.pid,
  });
  for (let i = 0; i < 50; i++) {
    if (
      (
        await readFile(join(root, "target.jsonl"), "utf8").catch(() => "")
      ).includes("warning")
    )
      break;
    await Bun.sleep(20);
  }
  const logs = (await readFile(join(root, "target.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    logs.map((log) => [log.component, log.stream, log.line]),
  ).toContainEqual(["web", "stdout", "ready"]);
  expect(
    logs.map((log) => [log.component, log.stream, log.line]),
  ).toContainEqual(["web", "stderr", "warning"]);
  expect((await supervisor.observe(request.key)).state).toBe("running");
  await supervisor.stop(request.key);
  expect((await supervisor.observe(request.key)).state).toBe("stopped");
  expect(() => process.kill(started.pid!, 0)).toThrow();
});
test("down kills shell descendants and an aborted observation does not stop the app", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-tree-"));
  roots.push(root);
  const supervisor = createChildSupervisor({ stateRoot: root });
  supervisors.push(supervisor);
  const request = {
    key: "tree",
    componentName: "shell",
    command: ["/bin/sh", "-c", "sleep 600 & echo $!; wait"],
    cwd: root,
    env: { PATH: "/usr/bin:/bin" },
    logRoot: root,
  };
  await supervisor.ensureRunning(request);
  let descendant = 0;
  for (let i = 0; i < 50; i++) {
    const log = await readFile(join(root, "target.jsonl"), "utf8").catch(
      () => "",
    );
    if (log) {
      descendant = Number(JSON.parse(log.trim()).line);
      break;
    }
    await Bun.sleep(20);
  }
  expect(descendant).toBeGreaterThan(0);
  const controller = new AbortController();
  controller.abort();
  expect((await supervisor.observe("tree", controller.signal)).state).toBe(
    "unknown",
  );
  expect((await supervisor.observe("tree")).state).toBe("running");
  await supervisor.stop("tree");
  for (let i = 0; i < 30; i++) {
    try {
      process.kill(descendant, 0);
    } catch {
      break;
    }
    await Bun.sleep(20);
  }
  expect(() => process.kill(descendant, 0)).toThrow();
});
test("a crashed process is observed as stopped with its exit code", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-crash-"));
  roots.push(root);
  const supervisor = createChildSupervisor({ stateRoot: root });
  supervisors.push(supervisor);
  await supervisor.ensureRunning({
    key: "crash",
    componentName: "web",
    command: [process.execPath, "-e", "process.exit(7)"],
    cwd: root,
    env: {},
    logRoot: root,
  });
  for (
    let i = 0;
    i < 50 && (await supervisor.observe("crash")).state === "running";
    i++
  )
    await Bun.sleep(20);
  expect(await supervisor.observe("crash")).toEqual({
    state: "stopped",
    exitCode: 7,
  });
});
test("concurrent up calls create only one process", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-concurrent-"));
  roots.push(root);
  const supervisor = createChildSupervisor({ stateRoot: root });
  supervisors.push(supervisor);
  const request = {
    key: "one",
    componentName: "web",
    command: [process.execPath, "-e", "setInterval(()=>{},1000)"],
    cwd: root,
    env: {},
    logRoot: root,
  };
  const outcomes = await Promise.all([
    supervisor.ensureRunning(request),
    supervisor.ensureRunning(request),
  ]);
  expect(
    outcomes.filter((result) => result.outcome === "started"),
  ).toHaveLength(1);
  expect(outcomes[0]!.pid).toBe(outcomes[1]!.pid);
});
test("a replacement daemon adopts an identity-matched lease and stops the original process", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-recover-"));
  roots.push(root);
  const first = createChildSupervisor({ stateRoot: root });
  supervisors.push(first);
  const started = await first.ensureRunning({
    key: "recover",
    componentName: "web",
    command: [process.execPath, "-e", "setInterval(()=>{},1000)"],
    cwd: root,
    env: {},
    logRoot: root,
  });
  const replacement = createChildSupervisor({ stateRoot: root });
  supervisors.push(replacement);
  expect(await replacement.observe("recover")).toEqual({
    state: "running",
    pid: started.pid,
  });
  expect(
    await replacement.ensureRunning({
      key: "recover",
      componentName: "web",
      command: ["/invalid/command"],
      cwd: root,
      env: {},
      logRoot: root,
    }),
  ).toEqual({ outcome: "unchanged", pid: started.pid });
  await replacement.stop("recover");
  expect(() => process.kill(started.pid!, 0)).toThrow();
});
test("a stale lease cannot stop a process whose identity no longer matches", async () => {
  const { createHash } = await import("node:crypto");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "rig-stale-"));
  roots.push(root);
  const supervisor = createChildSupervisor({ stateRoot: root });
  supervisors.push(supervisor);
  const started = await supervisor.ensureRunning({
    key: "real",
    componentName: "web",
    command: [process.execPath, "-e", "setInterval(()=>{},1000)"],
    cwd: root,
    env: {},
    logRoot: root,
  });
  await mkdir(join(root, "process-leases"), { recursive: true });
  await writeFile(
    join(
      root,
      "process-leases",
      createHash("sha256").update("stale").digest("hex") + ".json",
    ),
    JSON.stringify({
      key: "stale",
      pid: started.pid,
      identity: "0".repeat(64),
    }),
  );
  expect(await supervisor.stop("stale")).toEqual({ outcome: "unchanged" });
  expect((await supervisor.observe("real")).state).toBe("running");
});
test("keepAlive uses a bounded restart budget instead of an infinite crash loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-budget-"));
  roots.push(root);
  const supervisor = createChildSupervisor({
    stateRoot: root,
    restartLimit: 2,
    restartBackoffMs: 10,
  });
  supervisors.push(supervisor);
  await supervisor.ensureRunning({
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
  });
  await Bun.sleep(700);
  const logs = (await readFile(join(root, "target.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(logs.filter((log) => log.line === "attempt")).toHaveLength(3);
  expect((await supervisor.observe("budget")).state).toBe("stopped");
});
test("capture-backed processes keep writing logs after their starting daemon dies and can be adopted", async () => {
  const { writeFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "rig-hard-crash-"));
  roots.push(root);
  const capture = join(root, "capture.ts");
  await writeFile(
    capture,
    `import {runCapturedProcess} from ${JSON.stringify(resolve("src/providers/captured-process.ts"))};process.exitCode=await runCapturedProcess(process.argv[2]!);`,
  );
  const request = {
    key: "durable",
    componentName: "web",
    command: [
      process.execPath,
      "-e",
      "let i=0;setInterval(()=>process.stdout.write(String(++i)+'\\n'),40)",
    ],
    cwd: root,
    env: {},
    logRoot: root,
  };
  const daemon = join(root, "daemon.ts");
  await writeFile(
    daemon,
    `import {createChildSupervisor} from ${JSON.stringify(resolve("src/providers/child-supervisor.ts"))};const supervisor=createChildSupervisor({stateRoot:${JSON.stringify(root)},captureCommand:${JSON.stringify([process.execPath, capture])}});await supervisor.ensureRunning(${JSON.stringify(request)});process.exit(0);`,
  );
  const starting = Bun.spawn([process.execPath, daemon], {
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(await starting.exited).toBe(0);
  const replacement = createChildSupervisor({
    stateRoot: root,
    captureCommand: [process.execPath, capture],
  });
  supervisors.push(replacement);
  expect((await replacement.observe("durable")).state).toBe("running");
  await Bun.sleep(300);
  const before = (await readFile(join(root, "target.jsonl"), "utf8"))
    .trim()
    .split("\n").length;
  await Bun.sleep(200);
  expect(
    (await readFile(join(root, "target.jsonl"), "utf8")).trim().split("\n")
      .length,
  ).toBeGreaterThan(before);
  await replacement.stop("durable");
  expect((await replacement.observe("durable")).state).toBe("stopped");
}, 10000);
test("process title changes do not invalidate its birth identity after daemon replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-process-title-"));
  roots.push(root);
  const first = createChildSupervisor({ stateRoot: root });
  supervisors.push(first);
  const started = await first.ensureRunning({
    key: "title",
    componentName: "web",
    command: [
      process.execPath,
      "-e",
      "setTimeout(()=>{process.title='rig-title-changed';process.stdout.write('changed\\n')},150);setInterval(()=>{},1000)",
    ],
    cwd: root,
    env: {},
    logRoot: root,
  });
  for (let i = 0; i < 100; i++) {
    if (
      (await readFile(join(root, "target.jsonl"), "utf8")).includes("changed")
    )
      break;
    await Bun.sleep(20);
  }
  const replacement = createChildSupervisor({ stateRoot: root });
  supervisors.push(replacement);
  expect(await replacement.observe("title")).toEqual({
    state: "running",
    pid: started.pid,
  });
});
test("exec preserves process ownership across daemon replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-process-exec-"));
  roots.push(root);
  const first = createChildSupervisor({ stateRoot: root });
  supervisors.push(first);
  const started = await first.ensureRunning({
    key: "exec",
    componentName: "web",
    command: ["/bin/sh", "-c", "sleep 0.2; exec sleep 600"],
    cwd: root,
    env: { PATH: "/usr/bin:/bin" },
    logRoot: root,
  });
  await Bun.sleep(350);
  const replacement = createChildSupervisor({ stateRoot: root });
  supervisors.push(replacement);
  expect(await replacement.observe("exec")).toEqual({
    state: "running",
    pid: started.pid,
  });
});
test("capture-backed up rejects an app that cannot start instead of reporting the wrapper as success", async () => {
  const { writeFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "rig-capture-start-fail-"));
  roots.push(root);
  const capture = join(root, "capture.ts");
  await writeFile(
    capture,
    `import {runCapturedProcess} from ${JSON.stringify(resolve("src/providers/captured-process.ts"))};process.exitCode=await runCapturedProcess(process.argv[2]!);`,
  );
  const supervisor = createChildSupervisor({
    stateRoot: root,
    captureCommand: [process.execPath, capture],
  });
  supervisors.push(supervisor);
  await expect(
    supervisor.ensureRunning({
      key: "missing",
      componentName: "web",
      command: ["/missing/rig-test-executable"],
      cwd: root,
      env: {},
      logRoot: root,
    }),
  ).rejects.toThrow();
  expect((await supervisor.observe("missing")).state).toBe("stopped");
});
