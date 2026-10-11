import { activityResultSchema, type ActivityResult } from "../daemon/protocol";
import type { CliDependencies } from "./types";

/** How often a waiting restore asks rigd whether its run ended. */
const RESTORE_POLL_MS = 1000;
/** A restore run's end, as Activity records it. */
export type RestoreEnd = ActivityResult["operations"][number];

/** Waits for the restore the Operation `operationId` started to end. Its run has the Operation's id, and its end is the
 * Activity entry `restore` with an outcome other than `started`. Resolves that entry, or undefined once `signal` aborts
 * (Ctrl-C): the restore goes on without rig. A reply rigd cannot give is asked again at the next poll. */
export async function awaitRestore(
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
