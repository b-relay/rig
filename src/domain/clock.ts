/** Rig keeps two kinds of time apart. Wall time is the Mac's clock: what records and people read, and what job schedules
 * follow; correcting the Mac's clock moves it, forwards or back. Elapsed time is monotonic and stops while the Mac
 * sleeps: the waits Rig measures on it (see CONTEXT.md, Elapsed time) are neither shortened nor lengthened by a
 * correction of the clock, and resume after sleep where they were, as the processes they time do. Elapsed time does not
 * survive a rigd restart: an instant a previous rigd recorded is placed by its wall-clock age (`placed`). */
export interface Clock {
  /** Wall-clock Unix milliseconds now. */
  now(): number;
  /** Elapsed milliseconds from an arbitrary origin. */
  elapsed(): number;
}

/** Where on `clock`'s elapsed time the wall-clock instant `at` lies, for an instant this rigd did not see happen (one a
 * previous rigd recorded): its wall-clock age now, never below zero (an instant the clock, set back since, puts in the
 * future happened now) and never above `atMost` (an instant known to be younger than that). The wall-clock age counts
 * time the Mac slept, which elapsed time does not. */
export function placed(clock: Clock, at: number, atMost = Infinity): number {
  return clock.elapsed() - Math.min(Math.max(0, clock.now() - at), atMost);
}

/** A clock whose elapsed time is its wall clock `now`, for a caller that scripts the wall clock alone (a test). */
export function wallOnlyClock(now: () => number): Clock {
  return { now, elapsed: now };
}
/** `clock` when given; otherwise the `wallOnlyClock` of `now`, an ISO timestamp, for dependencies that script only that. */
export function clockOr(clock: Clock | undefined, now: () => string): Clock {
  return clock ?? wallOnlyClock(() => Date.parse(now()));
}
