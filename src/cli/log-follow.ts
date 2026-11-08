import type { RuntimeCommand } from "../daemon/protocol";
import type { CliDependencies } from "./types";
import { jsonLines, object, renderLogs, shortenedLogs } from "./output";
import { endsOnCancel } from "./stream-cancel";

/** Entries fetched per follow poll: --lines sizes the first page only, so a busy Target is not throttled to it. */
const FOLLOW_BATCH_LINES = 1000;
/** How long a follow waits between pages. */
const FOLLOW_POLL_MS = 250;
/** What following logs uses: rigd's client, the wait between pages, cancellation, and stdout. */
export type LogFollowDependencies = Pick<
  CliDependencies,
  "client" | "output" | "wait" | "signal"
>;

/** Prints the pages after the logs read `initial` answered, as JSON Lines or text, until cancellation. Follow consumes
 * opaque daemon cursors; duplicate text is never used as identity. Each page waits until its reader took the one before,
 * and an empty page still asks whether the reader is there. It ends on cancellation, which the entrypoint also raises when
 * the reader has gone away; that is how a stream with no end ends, so it is no failure. */
export async function followLogs(
  request: RuntimeCommand,
  initial: unknown,
  dependencies: LogFollowDependencies,
  print: { readonly json: boolean; readonly full: boolean },
): Promise<void> {
  let cursor = object(initial).cursor;
  while (!dependencies.signal?.aborted) {
    await dependencies.wait(FOLLOW_POLL_MS, dependencies.signal);
    if (dependencies.signal?.aborted) return;
    const result = await dependencies.client
      .command(
        {
          ...request,
          lines: FOLLOW_BATCH_LINES,
          ...(typeof cursor === "string" ? { after: cursor } : {}),
        },
        dependencies.signal,
      )
      .catch(endsOnCancel(dependencies.signal));
    if (result === undefined) return;
    const page = shortenedLogs(result, print.full);
    await dependencies.output.write(
      print.json ? jsonLines("logs", page) : renderLogs(page, false),
    );
    cursor = object(result).cursor;
  }
}
