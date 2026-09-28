import type { ComponentReport, TargetReport } from "../domain/project-status";
import type {
  AlertState,
  DownRecord,
  DownService,
  OperatorAlert,
} from "../domain/operator-alerts";
import type {
  ProjectRecord,
  ServiceRun,
  TargetRecord,
} from "../domain/runtime";
import { composeAlert, recoverCommand } from "./alert-messages";
import { currentRun } from "./supervision";

/** How long a Stable Target stays down before the operator is alerted: normal restarts, deploy swaps and the retries after
 * an unknown exit end well within it. */
export const ALERT_GRACE_MS = 5 * 60_000;
/** How often a reminder goes out while any Stable Target the operator was alerted about stays down. */
export const ALERT_REMINDER_MS = 6 * 60 * 60_000;
/** Stable Targets that went down within this long of the first of them went down together: one alert names them all. */
export const ALERT_GROUP_WINDOW_MS = 60_000;
/** The wait after a failed delivery; it doubles with each further failure in a row, up to the reminder interval. */
export const ALERT_RETRY_MS = 5 * 60_000;

export const NO_ALERTS: AlertState = { targets: [] };

/** What one evaluation found of a Stable Target: serving (`up`), stopped by an operator, down with the Services and route
 * that keep it down and the command that recovers it, or `inconclusive` when nothing can be said now (an operation is
 * working on it, or its observation did not answer), which leaves what Rig counted before unchanged. `since` is the
 * earliest recorded end among the down Services. */
export type StableTargetCondition = {
  targetId: string;
  project: string;
  target: string;
} & (
  | { state: "up" | "stopped" | "inconclusive" }
  | {
      state: "down";
      since?: string;
      services: DownService[];
      unpublishedRoute?: string;
      recover: string;
    }
);

/** The mutation rigd is executing, as its command selected the Project (by name or directory) and the Target. */
export interface MutationInFlight {
  operationId: string;
  /** The command's action; absent when unknown, which counts as one that may change every Target of its Project. */
  action?: string;
  project?: string;
  repoPath?: string;
  /** A Target name, or `preview` for a Preview. */
  target?: string;
  /** The kind of Target the command selected, once rigd has selected it; it decides over `target`. */
  kind?: TargetRecord["kind"];
  /** The recorded Target the operation works on, when rigd's own work names it by id (the first pass starting a Stable
   * Target again after a Host restart); it decides over everything else. */
  targetId?: string;
}

/** Actions that work on one Target, which is the Working copy when the command names none. A `git-push` is not one: it
 * names no Target and selects the Stable Target or a Preview by its Branch once rigd reads the Project's config. */
const TARGET_ACTIONS: ReadonlySet<string> = new Set([
  "up",
  "down",
  "restart",
  "deploy",
  "destroy",
]);

/** The ids of the recorded Stable Targets any of `mutations`, the operations in flight at once, may be changing now: the
 * union of what each one may change. One that names a recorded Target by id may change that Target only. The others
 * name their Project by name or directory; one that names it by a directory no Project
 * is registered at, or not at all, may be any. Once rigd has selected the kind of Target a mutation works on, that
 * decides: the Stable Target, or none. Before that, a mutation of a Preview changes no Stable
 * Target, nor does a Target action that names no Target, which selects the Working copy; any other mutation without a
 * Target may change every Target of its Project. A deploy's own transition is always its own. */
export function engagedTargets(
  mutations: readonly MutationInFlight[],
  state: {
    projects: readonly Pick<ProjectRecord, "id" | "name" | "repoPath">[];
    targets: readonly Pick<
      TargetRecord,
      "id" | "projectId" | "name" | "kind" | "recovery"
    >[];
  },
): Set<string> {
  const engaged = new Set<string>();
  for (const mutation of mutations) {
    const named = mutation.project
      ? state.projects.filter((project) => project.name === mutation.project)
      : mutation.repoPath
        ? state.projects.filter(
            (project) => project.repoPath === mutation.repoPath,
          )
        : [];
    const projects = named.length
      ? new Set(named.map((project) => project.id))
      : undefined;
    for (const target of state.targets) {
      if (target.recovery?.operationId === mutation.operationId)
        engaged.add(target.id);
      if (target.kind !== "live") continue;
      if (mutation.targetId !== undefined) {
        if (mutation.targetId === target.id) engaged.add(target.id);
        continue;
      }
      if (projects && !projects.has(target.projectId)) continue;
      if (mutation.kind !== undefined) {
        if (mutation.kind === "live") engaged.add(target.id);
        continue;
      }
      if (mutation.target === "preview") continue;
      if (
        mutation.target === undefined &&
        mutation.action !== undefined &&
        TARGET_ACTIONS.has(mutation.action)
      )
        continue;
      if (mutation.target === undefined || mutation.target === target.name)
        engaged.add(target.id);
    }
  }
  return engaged;
}

/** Component states that keep a Stable Target from serving. `starting` counts: a Service that never gets past it, waiting on
 * a dependency that does not return, is down once the grace period has passed. */
const DOWN_STATES = new Set<ComponentReport["state"]>([
  "failed",
  "starting",
  "unhealthy",
]);

/** Whether the host Caddy loads Rig's routes, as far as the last inspection could tell. */
export type RoutePublication = "published" | "unpublished" | "unknown";

/** Judges one Stable Target from its record and the status observation of it. A Service keeps it down when it failed, never
 * gets past starting, fails its readiness check, or stays stopped because its automatic restarts are used up; one that
 * finished with a clean exit its policy does not restart does not. An unpublished route keeps a routed Target down. A Target
 * an operation is working on (`engaged`), or whose observation did not answer, is inconclusive. A deploy transition no
 * operation is working on any more, because its rollback could not be completed or rigd stopped during it, keeps a Target
 * meant to run down until an operator runs rig down: supervision leaves its Services alone until then. */
export function stableTargetCondition(input: {
  target: Pick<
    TargetRecord,
    "id" | "name" | "desired" | "recovery" | "services" | "plan"
  >;
  project: string;
  report: TargetReport | undefined;
  routes: RoutePublication;
  engaged: boolean;
}): StableTargetCondition {
  const { target, report } = input;
  const identity = {
    targetId: target.id,
    project: input.project,
    target: target.name,
  };
  if (input.engaged) return { ...identity, state: "inconclusive" };
  const { recovery } = target;
  if (
    recovery &&
    (recovery.stage === "blocked" ||
      target.desired === "running" ||
      recovery.desired === "running")
  )
    return {
      ...identity,
      state: "down",
      services: [
        recovery.stage === "blocked"
          ? {
              name: "deployment",
              reason:
                "The last deploy failed and its rollback could not be completed.",
              brief: "deploy rollback incomplete",
            }
          : {
              name: "deployment",
              reason:
                "A deploy stopped before it finished and left its transition unresolved; Rig does not supervise the Target's Services until it is resolved.",
              brief: "deploy interrupted, transition unresolved",
            },
      ],
      recover: recoverCommand(identity, "down"),
    };
  if (target.desired !== "running") return { ...identity, state: "stopped" };
  if (!report) return { ...identity, state: "inconclusive" };
  const managed = report.components.filter(
    (component) => component.kind === "managed",
  );
  const down = managed.filter(
    (component) =>
      DOWN_STATES.has(component.state) ||
      (component.state === "stopped" &&
        currentRun(target, component.name)?.exhausted === true),
  );
  const routed = target.plan.domain !== undefined;
  const unpublishedRoute =
    routed && input.routes === "unpublished" ? target.plan.domain : undefined;
  if (!down.length && !unpublishedRoute)
    return {
      ...identity,
      state:
        managed.some((component) => component.state === "unknown") ||
        (routed && input.routes === "unknown")
          ? "inconclusive"
          : "up",
    };
  const runs = down.map((component) => currentRun(target, component.name));
  const ends = runs.flatMap((run) => (run?.outcome ? [run.outcome.at] : []));
  return {
    ...identity,
    state: "down",
    ...(ends.length ? { since: earliestTime(ends) } : {}),
    services: down.map((component, index) => ({
      name: component.name,
      brief: briefReason(component, runs[index]),
      reason: component.reason ?? briefReason(component, runs[index]),
    })),
    ...(unpublishedRoute ? { unpublishedRoute } : {}),
    recover: recoverCommand(identity),
  };
}

/** The reason a Service keeps its Target down, in a few words, from what Rig recorded about its latest process. */
function briefReason(component: ComponentReport, run?: ServiceRun): string {
  if (component.state === "unhealthy") return "failing its readiness check";
  const outcome = run?.outcome;
  if (component.state === "starting") {
    if (run?.waitingFor)
      return "service" in run.waitingFor
        ? `waiting for ${run.waitingFor.service}`
        : "waiting for its ports to be free";
    return outcome?.kind === "unknown"
      ? "unknown exit, restart pending"
      : "restart pending";
  }
  if (run?.exhausted)
    return outcome?.kind === "unknown"
      ? "unknown exits, automatic restarts used up"
      : "automatic restarts used up";
  if (outcome?.kind === "unknown") return "unknown exit, not restarted";
  if (outcome?.kind === "exited")
    return outcome.signal !== undefined
      ? `ended by ${outcome.signal}`
      : `exited with code ${outcome.exitCode}`;
  if (outcome) return `start failed (${outcome.errorCode})`;
  return "not running";
}

/** The alert state after one evaluation at `now` found `conditions`, one per recorded Stable Target. A Target found down
 * starts a down period, from its earliest recorded end or else from `now`. A down period that ends before its alert is
 * forgotten; one that ends after it stays, resolved, until the recovery message is delivered. A Target no longer among
 * `conditions` was removed. An inconclusive condition changes nothing. */
export function trackDowntime(
  previous: AlertState,
  conditions: readonly StableTargetCondition[],
  now: string,
): AlertState {
  const pending = new Map(
    conditions.map((condition) => [condition.targetId, condition]),
  );
  const targets: DownRecord[] = [];
  for (const record of previous.targets) {
    const next = followRecord(record, pending.get(record.targetId), now);
    pending.delete(record.targetId);
    if (next) targets.push(next);
  }
  for (const condition of pending.values())
    if (condition.state === "down")
      targets.push({
        ...described(condition),
        since: periodStart(condition.since, now),
      });
  // With nothing left to tell, a past delivery failure says nothing about the next outage's first alert.
  const { retry, ...rest } = previous;
  return { ...rest, ...(retry && targets.length ? { retry } : {}), targets };
}

function followRecord(
  record: DownRecord,
  condition: StableTargetCondition | undefined,
  now: string,
): DownRecord | undefined {
  if (condition?.state === "inconclusive") return record;
  if (condition?.state === "down") {
    const { resolved, unpublishedRoute: _route, ...kept } = record;
    // Down again before its recovery was told: the operator still believes it down, and the new period starts now.
    return {
      ...kept,
      ...described(condition),
      ...(resolved
        ? { since: periodStart(condition.since, now, resolved.at) }
        : {}),
    };
  }
  if (record.resolved) return record;
  if (record.alertedAt === undefined) return undefined;
  return {
    ...record,
    resolved: {
      at: now,
      how:
        condition === undefined
          ? "removed"
          : condition.state === "up"
            ? "running"
            : "stopped",
    },
  };
}

/** The names, Services and route a down condition gives its record. */
function described(
  condition: Extract<StableTargetCondition, { state: "down" }>,
): Omit<DownRecord, "since"> {
  return {
    targetId: condition.targetId,
    project: condition.project,
    target: condition.target,
    services: condition.services,
    ...(condition.unpublishedRoute
      ? { unpublishedRoute: condition.unpublishedRoute }
      : {}),
    recover: condition.recover,
  };
}

/** A recorded end starts the period when it lies between `notBefore` and `now`; otherwise the period starts `now`. */
function periodStart(
  recorded: string | undefined,
  now: string,
  notBefore?: string,
): string {
  if (recorded === undefined) return now;
  const at = Date.parse(recorded);
  return at <= Date.parse(now) &&
    (notBefore === undefined || at >= Date.parse(notBefore))
    ? recorded
    : now;
}

/** One alert to deliver and the down records it is about. */
export interface PlannedAlert {
  alert: OperatorAlert;
  targetIds: string[];
}

/** The alerts due at `now`, in delivery order: one recovery message for every alerted Target no longer down, one down alert
 * per group of Targets that went down together once each of them has been down for the grace period, and a reminder
 * about every alerted Target still down once the reminder interval has passed since the last alert or reminder. A Target in
 * `unsettled`, whose condition this evaluation could not judge, gets no first down alert: an operation may be fixing it.
 * Nothing is due while a failed delivery waits for its retry. */
export function dueAlerts(
  state: AlertState,
  now: string,
  unsettled: ReadonlySet<string> = new Set(),
): PlannedAlert[] {
  const at = Date.parse(now);
  if (state.retry && at < Date.parse(state.retry.at)) return [];
  const planned: PlannedAlert[] = [];
  const plan = (kind: OperatorAlert["kind"], records: DownRecord[]) =>
    planned.push({
      alert: composeAlert(kind, records, now),
      targetIds: records.map((record) => record.targetId),
    });
  const recovered = state.targets.filter(
    (record) => record.resolved && record.alertedAt !== undefined,
  );
  if (recovered.length) plan("recovered", recovered);
  const unalerted = state.targets.filter(
    (record) =>
      !record.resolved &&
      record.alertedAt === undefined &&
      !unsettled.has(record.targetId),
  );
  // A group is due once every Target in it has been down for the grace period: the last joined within the group window of
  // the first, so the alert waits at most that much longer, and no Target is named before its own grace has passed.
  for (const group of wentDownTogether(unalerted))
    if (at - Date.parse(group.at(-1)!.since) >= ALERT_GRACE_MS)
      plan("down", group);
  const alerted = state.targets.filter(
    (record) => !record.resolved && record.alertedAt !== undefined,
  );
  if (alerted.length) {
    const last =
      state.notifiedAt ??
      earliestTime(alerted.map((record) => record.alertedAt!));
    if (at - Date.parse(last) >= ALERT_REMINDER_MS) plan("reminder", alerted);
  }
  return planned;
}

/** Groups of down records whose periods began within the group window of the earliest in the group, earliest group first. */
function wentDownTogether(records: readonly DownRecord[]): DownRecord[][] {
  const groups: DownRecord[][] = [];
  const ordered = [...records].sort(
    (a, b) => Date.parse(a.since) - Date.parse(b.since),
  );
  for (const record of ordered) {
    const group = groups.at(-1);
    if (
      group &&
      Date.parse(record.since) - Date.parse(group[0]!.since) <
        ALERT_GROUP_WINDOW_MS
    )
      group.push(record);
    else groups.push([record]);
  }
  return groups;
}

/** The alert state after `planned` was delivered at `now`, or after every channel failed to deliver it. A delivered down
 * alert marks its Targets alerted and a delivered recovery forgets them. The reminder interval restarts only with a message
 * about every alerted Target still down: a reminder, or a down alert while no other alerted Target is down, so a stream of
 * new outages never silences the reminder about an old one. A failure schedules the next attempt of every due alert. */
export function settleDelivery(
  state: AlertState,
  planned: PlannedAlert,
  delivered: boolean,
  now: string,
): AlertState {
  if (!delivered) {
    const failures = (state.retry?.failures ?? 0) + 1;
    return {
      ...state,
      retry: {
        failures,
        at: new Date(Date.parse(now) + retryDelay(failures)).toISOString(),
      },
    };
  }
  const { retry: _retry, ...settled } = state;
  const named = new Set(planned.targetIds);
  switch (planned.alert.kind) {
    case "recovered":
      return {
        ...settled,
        targets: settled.targets.filter(
          (record) => !(named.has(record.targetId) && record.resolved),
        ),
      };
    case "down": {
      const othersDown = settled.targets.some(
        (record) =>
          !named.has(record.targetId) &&
          !record.resolved &&
          record.alertedAt !== undefined,
      );
      return {
        ...settled,
        notifiedAt: othersDown && settled.notifiedAt ? settled.notifiedAt : now,
        targets: settled.targets.map((record) =>
          named.has(record.targetId) ? { ...record, alertedAt: now } : record,
        ),
      };
    }
    case "reminder":
      return { ...settled, notifiedAt: now };
  }
}

/** The wait before the next attempt after `failures` failed deliveries in a row. */
function retryDelay(failures: number): number {
  return Math.min(ALERT_RETRY_MS * 2 ** (failures - 1), ALERT_REMINDER_MS);
}

function earliestTime(times: readonly string[]): string {
  return times.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
}
