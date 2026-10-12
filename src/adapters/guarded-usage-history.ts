import { RigError } from "../domain/errors";
import type { UsageHistory } from "../runtime/usage-history";

/** Usage history that never stops rigd: the store is opened at its first use rather than as rigd starts, and a store
 * that cannot be opened fails each call with MONITOR_STORAGE (which the sampler's pass reports to doctor) and is tried
 * again at the next call. Closing waits for every call in progress, and refuses later ones with MONITOR_UNAVAILABLE, so
 * a read that began before rigd stopped never meets a closed database. */
export function guardedUsageHistory(input: {
  readonly open: () => UsageHistory;
  /** Where the store lives, for the failure's message. */
  readonly path: string;
}): UsageHistory {
  let store: UsageHistory | undefined;
  let closed = false;
  const inFlight = new Set<Promise<unknown>>();
  const opened = (): UsageHistory => {
    if (closed)
      throw new RigError(
        "MONITOR_UNAVAILABLE",
        "rigd is stopping, so its CPU and memory history is closed.",
        "Try again once rigd has started again.",
      );
    if (store) return store;
    try {
      store = input.open();
      return store;
    } catch (error) {
      throw new RigError(
        "MONITOR_STORAGE",
        `rigd could not open its CPU and memory history at ${input.path}: ${error instanceof Error ? error.message : String(error)}`,
        "Check that the monitor directory under the Rig root is writable. A damaged usage.sqlite can be deleted: rigd starts a new one, losing only Monitor's history.",
      );
    }
  };
  const tracked = <T>(
    work: (store: UsageHistory) => Promise<T>,
  ): Promise<T> => {
    let run: Promise<T>;
    try {
      run = work(opened());
    } catch (error) {
      return Promise.reject(error);
    }
    inFlight.add(run);
    void run.finally(() => inFlight.delete(run)).catch(() => {});
    return run;
  };
  return {
    write: (minutes) => tracked((each) => each.write(minutes)),
    read: (request) => tracked((each) => each.read(request)),
    prune: (input) => tracked((each) => each.prune(input)),
    forget: (projectId) => tracked((each) => each.forget(projectId)),
    async close() {
      closed = true;
      await Promise.allSettled([...inFlight]);
      await store?.close();
    },
  };
}
