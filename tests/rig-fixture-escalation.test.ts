import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  platformInspect,
  rigFixture,
  type Inspect,
} from "./support/rig-fixture";

// Sequential on purpose: the test replaces Date.now and process.kill, which every test running beside it would share.
test("a rigd whose pid another process takes while cleanup waits for it to exit is not sent SIGKILL", async () => {
  // No real process has this pid: ps answers for it through the seam alone, and no signal to it leaves the test.
  const pid = 987654321;
  const born = "Thu Jan  1 00:00:00 1970";
  const replacement = "Fri Jan  2 00:00:00 1970";
  let replaced = false;
  const now = Date.now;
  let skew = 0;
  // The daemon is still there when cleanup first looks, by when its wait has run out; from then on another process has
  // its pid.
  const inspect: Inspect = (args) => {
    const asked = args.join(" ");
    if (asked === `-p ${pid} -o lstart= -o command=`)
      return { exitCode: 0, stdout: `${born} rigd\n` };
    if (asked !== `-p ${pid} -o lstart=`) return platformInspect(args);
    if (replaced) return { exitCode: 0, stdout: `${replacement}\n` };
    replaced = true;
    skew = 60_000;
    return { exitCode: 0, stdout: `${born}\n` };
  };
  const signals: { signal: unknown; stateAtSignal: string }[] = [];
  const kill = process.kill;
  const f = await rigFixture({
    commands: { rig: ["/usr/bin/true"], rigd: ["/usr/bin/true"] },
    inspect,
  });
  try {
    await mkdir(join(f.root, "daemon"), { recursive: true });
    await writeFile(
      join(f.root, "daemon", "address.json"),
      JSON.stringify({ pid }),
    );
    Date.now = () => now() + skew;
    process.kill = ((target: number, signal?: NodeJS.Signals | number) => {
      if (target !== pid) return kill.call(process, target, signal);
      signals.push({
        signal,
        stateAtSignal: replaced ? "replacement" : "daemon",
      });
      return true;
    }) as typeof process.kill;
    const failure = await f.cleanup().then(
      () => undefined,
      (error: Error) => error.message,
    );
    Date.now = now;
    process.kill = kill;
    // Cleanup reached the escalation: the daemon had not exited when its wait ran out.
    expect(failure).toContain(`rigd ${pid} did not stop`);
    expect(failure).toContain(`its root is kept at ${f.base}:`);
    expect(signals).toEqual([]);
  } finally {
    Date.now = now;
    process.kill = kill;
    await rm(f.base, { recursive: true, force: true });
  }
});
