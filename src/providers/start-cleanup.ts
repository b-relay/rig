import { failureCauses, RigError } from "../domain/errors";
import type { StartControl, StopRequest, StopResult } from "./contracts";

/** Stops what a failed start spawned, then throws the start's failure. `stop` is the supervisor's stop of that process with
 * the start's `graceMs`, its kill and `detach`; it must ask the process to stop even when `detach` is already aborted, so a
 * shutdown only ends the clean-up's wait and never skips it. The start's observer hears the stop begin and how it ended
 * (`failed` when it throws). A stop that fails (STOP_DETACHED included) is thrown in place of the start's failure, naming
 * that failure in its details and causes. */
export async function failStart(input: {
  stop: (request: StopRequest) => Promise<StopResult>;
  graceMs: number;
  control: StartControl;
  detach: AbortSignal;
  startFailure: unknown;
}): Promise<never> {
  const { control } = input;
  control.observer?.stopping(input.graceMs);
  let ended: StopResult;
  try {
    ended = await input.stop({
      graceMs: input.graceMs,
      ...(control.kill ? { kill: control.kill } : {}),
      detach: input.detach,
    });
  } catch (error) {
    control.observer?.stopped({ outcome: "failed" });
    throw withStartFailure(error, input.startFailure);
  }
  control.observer?.stopped(ended);
  throw input.startFailure;
}

/** `stopFailure` naming the start failure it interrupted, when it is a RigError; otherwise `stopFailure` itself. */
function withStartFailure(
  stopFailure: unknown,
  startFailure: unknown,
): unknown {
  if (!(stopFailure instanceof RigError)) return stopFailure;
  return new RigError(
    stopFailure.code,
    stopFailure.message,
    stopFailure.hint,
    {
      ...stopFailure.details,
      startFailure:
        startFailure instanceof RigError
          ? `${startFailure.code}: ${startFailure.message}`
          : startFailure instanceof Error
            ? startFailure.message
            : String(startFailure),
    },
    failureCauses(startFailure, stopFailure),
  );
}

/** The signal a supervisor's own stops detach on: its `detach()`, or the shutdown signal its owner aborts before it drains. */
export function ownStopsDetach(
  detaching: AbortSignal,
  shutdown: AbortSignal | undefined,
): AbortSignal {
  return shutdown ? AbortSignal.any([detaching, shutdown]) : detaching;
}
