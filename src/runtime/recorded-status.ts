import type { JobReport } from "../domain/project-status";
import type { ServiceStopView } from "../domain/operation-progress";
import type { TargetRecord } from "../domain/runtime";
import { rigCommand } from "../domain/rig-command";
import type { ProcessObservation } from "../providers/contracts";
import type { ObservationResult } from "./bounded-observations";
import {
  OBSERVATION_EXPIRED,
  type ComponentReport,
  type TargetReport,
} from "./status";

/** What status knows of a recorded Target besides what observation saw: what rig.yaml adds to it, its job runs, and what
 * the daemon is doing with it right now. */
export interface RecordedEvidence {
  /** What rig.yaml would add while it turns the Target on; absent for a Preview, an off Target, or without current config. */
  configured?: readonly ComponentReport[];
  /** Its jobs' recorded runs. */
  jobs?: JobReport[];
  /** While an Operation stops the Target: the Services it waits on, with when each is killed. */
  stops?: readonly ServiceStopView[];
  /** Its recovery record: `live` while this daemon runs the deploy it names, `abandoned` when none does. */
  recovery?: "live" | "abandoned";
  /** What became of a build an earlier rigd started, observed under the status deadline. */
  build?: ObservationResult<ProcessObservation>;
}

/** Pure: a recorded Target's report, its observation decorated in order of precedence: the Components rig.yaml adds, its
 * jobs, an active stop, then an unresolved recovery, whose unknown overrides every state before it, and a leftover build. */
export function recordedReport(
  observed: TargetReport,
  evidence: RecordedEvidence,
): TargetReport {
  const configured = evidence.configured
    ? withConfiguredComponents(observed, evidence.configured)
    : observed;
  const scheduled = evidence.jobs
    ? { ...configured, jobs: evidence.jobs }
    : configured;
  const stopping = evidence.stops
    ? stoppingReport(scheduled, evidence.stops)
    : scheduled;
  const recovered =
    evidence.recovery === "abandoned"
      ? unresolvedRecoveryReport(stopping)
      : stopping;
  return leftoverBuildRunning(evidence.build)
    ? { ...recovered, leftoverBuild: true }
    : recovered;
}

/** Pure: the report with the Components rig.yaml defines that it does not show yet, after its own. */
export function withConfiguredComponents(
  report: TargetReport,
  configured: readonly ComponentReport[],
): TargetReport {
  const known = new Set(report.components.map((c) => c.name));
  return {
    ...report,
    components: [
      ...report.components,
      ...configured.filter((c) => !known.has(c.name)),
    ],
  };
}

/** Pure: a Target an Operation is stopping. A stop is a phase of an Operation, not something observation can see: the
 * Target is stopping, and so is each Service the Operation waits on, with when it is killed. Should two Operations wait on
 * one Service, the last one's kill time shows. */
export function stoppingReport(
  report: TargetReport,
  stops: readonly ServiceStopView[],
): TargetReport {
  return {
    ...report,
    state: "stopping",
    components: report.components.map((component) => {
      const stop = stops.findLast((s) => s.service === component.name);
      return stop
        ? { ...component, state: "stopping", killAt: stop.killAt }
        : component;
    }),
  };
}

/** Pure: a Target whose deploy no daemon runs any more: which plan runs is not known, so it and every Component are unknown. */
export function unresolvedRecoveryReport(report: TargetReport): TargetReport {
  return {
    ...report,
    state: "unknown",
    components: report.components.map((c) => ({
      ...c,
      state: "unknown",
      reason: "Deployment recovery is unresolved.",
    })),
  };
}

/** Pure: the report, refusing what `refusals` names; unchanged when it names nothing. */
export function withRefusals(
  report: TargetReport,
  refusals: NonNullable<TargetReport["refusals"]>,
): TargetReport {
  return Object.keys(refusals).length ? { ...report, refusals } : report;
}

/** Pure: whether a report shows a route, its Target's or a Component's. */
export function showsRoute(report: TargetReport): boolean {
  return Boolean(report.route || report.components.some((c) => c.route));
}

/** Pure: the report with its routes shown as unpublished, when it shows any. A route the host Caddy never loads is shown,
 * but never presented as served. */
export function unpublishedReport(report: TargetReport): TargetReport {
  return showsRoute(report) ? { ...report, routePublished: false } : report;
}

/** Pure: what status warns of recorded Targets, each kind together in Target order: a deploy in progress or an unresolved
 * recovery, an incomplete deploy, an incomplete Preview destruction, then a build an earlier rigd left. */
export function recordedWarnings(
  recorded: readonly {
    target: TargetRecord;
    evidence: Pick<RecordedEvidence, "recovery" | "build">;
  }[],
): string[] {
  return [
    ...recorded.flatMap(({ target, evidence }) =>
      evidence.recovery === "live"
        ? [
            `${target.name}: deploy in progress (operation ${target.recovery!.operationId}).`,
          ]
        : evidence.recovery === "abandoned"
          ? [
              `${target.name} has an unresolved deployment transition; run ${rigCommand("down", { target })} to stop both recorded plans.`,
            ]
          : [],
    ),
    ...recorded.flatMap(({ target }) =>
      target.deploymentIncomplete && !target.recovery
        ? [
            `${target.name}: the last deploy did not complete; run ${rigCommand("up", { target })} to finish it, or redeploy.`,
          ]
        : [],
    ),
    ...recorded.flatMap(({ target }) =>
      target.destructionPending
        ? [
            `${target.name}: Preview destruction is incomplete; its stopped inventory is retained. Run ${rigCommand("down", { target }, "--destroy")} to finish cleanup.`,
          ]
        : [],
    ),
    ...recorded.flatMap(({ target, evidence }) =>
      leftoverBuildWarning(target, evidence.build),
    ),
  ];
}

/** A build a daemon that died left running is in no Service's state, so only its recorded process group shows it. Only one
 * seen running is said to run. */
function leftoverBuildRunning(
  build: ObservationResult<ProcessObservation> | undefined,
): boolean {
  return build?.kind === "completed" && build.value.state === "running";
}

/** What status says of a leftover build: that one runs, or that whether one runs is uncertain when it could not be
 * observed; nothing when none runs or nothing was asked. */
function leftoverBuildWarning(
  target: TargetRecord,
  build: ObservationResult<ProcessObservation> | undefined,
): string[] {
  if (!build) return [];
  if (build.kind === "completed" && build.value.state === "stopped") return [];
  const stop = `rigd stops one as it starts and before the next build; ${rigCommand("down", { target })} stops it now, with the Target's Services.`;
  if (build.kind !== "completed" || build.value.state !== "running") {
    const why =
      build.kind === "completed"
        ? build.value.reason
        : build.kind === "expired"
          ? OBSERVATION_EXPIRED
          : "Observation failed.";
    return [
      `${target.name}: whether a build an earlier rigd started is still running could not be established${why ? ` (${why})` : ""}. ${stop}`,
    ];
  }
  return [
    `${target.name}: a build an earlier rigd started is still running${build.value.pid ? ` (process group ${build.value.pid})` : ""}. ${stop}`,
  ];
}
