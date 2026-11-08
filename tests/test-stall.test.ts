import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asksFor, fakeProcess, type Fault } from "./support/process-double";
import {
  awaitExit,
  platformInspect,
  signalOwned,
  type Inspect,
} from "./support/rig-fixture";

const roots: string[] = [];
/** What the runs' tests started, by pid and birth, stopped only while each is still that process. */
const children: { pid: number; identity: string }[] = [];
/** Kills each of `started` while it is still that process, and removes `kept` only once each is seen gone. Otherwise it
 * keeps them and fails naming them, with why for one whose read or signal threw. `inspect` is the `ps` it reads processes
 * with. */
async function stopStarted(
  started: readonly { pid: number; identity: string }[],
  kept: readonly string[],
  inspect: Inspect = platformInspect,
) {
  const unconfirmed: string[] = [];
  for (const child of started)
    try {
      if (signalOwned(child, "SIGKILL", inspect) === "gone") continue;
      if ((await awaitExit(child, inspect)) !== "gone")
        unconfirmed.push(String(child.pid));
    } catch (error) {
      unconfirmed.push(
        `${child.pid} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  if (unconfirmed.length > 0)
    throw new Error(
      `processes ${unconfirmed.join(", ")} could not be seen to exit, so the roots ${kept.join(", ")} are kept`,
    );
  for (const root of kept) await rm(root, { recursive: true, force: true });
}
afterEach(() => stopStarted(children.splice(0), roots.splice(0)));

/** Ways a process the tests started cannot be seen to exit: what it ends on, how its reads and signals go wrong, what the
 * teardown names it as, and the signals it is sent. */
const unseenExits: {
  what: string;
  endsOn: NodeJS.Signals[];
  fault?: Fault;
  read?: "throws";
  signal?: "throws";
  named: (pid: number) => string;
  signals: string[];
}[] = [
  {
    what: "whose reads all fail",
    endsOn: ["SIGKILL"],
    fault: "failed",
    named: String,
    signals: [],
  },
  {
    what: "that outlives its SIGKILL",
    endsOn: [],
    named: String,
    signals: ["SIGKILL"],
  },
  {
    what: "whose reads throw, as a ps that does not answer does",
    endsOn: ["SIGKILL"],
    read: "throws",
    named: (pid) => `${pid} (ps probe timed out)`,
    signals: [],
  },
  {
    what: "whose SIGKILL throws",
    endsOn: ["SIGKILL"],
    signal: "throws",
    named: (pid) => `${pid} (injected EPERM)`,
    signals: [],
  },
];
for (const each of unseenExits)
  test(`the teardown keeps the roots, and fails naming them, when a process the tests started ${each.what}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-test-stall-teardown-"));
    // Sequential, as this file is: the fake replaces Date.now and process.kill.
    const fake = fakeProcess({
      command: "/bin/sleep 600",
      endsOn: each.endsOn,
      fault: () => each.fault,
    });
    const kill = process.kill;
    if (each.signal)
      process.kill = ((target: number, signal?: NodeJS.Signals | number) => {
        if (target === fake.pid)
          throw Object.assign(new Error("injected EPERM"), { code: "EPERM" });
        return kill.call(process, target, signal);
      }) as typeof process.kill;
    const inspect: Inspect = (args) => {
      if (each.read && asksFor(args, fake.pid))
        throw new Error("ps probe timed out");
      return fake.inspect(args);
    };
    try {
      const failure = await stopStarted(
        [{ pid: fake.pid, identity: fake.identity }],
        [root],
        inspect,
      ).then(
        () => undefined,
        (error: Error) => error.message,
      );
      expect(failure).toBe(
        `processes ${each.named(fake.pid)} could not be seen to exit, so the roots ${root} are kept`,
      );
      expect(fake.signals).toEqual(each.signals);
      expect(
        await stat(root).then(
          () => true,
          () => false,
        ),
      ).toBe(true);
    } finally {
      process.kill = kill;
      fake.restore();
      await rm(root, { recursive: true, force: true });
    }
  });
/** Blocks the thread it runs on for a minute, where no Bun timeout can end it. */
const BLOCK =
  "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);";
const PASSES = `import { test } from "bun:test";
test("passes", () => {});
`;
/** Runs `files` (name to source) with `bun test` from the repository, so the run is configured as every test run here is,
 * with a stall limit of `stallMs`. A run still going after a deadline well inside a blocked thread's minute is killed and
 * answers `overran`. */
async function testRun(
  files: Record<string, string>,
  stallMs: number,
  args: readonly string[] = [],
) {
  // Bun names a test file by its real path.
  const work = await realpath(await mkdtemp(join(tmpdir(), "rig-test-stall-")));
  roots.push(work);
  for (const [name, source] of Object.entries(files))
    await writeFile(join(work, name), source);
  const started = Date.now();
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      ...args,
      ...Object.keys(files).map((name) => join(work, name)),
    ],
    {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, RIG_TEST_STALL_MS: String(stallMs) },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let overran = false;
  const deadline = setTimeout(() => {
    overran = true;
    run.kill("SIGKILL");
  }, 40_000);
  const [code, stdout, stderr] = await Promise.all([
    run.exited,
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  clearTimeout(deadline);
  return {
    code,
    output: stdout + stderr,
    overran,
    seconds: (Date.now() - started) / 1000,
    work,
  };
}
/** A stall the run was ended for, `where` it says it was. */
function expectStall(run: Awaited<ReturnType<typeof testRun>>, where: string) {
  expect(run.overran).toBe(false);
  expect(run.code).not.toBe(0);
  expect(run.output).toMatch(
    /Test stall: no test has begun or ended for 2 s, since \d{4}-\d\d-\d\dT[\d:.]+Z, /,
  );
  expect(run.output).toContain(`, ${where}. Bun's own timeouts did not end it`);
}

test("a test whose thread is blocked past the stall limit is named with its child processes and its threads' stacks, and killed, and the file beside it still runs", async () => {
  const run = await testRun(
    {
      "blocked.test.ts": `import { test } from "bun:test";
import { writeFileSync } from "node:fs";
import { processIdentity } from ${JSON.stringify(join(import.meta.dir, "support", "rig-fixture.ts"))};
test("blocks its thread", () => {
  const sleep = Bun.spawn(["/bin/sleep", "30"]);
  writeFileSync(import.meta.dir + "/sleep.json", JSON.stringify({ pid: sleep.pid, identity: processIdentity(sleep.pid) }));
  ${BLOCK}
}, 500);
`,
      "passes.test.ts": PASSES,
    },
    2_000,
    ["--parallel=2"],
  );
  // Its birth, read while it surely ran, so teardown never signals a later process with its pid.
  const child = JSON.parse(
    await readFile(join(run.work, "sleep.json"), "utf8"),
  ) as { pid: number; identity: string };
  children.push(child);
  expect(child.identity).toBeString();
  const sleep = child.pid;
  expectStall(
    run,
    `in a test of ${join(run.work, "blocked.test.ts")} (1 began, 0 ended)`,
  );
  expect(run.output).toMatch(
    new RegExp(`--- child processes of \\d+\\n *${sleep} .*/bin/sleep 30\\n`),
  );
  expect(run.output).toMatch(
    /--- threads of \d+\n[^]*Call graph:\n[^]*com\.apple\.main-thread/,
  );
  expect(run.output).toContain("blocked.test.ts (worker crashed: SIGKILL)");
  expect(run.output).toMatch(/^ 1 pass\n 1 fail$/m);
}, 60_000);

test("a file that blocks while it loads, before any hook or test, is caught by the limit from the run's start", async () => {
  const run = await testRun(
    { "loading.test.ts": `${BLOCK}\n${PASSES}` },
    2_000,
  );
  expectStall(
    run,
    "before any test file's hooks or tests ran: in loading the first file, or its first hooks",
  );
}, 60_000);

test("a file that blocks in its beforeAll under --parallel is named, with no test running", async () => {
  const run = await testRun(
    {
      "setup.test.ts": `import { beforeAll, test } from "bun:test";
beforeAll(() => {
  ${BLOCK}
}, 500);
test("never runs", () => {});
`,
    },
    2_000,
    ["--parallel=2"],
  );
  expectStall(
    run,
    `in ${join(run.work, "setup.test.ts")} with no test running (0 began and ended): in its hooks, or in loading the next file or its hooks`,
  );
}, 60_000);

test("in one process, a stall in a later file's beforeAll is said to follow the last file seen, never blamed on it", async () => {
  const run = await testRun(
    {
      "a-first.test.ts": PASSES,
      "b-second.test.ts": `import { beforeAll, test } from "bun:test";
beforeAll(() => {
  ${BLOCK}
}, 500);
test("never runs", () => {});
`,
    },
    2_000,
  );
  expectStall(
    run,
    `in ${join(run.work, "a-first.test.ts")} with no test running (1 began and ended): in its hooks, or in loading the next file or its hooks`,
  );
}, 60_000);

test("a file whose tests keep beginning and ending is never stopped, however long it runs in all", async () => {
  const run = await testRun(
    {
      "slow.test.ts": `import { test } from "bun:test";
for (const n of [1, 2, 3, 4])
  test(\`step \${n}\`, async () => {
    await Bun.sleep(700);
  });
`,
    },
    1_500,
  );
  expect(run.output).not.toContain("Test stall");
  expect(run.code).toBe(0);
  expect(run.seconds).toBeGreaterThan(2.8);
}, 60_000);
