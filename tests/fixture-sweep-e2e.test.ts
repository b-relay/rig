import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processExited, processIdentity } from "./support/rig-fixture";

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
/** A test file whose tests run concurrently, as the e2e files do, and never reach their fixture's cleanup: one times out
 * with a Service running, two throw first, one of them having left a record its cleanup cannot read. Each reports its
 * fixture's root and processes to `$FIXTURE_REPORTS`. */
const abandoning = (fixture: string) => `import { test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { processIdentity, recordedDaemon, rigFixture } from ${JSON.stringify(fixture)};

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
`;

test("a fixture whose test timed out or threw before its cleanup has its processes stopped once the run's tests are done, and its root removed only when that is confirmed", async () => {
  const work = await mkdtemp(join(tmpdir(), "rig-fixture-sweep-"));
  const reports: {
    base: string;
    processes: { pid: number; identity?: string }[];
  }[] = [];
  try {
    const file = join(work, "abandoning.test.ts");
    await writeFile(
      file,
      abandoning(join(import.meta.dir, "support/rig-fixture.ts")),
    );
    // From the repository, so the run is configured as every test run here is.
    const run = Bun.spawn([process.execPath, "test", file], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, FIXTURE_REPORTS: work },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, stdout, stderr] = await Promise.all([
      run.exited,
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
    ]);
    const output = stdout + stderr;
    for (const name of ["timed-out", "threw", "unreadable"])
      reports.push(
        JSON.parse(await readFile(join(work, `${name}.json`), "utf8")),
      );
    const [timedOut, threw, unreadable] = reports;
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
  } finally {
    // What the run left behind is stopped here while it is still the process reported, and its root goes only once it
    // has.
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
    await rm(work, { recursive: true, force: true });
  }
}, 150_000);
