import type { ManagedComponent } from "../config/types";
import { recordActivity } from "../domain/activity";
import { diagnosticErrorCode } from "../domain/errors";
import { boundedOutput } from "../domain/health-policy";
import type { OperationPhase } from "../domain/operation-progress";
import type { TargetRecord } from "../domain/runtime";
import type { RuntimeDependencies } from "./contracts";
import type { HealthRestartRequest } from "./health-monitor";
import {
  activationJournal,
  recordFailedAttempt,
  recordHealthStretch,
} from "./supervision";
import { boundedObservations } from "./bounded-observations";

type Deps = Pick<
  RuntimeDependencies,
  | "store"
  | "now"
  | "id"
  | "lifecycle"
  | "observations"
  | "observationBudgetMs"
  | "observationDeadline"
  | "diagnostic"
>;

/** One health restart, run by an Operation that holds the Target: the Service's process the checks judged is stopped
 * through the normal stop path, within its stop_timeout, and started again as automatic restart starts it (fresh
 * environment, start check, route). The start spends none of the crash-restart budget; the record carries the unhealthy
 * stretch on, so a new rigd continues the back-off. Activity records the restart with the checks' last output, or why it
 * failed; a start that failed is left to automatic restart, as any failed start is. `skipped` when the Service no longer
 * runs the process that was checked. */
export async function restartForHealth(
  target: TargetRecord,
  request: HealthRestartRequest,
  deps: Deps,
  phase: (phase: OperationPhase) => void,
): Promise<"restarted" | "skipped" | "failed"> {
  const component = target.plan.components.find(
    (candidate): candidate is ManagedComponent =>
      candidate.kind === "managed" && candidate.name === request.service,
  );
  if (!component) return "skipped";
  // Bounded like every observation made under a Target's lock: one that never answers decides nothing and holds nothing.
  const [seen] = await boundedObservations(
    [(signal) => deps.observations.process(target, component, signal)],
    deps.observationBudgetMs,
    deps.observationDeadline,
  );
  const observed = seen?.kind === "completed" ? seen.value : undefined;
  if (
    observed?.state !== "running" ||
    (request.incarnation !== undefined &&
      observed.incarnation !== request.incarnation)
  )
    return "skipped";
  const at = Date.parse(deps.now());
  const stretch = { since: request.since, at: [...request.restarts, at] };
  // Recorded before the stop, so whatever starts it next (this restart, or automatic restart after a failed one) carries
  // the stretch on, and its back-off and retry_for hold.
  await recordHealthStretch(target, request.service, stretch, deps);
  const why = `it failed ${request.failures} health checks in a row${request.output ? ` (last output: ${boundedOutput(request.output)})` : ""}`;
  const activity = (outcome: "started" | "failed", message: string) =>
    deps.store.update((state) =>
      recordActivity(state, {
        id: deps.id(),
        projectId: target.projectId,
        project: state.projects.find((p) => p.id === target.projectId)?.name,
        target: target.name,
        occurredAt: deps.now(),
        action: "health-restart",
        outcome,
        message,
      }),
    );
  phase("stopping");
  try {
    await deps.lifecycle.stop(target, request.service);
  } catch (error) {
    await activity(
      "failed",
      `${request.service} was to be restarted because ${why}, but it could not be stopped (${diagnosticErrorCode(error)}).`,
    ).catch(() => {});
    return "failed";
  }
  phase("starting");
  const journal = activationJournal(target, "health", deps, {
    healthRestarts: stretch,
  });
  try {
    await deps.lifecycle.recover(target, request.service, journal);
  } catch (error) {
    await recordFailedAttempt(target, request.service, error, deps).catch(
      () => {},
    );
    await activity(
      "failed",
      `${request.service} was stopped because ${why}, and could not be started again (${diagnosticErrorCode(error)}); automatic restart takes it from here.`,
    ).catch(() => {});
    return "failed";
  }
  await activity(
    "started",
    `${request.service} was restarted because ${why} (health restart ${request.attempt}).`,
  );
  return "restarted";
}
