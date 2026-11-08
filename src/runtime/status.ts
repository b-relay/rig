import type { ComponentReport, TargetReport } from "../domain/project-status";
export type { ComponentReport, TargetReport } from "../domain/project-status";
import {
  boundedObservations,
  type ObservationDeadline,
  type ObservationResult,
} from "./bounded-observations";
import type {
  InstalledComponent,
  ManagedComponent,
  PersistentComponent,
  PlanComponent,
} from "../config/types";
import type { TargetRecord } from "../domain/runtime";
import type { RigError } from "../domain/errors";
import type { HealthCheck, ProcessObservation } from "../providers/contracts";
import type { HealthResults } from "./health-monitor";
import { plannedSites, serviceHostnames } from "./ports";
import {
  monitoredHealth,
  notRunningServiceReport,
  runningServiceReport,
  type ComponentBase,
  type HealthStanding,
} from "./service-report";
export { runningCommit } from "./service-report";
/** One Component to observe, with the Target it belongs to and that Target's place in the request. */
interface ObservationEntry {
  targetIndex: number;
  target: TargetRecord;
  component: PlanComponent;
  base: ComponentBase;
}
/** A Service's hostnames for a report: `route` is the first, the one shown where only one fits, and `hostnames` all of
 * them. Nothing when no hostname's '/' reaches it. */
export function hostnameFields(
  hostnames: readonly string[],
): Pick<ComponentReport, "route" | "hostnames"> {
  return hostnames.length
    ? { route: hostnames[0]!, hostnames: [...hostnames] }
    : {};
}
/** A health check's answer. `unrecorded` says why its evidence could not be written to the Target log; logging never
 * changes the answer, and evidence not written is written by the next check. */
export type HealthObservation = HealthCheck & { readonly unrecorded?: string };
export interface ObservationEffects {
  process(
    target: TargetRecord,
    component: ManagedComponent,
    signal: AbortSignal,
  ): Promise<ProcessObservation>;
  health(
    target: TargetRecord,
    component: ManagedComponent,
    signal: AbortSignal,
  ): Promise<HealthObservation>;
  artifact(
    target: TargetRecord,
    component: InstalledComponent,
    signal: AbortSignal,
  ): Promise<"installed" | "missing" | "unknown">;
  persistent(
    target: TargetRecord,
    component: PersistentComponent,
    signal: AbortSignal,
  ): Promise<boolean>;
  /** Whether a Tool of `target` published now runs from the checkout `checkout`, as a source-file Tool's shim does from the
   * checkout it was published from. Absent: none is taken to. */
  toolRunsFrom?(target: TargetRecord, checkout: string): Promise<boolean>;
  /** The Service's recorded ports, its separate Convex site port included, that accept a connection right now, in
   * ascending order. Says nothing of who listens; an aborted probe counts as not listening. */
  listening(
    target: TargetRecord,
    component: ManagedComponent,
    signal: AbortSignal,
  ): Promise<number[]>;
  /** The env files `target`'s plan lists that a start would refuse now, each with that refusal. Reads them and changes
   * nothing; no value leaves it. Absent: none is checked. */
  unusableEnvFiles?(target: TargetRecord): Promise<UnusableEnvFile[]>;
}
/** An env file a start of its Target would refuse: missing, unreadable, unparsable, or inside the checkout without Git
 * ignoring it. */
export interface UnusableEnvFile {
  readonly path: string;
  /** Who reads it, as an operator names them: "the whole Project", "Service web", "job nightly". */
  readonly readers: readonly string[];
  /** The refusal a start would give (ENV_FILE_MISSING, ENV_FILE, ENV_FILE_TRACKED, ENV_FILE_UNVERIFIED), which names the
   * file and never a value. */
  readonly refusal: RigError;
}
/** Read-only observations share one deadline; unresponsive adapters cannot extend the request budget.
 * The caller chooses the budget and the deadline scheduler, so a test can expire an observation deterministically.
 * A running Service with a healthcheck is judged by the health monitor's cached `health` results and its check is not run;
 * without them (no monitor runs) it is checked here once, as a Service whose plan predates healthcheck is. */
export async function observeTargets(
  targets: readonly TargetRecord[],
  effects: ObservationEffects,
  budgetMs: number,
  deadline: ObservationDeadline,
  health?: HealthResults,
): Promise<TargetReport[]> {
  return (
    await observeTargetsAndBuilds(targets, effects, budgetMs, deadline, health)
  ).reports;
}
/** `observeTargets`, with what `leftoverBuild` says of each Target observed under the same one deadline. */
export async function observeTargetsAndBuilds(
  targets: readonly TargetRecord[],
  effects: ObservationEffects,
  budgetMs: number,
  deadline: ObservationDeadline,
  health?: HealthResults,
  leftoverBuild?: (
    target: TargetRecord,
    signal: AbortSignal,
  ) => Promise<ProcessObservation>,
): Promise<{
  reports: TargetReport[];
  builds: ObservationResult<ProcessObservation>[];
}> {
  const entries = targets.flatMap((target, targetIndex) =>
    target.plan.components.map((component): ObservationEntry => ({
      targetIndex,
      target,
      component,
      base: componentBase(target, component),
    })),
  );
  const observed = await boundedObservations<
    ComponentReport | ProcessObservation
  >(
    [
      ...entries.map(
        (entry) => (signal: AbortSignal) =>
          observeComponent(entry, effects, health, signal),
      ),
      ...(leftoverBuild
        ? targets.map(
            (target) => (signal: AbortSignal) => leftoverBuild(target, signal),
          )
        : []),
    ],
    budgetMs,
    deadline,
  );
  // In the order they were asked: every Component's, then every Target's build.
  const components = entries.map(({ targetIndex, base }, job) => ({
    targetIndex,
    report: settledComponent(
      base,
      observed[job] as ObservationResult<ComponentReport>,
    ),
  }));
  const builds = observed.slice(
    entries.length,
  ) as ObservationResult<ProcessObservation>[];
  return {
    reports: targets.map((target, index) =>
      targetReport(
        target,
        components
          .filter((component) => component.targetIndex === index)
          .map((component) => component.report),
      ),
    ),
    builds,
  };
}
/** Pure: what a Component's report says before it is observed: its name and kind, a Service's ports, its recent automatic
 * restarts, and the hostnames that reach it. */
export function componentBase(
  target: TargetRecord,
  component: PlanComponent,
): ComponentBase {
  return {
    name: component.name,
    kind: component.kind,
    ...(component.kind === "managed" ? { port: component.port } : {}),
    ...(component.kind === "managed" && component.ports
      ? { ports: component.ports }
      : {}),
    ...automaticRestarts(target, component.name),
    ...hostnameFields(serviceHostnames(target.plan, component.name)),
  };
}
/** Observes one Component: a Tool's artifact, storage's presence, or a Service's process and, while it runs, its health. */
async function observeComponent(
  { target, component, base }: ObservationEntry,
  effects: ObservationEffects,
  health: HealthResults | undefined,
  signal: AbortSignal,
): Promise<ComponentReport> {
  if (component.kind === "installed")
    return {
      ...base,
      state: await effects.artifact(target, component, signal),
    };
  if (component.kind === "persistent")
    return {
      ...base,
      state: (await effects.persistent(target, component, signal))
        ? "ready"
        : "missing",
    };
  const observed = await effects.process(target, component, signal);
  if (observed.state !== "running")
    return notRunningServiceReport(target, component, base, observed);
  // The monitor's cached checks first; without them the Service is checked now, if it has a check at all.
  const standing: HealthStanding =
    monitoredHealth(target, component, health) ??
    (component.health || component.healthcheck
      ? {
          state: (await effects.health(target, component, signal)).ready
            ? "healthy"
            : "unhealthy",
        }
      : { state: "running" });
  return runningServiceReport(target, component, base, observed, standing);
}
/** Pure: a Component's report once its observation settled; one that failed or outlived the deadline is unknown. */
export function settledComponent(
  base: ComponentBase,
  result: ObservationResult<ComponentReport>,
): ComponentReport {
  if (result.kind === "completed") return result.value;
  return {
    ...base,
    state: "unknown",
    reason:
      result.kind === "expired" ? OBSERVATION_EXPIRED : "Observation failed.",
  };
}
/** Pure: a recorded Target's report from its Components' reports, in its plan's order. */
export function targetReport(
  target: TargetRecord,
  components: ComponentReport[],
): TargetReport {
  return {
    id: target.id,
    name: target.name,
    kind: target.kind,
    branch: target.branch,
    commit: target.commit,
    ...deploymentFlags(target),
    route: target.plan.domain,
    ...targetHostnames(target),
    ...(target.plan.domain && target.plan.proxy?.routes?.length
      ? {
          routes: target.plan.proxy.routes.map(({ prefix, service, port }) => ({
            prefix,
            service,
            port,
          })),
        }
      : {}),
    ...(target.plan.serviceDomains?.length
      ? {
          serviceDomains: target.plan.serviceDomains.map(
            ({ hostname, service, port }) => ({ hostname, service, port }),
          ),
        }
      : {}),
    components,
    state: aggregate(components),
  };
}
/** Every hostname a recorded Target serves, its domain first; nothing when it serves none. */
function targetHostnames(
  target: Pick<TargetRecord, "plan">,
): Pick<TargetReport, "hostnames"> {
  const hostnames = plannedSites(target.plan).map((site) => site.hostname);
  return hostnames.length ? { hostnames } : {};
}
/** Pure: the automatic restart attempts still inside the Service's restart budget windows, after a known and after an
 * unknown exit together; nothing when there are none or rigd never ran the Service. Attempts age out of the windows, so the
 * count can fall, and an attempt the budget refused before spawning counts too: it is recent activity, not a lifetime total. */
export function automaticRestarts(
  target: Pick<TargetRecord, "services">,
  service: string,
): Pick<ComponentReport, "restarts"> {
  const run = target.services?.[service];
  const restarts =
    (run?.attempts.length ?? 0) + (run?.unknownAttempts?.length ?? 0);
  return restarts ? { restarts } : {};
}
/** The reason a component report carries when the shared status deadline expired before its observation finished. */
export const OBSERVATION_EXPIRED =
  "Observation did not complete before the status deadline.";
/** Whether the recorded Commit is a completed deployment; callers such as git push must not treat an incomplete one as deployed. */
export function deploymentFlags(
  target: Pick<
    TargetRecord,
    "deploymentIncomplete" | "recovery" | "destructionPending"
  >,
): Pick<
  TargetReport,
  "deploymentIncomplete" | "transitionPending" | "destructionPending"
> {
  return {
    ...(target.deploymentIncomplete ? { deploymentIncomplete: true } : {}),
    ...(target.recovery ? { transitionPending: true } : {}),
    ...(target.destructionPending ? { destructionPending: true } : {}),
  };
}

/** Managed processes decide whether a Target is live, stopped, starting or
 * failed; the other Components qualify a live Target. Storage or an
 * executable that is missing beside a healthy process is a degraded Target,
 * and a process that runs but fails its check is unhealthy rather than
 * failed. A stopped Target is stopped whatever the state of its data. */
function aggregate(components: ComponentReport[]): TargetReport["state"] {
  if (!components.length) return "configured";
  const managed = components.filter(
    (component) => component.kind === "managed",
  );
  const capabilities = managed.length ? managed : components;
  const others = managed.length
    ? components.filter((component) => component.kind !== "managed")
    : [];
  const usable = (component: ComponentReport) =>
    ["healthy", "running", "installed", "ready"].includes(component.state);
  const present = (component: ComponentReport) =>
    usable(component) || component.state === "unhealthy";
  const qualified = (live: TargetReport["state"]) =>
    others.every(usable) ? live : "degraded";
  if (capabilities.every(usable))
    return qualified(
      managed.length
        ? managed.every((component) => component.state === "healthy")
          ? "healthy"
          : "running"
        : "ready",
    );
  if (capabilities.every(present)) return qualified("unhealthy");
  if (capabilities.some(usable)) return "degraded";
  if (capabilities.every((component) => component.state === "stopped"))
    return "stopped";
  if (capabilities.every((component) => component.state === "starting"))
    return "starting";
  if (
    capabilities.some(
      (component) =>
        component.state === "unknown" || component.state === "starting",
    )
  )
    return "unknown";
  return "failed";
}
