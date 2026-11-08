import { expect, test } from "bun:test";
import { stopsWithin } from "../src/daemon/admin-stop";

/** Runs `work` on a clock that moves only when a pause is taken, recording each pause's length. */
async function onControlledClock<T>(
  work: (now: () => number) => Promise<T>,
): Promise<{ result: T; pauses: number[]; elapsed: number }> {
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  const start = 1_000_000;
  let clock = start;
  const pauses: number[] = [];
  Date.now = () => clock;
  globalThis.setTimeout = ((resolve: () => void, ms: number) => {
    pauses.push(ms);
    clock += ms;
    queueMicrotask(resolve);
    return 0;
  }) as unknown as typeof setTimeout;
  try {
    const result = await work(() => clock - start);
    return { result, pauses, elapsed: clock - start };
  } finally {
    Date.now = realNow;
    globalThis.setTimeout = realSetTimeout;
  }
}

test("a condition that ends is seen to end, asked once more after the wait", async () => {
  const asked: number[] = [];
  const { result, pauses } = await onControlledClock((now) =>
    stopsWithin(() => {
      asked.push(now());
      return asked.length < 3;
    }, 5000),
  );
  expect(result).toBe(true);
  // Twice while it held, once when it ended, and once more to decide.
  expect(asked).toEqual([0, 50, 100, 100]);
  expect(pauses).toEqual([50, 50]);
});

test("a condition that holds is asked every 50 ms until the budget runs out on time, then once more", async () => {
  const asked: number[] = [];
  const { result, pauses, elapsed } = await onControlledClock((now) =>
    stopsWithin(async () => {
      asked.push(now());
      return true;
    }, 200),
  );
  expect(result).toBe(false);
  expect(pauses).toEqual([50, 50, 50, 50]);
  expect(asked).toEqual([0, 50, 100, 150, 200, 200]);
  expect(elapsed).toBe(200);
});

test("with no budget a condition that holds is asked twice and never waited for", async () => {
  const asked: number[] = [];
  const { result, pauses } = await onControlledClock((now) =>
    stopsWithin(async () => {
      asked.push(now());
      return true;
    }, 0),
  );
  expect(result).toBe(false);
  // Once before the deadline is checked, once at the end.
  expect(asked).toEqual([0, 0]);
  expect(pauses).toEqual([]);
});
