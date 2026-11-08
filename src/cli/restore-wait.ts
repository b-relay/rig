import {
  activityResultSchema,
  type ActivityResult,
  type RuntimeCommand,
} from "../daemon/protocol";
import { RigError } from "../domain/errors";
import { rigCommand, selectedTarget } from "../domain/rig-command";
import type { CliDependencies } from "./types";
import { terminalText } from "./terminal-text";

/** How often a waiting restore asks rigd whether its run ended. */
const RESTORE_POLL_MS = 1000;
/** A restore run's end, as Activity records it. */
type RestoreEnd = ActivityResult["operations"][number];

/** Waits for the restore `started` began and resolves the reply with how it `ended`; fails RESTORE_FAILED, with where its
 * output is, when it did not succeed. A Ctrl-C while waiting leaves it running and says how to see its end. */
export async function restoreOutcome(
  request: RuntimeCommand,
  started: unknown,
  operationId: string,
  dependencies: Pick<CliDependencies, "client" | "wait" | "signal" | "output">,
): Promise<unknown> {
  if (!json(started)) return started;
  const logs = terminalText(
    rigCommand("logs", {
      project: request.project,
      target: selectedTarget(
        request,
        String(started.target ?? request.target ?? "stable"),
      ),
      ...(request.job !== undefined ? { service: request.job } : {}),
    }),
  );
  if (!dependencies.signal?.aborted)
    dependencies.output.error(
      `Restoring ${request.job} from ${terminalText(String(started.backup ?? request.backup))}; its output is in ${logs}.\n`,
    );
  const ended = await awaitRestore(operationId, dependencies);
  // Interrupted: the wait ends, the restore goes on, and the exit (130) never reads as a restore that succeeded.
  if (!ended)
    throw new RigError(
      "DETACHED",
      "Stopped waiting; the restore goes on in the background.",
      `rig activity ${operationId} shows how it ends.`,
      { operationId, oneLine: true },
    );
  if (ended.outcome !== "succeeded")
    throw new RigError(
      "RESTORE_FAILED",
      `${ended.message ?? `${request.job}: the restore ${ended.outcome}`}.`,
      `Its output is in ${logs}.`,
      { operationId },
    );
  return { ...started, outcome: "restored", ended };
}
function json(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Waits for the restore the Operation `operationId` started to end. Its run has the Operation's id, and its end is the
 * Activity entry `restore` with an outcome other than `started`. Resolves that entry, or undefined once `signal` aborts
 * (Ctrl-C): the restore goes on without rig. A reply rigd cannot give is asked again at the next poll. */
async function awaitRestore(
  operationId: string,
  deps: Pick<CliDependencies, "client" | "wait" | "signal">,
): Promise<RestoreEnd | undefined> {
  while (!deps.signal?.aborted) {
    const reply = await deps.client
      .command({ action: "activity", operation: operationId }, deps.signal)
      .catch(() => undefined);
    const parsed = activityResultSchema.safeParse(reply);
    const ended = parsed.success
      ? parsed.data.operations.find(
          (entry) =>
            entry.id === operationId &&
            entry.action === "restore" &&
            entry.outcome !== "started",
        )
      : undefined;
    // The Operation's own entry is `started`: it is recorded under the Target's lease, before the run's end can be. A
    // refusal (JOB_RUNNING, say) never reaches here, since the command itself failed.
    if (ended) return ended;
    await deps.wait(RESTORE_POLL_MS, deps.signal);
  }
  return undefined;
}
