import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChildSupervisor } from "../src/providers/child-supervisor";
import { runCommand } from "../src/providers/command-runner";
import {
  createProcessInspection,
  platformKill,
} from "../src/providers/process-inspection";
import { createProcessTiming } from "../src/providers/process-timing";
/** These tests exercise real processes, so they pass the platform clock and signal path explicitly. */
const platform = () => ({
  timing: createProcessTiming(),
  processInspection: createProcessInspection({
    run: runCommand,
    kill: platformKill,
  }),
});
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
  const supervisor = createChildSupervisor({ ...platform(), stateRoot: root });
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
    incarnation: "start-1",
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
  const supervisor = createChildSupervisor({ ...platform(), stateRoot: root });
  supervisors.push(supervisor);
  const request = {
    key: "tree",
    componentName: "shell",
    command: ["/bin/sh", "-c", "sleep 600 & echo $!; wait"],
    cwd: root,
    env: { PATH: "/usr/bin:/bin" },
    logRoot: root,
    incarnation: "start-1",
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
test("a crashed process is observed as stopped with its exit code and incarnation", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-crash-"));
  roots.push(root);
  const supervisor = createChildSupervisor({ ...platform(), stateRoot: root });
  supervisors.push(supervisor);
  await supervisor.ensureRunning({
    key: "crash",
    componentName: "web",
    command: [process.execPath, "-e", "process.exit(7)"],
    cwd: root,
    env: {},
    logRoot: root,
    incarnation: "start-1",
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
    incarnation: "start-1",
  });
});
test("concurrent up calls create only one process", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-concurrent-"));
  roots.push(root);
  const supervisor = createChildSupervisor({ ...platform(), stateRoot: root });
  supervisors.push(supervisor);
  const request = {
    key: "one",
    componentName: "web",
    command: [process.execPath, "-e", "setInterval(()=>{},1000)"],
    cwd: root,
    env: {},
    logRoot: root,
    incarnation: "start-1",
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
  const first = createChildSupervisor({ ...platform(), stateRoot: root });
  supervisors.push(first);
  const started = await first.ensureRunning({
    key: "recover",
    componentName: "web",
    command: [process.execPath, "-e", "setInterval(()=>{},1000)"],
    cwd: root,
    env: {},
    logRoot: root,
    incarnation: "start-1",
  });
  const replacement = createChildSupervisor({ ...platform(), stateRoot: root });
  supervisors.push(replacement);
  expect(await replacement.observe("recover")).toEqual({
    state: "running",
    pid: started.pid,
    incarnation: "start-1",
  });
  expect(
    await replacement.ensureRunning({
      key: "recover",
      componentName: "web",
      command: ["/invalid/command"],
      cwd: root,
      env: {},
      logRoot: root,
      incarnation: "start-1",
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
  const supervisor = createChildSupervisor({ ...platform(), stateRoot: root });
  supervisors.push(supervisor);
  const started = await supervisor.ensureRunning({
    key: "real",
    componentName: "web",
    command: [process.execPath, "-e", "setInterval(()=>{},1000)"],
    cwd: root,
    env: {},
    logRoot: root,
    incarnation: "start-1",
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
test("a process that exits is not started again: one attempt is logged and observe reports its exit code and incarnation", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-budget-"));
  roots.push(root);
  const supervisor = createChildSupervisor({ ...platform(), stateRoot: root });
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
    incarnation: "start-1",
  });
  for (let i = 0; i < 100; i++) {
    if ((await supervisor.observe("budget")).state === "stopped") break;
    await Bun.sleep(10);
  }
  await Bun.sleep(150);
  const logs = (await readFile(join(root, "target.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(logs.filter((log) => log.line === "attempt")).toHaveLength(1);
  expect(await supervisor.observe("budget")).toEqual({
    state: "stopped",
    exitCode: 9,
    incarnation: "start-1",
  });
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
    incarnation: "start-1",
  };
  const daemon = join(root, "daemon.ts");
  await writeFile(
    daemon,
    `import {createChildSupervisor} from ${JSON.stringify(resolve("src/providers/child-supervisor.ts"))};import {runCommand} from ${JSON.stringify(resolve("src/providers/command-runner.ts"))};import {createProcessInspection,platformKill} from ${JSON.stringify(resolve("src/providers/process-inspection.ts"))};import {createProcessTiming} from ${JSON.stringify(resolve("src/providers/process-timing.ts"))};const supervisor=createChildSupervisor({stateRoot:${JSON.stringify(root)},captureCommand:${JSON.stringify([process.execPath, capture])},timing:createProcessTiming(),processInspection:createProcessInspection({run:runCommand,kill:platformKill})});await supervisor.ensureRunning(${JSON.stringify(request)});process.exit(0);`,
  );
  const starting = Bun.spawn([process.execPath, daemon], {
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(await starting.exited).toBe(0);
  const replacement = createChildSupervisor({
    ...platform(),
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
  const first = createChildSupervisor({ ...platform(), stateRoot: root });
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
    incarnation: "start-1",
  });
  for (let i = 0; i < 100; i++) {
    if (
      (await readFile(join(root, "target.jsonl"), "utf8")).includes("changed")
    )
      break;
    await Bun.sleep(20);
  }
  const replacement = createChildSupervisor({ ...platform(), stateRoot: root });
  supervisors.push(replacement);
  expect(await replacement.observe("title")).toEqual({
    state: "running",
    pid: started.pid,
    incarnation: "start-1",
  });
});
test("exec preserves process ownership across daemon replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-process-exec-"));
  roots.push(root);
  const first = createChildSupervisor({ ...platform(), stateRoot: root });
  supervisors.push(first);
  const started = await first.ensureRunning({
    key: "exec",
    componentName: "web",
    command: ["/bin/sh", "-c", "sleep 0.2; exec sleep 600"],
    cwd: root,
    env: { PATH: "/usr/bin:/bin" },
    logRoot: root,
    incarnation: "start-1",
  });
  await Bun.sleep(350);
  const replacement = createChildSupervisor({ ...platform(), stateRoot: root });
  supervisors.push(replacement);
  expect(await replacement.observe("exec")).toEqual({
    state: "running",
    pid: started.pid,
    incarnation: "start-1",
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
    ...platform(),
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
      incarnation: "start-1",
    }),
  ).rejects.toThrow();
  expect((await supervisor.observe("missing")).state).toBe("stopped");
});

for (const captured of [false, true]) {
  test(`stop drains final owned output before lease cleanup (capture wrapper: ${captured})`, async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    const { resolve } = await import("node:path");
    const base = await mkdtemp(join(tmpdir(), "rig-stop-drain-"));
    roots.push(base);
    const root = join(base, ".rig");
    await mkdir(root);
    const captureScript = join(root, "capture.ts");
    if (captured)
      await writeFile(
        captureScript,
        `import {runCapturedProcess} from ${JSON.stringify(resolve("src/providers/captured-process.ts"))};process.exitCode=await runCapturedProcess(process.argv[2]!);`,
      );
    const supervisor = createChildSupervisor({
      ...platform(),
      stateRoot: root,
      ...(captured
        ? { captureCommand: [process.execPath, captureScript] }
        : {}),
    });
    supervisors.push(supervisor);
    const started = await supervisor.ensureRunning({
      key: "drain",
      componentName: "web",
      cwd: root,
      logRoot: root,
      env: { RIG_ROOT: root },
      incarnation: "start-1",
      command: [
        process.execPath,
        "-e",
        "process.on('SIGTERM',()=>setTimeout(()=>{process.stdout.write('final stdout');process.stderr.write('final stderr');process.exit(0)},100));process.stdout.write('ready\\n');setInterval(()=>{},1000)",
      ],
    });
    const log = join(root, "target.jsonl");
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await readFile(log, "utf8")).includes("ready")) break;
      await Bun.sleep(20);
    }
    expect(await readFile(log, "utf8")).toContain("ready");
    const digest = createHash("sha256").update("drain").digest("hex");
    const lease = join(root, "process-leases", `${digest}.json`);
    expect(JSON.parse(await readFile(lease, "utf8")).pid).toBe(started.pid);
    expect(await supervisor.stop("drain")).toEqual({ outcome: "stopped" });
    const entries = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries.map((entry) => [entry.stream, entry.line])).toContainEqual([
      "stdout",
      "final stdout",
    ]);
    expect(entries.map((entry) => [entry.stream, entry.line])).toContainEqual([
      "stderr",
      "final stderr",
    ]);
    await expect(readFile(lease)).rejects.toMatchObject({ code: "ENOENT" });
    if (captured)
      await expect(
        readFile(join(root, "capture", `${digest}.json`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => process.kill(started.pid!, 0)).toThrow();
    expect(await supervisor.stop("drain")).toEqual({ outcome: "unchanged" });
    await Bun.sleep(150);
    expect((await supervisor.observe("drain")).state).toBe("stopped");
  });
}

test("stop after an owned child already exited is unchanged, keeps its exit on record, and nothing starts it again", async () => {
  const { mkdir } = await import("node:fs/promises");
  const base = await mkdtemp(join(tmpdir(), "rig-stop-exited-"));
  roots.push(base);
  const root = join(base, ".rig");
  await mkdir(root);
  const supervisor = createChildSupervisor({ ...platform(), stateRoot: root });
  supervisors.push(supervisor);
  await supervisor.ensureRunning({
    key: "exited",
    componentName: "web",
    cwd: root,
    logRoot: root,
    env: { RIG_ROOT: root },
    incarnation: "start-1",
    command: [
      process.execPath,
      "-e",
      "process.stdout.write('attempt\\n');setTimeout(()=>process.exit(7),100)",
    ],
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await supervisor.observe("exited")).state === "stopped") break;
    await Bun.sleep(10);
  }
  expect(await supervisor.observe("exited")).toEqual({
    state: "stopped",
    exitCode: 7,
    incarnation: "start-1",
  });
  expect(await supervisor.stop("exited")).toEqual({ outcome: "unchanged" });
  await Bun.sleep(150);
  expect(await supervisor.observe("exited")).toEqual({
    state: "stopped",
    exitCode: 7,
    incarnation: "start-1",
  });
  const entries = (await readFile(join(root, "target.jsonl"), "utf8"))
    .trim()
    .split("\n");
  expect(entries).toHaveLength(1);
});
test("a detached daemon leaves its processes running and the next daemon adopts them without restarting", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-detach-"));
  roots.push(root);
  const first = createChildSupervisor({ ...platform(), stateRoot: root });
  const request = {
    key: "target/web",
    componentName: "web",
    command: [process.execPath, "-e", "setInterval(()=>{},1000)"],
    cwd: root,
    env: { ...process.env } as Record<string, string>,
    logRoot: root,
    incarnation: "start-1",
  };
  const started = await first.ensureRunning(request);
  await first.detach();
  expect(() => process.kill(started.pid!, 0)).not.toThrow();
  const second = createChildSupervisor({ ...platform(), stateRoot: root });
  supervisors.push(second);
  expect(await second.observe(request.key)).toMatchObject({
    state: "running",
    pid: started.pid,
    incarnation: "start-1",
  });
  expect(await second.ensureRunning(request)).toEqual({
    outcome: "unchanged",
    pid: started.pid,
  });
  expect(await second.stop(request.key)).toEqual({ outcome: "stopped" });
  expect(() => process.kill(started.pid!, 0)).toThrow();
  expect((await second.observe(request.key)).state).toBe("stopped");
});
test("after a daemon restart, a dead group leader with live members is stopped as a group and up does not spawn a duplicate", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-orphan-group-"));
  roots.push(root);
  const request = {
    key: "orphans",
    componentName: "web",
    command: ["/bin/sh", "-c", "sleep 300 & sleep 300 & wait"],
    cwd: root,
    env: { PATH: "/usr/bin:/bin" },
    logRoot: join(root, "logs"),
    incarnation: "start-1",
  };
  const first = createChildSupervisor({ ...platform(), stateRoot: root });
  const leader = (await first.ensureRunning(request)).pid!;
  await first.detach();
  const inspection = createProcessInspection({
    run: runCommand,
    kill: platformKill,
  });
  await Bun.sleep(300); // let sh fork its members before the leader dies
  process.kill(leader, "SIGKILL");
  await Bun.sleep(200);
  expect(await inspection.groupExists(leader)).toBe(true);
  const second = createChildSupervisor({ ...platform(), stateRoot: root });
  supervisors.push(second);
  expect((await second.observe(request.key)).state).toBe("stopped");
  await second.stop(request.key);
  expect(await inspection.groupExists(leader)).toBe(false);
  const again = (await second.ensureRunning(request)).pid!;
  await second.detach();
  await Bun.sleep(300);
  process.kill(again, "SIGKILL");
  await Bun.sleep(200);
  expect(await inspection.groupExists(again)).toBe(true);
  const third = createChildSupervisor({ ...platform(), stateRoot: root });
  supervisors.push(third);
  const restarted = await third.ensureRunning(request);
  expect(restarted.outcome).toBe("started");
  expect(await inspection.groupExists(again)).toBe(false);
  expect(await third.observe(request.key)).toMatchObject({
    state: "running",
    pid: restarted.pid,
  });
});
test("a deleted log directory is recreated on the next line; output that cannot be recorded is named while it lasts", async () => {
  const { mkdir, writeFile, stat } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "rig-process-logdir-"));
  roots.push(root);
  const supervisor = createChildSupervisor({ ...platform(), stateRoot: root });
  supervisors.push(supervisor);
  const logRoot = join(root, "logs", "live");
  await mkdir(logRoot, { recursive: true });
  const request = {
    key: "target/web",
    componentName: "web",
    command: [
      process.execPath,
      "-e",
      "let n=0; setInterval(()=>process.stdout.write(`tick ${n++}\\n`), 10)",
    ],
    cwd: root,
    env: { ...process.env } as Record<string, string>,
    logRoot,
    incarnation: "start-1",
  };
  await supervisor.ensureRunning(request);
  const lines = async () =>
    (await readFile(join(logRoot, "target.jsonl"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean).length;
  while ((await lines()) < 3) await Bun.sleep(10);
  // The directory disappears under the running component: the next line brings it back.
  await rm(logRoot, { recursive: true, force: true });
  for (let i = 0; i < 100 && (await lines()) < 2; i++) await Bun.sleep(10);
  expect(await lines()).toBeGreaterThanOrEqual(2);
  expect(await supervisor.observe(request.key)).toEqual({
    state: "running",
    pid: expect.any(Number),
    incarnation: "start-1",
  });
  // A path that cannot be a directory cannot take output: the observation says so, and recovers once it can.
  await rm(logRoot, { recursive: true, force: true });
  await writeFile(logRoot, "not a directory");
  let observed = await supervisor.observe(request.key);
  for (let i = 0; i < 100 && !observed.reason; i++) {
    await Bun.sleep(10);
    observed = await supervisor.observe(request.key);
  }
  expect(observed).toMatchObject({
    state: "running",
    reason: expect.stringContaining(
      `Target output is not being recorded in ${logRoot}`,
    ),
  });
  await rm(logRoot, { force: true });
  for (let i = 0; i < 100 && observed.reason; i++) {
    await Bun.sleep(10);
    observed = await supervisor.observe(request.key);
  }
  expect(observed).toEqual({
    state: "running",
    pid: expect.any(Number),
    incarnation: "start-1",
  });
  expect((await stat(join(logRoot, "target.jsonl"))).isFile()).toBe(true);
  await supervisor.stop(request.key);
});
test("a newline-free output run is recorded as bounded records that reassemble losslessly", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-process-longline-"));
  roots.push(root);
  const supervisor = createChildSupervisor({ ...platform(), stateRoot: root });
  supervisors.push(supervisor);
  const request = {
    key: "target/web",
    componentName: "web",
    command: [
      process.execPath,
      "-e",
      "process.stdout.write(Buffer.alloc(200000, 0)); process.stdout.write('\\ndone\\n'); setInterval(()=>{},1000)",
    ],
    cwd: root,
    env: { ...process.env } as Record<string, string>,
    logRoot: root,
    incarnation: "start-1",
  };
  await supervisor.ensureRunning(request);
  const read = async () =>
    (await readFile(join(root, "target.jsonl"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean);
  while (!(await read()).some((line) => line.includes('"done"')))
    await Bun.sleep(20);
  const lines = await read();
  expect(lines.length).toBeGreaterThan(2);
  for (const line of lines)
    expect(Buffer.byteLength(line)).toBeLessThan(1024 * 1024);
  const records = lines.map((line) => JSON.parse(line) as { line: string });
  expect(
    records
      .slice(0, -1)
      .map((record) => record.line)
      .join(""),
  ).toBe("\0".repeat(200000));
  expect(records.at(-1)!.line).toBe("done");
  await supervisor.stop(request.key);
});
