import type { HostConfig } from "../config/types";
import {
  DEFAULT_LOG_RETENTION,
  type LogRetention,
} from "../providers/target-log";

/** The Host config's `logs` settings as they are now, for the writers of Target logs. The config is read again at most
 * once per `refreshMs` of `now`, so a changed setting reaches rigd's writers within that time without a daemon
 * restart; callers in between share one read. A config that cannot be read or is invalid keeps the last retention
 * read (the default before any), so a config mistake never stops output being recorded; `rig doctor` and other
 * commands report the config problem itself. */
export function hostLogRetention(input: {
  readonly read: () => Promise<HostConfig>;
  readonly now: () => number;
  readonly refreshMs: number;
}): () => Promise<LogRetention> {
  let current: LogRetention = DEFAULT_LOG_RETENTION;
  let readAt: number | undefined;
  let reading: Promise<LogRetention> | undefined;
  return () => {
    if (readAt !== undefined && input.now() - readAt < input.refreshMs)
      return Promise.resolve(current);
    reading ??= input
      .read()
      .then(
        (host) =>
          (current = {
            maxBytes: host.logs.max_bytes,
            generations: host.logs.generations,
          }),
        () => current,
      )
      .finally(() => {
        readAt = input.now();
        reading = undefined;
      });
    return reading;
  };
}
