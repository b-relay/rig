import type { ManagedComponent } from "../config/types";
import { recordActivity } from "../domain/activity";
import { diagnosticErrorCode } from "../domain/errors";
import { boundedOutput, healthRestartDueAt } from "../domain/health-policy";
import type { OperationPhase } from "../domain/operation-progress";
import type { TargetRecord } from "../domain/runtime";
import { targetSelector } from "../domain/target-selector";
import type { RuntimeDependencies } from "./contracts";
import {
  checkIdentity,
  healthStartPending,
  type HealthRestartRequest,
  type HealthRestartResult,
} from "./health-monitor";
import {
  activationJournal,
  currentRun,
  recordFailedHealthStart,
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
>;

/** One health restart (`on_failure: restart`), run by an Operation that holds the Target. The process the checks judged is
 * stopped through the normal stop path, within its stop_timeout, and started again as automatic restart starts it (fresh
 * environment, start check, route). With `start`, the process is already stopped because the last health restart's start
 * failed, and it is only started. The start spends none of the crash-restart budget; the record carries the unhealthy
 * stretch on, so a new rigd continues the back-off. A start that fails stays the health monitor's: the record says so
 * (`failedStart`), automatic restart leaves it alone, and the monitor starts it again at the next step of the back-off.
 * Activity records the restart with the checks' last output, or why it failed. `skipped` when the Service no longer runs
 * the process that was checked, or no longer waits for a health restart; `deferred` when the process could not be
 * observed, so the monitor asks again. */
export async function restartForHealth(
  target: TargetRecord,
  request: HealthRestartRequest,
  deps: Deps,
  phase: (phase: OperationPhase) => void,
): Promise<HealthRestartResult> {
  const component = target.plan.components.find(
    (candidate): candidate is ManagedComponent =>
      candidate.kind === "managed" && candidate.name === request.service,
  );
  // Judged again under the Target's lock: a deploy or edit since the check may have removed the healthcheck or set it to
  // report, and then nothing is restarted for it.
  // Only the check that judged it, too: one the recorded plan now makes another way says nothing about this process.
  if (
    component?.healthcheck?.onFailure !== "restart" ||
    checkIdentity(component) !== request.check
  )
    return { outcome: "skipped" };
  // Bounded like every observation made under a Target's lock: one that never answers decides nothing and holds nothing.
  const [seen] = await boundedObservations(
    [(signal) => deps.observations.process(target, component, signal)],
    deps.observationBudgetMs,
    deps.observationDeadline,
  );
  if (seen?.kind !== "completed") return { outcome: "deferred" };
  const observed = seen.value;
  const run = currentRun(target, request.service);
  // Only the process the checks judged, which the run record names (every start records it before it spawns), or, for a
  // start, the record of the health restart whose start failed and nothing has started since; a request that names
  // neither is never acted on. An explicit start since cleared the stretch, and a down left the Target meant to stop.
  if (
    request.incarnation === undefined ||
    run?.incarnation !== request.incarnation ||
    (request.start
      ? !healthStartPending(run) || observed.state !== "stopped"
      : observed.state !== "running" ||
        (observed.incarnation !== undefined &&
          observed.incarnation !== request.incarnation))
  )
    return { outcome: "skipped" };
  const at = Date.parse(deps.now());
  const stretch = { since: request.since, restarts: [...request.restarts, at] };
  // Recorded before the stop, so whatever starts it next carries the stretch on, and its back-off holds.
  await recordHealthStretch(target, request.service, stretch, deps);
  const why = request.start
    ? "its last health restart failed its start check"
    : `it is unhealthy: ${request.failures} health ${request.failures === 1 ? "check" : "checks"} in a row failed${request.output ? ` (last output: ${boundedOutput(request.output)})` : ""}`;
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
  if (!request.start) {
    phase("stopping");
    try {
      await deps.lifecycle.stop(target, request.service);
    } catch (error) {
      await activity(
        "failed",
        `${request.service} was to be restarted because ${why}, but it could not be stopped (${diagnosticErrorCode(error)}).`,
      ).catch(() => {});
      return { outcome: "failed", at };
    }
  }
  phase("starting");
  const journal = activationJournal(target, "health", deps, {
    healthStretch: stretch,
  });
  try {
    await deps.lifecycle.recover(target, request.service, journal);
  } catch (error) {
    await recordFailedHealthStart(
      target,
      request.service,
      error,
      stretch,
      deps,
    ).catch(() => {});
    const next = Math.round((healthRestartDueAt(stretch) - at) / 60_000);
    await activity(
      "failed",
      `${request.service} was ${request.start ? "to be started" : "stopped"} because ${why}, and its start failed its start check (${diagnosticErrorCode(error)}). It stays stopped and unhealthy; Rig tries again in ${next} min (health restart ${request.attempt + 1}). Run rig restart ${targetSelector(target)} to start it now, or rig down ${targetSelector(target)} to stop trying.`,
    ).catch(() => {});
    return { outcome: "failed", at };
  }
  await activity(
    "started",
    `${request.service} was ${request.start ? "started again" : "restarted"} because ${why} (health restart ${request.attempt}).`,
  );
  return { outcome: "restarted", at };
}
