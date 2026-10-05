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
 * environment, start check, route). With `start`, the process is already stopped and is only started.
 *
 * Ownership is written ahead: before anything is stopped, the record carries the unhealthy stretch with this attempt and
 * `pendingStart`, which says the health monitor, not automatic restart, owns starting the Service until a start passes.
 * Only a start that passed clears it. So whatever happens between the steps (a stop or start that fails, a rollback
 * that cannot be confirmed, an observation that does not answer, a write that is refused, rigd stopping), the Service
 * stays owned by the health back-off: the monitor checks it while a process runs and starts it on the back-off while
 * none does. The start spends none of the crash-restart budget. Activity records the restart, or why it failed.
 * `skipped` when the Service no longer runs the process that was checked, or no longer waits for a health restart;
 * `deferred` when the process could not be observed, so the monitor asks again and nothing was changed. */
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
  // start, the record of the health restart whose start did not pass and nothing has started since; a request that names
  // neither is never acted on. An explicit start since cleared the stretch, a down left the Target meant to stop, and a
  // Host restart holds the Service stopped until rig up.
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
  // Written ahead, before the stop: the stretch with this attempt, owned by the health back-off until a start passes. A
  // refused write stops here, with nothing stopped.
  await recordHealthStretch(
    target,
    request.service,
    { ...stretch, pendingStart: at },
    deps,
  );
  const why = request.start
    ? "its last health restart did not start it"
    : `it is unhealthy: ${request.failures} health ${request.failures === 1 ? "check" : "checks"} in a row failed${request.output ? ` (last output: ${boundedOutput(request.output)})` : ""}`;
  const activity = (outcome: "started" | "failed", message: string) =>
    deps.store
      .update((state) =>
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
      )
      .catch(() => {});
  const next = `Rig checks it while it runs, and starts it again in ${Math.round((healthRestartDueAt(stretch) - at) / 60_000)} min while it does not (health restart ${request.attempt + 1}), whatever its restart policy. Run rig restart ${targetSelector(target)} to start it now, or rig down ${targetSelector(target)} to stop trying.`;
  if (!request.start) {
    phase("stopping");
    try {
      await deps.lifecycle.stop(target, request.service);
    } catch (error) {
      await activity(
        "failed",
        `${request.service} was to be restarted because ${why}, but it could not be stopped (${diagnosticErrorCode(error)}). ${next}`,
      );
      return { outcome: "failed", at };
    }
  }
  phase("starting");
  const journal = activationJournal(target, "health", deps, {
    healthStretch: { ...stretch, pendingStart: at },
  });
  try {
    await deps.lifecycle.recover(target, request.service, journal);
  } catch (error) {
    // Nothing more to record: the stretch already says the health back-off owns the Service, whether its replacement was
    // stopped, could not be confirmed stopped, or could not be observed.
    await activity(
      "failed",
      `${request.service} was ${request.start ? "to be started" : "stopped"} because ${why}, and its start did not pass its start check (${diagnosticErrorCode(error)}). It is unhealthy. ${next}`,
    );
    return { outcome: "failed", at };
  }
  // The start passed: the stretch goes on until a check passes, but the health back-off no longer owns starting it. A
  // refused write leaves pendingStart, and the monitor, finding the process running, checks it as any other.
  await recordHealthStretch(target, request.service, stretch, deps).catch(
    () => {},
  );
  await activity(
    "started",
    `${request.service} was ${request.start ? "started again" : "restarted"} because ${why} (health restart ${request.attempt}).`,
  );
  return { outcome: "restarted", at };
}
