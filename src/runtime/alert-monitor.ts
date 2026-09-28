import { isDeepStrictEqual } from "node:util";
import { recordActivity } from "../domain/activity";
import {
  RigError,
  diagnosticCauses,
  diagnosticErrorCode,
  failureReason,
} from "../domain/errors";
import type { OperatorAlert, OperatorAlerts } from "../domain/operator-alerts";
import type { ProxyPublication } from "../domain/proxy-publication";
import type {
  OperationRecord,
  RuntimeState,
  StateStore,
  TargetRecord,
} from "../domain/runtime";
import {
  NO_ALERTS,
  dueAlerts,
  engagedTargets,
  settleDelivery,
  stableTargetCondition,
  trackDowntime,
  type MutationInFlight,
  type RoutePublication,
  type StableTargetCondition,
} from "./alert-policy";
import { deliveryFailureActivity, sentActivity } from "./alert-messages";
import type { ObservationDeadline } from "./bounded-observations";
import type { RuntimeDependencies } from "./contracts";
import { observeTargets, type ObservationEffects } from "./status";

/** How often rigd evaluates operator alerts. */
export const ALERT_EVALUATION_INTERVAL_MS = 30_000;
/** The observation budget of one evaluation. It runs in the background, so it may wait longer than status does; a readiness
 * check gets half of it. */
export const ALERT_OBSERVATION_BUDGET_MS = 10_000;

export interface AlertMonitorDependencies {
  store: StateStore;
  observations: ObservationEffects;
  observationBudgetMs: number;
  observationDeadline: ObservationDeadline;
  inspectProxy(): Promise<ProxyPublication>;
  /** The channels alerts go out on. With none, Rig still counts downtime and records each alert in Activity. */
  channels: readonly OperatorAlerts[];
  now(): string;
  id(): string;
  diagnostic: RuntimeDependencies["diagnostic"];
  /** The mutation rigd is executing now, if any; a Stable Target it may be changing is not judged. None when absent. */
  mutation?(): MutationInFlight | undefined;
}

type Activity = Pick<OperationRecord, "action" | "outcome" | "message">;

/** One evaluation of operator alerts: observes every Stable Target as status does, counts the ones down, delivers the alerts
 * that are due and saves what was alerted with one Activity entry per alert sent and per failed delivery. It reads state and
 * observes Targets without the mutation queue and writes only the alert state and Activity, so it never waits for, holds or
 * changes a lifecycle operation. A channel that fails is recorded in Activity and diagnostics and tried again later. Rejects
 * only when runtime state cannot be read or saved; an alert delivered before a failed save may be delivered again. */
export async function evaluateOperatorAlerts(
  deps: AlertMonitorDependencies,
): Promise<void> {
  const began = deps.mutation?.();
  const state = await deps.store.read();
  const now = deps.now();
  const before = state.alerts ?? NO_ALERTS;
  const conditions = await observeStableTargets(state, deps, began);
  let alerts = trackDowntime(before, conditions, now);
  const unsettled = new Set(
    conditions
      .filter((condition) => condition.state === "inconclusive")
      .map((condition) => condition.targetId),
  );
  const activity: { alert: OperatorAlert; entry: Activity }[] = [];
  for (const planned of dueAlerts(alerts, now, unsettled)) {
    const { sent, failed } = await deliver(planned.alert, deps.channels);
    const delivered = !deps.channels.length || sent.length > 0;
    alerts = settleDelivery(alerts, planned, delivered, now);
    if (delivered)
      activity.push({
        alert: planned.alert,
        entry: sentActivity(planned.alert, sent),
      });
    for (const failure of failed) {
      activity.push({
        alert: planned.alert,
        entry: deliveryFailureActivity(
          planned.alert,
          failure.channel,
          failureReason(failure.error),
          delivered ? undefined : alerts.retry?.at,
        ),
      });
      await deps
        .diagnostic({
          operationId: deps.id(),
          action: "alert",
          outcome: "delivery-failed",
          reason: failure.channel,
          errorCode: diagnosticErrorCode(failure.error),
          ...diagnosticCauses(failure.error),
        })
        .catch(() => {});
    }
    if (!delivered) break;
  }
  if (isDeepStrictEqual(alerts, before) && !activity.length) return;
  await deps.store.update((current) => {
    current.alerts = alerts;
    for (const { alert, entry } of activity)
      recordActivity(current, {
        id: deps.id(),
        occurredAt: now,
        ...subject(alert, current),
        ...entry,
      });
  });
}

/** The condition of every recorded Stable Target. A Target the mutation in flight when the evaluation began (`began`) or when
 * its observation ended may be changing is inconclusive: its record and processes may be caught between two steps, as a
 * restart's stop is before its start. Of the rest, only those meant to run and not left mid-deploy are observed, within the
 * observation budget; a readiness check that has not answered by half of it counts as failing, so a hung endpoint is down
 * rather than never judged. The route is checked only when one of them has a domain. */
async function observeStableTargets(
  state: RuntimeState,
  deps: AlertMonitorDependencies,
  began: MutationInFlight | undefined,
): Promise<StableTargetCondition[]> {
  const stable = state.targets.filter((target) => target.kind === "live");
  const engagedAtStart = engagedTargets(began, state);
  const observed = stable.filter(
    (target) =>
      target.desired === "running" &&
      !target.recovery &&
      !engagedAtStart.has(target.id),
  );
  const [reports, routes] = await Promise.all([
    observeTargets(
      observed,
      answeringHealth(
        deps.observations,
        Math.floor(deps.observationBudgetMs / 2),
      ),
      deps.observationBudgetMs,
      deps.observationDeadline,
    ),
    observed.some((target) => target.plan.domain)
      ? routePublication(deps)
      : ("unknown" as const),
  ]);
  const engagedAtEnd = engagedTargets(deps.mutation?.(), state);
  const changed = await changedMeanwhile(stable, deps);
  return stable.map((target) =>
    stableTargetCondition({
      target,
      project:
        state.projects.find((project) => project.id === target.projectId)
          ?.name ?? target.plan.project,
      report: reports[observed.indexOf(target)],
      routes,
      engaged:
        engagedAtStart.has(target.id) ||
        engagedAtEnd.has(target.id) ||
        changed.has(target.id),
    }),
  );
}

/** The Stable Targets whose intent changed while they were observed: an operation that began and ended in between (a
 * `rig down`, say) left no mutation in flight at either end, but the state read before it no longer says what the
 * Target is meant to be. Every Target counts as changed when state cannot be read again. */
async function changedMeanwhile(
  stable: readonly TargetRecord[],
  deps: Pick<AlertMonitorDependencies, "store">,
): Promise<Set<string>> {
  const now = await deps.store.read().catch(() => undefined);
  return new Set(
    stable
      .filter((target) => {
        const saved = now?.targets.find((t) => t.id === target.id);
        return (
          !saved ||
          saved.desired !== target.desired ||
          (saved.recovery === undefined) !== (target.recovery === undefined)
        );
      })
      .map((target) => target.id),
  );
}

/** `effects` whose readiness check answers within `answerMs`: one still waiting then is reported not ready. */
function answeringHealth(
  effects: ObservationEffects,
  answerMs: number,
): ObservationEffects {
  return {
    ...effects,
    async health(target, component, signal) {
      const late = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unanswered = new Promise<{ ready: false; reason: string }>(
        (resolve) => {
          timer = setTimeout(() => {
            late.abort();
            resolve({
              ready: false,
              reason: `The readiness check did not answer within ${answerMs / 1000} s.`,
            });
          }, answerMs);
        },
      );
      try {
        return await Promise.race([
          effects.health(
            target,
            component,
            AbortSignal.any([signal, late.signal]),
          ),
          unanswered,
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Whether the host Caddy loads Rig's routes; `unknown` when the inspection failed. */
async function routePublication(
  deps: Pick<AlertMonitorDependencies, "inspectProxy">,
): Promise<RoutePublication> {
  try {
    return (await deps.inspectProxy()).state === "unpublished"
      ? "unpublished"
      : "published";
  } catch {
    return "unknown";
  }
}

/** How long one channel may take to deliver an alert before it counts as failed. */
export const ALERT_DELIVERY_DEADLINE_MS = 30_000;

/** Sends `alert` on every channel at once; a channel that throws, rejects or does not answer within the deadline failed. */
async function deliver(
  alert: OperatorAlert,
  channels: readonly OperatorAlerts[],
): Promise<{ sent: string[]; failed: { channel: string; error: unknown }[] }> {
  const results = await Promise.allSettled(
    channels.map((channel) => withinDeadline(channel, alert)),
  );
  const sent: string[] = [];
  const failed: { channel: string; error: unknown }[] = [];
  results.forEach((result, index) => {
    const channel = channels[index]!.channel;
    if (result.status === "fulfilled") sent.push(channel);
    else failed.push({ channel, error: result.reason });
  });
  return { sent, failed };
}

async function withinDeadline(
  channel: OperatorAlerts,
  alert: OperatorAlert,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => channel.send(alert))(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new RigError(
                "ALERT_DELIVERY",
                `The ${channel.channel} did not answer within ${ALERT_DELIVERY_DEADLINE_MS / 1000} s.`,
                "Rig tries again later; check the channel's setup if this repeats.",
              ),
            ),
          ALERT_DELIVERY_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The Project an alert's Activity is filed under when every Target it names belongs to one, and the Target when it names
 * one; a Host-wide alert is filed under neither. */
function subject(
  alert: OperatorAlert,
  state: Pick<RuntimeState, "projects">,
): Pick<OperationRecord, "projectId" | "project" | "target"> {
  const projects = new Set(alert.targets.map((target) => target.project));
  if (projects.size !== 1) return {};
  const [name] = projects;
  const project = state.projects.find((candidate) => candidate.name === name);
  return {
    ...(project ? { projectId: project.id } : {}),
    project: name!,
    ...(alert.targets.length === 1 ? { target: alert.targets[0]!.target } : {}),
  };
}
