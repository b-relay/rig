import { failureReason } from "../domain/errors";

/** The health monitor's work in flight: the jobs it started, the check slots they share, and the probes a stop aborts. It
 * knows nothing of health or state. */
export interface HealthWork {
  /** Waits for one of the slots checks share; `release` gives it back. */
  slot(): Promise<void>;
  release(): void;
  /** Tracks `job` until it settles. */
  track(job: Promise<void>): void;
  /** Resolves once every job tracked so far has settled. */
  idle(): Promise<void>;
  /** Runs `observe`, aborted after `timeoutMs` or by `stop`: its answer, a failure as a failed check, or undefined when it
   * did not answer in time. Undefined at once after `stop`. */
  withinTimeout<T>(
    observe: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
  ): Promise<T | { ready: false; reason: string } | undefined>;
  /** Aborts every probe in flight and starts no other, then resolves once the jobs settled or `boundMs` passed. */
  stop(boundMs: number): Promise<void>;
}

export function createHealthWork(deps: {
  /** Calls `fire` once after `delayMs`; returns the cancellation. */
  schedule(delayMs: number, fire: () => void): () => void;
  /** Slots checks share. */
  concurrency: number;
}): HealthWork {
  let stopped = false;
  const probes = new Set<AbortController>();
  const work = new Set<Promise<void>>();
  let running = 0;
  const waiting: (() => void)[] = [];
  const idle = async () => {
    while (work.size) await Promise.allSettled([...work]);
  };
  return {
    async slot() {
      if (running < deps.concurrency) running++;
      else await new Promise<void>((resolve) => waiting.push(resolve));
    },
    release() {
      const next = waiting.shift();
      if (next) next();
      else running--;
    },
    track(job) {
      work.add(job);
      void job.finally(() => work.delete(job));
    },
    idle,
    async withinTimeout(observe, timeoutMs) {
      if (stopped) return undefined;
      const controller = new AbortController();
      probes.add(controller);
      let cancel = () => {};
      const late = new Promise<undefined>((resolve) => {
        cancel = deps.schedule(timeoutMs, () => {
          controller.abort();
          resolve(undefined);
        });
      });
      try {
        return await Promise.race([
          observe(controller.signal).catch((error: unknown) =>
            controller.signal.aborted
              ? undefined
              : { ready: false as const, reason: failureReason(error) },
          ),
          late,
          // A stop aborts the probe and answers at once, whether or not the probe heeds its signal.
          new Promise<undefined>((resolve) =>
            controller.signal.addEventListener(
              "abort",
              () => resolve(undefined),
              { once: true },
            ),
          ),
        ]);
      } finally {
        cancel();
        probes.delete(controller);
      }
    },
    async stop(boundMs) {
      stopped = true;
      for (const probe of probes) probe.abort();
      let cancel = () => {};
      await Promise.race([
        idle(),
        new Promise<void>((resolve) => {
          cancel = deps.schedule(boundMs, resolve);
        }),
      ]);
      cancel();
    },
  };
}
