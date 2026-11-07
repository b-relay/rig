import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  daemonIdentity,
  processExited,
  processIdentity,
  recordedDaemon,
  rigFixture,
} from "./support/rig-fixture";

/** Stops `owned` if it is still the process it was, and fails when it will not go: a test's last word on what it started. */
async function stopOwned(owned: { pid: number; identity: string } | undefined) {
  if (owned === undefined || processIdentity(owned.pid) !== owned.identity)
    return;
  process.kill(owned.pid, "SIGTERM");
  if (!(await processExited(owned))) process.kill(owned.pid, "SIGKILL");
  if (!(await processExited(owned)))
    throw new Error(`process ${owned.pid} is still running`);
}

test("a fixture whose record cannot be read still stops its rigd, keeps its root as it was, and fails saying why", async () => {
  const f = await rigFixture();
  let daemon: Awaited<ReturnType<typeof recordedDaemon>>;
  try {
    const installed = await f.rigd(["install"]);
    // Known before anything is asserted, so the finally below can stop it whatever fails.
    daemon = await recordedDaemon(f.root);
    expect(installed.code).toBe(0);
    expect(daemon).toBeDefined();
    // What a failed assertion can leave behind: a record neither rig down nor rigd uninstall can read.
    const state = join(f.root, "runtime", "state.json");
    await writeFile(state, "{broken");
    const failure = await f.cleanup().then(
      () => undefined,
      (error: Error) => error.message,
    );
    expect(failure).toContain(`its root is kept at ${f.base}:`);
    expect(failure).toContain("its Targets could not be read");
    expect(failure).toContain("rigd uninstall exited with 1:");
    // Asked to stop, it stopped: it never had to be killed.
    expect(failure).not.toContain("did not stop");
    expect(await processExited(daemon!)).toBe(true);
    expect(await readFile(state, "utf8")).toBe("{broken");
  } finally {
    // The root goes only once the rigd it served is confirmed gone; otherwise it stays, and the test fails saying so.
    daemon ??= await recordedDaemon(f.root);
    if (
      daemon !== undefined &&
      daemonIdentity(daemon.pid) === daemon.identity
    ) {
      process.kill(daemon.pid, "SIGTERM");
      if (!(await processExited(daemon))) process.kill(daemon.pid, "SIGKILL");
      if (!(await processExited(daemon)))
        throw new Error(
          `rigd ${daemon.pid} is still running; its root is kept at ${f.base}`,
        );
    }
    await rm(f.base, { recursive: true, force: true });
  }
}, 60_000);

test("a fixture whose record cannot be read still stops the Services its leases name, and waits for them, before it fails", async () => {
  const f = await rigFixture();
  let daemon: Awaited<ReturnType<typeof recordedDaemon>>;
  let service: { pid: number; identity: string }[] = [];
  try {
    await writeFile(
      join(f.repo, "rig.yaml"),
      "name: demo\nservices:\n  api:\n    command: sleep 120\ntargets:\n  working: true\n",
    );
    const installed = await f.rigd(["install"]);
    daemon = await recordedDaemon(f.root);
    expect(installed.code).toBe(0);
    expect(await f.rig(["init", "--create-git"])).toMatchObject({ code: 0 });
    expect(await f.rig(["up"])).toMatchObject({ code: 0 });
    const status = JSON.parse(
      (await f.rig(["status", "--project", "demo", "--json"])).stdout,
    ) as { targets: { name: string; components: { pid?: number }[] }[] };
    const wrapper = status.targets.find((target) => target.name === "working")
      ?.components[0]?.pid;
    expect(wrapper).toBeNumber();
    // The Service is its capture wrapper and the application the wrapper runs.
    const application = Bun.spawnSync(["pgrep", "-P", String(wrapper)])
      .stdout.toString()
      .trim();
    service = [wrapper!, Number(application)].map((pid) => ({
      pid,
      identity: processIdentity(pid) ?? "",
    }));
    expect(service[1]!.identity).toContain("sleep 120");
    // With its record unreadable, nothing can ask rigd to stop the Service: only what the fixture tracks apart from it.
    await writeFile(join(f.root, "runtime", "state.json"), "{broken");
    const failure = await f.cleanup().then(
      () => undefined,
      (error: Error) => error.message,
    );
    expect(failure).toContain(`its root is kept at ${f.base}:`);
    expect(failure).toContain("its Targets could not be read");
    expect(failure).toContain("outlived rigd, and were stopped");
    // Gone by the time cleanup answers, not just signalled.
    expect(service.map(({ pid }) => processIdentity(pid))).toEqual([
      undefined,
      undefined,
    ]);
  } finally {
    for (const owned of service) await stopOwned(owned);
    await stopOwned(daemon ?? (await recordedDaemon(f.root)));
    await rm(f.base, { recursive: true, force: true });
  }
}, 60_000);
