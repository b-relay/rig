import type { Served } from "../domain/runtime";
import { formatDuration } from "./jobs";

/** Where a start's journal keeps what it served (ADR 0020), for its caller to read whatever the start's outcome: a deploy's
 * receipts read it after a rollback, or once the error was wrapped. */
export interface ServedReceipt {
  served?: Served;
}

/** Pure: what a deploy of `commit` says it served, as an Activity note or, after "The ", a sentence of its error: `new
 * Commit 1a2b3c4 was served from 2026-11-05T08:00:00.000Z for 3m12s`. `atMost` bounds a service whose end was not
 * recorded: the moment its paths were confirmed withheld. */
export function servedPhrase(
  commit: string | undefined,
  served: Served,
  atMost?: string,
): string {
  const what = commit ? `new Commit ${commit.slice(0, 7)}` : "new Deployment";
  if (served.from === undefined)
    return `${what} may have been served, from a time Rig did not record`;
  const length = (end: string) =>
    formatDuration(Date.parse(end) - Date.parse(served.from!));
  if (served.until !== undefined)
    return `${what} was served from ${served.from} for ${length(served.until)}`;
  if (atMost !== undefined)
    return `${what} was served from ${served.from} for at most ${length(atMost)}`;
  return `${what} was served from ${served.from}`;
}
