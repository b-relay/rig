import { createClock } from "../domain/clock";

/** The monotonic milliseconds this process measures durations on; a correction of the Mac's clock never moves them. */
export const elapsedNow = (): number => performance.now();
/** The platform clock: the Mac's wall clock, with durations on this process's monotonic clock. One per process, so every
 * part of rigd measures from the instants the others stamped. */
export const systemClock = createClock({
  wall: () => Date.now(),
  elapsed: elapsedNow,
});
