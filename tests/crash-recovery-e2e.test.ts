import { expect, test } from "bun:test";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rigFixture } from "./support/rig-fixture";

type Fixture = Awaited<ReturnType<typeof rigFixture>>;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  what: string,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read().catch(() => undefined);
    if (value !== undefined && accept(value)) return value;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const state = async (f: Fixture) =>
  JSON.parse(await readFile(join(f.root, "runtime", "state.json"), "utf8"));

/** A build that records its pid, then waits for a release that never comes while `hold` exists. */
async function heldBuild(f: Fixture) {
  const gate = join(f.base, "gate.sh");
  await writeFile(
    gate,
    `[ -f '${f.base}/hold' ] || exit 0
echo $$ > '${f.base}/build.pid'
while [ ! -f '${f.base}/release' ]; do sleep 0.1; done
`,
  );
  return {
    command: `sh '${gate}'`,
    hold: () => writeFile(join(f.base, "hold"), ""),
    /** The pid of the held build, once it runs. */
    started: async () =>
      Number(
        await until(
          () => readFile(join(f.base, "build.pid"), "utf8"),
          (text) => Number(text) > 0,
          "the build to start",
        ),
      ),
    release: () => writeFile(join(f.base, "release"), ""),
  };
}
/** Kills this fixture's own rigd, as a crash would, and waits until it is gone. */
async function crash(f: Fixture) {
  const { pid } = JSON.parse(
    await readFile(join(f.root, "daemon", "address.json"), "utf8"),
  );
  process.kill(pid, "SIGKILL");
  await until(
    async () => alive(pid),
    (running) => !running,
    "rigd to die",
  );
}

test("a build a crashed rigd left running is stopped once rigd is back, before down and uninstall report success", async () => {
  const f = await rigFixture();
  const build = await heldBuild(f);
  try {
    await f.git(["init", "-b", "main"]);
    await writeFile(
      join(f.repo, "rig.yaml"),
      `name: demo
targets: { working: true }
build: ${build.command}
services:
  sleeper:
    command: /bin/sleep 600
    stop_timeout: 1s
`,
    );
    await f.commit();
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    expect(await f.rig(["init"])).toMatchObject({ code: 0 });
    await build.hold();
    const up = f.rig(["up", "working"]);
    const pid = await build.started();
    await crash(f);
    expect((await up).code).not.toBe(0);
    expect(alive(pid)).toBe(true);

    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    expect(await f.rig(["down", "working", "--kill"])).toMatchObject({
      code: 0,
    });
    await until(
      async () => alive(pid),
      (running) => !running,
      "the build",
    );
    expect(await f.rigd(["uninstall"])).toMatchObject({ code: 0 });
  } finally {
    await build.release();
    await f.cleanup();
  }
}, 90_000);

test("recovering an interrupted deploy with rig down stops what it ran, says so, and gives back the abandoned checkout", async () => {
  const f = await rigFixture();
  const build = await heldBuild(f);
  try {
    await f.git(["init", "-b", "main"]);
    await writeFile(
      join(f.repo, "rig.yaml"),
      `name: demo
targets: { stable: true }
build: ${build.command}
services:
  sleeper:
    command: /bin/sleep 600
    stop_timeout: 1s
`,
    );
    await f.commit();
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    expect(await f.rig(["init"])).toMatchObject({ code: 0 });
    expect(await f.rig(["deploy", "stable"])).toMatchObject({ code: 0 });
    const previous = (await state(f)).targets[0].plan.workspacePath;

    // A forced deploy builds a fresh checkout while the previous Deployment keeps serving; rigd dies during that build.
    await build.hold();
    const deploying = f.rig(["deploy", "stable", "--force"]);
    const pid = await build.started();
    const candidate = (await state(f)).targets[0].plan.workspacePath;
    expect(candidate).not.toBe(previous);
    await crash(f);
    expect((await deploying).code).not.toBe(0);

    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    // The build and the previous Deployment's Service still ran; the recovery stopped them, and says so.
    const down = await f.rig(["down", "stable"]);
    expect(down).toMatchObject({ code: 0 });
    expect(down.stdout.split("\n")[0]).toBe("demo stable stopped");
    await until(
      async () => alive(pid),
      (running) => !running,
      "the build",
    );
    const recovered = (await state(f)).targets[0];
    expect(recovered.plan.workspacePath).toBe(previous);
    expect(recovered.recovery).toBeUndefined();
    // The abandoned checkout is gone, from disk and from the mirror, and nothing is left holding it.
    expect(
      await access(candidate).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    const mirror = (await readdir(join(f.root, "sources"))).find((name) =>
      name.endsWith(".git"),
    )!;
    const worktrees = await f.git([
      "--git-dir",
      join(f.root, "sources", mirror),
      "worktree",
      "list",
      "--porcelain",
    ]);
    expect(worktrees).not.toContain(candidate);
    expect((await state(f)).heldCheckouts ?? []).toEqual([]);
    // The previous Deployment is still usable.
    expect(await f.rig(["up", "stable"])).toMatchObject({ code: 0 });
    expect(await f.rig(["down", "stable"])).toMatchObject({ code: 0 });
    expect(await f.rigd(["uninstall"])).toMatchObject({ code: 0 });
  } finally {
    await build.release();
    await f.cleanup();
  }
}, 120_000);
