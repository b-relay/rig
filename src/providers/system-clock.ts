import type { Clock } from "../domain/clock";

/** The monotonic milliseconds this process measures durations on. A correction of the Mac's clock never moves them, and
 * on macOS they stop while the Mac sleeps: Bun's `performance.now()` reads the uptime clock (CLOCK_UPTIME_RAW), the
 * clock its timers wait on too. */
export const elapsedNow = (): number => performance.now();
/** The platform clock: the Mac's wall clock, and this process's elapsed time. */
export const systemClock: Clock = {
  now: () => Date.now(),
  elapsed: elapsedNow,
};
