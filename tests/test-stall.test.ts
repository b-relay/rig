import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const children: number[] = [];
afterEach(async () => {
  for (const pid of children.splice(0))
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* Already gone. */
    }
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
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
test("blocks its thread", () => {
  const sleep = Bun.spawn(["/bin/sleep", "30"]);
  writeFileSync(import.meta.dir + "/sleep.pid", String(sleep.pid));
  ${BLOCK}
}, 500);
`,
      "passes.test.ts": PASSES,
    },
    2_000,
    ["--parallel=2"],
  );
  const sleep = Number(await readFile(join(run.work, "sleep.pid"), "utf8"));
  children.push(sleep);
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
