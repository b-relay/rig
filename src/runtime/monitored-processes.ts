import type { StateStore } from "../domain/runtime";
import type { TargetLifecycle } from "./lifecycle";
import type { ObservationEffects } from "./status";
import type { MonitoredProcess } from "./usage-sampler";

/** Every Service and Job run that runs now on a Target meant to run, with the capture wrapper rigd started it under, as
 * the usage sampler samples them. A Component whose process cannot be observed, or is not running, is left out: it is
 * sampled again once it runs. Rejects only when rigd's records cannot be read. */
export async function monitoredProcesses(deps: {
  readonly store: StateStore;
  readonly observations: Pick<ObservationEffects, "process">;
  readonly lifecycle: Pick<TargetLifecycle, "observeJob">;
  readonly signal: AbortSignal;
}): Promise<MonitoredProcess[]> {
  const state = await deps.store.read();
  const projects = new Map(
    state.projects.map((project) => [project.id, project.name]),
  );
  const found: Promise<MonitoredProcess | undefined>[] = [];
  for (const target of state.targets) {
    const project = projects.get(target.projectId);
    if (
      project === undefined ||
      target.desired !== "running" ||
      target.destructionPending
    )
      continue;
    const series = (component: string, componentKind: "service" | "job") =>
      ({
        scope: "component",
        projectId: target.projectId,
        project,
        targetId: target.id,
        target: target.name,
        targetKind: target.kind,
        component,
        componentKind,
      }) as const;
    for (const component of target.plan.components) {
      if (component.kind !== "managed") continue;
      found.push(
        deps.observations
          .process(target, component, deps.signal)
          .then((seen) => running(seen, series(component.name, "service")))
          .catch(() => undefined),
      );
    }
    for (const job of target.plan.jobs ?? [])
      found.push(
        deps.lifecycle
          .observeJob(target, job.name, deps.signal)
          .then((seen) => running(seen, series(job.name, "job")))
          .catch(() => undefined),
      );
  }
  return (await Promise.all(found)).filter(
    (each): each is MonitoredProcess => each !== undefined,
  );
}

function running(
  seen: { readonly state: string; readonly pid?: number },
  series: MonitoredProcess["series"],
): MonitoredProcess | undefined {
  return seen.state === "running" && seen.pid !== undefined
    ? { series, wrapperPid: seen.pid }
    : undefined;
}
