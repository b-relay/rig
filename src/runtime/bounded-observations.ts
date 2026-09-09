/** Schedules one asynchronous expiry. Cancellation releases the scheduled callback.
 * Implementations must not throw or invoke expiry synchronously from schedule.
 */
export interface ObservationDeadline {
  schedule(budgetMs: number, expire: () => void): () => void;
}

/** The production timing effect owner. */
export const timerObservationDeadline: ObservationDeadline = {
  schedule(budgetMs, expire) {
    const timer = setTimeout(expire, budgetMs);
    return () => clearTimeout(timer);
  },
};

export type ObservationResult<T> =
  | { kind: "completed"; value: T }
  | { kind: "rejected"; error: unknown }
  | { kind: "expired" };

/** Provider work shares one budget. First settlement wins; cancellation requests
 * cooperation but never waits for it. Jobs must not mutate caller-owned results.
 */
export async function boundedObservations<T>(
  jobs: readonly ((signal: AbortSignal) => Promise<T>)[],
  budgetMs: number,
  deadline: ObservationDeadline,
): Promise<ObservationResult<T>[]> {
  if (!jobs.length) return [];
  const controller = new AbortController();
  const unfinished = new Set<() => void>();
  let expired = false;
  const cancel = deadline.schedule(budgetMs, () => {
    expired = true;
    for (const expire of unfinished) expire();
    controller.abort();
  });
  try {
    return await Promise.all(
      jobs.map(
        (job) =>
          new Promise<ObservationResult<T>>((resolve) => {
            let settled = false;
            const finish = (result: ObservationResult<T>) => {
              if (settled) return;
              settled = true;
              unfinished.delete(expire);
              resolve(result);
            };
            const expire = () => finish({ kind: "expired" });
            unfinished.add(expire);
            if (expired) {
              expire();
              return;
            }
            // Both synchronous throws and eventual rejection have a terminal handler.
            Promise.resolve()
              .then(() => {
                if (expired) return;
                return job(controller.signal).then((value) =>
                  finish({ kind: "completed", value }),
                );
              })
              .catch((error) => finish({ kind: "rejected", error }));
          }),
      ),
    );
  } finally {
    cancel();
    unfinished.clear();
    controller.abort();
  }
}
