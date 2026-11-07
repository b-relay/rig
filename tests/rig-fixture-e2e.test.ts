import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rigFixture } from "./support/rig-fixture";

/** What `ps` shows running as `pid`, empty once it has gone. */
const running = (pid: number) =>
  Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], {
    stdout: "pipe",
    stderr: "ignore",
  }).stdout.toString();

test("a fixture whose record cannot be read still stops its rigd, keeps its root as it was, and fails saying why", async () => {
  const f = await rigFixture();
  try {
    expect((await f.rigd(["install"])).code).toBe(0);
    const { pid } = JSON.parse(
      await readFile(join(f.root, "daemon", "address.json"), "utf8"),
    ) as { pid: number };
    expect(running(pid)).toContain("rigd");
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
    expect(running(pid)).toBe("");
    expect(await readFile(state, "utf8")).toBe("{broken");
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
}, 60_000);
