import { expect, test } from "bun:test";
import { placed, wallOnlyClock, type Clock } from "../src/domain/clock";

test("an instant this rigd did not see happen is placed by its wall-clock age, never in the future, and never older than it can be", () => {
  const clock: Clock = {
    now: () => Date.parse("2026-10-13T12:00:00Z"),
    elapsed: () => 100_000,
  };
  const now = clock.now();
  expect(placed(clock, now - 30_000)).toBe(70_000);
  // The clock was set back after it was recorded: it happened now.
  expect(placed(clock, now + 3_600_000)).toBe(100_000);
  // Known to be at most 5 s old, whatever the wall clock says.
  expect(placed(clock, now - 3_600_000, 5000)).toBe(95_000);
});

test("a wall clock alone is its own elapsed time", () => {
  let now = 10_000;
  const clock = wallOnlyClock(() => now);
  now = 15_000;
  expect([clock.now(), clock.elapsed()]).toEqual([15_000, 15_000]);
});
