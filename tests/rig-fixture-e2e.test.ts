import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  daemonExited,
  daemonIdentity,
  recordedDaemon,
  rigFixture,
} from "./support/rig-fixture";

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
    expect(await daemonExited(daemon!)).toBe(true);
    expect(await readFile(state, "utf8")).toBe("{broken");
  } finally {
    // The root goes only once the rigd it served is confirmed gone; otherwise it stays, and the test fails saying so.
    daemon ??= await recordedDaemon(f.root);
    if (
      daemon !== undefined &&
      daemonIdentity(daemon.pid) === daemon.identity
    ) {
      process.kill(daemon.pid, "SIGTERM");
      if (!(await daemonExited(daemon))) process.kill(daemon.pid, "SIGKILL");
      if (!(await daemonExited(daemon)))
        throw new Error(
          `rigd ${daemon.pid} is still running; its root is kept at ${f.base}`,
        );
    }
    await rm(f.base, { recursive: true, force: true });
  }
}, 60_000);
