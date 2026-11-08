import { cache } from "react";
import { cancelled } from "../../src/domain/errors";
import { attempt, describeFailure, refused } from "../lib/outcome";
import { pulseStamp, type Pulse, type PulseReadings } from "../lib/pulse";
import type { ActivityResult, DaemonHealth, QueueResult } from "../lib/types";
import { daemon } from "./daemon";
import { requireSession } from "./session";

/** The pulse read in flight, which every request asking meanwhile shares, and how many of them still wait for it. */
interface SharedRead {
  readonly readings: Promise<PulseReadings>;
  readonly abandon: AbortController;
  waiting: number;
}
/** Where the read in flight is kept. Next loads this module once for the pages and again for the `/pulse` route, so the
 * slot lives on the process: a page render and a poll share one read, and a read that began before a change is never
 * joined by a render the poll that saw the change asked for. */
const slot = ((globalThis as { [key: symbol]: unknown })[
  Symbol.for("rig.dashboard.pulse")
] ??= {}) as { inFlight?: SharedRead };

/** Reads rigd's health, queue and Activity in parallel, through one discovery of rigd. */
function readFromRigd(abandon: AbortController): SharedRead {
  const signal = abandon.signal;
  const client = daemon();
  const shared: SharedRead = {
    abandon,
    waiting: 0,
    readings: Promise.all([
      attempt(
        client.then((each) => each.health(signal) as Promise<DaemonHealth>),
      ),
      attempt(
        client.then(
          (each) =>
            each.command({ action: "queue" }, signal) as Promise<QueueResult>,
        ),
      ),
      attempt(
        client.then(
          (each) =>
            each.command(
              { action: "activity" },
              signal,
            ) as Promise<ActivityResult>,
        ),
      ),
    ]).then(([health, queue, activity]) => ({ health, queue, activity })),
  };
  // Nothing is kept once it answered: the next request reads afresh.
  void shared.readings.finally(() => {
    if (slot.inFlight === shared) slot.inFlight = undefined;
  });
  return shared;
}

/** The readings of a request whose browser has gone: each one cancelled, as a read its signal abandoned is. */
function abandonedReadings(): PulseReadings {
  const gone = refused(
    describeFailure(
      cancelled(
        "rigd keeps running whatever it was asked; run rig activity to see it.",
      ),
    ),
  );
  return { health: gone, queue: gone, activity: gone };
}

/** The three pulse inputs. Each request is admitted on its own; requests that ask while a read is in flight share it rather
 * than ask rigd again, and none is kept after it answered. `signal` is this request's: once it aborts, this request is
 * answered at once with cancelled readings, and the shared read is abandoned when every request sharing it has gone, as
 * when their browsers closed. */
export async function pulseReadings(
  signal?: AbortSignal,
): Promise<PulseReadings> {
  const admitted = await attempt(requireSession());
  if (!admitted.ok)
    return { health: admitted, queue: admitted, activity: admitted };
  if (signal?.aborted) return abandonedReadings();
  if (!slot.inFlight || slot.inFlight.abandon.signal.aborted)
    slot.inFlight = readFromRigd(new AbortController());
  const shared = slot.inFlight;
  shared.waiting += 1;
  if (!signal) return await shared.readings;
  let leave = () => {};
  const gone = new Promise<PulseReadings>((resolve) => {
    leave = () => {
      shared.waiting -= 1;
      if (shared.waiting === 0) shared.abandon.abort();
      resolve(abandonedReadings());
    };
    signal.addEventListener("abort", leave, { once: true });
  });
  try {
    return await Promise.race([shared.readings, gone]);
  } finally {
    signal.removeEventListener("abort", leave);
  }
}

/** A command from this site has ended: a request from now on reads rigd afresh rather than share a read begun before,
 * which may miss what the command changed. Requests already sharing that read keep it. */
export function readPulseAfresh(): void {
  slot.inFlight = undefined;
}

/** The pulse a browser polls: the three inputs reduced to one stamp. */
export async function readPulse(signal?: AbortSignal): Promise<Pulse> {
  return pulseStamp(await pulseReadings(signal));
}

/** The pulse inputs as one page render reads them, once however many parts of the page ask: the top bar's rigd state, the
 * stamp the sidebar keeps its Project statuses under, and rigd's health, queue and Activity wherever the page shows them. */
export const pagePulse = cache(
  async (): Promise<{ readings: PulseReadings; settledAt: number }> => {
    const readings = await pulseReadings();
    return { readings, settledAt: performance.now() };
  },
);
