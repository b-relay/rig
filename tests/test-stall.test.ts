import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
/** A test whose thread is blocked for a minute, where no Bun timeout can end it. */
const BLOCKED = `import { test } from "bun:test";
test("blocks its thread", () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
}, 500);
`;
const PASSES = `import { test } from "bun:test";
test("passes", () => {});
`;
/** Runs `files` (name to source) with `bun test` from the repository, so the run is configured as every test run here is,
 * with a stall limit of `stallMs`. A run still going after a deadline well inside the blocked test's minute is killed and
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

test("a test file whose thread is blocked past the stall limit is named, shown, and killed, and the files beside it still run", async () => {
  const run = await testRun(
    { "blocked.test.ts": BLOCKED, "passes.test.ts": PASSES },
    2_000,
    ["--parallel=2"],
  );
  expect(run.overran).toBe(false);
  expect(run.code).not.toBe(0);
  expect(run.output).toContain(
    `Test stall: ${join(run.work, "blocked.test.ts")} has had no test begin or end for 2 s (1 began, 0 ended;`,
  );
  expect(run.output).toContain("--- child processes of");
  expect(run.output).toContain("--- threads of");
  expect(run.output).toContain("blocked.test.ts (worker crashed: SIGKILL)");
  expect(run.output).toMatch(/^ 1 pass\n 1 fail$/m);
}, 60_000);

test("a run of one process is killed at the stall limit too", async () => {
  const run = await testRun({ "blocked.test.ts": BLOCKED }, 2_000);
  expect(run.overran).toBe(false);
  expect(run.code).not.toBe(0);
  expect(run.output).toContain(
    `Test stall: ${join(run.work, "blocked.test.ts")} has had no test begin or end`,
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
