import { RigError } from "../domain/errors";
import {
  serviceStopSchema,
  type RuntimeCommand,
  type ServiceStop,
} from "../daemon/protocol";
import type { CliDependencies } from "./types";
import { waitStatus } from "./wait-notice";
import {
  liveDisplay,
  plainDisplay,
  type ProgressDisplay,
} from "./progress-display";
import { formatClock } from "./stop-display";
import { terminalText } from "./terminal-text";
import { rigCommand, selectedTarget } from "../domain/rig-command";
import { z } from "zod";

/** How long a command may go unanswered before the user is told what rigd is doing instead. */
const NOTICE_AFTER_MS = 2000;
/** How often a waiting command asks rigd again where it stands, and redraws a countdown on a terminal. */
const PROGRESS_TICK_MS = 1000;
/** What waiting for a mutation uses: rigd's client, the poll wait and clock, cancellation and detachment, and stderr. */
export type MutationWaitDependencies = Pick<
  CliDependencies,
  | "client"
  | "output"
  | "wait"
  | "signal"
  | "detach"
  | "now"
  | "liveOutput"
  | "terminalColumns"
>;

/** Sends the mutation `request` as Operation `operationId` and resolves rigd's answer. When rigd has not answered in
 * time, shows what it waits for and the Services it waits on to stop, so a long wait has a cause and a deadline. A
 * cancellation after submission is acknowledged but not honoured, since rigd finishes the mutation either way; only
 * detachment abandons the wait, failing DETACHED. While a stop is shown, the first Ctrl-C detaches at once and says how
 * to end the stop now. */
export async function awaitMutation(
  request: RuntimeCommand,
  dependencies: MutationWaitDependencies,
  operationId: string,
): Promise<unknown> {
  const now = dependencies.now ?? (() => new Date());
  const display = dependencies.liveOutput
    ? liveDisplay(dependencies.output, dependencies.terminalColumns)
    : plainDisplay(dependencies.output);
  // Leaving a stop to rigd: detaches like a second Ctrl-C, with the stop named.
  const leave = new AbortController();
  let left: RigError | undefined;
  let settled = false;
  const interrupted = () => {
    if (settled) return;
    const stopping = display.stopping(now());
    if (stopping.length) {
      left = leftStopping(request, operationId, stopping);
      leave.abort(left);
      return;
    }
    display.note(
      `rigd is still running ${request.action} (operation ${operationId}); it finishes in the background. Press Ctrl-C again to detach.\n`,
    );
  };
  dependencies.signal?.addEventListener("abort", interrupted, { once: true });
  const detach = dependencies.detach
    ? AbortSignal.any([dependencies.detach, leave.signal])
    : leave.signal;
  const pending = dependencies.client.command(request, detach).finally(() => {
    settled = true;
  });
  try {
    void reportProgress(
      { ...dependencies, detach },
      display,
      now,
      operationId,
      pending,
      () => settled,
    ).catch(() => {});
    const result = await Promise.race([pending, untilDetached(detach)]);
    display.finish(stopsOf(result), now());
    return result;
  } catch (error) {
    const detached = Boolean(left) || dependencies.detach?.aborted === true;
    // A second Ctrl-C while a stop is shown leaves it the way the first one would have.
    const stopping = display.stopping(now());
    display.abandon(now(), detached);
    if (left) throw left;
    if (dependencies.detach?.aborted && stopping.length)
      throw leftStopping(request, operationId, stopping);
    if (dependencies.detach?.aborted)
      throw new RigError(
        "DETACHED",
        `Detached from operation ${operationId}.`,
        `Run rig activity ${operationId}.`,
        { operationId },
      );
    throw error;
  } finally {
    dependencies.signal?.removeEventListener("abort", interrupted);
  }
}
/** The detachment a Ctrl-C during a shown stop makes: `Left <service> stopping in the background (killing at 04:31). Run
 * rig down <target> --kill to stop it now.` */
function leftStopping(
  request: RuntimeCommand,
  operationId: string,
  stopping: readonly ServiceStop[],
): RigError {
  const services = stopping.map((stop) => stop.service);
  const names =
    services.length > 1
      ? `${services.slice(0, -1).join(", ")} and ${services.at(-1)}`
      : services[0]!;
  const killAt = Math.min(...stopping.map((stop) => Date.parse(stop.killAt)));
  const down = rigCommand(
    "down",
    {
      project: request.project,
      target: selectedTarget(request, stopping[0]!.target),
    },
    "--kill",
  );
  return new RigError(
    "DETACHED",
    `Left ${names} stopping in the background (killing at ${formatClock(new Date(killAt), false)}).`,
    `Run ${terminalText(down)} to stop it now.`,
    { operationId, oneLine: true },
  );
}
/** The stops a mutation's result reports, when it has any. */
function stopsOf(result: unknown): ServiceStop[] | undefined {
  const parsed = z
    .object({ stops: z.array(serviceStopSchema) })
    .safeParse(result);
  return parsed.success ? parsed.data.stops : undefined;
}
/** Never settles unless the signal aborts; one command holds at most one such listener. */
function untilDetached(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
  });
}
/** Once the command has gone NOTICE_AFTER_MS without an answer, asks rigd every PROGRESS_TICK_MS where it stands until it
 * settles or is detached, and shows it: what it waits for while rigd holds it behind another Operation on the same
 * Target or Project, and the Services it waits on to stop while it runs. A first Ctrl-C does not end it, since the
 * command keeps waiting. Stops when rigd cannot say. */
async function reportProgress(
  dependencies: Pick<CliDependencies, "client" | "wait" | "detach">,
  display: ProgressDisplay,
  now: () => Date,
  operationId: string,
  pending: Promise<unknown>,
  settled: () => boolean,
): Promise<void> {
  // A pause ends when the command settles, and its timer is released then, so nothing keeps rig alive after its answer.
  const done = new AbortController();
  void pending.then(
    () => done.abort(),
    () => done.abort(),
  );
  const signal = dependencies.detach
    ? AbortSignal.any([dependencies.detach, done.signal])
    : done.signal;
  const pause = (ms: number) => dependencies.wait(ms, signal);
  await pause(NOTICE_AFTER_MS);
  while (!settled() && !signal.aborted) {
    const reply = await dependencies.client
      .command({ action: "queue", operation: operationId })
      .catch(() => undefined);
    const status = waitStatus(reply, now());
    if (status === undefined || settled()) return;
    display.show(status, now());
    await pause(PROGRESS_TICK_MS);
  }
}
