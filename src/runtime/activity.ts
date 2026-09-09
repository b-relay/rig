import {
  boundedObservations,
  timerObservationDeadline,
  type ObservationDeadline,
} from "./bounded-observations";
import { createHash } from "node:crypto";
import type { StateStore } from "../domain/runtime";
import type { ObservationEffects } from "./status";

export interface FailureMonitorOptions {
  store: StateStore;
  observations: Pick<ObservationEffects, "process">;
  now(): string;
  budgetMs?: number;
  deadline?: ObservationDeadline;
}
/** One bounded observation pass. Caller serializes against lifecycle changes and skips pending ownership.
 * Concrete terminal exits become durable Activity; absence, uncertainty, and restart backoff do not.
 */
export async function monitorRuntimeFailures(
  options: FailureMonitorOptions,
): Promise<{ recorded: number }> {
  const snapshot = await options.store.read();
  const entries = snapshot.targets
    .filter((target) => target.desired === "running" && !target.recovery)
    .flatMap((target) =>
      target.plan.components
        .filter((component) => component.kind === "managed")
        .map((component) => ({ target, component })),
    );
  const results = await boundedObservations(
    entries.map(
      ({ target, component }) =>
        (signal) =>
          options.observations.process(target, component, signal),
    ),
    options.budgetMs ?? 2000,
    options.deadline ?? timerObservationDeadline,
  );
  const observations = results.map((result, index) => {
    if (result.kind !== "completed") return undefined;
    const observed = result.value;
    const { target, component } = entries[index]!;
    if (
      observed.state !== "stopped" ||
      observed.restartPending ||
      observed.exitCode === undefined
    )
      return undefined;
    const id =
      "crash-" +
      createHash("sha256")
        .update(
          JSON.stringify([
            target.id,
            target.updatedAt,
            component.name,
            observed.exitCode,
          ]),
        )
        .digest("hex");
    return {
      target,
      component: component.name,
      exitCode: observed.exitCode,
      id,
    };
  });
  const failures = observations.filter((entry) => entry !== undefined);
  if (!failures.length) return { recorded: 0 };
  let recorded = 0;
  await options.store.update((state) => {
    for (const failure of failures) {
      const current = state.targets.find(
        (target) => target.id === failure.target.id,
      );
      if (
        !current ||
        current.desired !== "running" ||
        current.recovery ||
        current.updatedAt !== failure.target.updatedAt ||
        state.activity.some((operation) => operation.id === failure.id)
      )
        continue;
      const project = state.projects.find(
        (project) => project.id === current.projectId,
      );
      state.activity.push({
        id: failure.id,
        projectId: current.projectId,
        project: project?.name,
        target: current.name,
        action: "crash",
        outcome: "failed",
        occurredAt: options.now(),
        message: `${failure.component} exited with code ${failure.exitCode}.`,
      });
      recorded++;
    }
  });
  return { recorded };
}
