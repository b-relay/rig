/** Rig keeps two kinds of time apart. Wall time is the Mac's clock: what records and people read, and what cron schedules
 * follow; correcting the Mac's clock moves it, forwards or back. Elapsed time is monotonic: every duration, timeout,
 * interval, back-off and grace is measured on it, so correcting the clock never shortens or lengthens one. */
export interface Clock {
  /** Wall-clock Unix milliseconds now. */
  now(): number;
  /** Elapsed milliseconds from an arbitrary origin, for an interval that is never recorded. */
  elapsed(): number;
  /** Wall-clock Unix milliseconds now, as the instant something happened that a duration is later measured from (an exit,
   * an attempt, a check, a run's start): `since` measures from it exactly. */
  stamp(): number;
  /** Milliseconds elapsed since the wall-clock instant `at`, on the elapsed clock: from when `stamp` gave it out, or from
   * when this clock first measured it. An instant this clock never gave out (one a previous rigd recorded) is placed by
   * its wall-clock age then, never in the future, so a correction of the clock while no rigd ran can shorten a wait
   * measured from it but never lengthen it. */
  since(at: number): number;
}
/** What a clock reads: the wall clock and a monotonic one, both in milliseconds. */
export interface ClockSource {
  wall(): number;
  elapsed(): number;
}

/** How long an instant neither `stamp` nor `since` used is remembered: longer than any wait Rig measures from a recorded
 * instant of a Service (the hourly health restart back-off). A job run's timeout is measured at every scheduler pass, so
 * its start is remembered for as long as the run goes. An instant used again after it was forgotten is placed again by
 * its wall-clock age. */
export const CLOCK_MEMORY_MS = 2 * 60 * 60_000;

/** A clock reading `source`, which remembers where on the elapsed clock each instant it stamped or measured lies. */
export function createClock(source: ClockSource): Clock {
  /** The elapsed reading of each instant, by its wall-clock value, and when it was last used. */
  const placed = new Map<number, { at: number; used: number }>();
  let swept = source.elapsed();
  const remember = (wall: number, at: number, used: number) => {
    placed.set(wall, { at, used });
    if (used - swept < CLOCK_MEMORY_MS) return;
    swept = used;
    for (const [instant, entry] of placed)
      if (used - entry.used > CLOCK_MEMORY_MS) placed.delete(instant);
  };
  return {
    now: () => source.wall(),
    elapsed: () => source.elapsed(),
    stamp() {
      const wall = source.wall(),
        elapsed = source.elapsed();
      remember(wall, elapsed, elapsed);
      return wall;
    },
    since(at) {
      const elapsed = source.elapsed();
      const mark =
        placed.get(at)?.at ?? elapsed - Math.max(0, source.wall() - at);
      remember(at, mark, elapsed);
      return elapsed - mark;
    },
  };
}

/** A clock whose elapsed time is the wall clock `now`, for a caller that scripts the wall clock alone (a test): durations
 * follow `now`, an instant in its future counting as now. */
export function wallClock(now: () => number): Clock {
  return {
    now,
    elapsed: now,
    stamp: now,
    since: (at) => Math.max(0, now() - at),
  };
}
/** `clock` when given; otherwise the `wallClock` of `now`, an ISO timestamp, for dependencies that script only that. */
export function clockOr(clock: Clock | undefined, now: () => string): Clock {
  return clock ?? wallClock(() => Date.parse(now()));
}
