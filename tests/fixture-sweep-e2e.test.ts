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
import { processExited, processIdentity } from "./support/rig-fixture";

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
 * `environment` adds to what the run inherits. */
async function testRun(
  work: string,
  source: string,
  args: readonly string[] = [],
  environment: Record<string, string> = {},
) {
  const file = join(work, "child.test.ts");
  await writeFile(file, source);
  const run = Bun.spawn([process.execPath, "test", ...args, file], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, FIXTURE_REPORTS: work, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    run.exited,
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  return { code, output: stdout + stderr };
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
import { writeFile } from "node:fs/promises";
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
  await writeFile(join(f.root, "runtime", "state.json"), "{broken");
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
      "A fixture was asked for while the tests' fixtures were being swept, by a test Bun had abandoned, and was refused.",
    );
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

test("a repeated run makes its fixtures again once the sweep after a repetition has answered", async () => {
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
