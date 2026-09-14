import { expect, test } from "bun:test";
import {
  processStartTime,
  recordedProcess,
} from "../src/daemon/process-identity";

test("a process is identified by its start time, so a reused pid is told apart from the recorded process", async () => {
  const startedAt = await processStartTime(process.pid);
  expect(startedAt).toMatch(/\d{4}$/);
  expect(await processStartTime(process.pid)).toBe(startedAt!);
  expect(await processStartTime(2147483647)).toBeUndefined();
  expect(
    await recordedProcess({ pid: process.pid, startedAt: startedAt! }),
  ).toBe("running");
  expect(
    await recordedProcess({
      pid: process.pid,
      startedAt: "Thu Jan  1 00:00:00 1970",
    }),
  ).toBe("replaced");
  expect(await recordedProcess({ pid: process.pid })).toBe("unverified");
  expect(
    await recordedProcess({ pid: 2147483647, startedAt: startedAt! }),
  ).toBe("exited");
});
