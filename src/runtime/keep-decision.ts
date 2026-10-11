import type { ManagedComponent, TargetPlan } from "../config/types";
import type { ServiceRun, TargetRecord } from "../domain/runtime";
import { serviceDefinition } from "../domain/service-definition";
import { currentRun } from "./supervision";

/* Which Services a deploy keeps running (ADR 0016). A Service is kept when it is in both plans, its definition is
 * unchanged, none of the files it watches changed since the Commit its process started from, it runs the process Rig
 * recorded for it and is not unhealthy, nothing it depends on restarts, and the deploy starts its Target. Everything else
 * in the new plan is (re)started; what only the old plan has is stopped. Anything that cannot be established restarts. */

/** Why a deploy restarts a Service of the new plan rather than keep it running. */
export type RestartReason =
  /** The previous plan has no such Service. */
  | "new"
  /** `--force` or `--no-up`: a deploy that keeps nothing. */
  | "requested"
  /** Its run records nothing to compare (started before Rig recorded it), or the previous deploy never completed. */
  | "unrecorded"
  /** No process Rig recorded for it runs: stopped, stopped by an operator, or another process under its key. */
  | "not-running"
  /** Its process could not be observed. */
  | "unobserved"
  /** It is unhealthy, or waiting for a health restart. */
  | "unhealthy"
  /** Its definition changed: a setting, its build, or the shared build. */
  | "definition"
  /** Its composed environment changed (an env file's contents, say), or could not be composed. */
  | "environment"
  /** A file it watches changed between the two Commits, or that could not be told. */
  | "files"
  /** A Service it depends on restarts. */
  | "dependency";

/** What the deploy observed about one Service the rule cannot settle from the records alone. */
export interface KeepFacts {
  /** Its process under the Service's key now; absent when it was not observed in time. */
  process?: { state: "running" | "stopped" | "unknown"; incarnation?: string };
  /** Its healthcheck's cached result says unhealthy. */
  unhealthy?: boolean;
  /** The keyed digest of the environment it would start with from the new plan; absent when it could not be composed. */
  environment?: string;
  /** Whether a file it watches changed between its run's Commit and the new one; absent when that could not be told. */
  changed?: boolean;
}

/** What a deploy does with each Service. */
export interface KeepDecision {
  /** Services of both plans left running, in the new plan's order. */
  kept: string[];
  /** Services of the new plan it (re)starts, in the new plan's order, each with why; a dependency restart names it. */
  restarted: { service: string; reason: RestartReason; dependency?: string }[];
  /** Services only the previous plan has, which it stops. */
  removed: string[];
}

export interface KeepInput {
  previous: Pick<
    TargetRecord,
    "plan" | "services" | "desired" | "deploymentIncomplete"
  >;
  candidate: { plan: TargetPlan };
  /** False for a deploy that keeps nothing: `--force`, or `--no-up`, which starts nothing. */
  keep: boolean;
  /** By Service name; only the Services `servicesToObserve` names need any. */
  facts: ReadonlyMap<string, KeepFacts>;
}

/** Pure: what the deploy from `previous` to `candidate` does with each Service. Each Service of the new plan is judged on
 * its own, in dependency order, and then restarts when anything it depends on restarts, so restarts spread to every
 * dependent and no kept Service ever depends on one that stops. */
export function decideKept(input: KeepInput): KeepDecision {
  const restarting = new Map<string, KeepDecision["restarted"][number]>();
  const kept: string[] = [];
  for (const component of managed(input.candidate.plan)) {
    const own =
      settledReason(input, component.name) ??
      observedReason(input, component.name);
    const dependency = component.dependsOn.find((name) => restarting.has(name));
    if (own !== undefined)
      restarting.set(component.name, { service: component.name, reason: own });
    else if (dependency !== undefined)
      restarting.set(component.name, {
        service: component.name,
        reason: "dependency",
        dependency,
      });
    else kept.push(component.name);
  }
  const planned = new Set(managed(input.candidate.plan).map((c) => c.name));
  return {
    kept,
    restarted: [...restarting.values()],
    removed: managed(input.previous.plan)
      .map((component) => component.name)
      .filter((name) => !planned.has(name)),
  };
}

/** Pure: the Services of the new plan the rule cannot settle from the records alone, whose process, health, environment
 * and watched files the deploy must look at. */
export function servicesToObserve(input: Omit<KeepInput, "facts">): string[] {
  return managed(input.candidate.plan)
    .map((component) => component.name)
    .filter(
      (name) =>
        settledReason({ ...input, facts: new Map() }, name) === undefined,
    );
}

/** The run `service` of the previous plan was started under, when it records where and from what. */
export function recordedRun(
  previous: KeepInput["previous"],
  service: string,
): (ServiceRun & { source: NonNullable<ServiceRun["source"]> }) | undefined {
  const run = currentRun(previous, service);
  return run?.source ? { ...run, source: run.source } : undefined;
}

/** Why `service` restarts, from the plans and records alone; undefined when only observation can tell. */
function settledReason(
  input: KeepInput,
  service: string,
): RestartReason | undefined {
  const before = managed(input.previous.plan).find((c) => c.name === service);
  const after = managed(input.candidate.plan).find((c) => c.name === service)!;
  if (!before) return "new";
  if (!input.keep) return "requested";
  const run = recordedRun(input.previous, service);
  if (!run || input.previous.deploymentIncomplete) return "unrecorded";
  if (input.previous.desired !== "running" || run.intent !== "running")
    return "not-running";
  if (serviceDefinition(input.candidate.plan, after) !== run.source.definition)
    return "definition";
  return undefined;
}
/** Why `service` restarts given what was observed; undefined when it may be kept. Only for a Service `settledReason`
 * leaves open. */
function observedReason(
  input: KeepInput,
  service: string,
): RestartReason | undefined {
  const run = recordedRun(input.previous, service)!;
  const facts = input.facts.get(service) ?? {};
  if (!facts.process || facts.process.state === "unknown") return "unobserved";
  if (
    facts.process.state !== "running" ||
    facts.process.incarnation === undefined ||
    facts.process.incarnation !== run.incarnation
  )
    return "not-running";
  if (facts.unhealthy || run.healthStretch?.pendingStart !== undefined)
    return "unhealthy";
  if (
    facts.environment === undefined ||
    run.source.environment === undefined ||
    facts.environment !== run.source.environment
  )
    return "environment";
  if (facts.changed !== false) return "files";
  return undefined;
}
function managed(plan: Pick<TargetPlan, "components">): ManagedComponent[] {
  return plan.components.filter(
    (component): component is ManagedComponent => component.kind === "managed",
  );
}
