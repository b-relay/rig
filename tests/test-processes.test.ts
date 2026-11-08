import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  endScope,
  runOwned,
  testScope,
  within,
} from "./support/test-processes";

// How a test that ends while it still runs processes is stopped (tests/support/test-processes.ts): what it waits on is
// killed, descendants included, and it can start nothing more.

const env = { PATH: "/usr/bin:/bin" };
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(holds: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!(await holds()) && Date.now() < deadline) await Bun.sleep(20);
  return await holds();
}
/** The number a file the test's shell wrote holds, once it is there, or undefined. */
const recordedNumber = async (path: string) =>
  Number(await readFile(path, "utf8").catch(() => "")) || undefined;

/** Whether any process, an unreaped one included, is left in the process group `group`. */
const groupLeft = (group: number) =>
  Bun.spawnSync(["/bin/ps", "-axo", "pgid="])
    .stdout.toString()
    .split("\n")
    .some((line) => Number(line) === group);
/** Each test's directory, the file its shell records the sleep it starts in, and every process Bun spawned for it, known
 * from the moment each started. Each leads its own group, which the sleep its shell starts is in from the start. */
const started: {
  dir: string;
  descendant: string;
  spawns: ReturnType<typeof spyOn<typeof Bun, "spawn">>;
}[] = [];
// Whatever the test came to, and without the helper it tests, what it started is killed: each group it spawned, whether
// or not its shell came to record the sleep, and then a sleep its shell recorded, while its pid is still that sleep.
afterEach(async () => {
  for (const { dir, descendant, spawns } of started.splice(0)) {
    const children = spawns.mock.results.flatMap((result) =>
      result.type === "return" ? [result.value] : [],
    );
    spawns.mockRestore();
    for (const child of children)
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Its group has gone.
      }
    // Reaped: each shell by the runner, and what it left in its group by launchd.
    const reaped = await until(() =>
      children.every((child) => !groupLeft(child.pid)),
    );
    // Its shell has ended, so the file is all it will ever be.
    const sleep = await recordedNumber(descendant);
    if (
      sleep !== undefined &&
      Bun.spawnSync(["/bin/ps", "-p", String(sleep), "-o", "command="])
        .stdout.toString()
        .trim() === "/bin/sleep 60"
    )
      try {
        process.kill(sleep, "SIGKILL");
      } catch {
        // It has just gone.
      }
    await rm(dir, { recursive: true, force: true });
    expect(reaped).toBe(true);
  }
  // Longer than the one wait above, so a slow reap fails here rather than leaving the hook to time out.
}, 15_000);

test("ending a test kills a descendant that holds a process's output open, and the test's body settles at once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rig-test-processes-"));
  const recorded = join(dir, "descendant.pid");
  started.push({ dir, descendant: recorded, spawns: spyOn(Bun, "spawn") });
  const scope = testScope();
  // The shell exits at once; the sleep it leaves behind keeps its output open, so the run waits on it.
  const body = within(scope, async () => {
    await runOwned(
      ["/bin/sh", "-c", `/bin/sleep 60 & echo $! > '${recorded}'`],
      { env },
    );
    await runOwned(["/usr/bin/true"], { env });
  });
  expect(
    await until(async () => (await recordedNumber(recorded)) !== undefined),
  ).toBe(true);
  const descendant = (await recordedNumber(recorded))!;
  expect(alive(descendant)).toBe(true);
  expect(await endScope(scope, body, 3_000)).toBe(true);
  // Refused the run it asked for after the end.
  expect(
    await body.then(
      () => "resolved",
      (error: Error) => error.message,
    ),
  ).toBe("The test has ended, so /usr/bin/true is not run.");
  expect(await until(() => !alive(descendant))).toBe(true);
});

test("a test that has not ended runs to the end of what it starts, and leaves nothing for its end to kill", async () => {
  const scope = testScope();
  const body = within(scope, () =>
    runOwned(["/bin/sh", "-c", "echo out; echo err >&2; exit 3"], { env }),
  );
  expect(await body).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });
  expect(scope.groups.size).toBe(0);
  expect(await endScope(scope, body, 1_000)).toBe(true);
});
