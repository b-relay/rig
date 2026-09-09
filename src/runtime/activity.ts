import { createHash } from "node:crypto";
import type { StateStore } from "../domain/runtime";
import type { ObservationEffects } from "./status";
import type { ProcessObservation } from "../providers/contracts";

export interface FailureMonitorOptions {
  store: StateStore;
  observations: Pick<ObservationEffects, "process">;
  now(): string;
  budgetMs?: number;
}
/** One bounded observation pass. Caller serializes against lifecycle changes and skips pending ownership.
 * Concrete terminal exits become durable Activity; absence, uncertainty, and restart backoff do not.
 */
export async function monitorRuntimeFailures(
  options: FailureMonitorOptions,
): Promise<{ recorded: number }> {
  const snapshot = await options.store.read();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.budgetMs ?? 2000);
  try {
    const observations = await Promise.all(
      snapshot.targets
        .filter((target) => target.desired === "running" && !target.recovery)
        .flatMap((target) =>
          target.plan.components
            .filter((component) => component.kind === "managed")
            .map(async (component) => {
              const observed = await observeBeforeDeadline(
                () =>
                  options.observations.process(
                    target,
                    component,
                    controller.signal,
                  ),
                controller.signal,
              );
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
            }),
        ),
    );
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
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
/** A non-cooperating provider cannot extend the monitor's common deadline. */
async function observeBeforeDeadline(
  observe: () => Promise<ProcessObservation>,
  signal: AbortSignal,
): Promise<ProcessObservation> {
  if (signal.aborted) return { state: "unknown" };
  return await new Promise((resolve) => {
    const finish = (value: ProcessObservation) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => finish({ state: "unknown" });
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(observe)
      .then(finish, () => finish({ state: "unknown" }));
  });
}
