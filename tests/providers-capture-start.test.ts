import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  waitForCaptureStart,
  writeCaptureStatus,
} from "../src/providers/capture-status";

/** A clock the test advances itself: each poll pause moves it forward and no real time passes. */
function scriptedWait(timeoutMs: number) {
  let clock = 0;
  const pauses: number[] = [];
  return {
    pauses,
    wait: {
      timeoutMs,
      now: () => clock,
      wait: async (ms: number) => {
        pauses.push(ms);
        clock += ms;
      },
    },
  };
}

test("waitForCaptureStart expires on the injected clock without real time passing, and surfaces a failed status as PROCESS_START", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-capture-start-"));
  try {
    const requestPath = join(root, "job.json");
    const started = performance.now();
    const expired = scriptedWait(100);
    const timeout = waitForCaptureStart(requestPath, expired.wait).catch(
      (error) => error,
    );
    expect(await timeout).toMatchObject({ code: "PROCESS_START_TIMEOUT" });
    expect(expired.pauses).toEqual([20, 20, 20, 20, 20]);
    expect(performance.now() - started).toBeLessThan(100);

    await writeCaptureStatus(requestPath, {
      state: "failed",
      message: "The command exited before it listened.",
    });
    const failed = scriptedWait(5000);
    expect(
      await waitForCaptureStart(requestPath, failed.wait).catch((e) => e),
    ).toMatchObject({
      code: "PROCESS_START",
      message: "The command exited before it listened.",
    });
    expect(failed.pauses).toEqual([]);

    await writeCaptureStatus(requestPath, { state: "running", pid: 4242 });
    expect(await waitForCaptureStart(requestPath, failed.wait)).toBe(4242);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
