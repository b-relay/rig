import { attempt } from "../lib/outcome";
import { pulseStamp, type Pulse } from "../lib/pulse";
import type { ActivityResult, DaemonHealth, QueueResult } from "../lib/types";
import { daemon, read } from "./daemon";

/** Reads the three pulse inputs from rigd in parallel and reduces them to one stamp. */
export async function readPulse(): Promise<Pulse> {
  const [health, queue, activity] = await Promise.all([
    attempt(
      daemon().then((client) => client.health() as Promise<DaemonHealth>),
    ),
    attempt(read({ action: "queue" }) as Promise<QueueResult>),
    attempt(read({ action: "activity" }) as Promise<ActivityResult>),
  ]);
  return pulseStamp({ health, queue, activity });
}
