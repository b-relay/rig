import { RigError } from "../domain/errors";

/** For a stream that runs until it is cancelled: a request the cancellation abandoned ends it (undefined); any other
 * failure is the stream's. */
export function endsOnCancel(signal: AbortSignal | undefined) {
  return (error: unknown): undefined => {
    if (
      signal?.aborted &&
      error instanceof RigError &&
      error.code === "CANCELLED"
    )
      return undefined;
    throw error;
  };
}
