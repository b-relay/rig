import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  platformInspect,
  processExited,
  processIdentity,
  rigFixture,
  type Inspect,
} from "./support/rig-fixture";

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
/** What a test run left: each fixture's root and the processes it ran, by pid and birth. */
type Report = {
  base: string;
  processes: { pid: number; identity?: string }[];
};
/** Runs the test file `source` from the repository, so the run is configured as every test run here is, with
 * `$FIXTURE_REPORTS` set to `work`, where its tests report what their fixtures made. `args` are given to `bun test`, and
 * `environment` adds to what the run inherits. A run still going `deadlineMs` after it started is killed, and answers
 * `overran`. */
async function testRun(
  work: string,
  source: string,
  args: readonly string[] = [],
  environment: Record<string, string> = {},
  deadlineMs = 120_000,
) {
  const file = join(work, "child.test.ts");
  await writeFile(file, source);
  const run = Bun.spawn([process.execPath, "test", ...args, file], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, FIXTURE_REPORTS: work, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  let overran = false;
  const deadline = setTimeout(() => {
    overran = true;
    run.kill("SIGKILL");
  }, deadlineMs);
  const [code, stdout, stderr] = await Promise.all([
    run.exited,
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  clearTimeout(deadline);
  return { code, output: stdout + stderr, overran };
}
/** Stops what a run left behind while it is still the process reported, and removes each root once it has. */
async function stopLeftBehind(reports: readonly Report[]) {
  for (const report of reports) {
    for (const owned of report.processes) {
      if (
        owned.identity === undefined ||
        processIdentity(owned.pid) !== owned.identity
      )
        continue;
      process.kill(owned.pid, "SIGTERM");
      const known = { pid: owned.pid, identity: owned.identity };
      if (!(await processExited(known))) process.kill(owned.pid, "SIGKILL");
      if (!(await processExited(known)))
        throw new Error(
          `process ${owned.pid} is still running; its root is kept at ${report.base}`,
        );
    }
    await rm(report.base, { recursive: true, force: true });
  }
}
const fixturePath = JSON.stringify(
  join(import.meta.dir, "support/rig-fixture.ts"),
);
/** A test file whose tests run concurrently, as the e2e files do, and never reach their fixture's cleanup: one times out
 * with a Service running, two throw first, one of them having left a record its cleanup cannot read, and one times out
 * and runs on until the sweep is stopping its fixture, then asks for another. Each reports what its fixtures made to
 * `$FIXTURE_REPORTS`. */
const abandoning = `import { test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { processIdentity, recordedDaemon, rigFixture } from ${fixturePath};

async function started(name: string, service: boolean) {
  const f = await rigFixture();
  const report = async (pids: number[]) =>
    writeFile(
      join(process.env.FIXTURE_REPORTS!, name + ".json"),
      JSON.stringify({
        base: f.base,
        processes: pids.map((pid) => ({ pid, identity: processIdentity(pid) })),
      }),
    );
  if ((await f.rigd(["install"])).code !== 0) throw new Error("rigd install failed");
  const daemon = (await recordedDaemon(f.root))!;
  await report([daemon.pid]);
  if (!service) return f;
  await writeFile(
    join(f.repo, "rig.yaml"),
    "name: abandoned\\nservices:\\n  api:\\n    command: exec /bin/sleep 600\\ntargets:\\n  working: true\\n",
  );
  if ((await f.rig(["init", "--create-git"])).code !== 0) throw new Error("rig init failed");
  if ((await f.rig(["up"])).code !== 0) throw new Error("rig up failed");
  const status = JSON.parse((await f.rig(["status", "--json"])).stdout);
  // The Service is its capture wrapper and the application the wrapper runs.
  const wrapper: number = status.targets[0].components[0].pid;
  const application = Number(Bun.spawnSync(["pgrep", "-P", String(wrapper)]).stdout.toString().trim());
  await report([daemon.pid, wrapper, application]);
  return f;
}

test.concurrent("times out", async () => {
  await started("timed-out", true);
  await new Promise(() => {});
}, 30_000);

test.concurrent("throws before its cleanup", async () => {
  await started("threw", false);
  throw new Error("before its cleanup");
});

test.concurrent("throws with a record its cleanup cannot read", async () => {
  const f = await started("unreadable", false);
  // Broken once rigd's first pass has written the record, which would otherwise replace it whole.
  const state = join(f.root, "runtime", "state.json");
  for (let i = 0; i < 750; i++) {
    const text = await readFile(state, "utf8").catch(() => "");
    try {
      if (JSON.parse(text).host?.seenAt) break;
    } catch {}
    await Bun.sleep(20);
  }
  await writeFile(state, "{broken");
  throw new Error("before its cleanup");
});

test.concurrent("resumes during the sweep and asks for another fixture", async () => {
  const reports = process.env.FIXTURE_REPORTS!;
  // Its rigd's uninstall says so when the sweep has begun stopping this fixture, then takes a while.
  const f = await rigFixture({ commands: { rig: ["/usr/bin/true"], rigd: [join(reports, "slow-rigd")] } });
  await writeFile(join(reports, "resumed.json"), JSON.stringify({ base: f.base, processes: [] }));
  for (let i = 0; i < 3000 && !(await Bun.file(join(reports, "sweeping")).exists()); i++)
    await Bun.sleep(20);
  const late = await rigFixture({ commands: { rig: ["/usr/bin/true"], rigd: ["/usr/bin/true"] } }).then(
    (fixture) => ({ base: fixture.base }),
    (error: Error) => ({ refused: error.message }),
  );
  await writeFile(join(reports, "late.json"), JSON.stringify(late));
  // And its own fixture, which the sweep is cleaning up, runs nothing more.
  const command = await f.rig(["status"]).then(
    () => ({ ran: true }),
    (error: Error) => ({ refused: error.message }),
  );
  await writeFile(join(reports, "late-command.json"), JSON.stringify(command));
}, 1_000);
`;

/** A test file whose one test passes, and leaves a fixture whose cleanup will fail, reported to `$FIXTURE_REPORTS`. */
const passing = `import { test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rigFixture } from ${fixturePath};

test("passes, leaving a fixture whose cleanup fails", async () => {
  const f = await rigFixture({ commands: { rig: ["/usr/bin/true"], rigd: ["/usr/bin/false"] } });
  await writeFile(join(process.env.FIXTURE_REPORTS!, "passed.json"), JSON.stringify({ base: f.base, processes: [] }));
});
`;

test("a fixture whose test timed out or threw before its cleanup has its processes stopped once the run's tests are done, and its root removed only when that is confirmed", async () => {
  const work = await mkdtemp(join(tmpdir(), "rig-fixture-sweep-"));
  const reports: Report[] = [];
  try {
    await writeFile(
      join(work, "slow-rigd"),
      `#!/bin/sh\n[ "$1" = uninstall ] || exit 0\ntouch '${join(work, "sweeping")}'\nsleep 2\n`,
      { mode: 0o755 },
    );
    const { output } = await testRun(work, abandoning);
    for (const name of ["timed-out", "threw", "unreadable", "resumed"])
      reports.push(
        JSON.parse(await readFile(join(work, `${name}.json`), "utf8")),
      );
    const late = JSON.parse(await readFile(join(work, "late.json"), "utf8")) as
      { base: string } | { refused: string };
    if ("base" in late) reports.push({ base: late.base, processes: [] });
    const [timedOut, threw, unreadable, resumed] = reports;
    // Every test ended without reaching a cleanup, the first by its timeout once its Service ran.
    expect(output).toContain("(fail) times out");
    expect(output).toContain("this test timed out after 30000ms");
    expect(output).toContain("(fail) throws before its cleanup");
    expect(output).toContain(
      "(fail) throws with a record its cleanup cannot read",
    );
    expect(timedOut!.processes).toHaveLength(3);
    // Gone by the time the run ends, not just signalled.
    for (const report of reports)
      for (const { pid, identity } of report.processes) {
        expect(identity).toBeDefined();
        expect(processIdentity(pid)).not.toBe(identity);
      }
    // A root goes only once its cleanup is confirmed; the one that cannot be fails the run, naming it.
    expect(await exists(timedOut!.base)).toBe(false);
    expect(await exists(threw!.base)).toBe(false);
    expect(await exists(unreadable!.base)).toBe(true);
    expect(output).toContain(
      "A test left fixtures unfinished, and their cleanup failed",
    );
    expect(output).toContain(`its root is kept at ${unreadable!.base}:`);
    expect(output).not.toContain(`its root is kept at ${timedOut!.base}:`);
    expect(output).not.toContain(`its root is kept at ${threw!.base}:`);
    // A body Bun abandoned that asks for a fixture while the sweep runs is refused, and the run says so: nothing would
    // clean that fixture up.
    expect(await exists(resumed!.base)).toBe(false);
    expect(late).toEqual({
      refused: expect.stringContaining("was refused"),
    });
    expect(output).toContain(
      "A fixture was asked for once the tests' fixtures were swept, by a test Bun had abandoned, and was refused.",
    );
    const command = `\`/usr/bin/true status\``;
    expect(
      JSON.parse(await readFile(join(work, "late-command.json"), "utf8")),
    ).toEqual({
      refused: `The fixture at ${resumed!.base} was being cleaned up, so ${command} was refused.`,
    });
    expect(output).toContain(`so ${command} was refused.`);
  } finally {
    await stopLeftBehind(reports);
    await rm(work, { recursive: true, force: true });
  }
}, 150_000);

test("a run whose tests pass still fails when a fixture they left cannot be confirmed stopped, naming the root it kept", async () => {
  const work = await mkdtemp(join(tmpdir(), "rig-fixture-sweep-"));
  const reports: Report[] = [];
  try {
    const { code, output } = await testRun(work, passing);
    reports.push(JSON.parse(await readFile(join(work, "passed.json"), "utf8")));
    // Its one test passed; the run's one failure is the fixture's.
    expect(output).not.toContain("(fail) passes");
    expect(output).toContain(" 1 pass\n 1 fail\n");
    expect(output).toContain(
      "A test left fixtures unfinished, and their cleanup failed",
    );
    expect(output).toContain(`its root is kept at ${reports[0]!.base}:`);
    expect(await exists(reports[0]!.base)).toBe(true);
    expect(code).not.toBe(0);
  } finally {
    await stopLeftBehind(reports);
    await rm(work, { recursive: true, force: true });
  }
}, 60_000);

/** A test file whose one test makes a fixture and cleans it up. */
const repeated = `import { test } from "bun:test";
import { rigFixture } from ${fixturePath};

test("makes a fixture and cleans it up", async () => {
  const f = await rigFixture({ commands: { rig: ["/usr/bin/true"], rigd: ["/usr/bin/true"] } });
  await f.cleanup();
});
`;

/** A preload that loads the sweep and then adds a later teardown of its own, which marks when it starts and takes a
 * while, as another global hook might. */
const laterTeardown = (marker: string) => `import { afterAll } from "bun:test";
await import(${JSON.stringify(join(import.meta.dir, "support/fixture-sweep.ts"))});
afterAll(async () => {
  await Bun.write(${JSON.stringify(marker)}, "");
  await Bun.sleep(1_000);
});
`;
/** A test file whose two tests time out, run on until a later teardown has started, once the sweep has stopped their
 * fixtures, and then ask for more: one a new fixture, the other a command of its own fixture. Neither may start what
 * nothing would stop. Each reports what it got to `$FIXTURE_REPORTS`, then lets the refusal reach Bun. */
const resumingLater = `import { test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rigFixture } from ${fixturePath};

const reports = process.env.FIXTURE_REPORTS!;
// Its install leaves a mark in the root, as a real rigd would leave itself running there.
const commands = { rig: ["/usr/bin/true"], rigd: [join(reports, "marking-rigd")] };
async function afterLaterTeardown(name: string, ask: () => Promise<unknown>) {
  for (let i = 0; i < 3000 && !(await Bun.file(join(reports, "later-teardown")).exists()); i++)
    await Bun.sleep(20);
  try {
    await ask();
    await writeFile(join(reports, name + ".json"), JSON.stringify({ accepted: true }));
  } catch (error) {
    await writeFile(join(reports, name + ".json"), JSON.stringify({ refused: String(error) }));
    throw error;
  }
}

test.concurrent("asks for a fixture once the sweep is done", async () => {
  await rigFixture({ commands });
  await afterLaterTeardown("new-fixture", () => rigFixture({ commands }));
}, 20);

test.concurrent("asks its swept fixture to install rigd", async () => {
  const f = await rigFixture({ commands });
  await afterLaterTeardown("command", () => f.rigd(["install"]));
}, 20);
`;

test("a body Bun abandoned that resumes after the sweep, while a later teardown runs, can make no fixture and run no command, and the run says so", async () => {
  const work = await mkdtemp(join(tmpdir(), "rig-fixture-sweep-"));
  try {
    // Its own temporary directory, so every root the run took is seen.
    const roots = join(work, "roots");
    await mkdir(roots);
    await writeFile(
      join(work, "marking-rigd"),
      `#!/bin/sh\n[ "$1" = install ] || exit 0\nmkdir -p "$RIG_ROOT" && touch "$RIG_ROOT/installed"\n`,
      { mode: 0o755 },
    );
    const preload = join(work, "later-teardown.ts");
    await writeFile(preload, laterTeardown(join(work, "later-teardown")));
    const { code, output } = await testRun(
      work,
      resumingLater,
      ["--preload", preload],
      { TMPDIR: roots },
    );
    const asked = async (name: string) =>
      JSON.parse(await readFile(join(work, `${name}.json`), "utf8"));
    expect(await asked("new-fixture")).toEqual({
      refused: expect.stringContaining(
        "A fixture was asked for once the tests' fixtures were swept",
      ),
    });
    expect(await asked("command")).toEqual({
      refused: expect.stringContaining("`" + join(work, "marking-rigd")),
    });
    // Nothing was made or started, and Bun reports each refusal, failing the run.
    expect(await readdir(roots)).toEqual([]);
    expect(output).toContain(
      "error: A fixture was asked for once the tests' fixtures were swept",
    );
    expect(output).toContain("was being cleaned up, so `");
    expect(output).toContain("# Unhandled error between tests");
    expect(code).not.toBe(0);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}, 60_000);

/** A test file whose one test runs a command that leaves a process in the background holding its output open, and times
 * out waiting for it. It reports its fixture's root and that process to `$FIXTURE_REPORTS`. */
const backgrounded = `import { test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { processIdentity, rigFixture } from ${fixturePath};

test("waits on a command whose background process holds its output", async () => {
  const reports = process.env.FIXTURE_REPORTS!;
  const f = await rigFixture({ commands: { rig: ["/usr/bin/true"], rigd: ["/usr/bin/true"] } });
  const pidFile = join(reports, "background.pid");
  // The shell, which leads the group, waits on its background sleep, so the group is provably the fixture's.
  const ran = f.run(["/bin/sh", "-c", "/bin/sleep 600 & echo $! > '" + pidFile + "'; wait"]);
  for (let i = 0; i < 500 && !(await Bun.file(pidFile).exists()); i++) await Bun.sleep(10);
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  await writeFile(
    join(reports, "backgrounded.json"),
    JSON.stringify({ base: f.base, processes: [{ pid, identity: processIdentity(pid) }] }),
  );
  await ran;
}, 1_000);
`;

test("a timed-out test's command that a background process holds open is waited on only a while, signals nothing once Bun has killed its leader, and its root is kept and named", async () => {
  const work = await mkdtemp(join(tmpdir(), "rig-fixture-sweep-"));
  const reports: Report[] = [];
  try {
    const started = Date.now();
    const { output, overran } = await testRun(
      work,
      backgrounded,
      [],
      {},
      60_000,
    );
    reports.push(
      JSON.parse(await readFile(join(work, "backgrounded.json"), "utf8")),
    );
    const [backgrounded_] = reports;
    expect(overran).toBe(false);
    expect(Date.now() - started).toBeLessThan(45_000);
    expect(output).toContain("this test timed out after 1000ms");
    // Bun kills the test's own child, the group's leader, at the timeout: nothing then proves the group is the fixture's.
    expect(output).toContain(
      "had not answered 5 s after cleanup began, and its process group's leader is no longer the process it started, so nothing was signalled",
    );
    expect(output).toContain(`its root is kept at ${backgrounded_!.base}:`);
    // Sent nothing, so it runs on, for the finally below to stop.
    const [sleeper] = backgrounded_!.processes;
    expect(sleeper!.identity).toBeDefined();
    expect(processIdentity(sleeper!.pid)).toBe(sleeper!.identity);
  } finally {
    await stopLeftBehind(reports);
    await rm(work, { recursive: true, force: true });
  }
}, 90_000);

/** A fixture whose rigd is a script that marks `uninstalled` in `work` when asked to uninstall, so a test sees that
 * cleanup went on to the daemon. `inspect` is the `ps` cleanup reads processes with. */
async function markingFixture(work: string, inspect?: Inspect) {
  const rigd = join(work, "rigd");
  await writeFile(
    rigd,
    `#!/bin/sh\n[ "$1" = uninstall ] && touch '${join(work, "uninstalled")}'\nexit 0\n`,
    { mode: 0o755 },
  );
  return rigFixture({
    commands: { rig: ["/usr/bin/true"], rigd: [rigd] },
    ...(inspect ? { inspect } : {}),
  });
}
/** Runs `script` in a shell through the fixture's `run`, which answers only once nothing holds its output open, and waits
 * for the script to write to `$PIDS` the pids it names. Answers those processes, by pid and birth, and the run. */
async function holdingOutput(
  f: Awaited<ReturnType<typeof rigFixture>>,
  work: string,
  script: string,
) {
  const pids = join(work, "pids");
  const ran = f.run(["/bin/sh", "-c", `PIDS='${pids}'; ${script}`]);
  let text = "";
  for (let i = 0; i < 500 && !text.endsWith("\n"); i++) {
    text = await readFile(pids, "utf8").catch(() => "");
    await Bun.sleep(10);
  }
  const processes = text
    .trim()
    .split(" ")
    .map(Number)
    .map((pid) => ({ pid, identity: processIdentity(pid)! }));
  return { ran, processes };
}
/** Stops each of `processes` while it is still that process, then waits for `ran`, which answers once they have gone. */
async function stopHeld(
  processes: readonly { pid: number; identity: string }[],
  ran: Promise<unknown> | undefined,
) {
  for (const owned of processes) {
    if (processIdentity(owned.pid) !== owned.identity) continue;
    process.kill(owned.pid, "SIGKILL");
    if (!(await processExited(owned)))
      throw new Error(`process ${owned.pid} is still running`);
  }
  await ran;
}

test("a command whose leader is still the process it started, but which has not answered, has its whole group killed, and the root is kept and named", async () => {
  const work = await mkdtemp(join(tmpdir(), "rig-fixture-sweep-"));
  let held: Awaited<ReturnType<typeof holdingOutput>> | undefined;
  let base: string | undefined;
  try {
    const f = await markingFixture(work);
    base = f.base;
    held = await holdingOutput(
      f,
      work,
      "/bin/sleep 600 & echo $$ $! > $PIDS; wait",
    );
    const failure = await f.cleanup().then(
      () => undefined,
      (error: Error) => error.message,
    );
    expect(failure).toContain(`its root is kept at ${f.base}:`);
    expect(failure).toContain(
      "had not answered 5 s after cleanup began, so their process groups were killed",
    );
    expect(await exists(join(work, "uninstalled"))).toBe(true);
    // The shell and its sleep, both gone by the time cleanup answered.
    for (const { pid, identity } of held.processes)
      expect(processIdentity(pid)).not.toBe(identity);
  } finally {
    await stopHeld(held?.processes ?? [], held?.ran);
    if (base) await rm(base, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
}, 60_000);

test("a command whose leader has gone while what it left holds its output open has nothing signalled, and its cleanup goes on and names the root it keeps", async () => {
  const work = await mkdtemp(join(tmpdir(), "rig-fixture-sweep-"));
  let held: Awaited<ReturnType<typeof holdingOutput>> | undefined;
  let base: string | undefined;
  try {
    const f = await markingFixture(work);
    base = f.base;
    // The shell exits at once; its sleep holds the output open, and nothing now proves its group is the fixture's.
    held = await holdingOutput(f, work, "/bin/sleep 600 & echo $! > $PIDS");
    const failure = await f.cleanup().then(
      () => undefined,
      (error: Error) => error.message,
    );
    expect(failure).toContain(`its root is kept at ${f.base}:`);
    expect(failure).toContain(
      "process group's leader is no longer the process it started, so nothing was signalled",
    );
    expect(await exists(join(work, "uninstalled"))).toBe(true);
    // Sent nothing: the same process still runs.
    const [sleeper] = held.processes;
    expect(processIdentity(sleeper!.pid)).toBe(sleeper!.identity);
  } finally {
    await stopHeld(held?.processes ?? [], held?.ran);
    if (base) await rm(base, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
}, 60_000);

test("a command whose leader's birth differs when cleanup looks, as a reused pid's would, has nothing signalled, and the root is kept and named", async () => {
  const work = await mkdtemp(join(tmpdir(), "rig-fixture-sweep-"));
  let held: Awaited<ReturnType<typeof holdingOutput>> | undefined;
  let base: string | undefined;
  try {
    // Once the leader is known, ps says another process now has its pid.
    let leader = 0;
    const inspect: Inspect = (args) =>
      leader !== 0 && args.join(" ") === `-p ${leader} -o lstart=`
        ? { exitCode: 0, stdout: "Thu Jan  1 00:00:00 1970\n" }
        : platformInspect(args);
    const f = await markingFixture(work, inspect);
    base = f.base;
    held = await holdingOutput(
      f,
      work,
      "/bin/sleep 600 & echo $$ $! > $PIDS; wait",
    );
    leader = held.processes[0]!.pid;
    const failure = await f.cleanup().then(
      () => undefined,
      (error: Error) => error.message,
    );
    expect(failure).toContain(`its root is kept at ${f.base}:`);
    expect(failure).toContain("so nothing was signalled");
    expect(await exists(join(work, "uninstalled"))).toBe(true);
    // The shell and its sleep both still run as they were.
    for (const { pid, identity } of held.processes)
      expect(processIdentity(pid)).toBe(identity);
  } finally {
    await stopHeld(held?.processes ?? [], held?.ran);
    if (base) await rm(base, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
}, 60_000);

test("a group signal that fails is reported, and cleanup still stops the daemon and names the root it keeps", async () => {
  const work = await mkdtemp(join(tmpdir(), "rig-fixture-sweep-"));
  let held: Awaited<ReturnType<typeof holdingOutput>> | undefined;
  let base: string | undefined;
  const kill = process.kill;
  try {
    const f = await markingFixture(work);
    base = f.base;
    held = await holdingOutput(
      f,
      work,
      "/bin/sleep 600 & echo $$ $! > $PIDS; wait",
    );
    // Only this command's group is refused; every other signal goes through.
    const group = -held.processes[0]!.pid;
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === group)
        throw Object.assign(new Error("injected EPERM"), { code: "EPERM" });
      return kill.call(process, pid, signal);
    }) as typeof process.kill;
    const failure = await f.cleanup().then(
      () => undefined,
      (error: Error) => error.message,
    );
    process.kill = kill;
    expect(failure).toContain(`its root is kept at ${f.base}:`);
    expect(failure).toContain(
      "its process group could not be killed: Error: injected EPERM",
    );
    expect(await exists(join(work, "uninstalled"))).toBe(true);
  } finally {
    process.kill = kill;
    await stopHeld(held?.processes ?? [], held?.ran);
    if (base) await rm(base, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
}, 60_000);

/** A preload that loads the sweep, then, in a later teardown, asks for a fixture and catches its refusal, as a caller may. */
const catchingTeardown = `import { afterAll } from "bun:test";
await import(${JSON.stringify(join(import.meta.dir, "support/fixture-sweep.ts"))});
const { rigFixture } = await import(${fixturePath});
afterAll(async () => {
  await rigFixture({ commands: { rig: ["/usr/bin/true"], rigd: ["/usr/bin/true"] } }).catch(() => {});
});
`;
const quiet = `import { test } from "bun:test";

test("passes", () => {});
`;

test("a refusal its caller catches, after the last sweep, still fails the run", async () => {
  const work = await mkdtemp(join(tmpdir(), "rig-fixture-sweep-"));
  try {
    const roots = join(work, "roots");
    await mkdir(roots);
    const preload = join(work, "catching-teardown.ts");
    await writeFile(preload, catchingTeardown);
    for (const parallel of [[], ["--parallel=2"]]) {
      const { code, output } = await testRun(
        work,
        quiet,
        [...parallel, "--preload", preload],
        { TMPDIR: roots },
      );
      expect(output).toContain(
        "error: A fixture was asked for once the tests' fixtures were swept",
      );
      expect(code).not.toBe(0);
    }
    expect(await readdir(roots)).toEqual([]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}, 60_000);

test("a repeated run makes its fixtures again once its next repetition starts", async () => {
  const work = await mkdtemp(join(tmpdir(), "rig-fixture-sweep-"));
  try {
    const { code, output } = await testRun(work, repeated, ["--rerun-each=2"]);
    expect(output).not.toContain("was refused");
    expect(output).toContain(" 2 pass\n 0 fail\n");
    expect(code).toBe(0);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}, 60_000);

/** A test file whose fixtures cannot be made: the Project directory in each root fails with EIO, and in the second test
 * the root cannot be removed either. The second reports the fixture's failure to `$FIXTURE_REPORTS`. */
const unmade = `import { expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";

const real = { ...fs };
let failing: "mkdir" | "mkdir and rm" | undefined;
const eio = () => Object.assign(new Error("injected i/o error"), { code: "EIO" });
mock.module("node:fs/promises", () => ({
  ...real,
  async mkdir(path: string, ...rest: unknown[]) {
    if (failing && path.endsWith("/project")) throw eio();
    return (real.mkdir as (...args: unknown[]) => unknown)(path, ...rest);
  },
  async rm(path: string, ...rest: unknown[]) {
    if (failing === "mkdir and rm" && /rig-battle-[^/]+$/.test(path)) throw eio();
    return (real.rm as (...args: unknown[]) => unknown)(path, ...rest);
  },
}));
const { rigFixture } = await import(${fixturePath});

test("a root whose Project directory cannot be made is removed, and the fixture fails as it did", async () => {
  failing = "mkdir";
  await expect(rigFixture()).rejects.toThrow("injected i/o error");
});

test("a root that cannot then be removed is named in the failure", async () => {
  failing = "mkdir and rm";
  const failure = await rigFixture().then(
    () => "made",
    (error: Error) => error.message,
  );
  await real.writeFile(join(process.env.FIXTURE_REPORTS!, "unmade.txt"), failure);
  expect(failure).toContain("injected i/o error");
  expect(failure).toContain("could not be removed");
});
`;

test("a fixture that cannot be made removes the root it took, or names it when that cannot be removed", async () => {
  const work = await mkdtemp(join(tmpdir(), "rig-fixture-sweep-"));
  try {
    // Its own temporary directory, so every root the run took is seen.
    const roots = join(work, "roots");
    await mkdir(roots);
    const { code, output } = await testRun(work, unmade, [], {
      TMPDIR: roots,
    });
    expect(output).toContain(" 2 pass\n 0 fail\n");
    expect(code).toBe(0);
    // The one root left is the one the failure names.
    const left = await readdir(roots);
    expect(left).toHaveLength(1);
    expect(await readFile(join(work, "unmade.txt"), "utf8")).toContain(
      `its root ${join(roots, left[0]!)} could not be removed`,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}, 60_000);
