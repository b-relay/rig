import { attempt } from "../lib/outcome";
import { pulseStamp, type Pulse } from "../lib/pulse";
import type { ActivityResult, DaemonHealth, QueueResult } from "../lib/types";
import { daemon, read } from "./daemon";

/** Reads the three pulse inputs from rigd in parallel and reduces them to one stamp. The signal abandons all three, as
 * when the browser that asked has gone. */
export async function readPulse(signal?: AbortSignal): Promise<Pulse> {
  const [health, queue, activity] = await Promise.all([
    attempt(
      daemon().then((client) => client.health(signal) as Promise<DaemonHealth>),
    ),
    attempt(read({ action: "queue" }, signal) as Promise<QueueResult>),
    attempt(read({ action: "activity" }, signal) as Promise<ActivityResult>),
  ]);
  return pulseStamp({ health, queue, activity });
}
