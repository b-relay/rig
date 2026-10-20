import { elapsedNow } from "./system-clock";

/** The clock and timers a process supervisor lives by; the platform implementation is the effect owner, a test supplies a scripted one. */
export interface ProcessTiming {
  /** Wall-clock time, used for recorded timestamps only. */
  now(): Date;
  /** Monotonic milliseconds, which every stop and start deadline is measured on, so a correction of the Mac's clock never
   * shortens or lengthens a grace or a wait. */
  elapsed(): number;
  /** Resolves once `ms` have elapsed on this clock; the supervisor polls with it while waiting for a group to leave. */
  wait(ms: number): Promise<void>;
  /** Runs `callback` after `ms` on this clock and returns the cancellation; a cancelled callback never runs. */
  schedule(ms: number, callback: () => void): () => void;
}
export function createProcessTiming(): ProcessTiming {
  return {
    now: () => new Date(),
    elapsed: elapsedNow,
    wait: (ms) => Bun.sleep(ms),
    schedule: (ms, callback) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
  };
}
