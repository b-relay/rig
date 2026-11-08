import type { ManagedComponent } from "../config/types";
import type { TargetRecord } from "../domain/runtime";
import { RigError } from "../domain/errors";
import type { ProcessObservation, Supervisor } from "../providers/contracts";
import { plannedRoutes } from "./ports";

/** Pure: the names of the Services of the Target's plan. */
export function managedServices(target: TargetRecord): string[] {
  return target.plan.components.flatMap((component) =>
    component.kind === "managed" ? [component.name] : [],
  );
}
/** Pure: the ports the plan routes to the Services named `services`: what a route reaches them at. */
export function routedPorts(
  target: TargetRecord,
  services: Iterable<string>,
): Set<number> {
  const names = new Set(services);
  return new Set(
    plannedRoutes(target.plan)
      .filter((route) => names.has(route.service))
      .map((route) => route.port),
  );
}
/** Pure: the routed Services that `select` picks: the ones whose paths a caller withholds. */
export function routedServices(
  target: TargetRecord,
  select: (service: string) => boolean,
): Set<string> {
  return new Set(
    plannedRoutes(target.plan)
      .map((route) => route.service)
      .filter(select),
  );
}
/** Pure: the Service `service` of `target`'s plan; SERVICE_UNKNOWN when the plan has none. */
export function managedComponent(
  target: TargetRecord,
  service: string,
): ManagedComponent {
  const component = target.plan.components.find(
    (candidate): candidate is ManagedComponent =>
      candidate.kind === "managed" && candidate.name === service,
  );
  if (!component)
    throw new RigError(
      "SERVICE_UNKNOWN",
      `${target.name} has no Service named '${service}'.`,
      "Select a Service of the recorded plan.",
      { service },
    );
  return component;
}
/** Pure: the Service a process key of `target` names. */
export function componentOf(
  target: TargetRecord,
  key: string,
): ManagedComponent {
  return target.plan.components.find(
    (candidate): candidate is ManagedComponent =>
      candidate.kind === "managed" && key === `${target.id}:${candidate.name}`,
  )!;
}
/** Pure: whether a Service of the plan depends on `name`. */
export function hasDependents(target: TargetRecord, name: string): boolean {
  return target.plan.components.some(
    (component) =>
      component.kind === "managed" && component.dependsOn.includes(name),
  );
}
/** Observes every managed Component (those named `only`, when given) before anything starts, keyed by process key; an
 * unknown owner aborts before any install runs. */
export async function observeManaged(
  target: TargetRecord,
  supervisor: Supervisor,
  only?: string[],
): Promise<Map<string, ProcessObservation>> {
  const observations = new Map<string, ProcessObservation>();
  for (const component of target.plan.components) {
    if (component.kind !== "managed") continue;
    if (only && !only.includes(component.name)) continue;
    const observation = await supervisor.observe(
      `${target.id}:${component.name}`,
    );
    if (observation.state === "unknown")
      throw new RigError(
        "PROCESS_UNKNOWN",
        `Cannot safely start ${component.name}.`,
        "Run rig doctor to inspect process ownership.",
      );
    observations.set(`${target.id}:${component.name}`, observation);
  }
  return observations;
}
