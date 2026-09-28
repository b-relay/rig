import type { StartControl, StopRequest, StopResult } from "./contracts";

/** Stops what a failed start spawned: `stop` with the start's `graceMs`, its kill and `detach`, telling the start's observer as
 * the stop begins and how it ended (`failed` when it throws, STOP_DETACHED included). Returns or throws what `stop` does. */
export async function stopFailedStart(
  stop: (request: StopRequest) => Promise<StopResult>,
  graceMs: number,
  control: StartControl,
  detach: AbortSignal,
): Promise<StopResult> {
  control.observer?.stopping(graceMs);
  try {
    const ended = await stop({
      graceMs,
      ...(control.kill ? { kill: control.kill } : {}),
      detach,
    });
    control.observer?.stopped(ended);
    return ended;
  } catch (error) {
    control.observer?.stopped({ outcome: "failed" });
    throw error;
  }
}

/** The signal a supervisor's own stops detach on: its `detach()`, or the shutdown signal its owner aborts before it drains. */
export function ownStopsDetach(
  detaching: AbortSignal,
  shutdown: AbortSignal | undefined,
): AbortSignal {
  return shutdown ? AbortSignal.any([detaching, shutdown]) : detaching;
}
