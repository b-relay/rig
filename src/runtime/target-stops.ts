import type { ManagedComponent } from "../config/types";
import type { TargetRecord } from "../domain/runtime";
import { RigError, failureCauses, failureReason } from "../domain/errors";
import { isStopDetached, serviceGraceMs } from "../domain/stop-budget";
import type { StopResult } from "../providers/contracts";
import type {
  LifecycleObserver,
  StopControl,
  TargetEffects,
  TargetLifecycle,
} from "./lifecycle";
import {
  managedComponent,
  managedServices,
  routedPorts,
} from "./plan-services";
import { tailOf } from "./tail";

/** How a Target's Services stop: each within its stop_timeout under the Operation's kill and detach, told to the stop's
 * observer, with the paths that reach it withheld first. */
export interface TargetStops extends Pick<
  TargetLifecycle,
  "stop" | "withhold" | "withholdPorts" | "down"
> {
  /** Stops one Service within its stop_timeout under `stops`, telling its observer as the stop begins and ends. */
  stopService(
    target: TargetRecord,
    component: ManagedComponent,
    stops?: StopControl,
  ): Promise<StopResult>;
  /** Withholds the paths the plan routes to `services`, served so, before any of them is stopped. ROUTE_WITHHOLD, with no
   * Service that has a path stopped, when the proxy cannot be made to: it may still reach those ports, which any program
   * could bind once freed. */
  withholdServices(
    target: TargetRecord,
    services: Iterable<string>,
    stops?: StopControl,
  ): Promise<void>;
}
export function createTargetStops(
  effects: TargetEffects,
  guarded: (stops: StopControl | undefined) => TargetEffects,
  observer: LifecycleObserver | undefined,
  /** Stops the build a daemon that died left running, after the Services: `down` stops it last. */
  stopPreparation: TargetLifecycle["stopPreparation"],
): TargetStops {
  async function withholdServices(
    target: TargetRecord,
    services: Iterable<string>,
    stops?: StopControl,
  ): Promise<void> {
    const ports = routedPorts(target, services);
    if (ports.size) await withholdPorts(target, ports, stops);
  }
  async function withholdPorts(
    target: TargetRecord,
    ports: ReadonlySet<number>,
    stops?: StopControl,
  ): Promise<void> {
    try {
      await guarded(stops).withhold(target, ports);
    } catch (error) {
      throw new RigError(
        "ROUTE_WITHHOLD",
        `The route of ${target.name} could not be withheld (${failureReason(error)}), so no Service with a path was stopped: the proxy may still reach its Services' ports, which any program could bind once they are freed.`,
        `Run rig doctor to check the proxy, then retry once it answers (or once it is stopped).`,
        {},
        failureCauses(error),
      );
    }
  }
  async function stopService(
    target: TargetRecord,
    component: ManagedComponent,
    stops: StopControl = {},
  ): Promise<StopResult> {
    const graceMs = serviceGraceMs(component.stopTimeout);
    const kill = stops.kill?.(target);
    observer?.changing(target, component.name);
    stops.observer?.stopping(target, component.name, graceMs);
    try {
      const result = await effects
        .supervisor(target)
        .stop(`${target.id}:${component.name}`, {
          graceMs,
          ...(kill ? { kill } : {}),
          ...(stops.detach ? { detach: stops.detach } : {}),
        });
      stops.observer?.stopped(target, component.name, result);
      return result;
    } catch (error) {
      stops.observer?.stopped(target, component.name, { outcome: "failed" });
      throw error;
    }
  }
  return {
    stopService,
    withholdServices,
    withholdPorts,
    async stop(target, service, stops) {
      const component = managedComponent(target, service);
      await withholdServices(target, [service], stops);
      const result = await stopService(target, component, stops);
      return {
        outcome: result.outcome === "stopped" ? "stopped" : "unchanged",
      };
    },
    withhold: (target, services, stops) =>
      services
        ? withholdServices(target, services, stops)
        : guarded(stops).withhold(target),
    async down(target, stops, startFollows) {
      let changed = false;
      const processFailures: unknown[] = [];
      const services = target.plan.components.filter(
        (component): component is ManagedComponent =>
          component.kind === "managed",
      );
      const tail = new Set(
        startFollows ? tailOf(startFollows, managedServices(target)) : [],
      );
      let withheld = false;
      for (const component of [...services].reverse()) {
        // Withheld, and served so, before anything a path may need stops: once a process ends, any program may bind its
        // port. No path reaches a Service of the tail, so all of them stop first when a start follows.
        if (!withheld && !tail.has(component.name)) {
          await withholdServices(target, managedServices(target), stops);
          withheld = true;
        }
        try {
          const result = await stopService(target, component, stops);
          changed = result.outcome === "stopped" || changed;
        } catch (error) {
          if (isStopDetached(error)) throw error;
          processFailures.push(error);
        }
      }
      try {
        const result = await stopPreparation(target, stops);
        changed = result.outcome === "stopped" || changed;
      } catch (error) {
        if (isStopDetached(error)) throw error;
        processFailures.push(error);
      }
      if (processFailures.length)
        throw new RigError(
          "STOP_INCOMPLETE",
          "One or more managed processes could not be stopped.",
          "All managed Components were attempted. Inspect Target logs and status before retrying.",
          { processFailures },
        );
      return { outcome: changed ? "stopped" : "unchanged" };
    },
  };
}
