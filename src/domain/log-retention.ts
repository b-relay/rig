import type { HostConfig } from "../config/types";

/** How a Target log file is bounded on disk: the Host config's `logs` settings. */
export interface LogRetention {
  /** A file at or past this many bytes is rotated before the next write to it. */
  readonly maxBytes: number;
  /** How many rotated files are kept beside the current one: `<file>.1` is the newest, `<file>.<generations>` the oldest.
   * 0 keeps none: a full file is removed and writing starts a fresh one. */
  readonly generations: number;
}
/** 64 MiB and one previous generation: the policy when the Host config sets no `logs`. */
export const DEFAULT_LOG_RETENTION: LogRetention = {
  maxBytes: 64 * 1024 * 1024,
  generations: 1,
};
/** How long a writer uses the logs settings it read before reading config.yaml again. */
export const LOG_RETENTION_REFRESH_MS = 5000;

/** The Host config's `logs` settings as they are now, for the writers of Target logs: rigd and every capture wrapper
 * read them this way, so all writers of one file rotate it alike. The config is read again at most once per
 * `refreshMs` of `now`, so a changed setting reaches every writer within that time without a restart; callers in
 * between share one read. A config that cannot be read or is invalid keeps the last retention read (the default before
 * any), so a config mistake never stops output being recorded; `rig doctor` and other commands report the config
 * problem itself. */
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
