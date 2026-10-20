import { expect, test } from "bun:test";
import { CLOCK_MEMORY_MS, createClock, wallClock } from "../src/domain/clock";

/** A clock over a scripted wall clock and elapsed clock: `wait` moves both, `step` only the wall clock. */
function scripted(wall = Date.parse("2026-10-13T12:00:00Z")) {
  let elapsed = 0;
  return {
    clock: createClock({ wall: () => wall, elapsed: () => elapsed }),
    wait(ms: number) {
      wall += ms;
      elapsed += ms;
    },
    step(ms: number) {
      wall += ms;
    },
  };
}

test("an instant the clock stamped is measured on elapsed time, whichever way the wall clock is corrected after it", () => {
  for (const jump of [-3_600_000, 3_600_000]) {
    const s = scripted();
    const at = s.clock.stamp();
    expect(at).toBe(s.clock.now());
    s.wait(5000);
    s.step(jump);
    expect(s.clock.since(at)).toBe(5000);
    s.wait(1000);
    expect(s.clock.since(at)).toBe(6000);
  }
});

test("an instant it did not stamp is placed by its wall-clock age when first measured, never in the future, then on elapsed time", () => {
  const s = scripted();
  const now = s.clock.now();
  // Recorded by a previous rigd 30 s ago, and one recorded while its clock ran an hour ahead.
  expect(s.clock.since(now - 30_000)).toBe(30_000);
  expect(s.clock.since(now + 3_600_000)).toBe(0);
  s.step(-3_600_000);
  s.wait(1000);
  expect(s.clock.since(now - 30_000)).toBe(31_000);
  expect(s.clock.since(now + 3_600_000)).toBe(1000);
});

test("an instant left unused for longer than the clock remembers is placed again by its wall-clock age", () => {
  const s = scripted();
  const at = s.clock.stamp();
  s.wait(CLOCK_MEMORY_MS + 1000);
  // Another instant in use makes the clock forget the stale one.
  s.clock.stamp();
  s.step(-CLOCK_MEMORY_MS);
  expect(s.clock.since(at)).toBe(1000);
  // One in use is kept however long ago it was.
  const kept = scripted();
  const start = kept.clock.stamp();
  for (let hour = 1; hour <= 5; hour++) {
    kept.wait(3_600_000);
    expect(kept.clock.since(start)).toBe(hour * 3_600_000);
  }
  kept.step(-24 * 3_600_000);
  expect(kept.clock.since(start)).toBe(5 * 3_600_000);
});

test("a wall clock alone measures durations on itself, an instant in its future counting as now", () => {
  let now = 10_000;
  const clock = wallClock(() => now);
  expect(clock.stamp()).toBe(10_000);
  now = 15_000;
  expect(clock.since(10_000)).toBe(5000);
  expect(clock.since(20_000)).toBe(0);
  expect(clock.elapsed()).toBe(15_000);
});
