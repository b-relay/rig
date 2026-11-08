import { afterEach, expect, test } from "bun:test";
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

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
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

test("ending a test kills a descendant that holds a process's output open, and the test's body settles at once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rig-test-processes-"));
  dirs.push(dir);
  const recorded = join(dir, "descendant.pid");
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
    await until(async () =>
      Boolean(await readFile(recorded, "utf8").catch(() => "")),
    ),
  ).toBe(true);
  const descendant = Number(await readFile(recorded, "utf8"));
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
