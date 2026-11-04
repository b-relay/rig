/** Output on its way to a Target's log. Whatever arrives while a write is under way goes into the next write, whole, so a
 * burst costs a few appends rather than one for every read of its pipe. Past `limit` bytes waiting, `pause` holds the pipes:
 * a chatty Service slows to what the log can take, its writes blocking as on any full pipe, rather than growing the process
 * that captures it. `resume` lets them go once what waits has left for the log, so at most about twice `limit` is held. */
export function createOutputQueue<Entry>(options: {
  /** Writes one batch, in order. Never rejects: what a failed write means is the caller's to record. */
  readonly write: (batch: readonly Entry[]) => Promise<void>;
  readonly limit: number;
  readonly pause: () => void;
  readonly resume: () => void;
}): {
  /** Queues `entries`, which took `bytes` of output. Resolves once everything queued by then, and since, has been written. */
  add(entries: readonly Entry[], bytes: number): Promise<void>;
} {
  let waiting: Entry[] = [];
  let waitingBytes = 0;
  let paused = false;
  let writing: Promise<void> | undefined;
  const drain = async () => {
    while (waiting.length) {
      const batch = waiting;
      waiting = [];
      waitingBytes = 0;
      if (paused) {
        paused = false;
        options.resume();
      }
      await options.write(batch);
    }
    writing = undefined;
  };
  return {
    add(entries, bytes) {
      for (const entry of entries) waiting.push(entry);
      waitingBytes += bytes;
      if (waiting.length) writing ??= drain();
      if (!paused && waitingBytes >= options.limit) {
        paused = true;
        options.pause();
      }
      return writing ?? Promise.resolve();
    },
  };
}
