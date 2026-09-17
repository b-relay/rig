import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLaunchdSupervisor,
  type LaunchdTiming,
} from "../src/providers/launchd-supervisor";
import type { CommandRunner } from "../src/providers/contracts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** A clock the supervisor advances only through its own pauses, so budgets expire without real time. */
function scriptedTiming(): LaunchdTiming & { pauses: number[] } {
  let clock = 0;
  const pauses: number[] = [];
  return {
    pauses,
    now: () => clock,
    wait: async (ms) => {
      pauses.push(ms);
      clock += ms;
    },
    applicationStartMs: 300,
    unloadBudgetMs: 500,
  };
}

test("launchd start and unload waits run on the injected clock and budgets: a late application, a job that appears on the third poll, and a job that never unloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-launchd-timing-"));
  roots.push(root);
  const request = {
    key: "target-1:web",
    componentName: "web",
    command: ["/bin/sh", "-c", "serve"],
    cwd: root,
    env: {},
    logRoot: root,
    incarnation: "start-1",
  };
  let prints = 0;
  let pidAfterPrints = Infinity;
  let loaded = false;
  const run: CommandRunner = async ({ command }) => {
    const action = command[1];
    if (action === "bootstrap") loaded = true;
    if (action !== "print") return { exitCode: 0, stdout: "", stderr: "" };
    if (!loaded)
      return { exitCode: 113, stdout: "", stderr: "Could not find service" };
    prints += 1;
    return {
      exitCode: 0,
      stdout:
        prints >= pidAfterPrints
          ? "state = running\n\tpid = 4242\n"
          : "state = running\n",
      stderr: "",
    };
  };
  const timing = scriptedTiming();
  const started = performance.now();
  const supervisor = createLaunchdSupervisor({
    root,
    domain: "gui/99999",
    labelPrefix: "test.timing",
    run,
    inspect: async () => undefined,
    timing,
  });

  await expect(supervisor.ensureRunning(request)).rejects.toMatchObject({
    code: "LAUNCHD_START",
  });
  expect(timing.pauses).toEqual([100, 100, 100]);

  timing.pauses.length = 0;
  prints = 0;
  pidAfterPrints = 5; // the running-job check and the `existing` print before bootstrap, then three application polls
  expect(await supervisor.ensureRunning(request)).toEqual({
    outcome: "started",
    pid: 4242,
  });
  expect(timing.pauses).toEqual([100, 100]);

  timing.pauses.length = 0;
  await expect(supervisor.stop(request.key)).rejects.toMatchObject({
    code: "LAUNCHD_STOP",
    message: expect.stringContaining("did not unload within 0.5 s."),
  });
  expect(timing.pauses).toEqual([100, 100, 100, 100, 100]);
  expect(performance.now() - started).toBeLessThan(500);
});
