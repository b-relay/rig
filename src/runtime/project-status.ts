import type {
  ProjectStatusReport,
  StatusSelection,
} from "../domain/project-status";
import type { ProjectConfig } from "../config/types";
import type { ServiceStopView } from "../domain/operation-progress";
import type {
  BackupRecord,
  JobRecord,
  ProjectRecord,
  TargetRecord,
} from "../domain/runtime";
import { hostTimeZone } from "../domain/cron";
import { jobReports } from "./job-status";
import { asRigError } from "../domain/errors";
import type { ProcessObservation } from "../providers/contracts";
import type { RuntimeDependencies } from "./contracts";
import { observeTargetsAndBuilds, type TargetReport } from "./status";
import { configuredTarget, unrecordedReport } from "./configured-target";
import {
  recordedReport,
  recordedWarnings,
  showsRoute,
  unpublishedReport,
  withRefusals,
  type RecordedEvidence,
} from "./recorded-status";
import { previewName, selectTarget } from "./targets";
import { registrationRefusals } from "./registration";
import { targetRefusals } from "./target-refusals";
import { PREVIEW_SELECTOR, targetOn } from "../config/schema";
import {
  identityDriftHint,
  movedProject,
  registeredDirectoryMissing,
} from "./projects";
/** Which Targets a status selector means: every Target without one, one Preview by name, or the working or stable Target by
 * the same rule every other command uses, so an unknown name rejects TARGET_UNKNOWN instead of reporting nothing. */
function targetSelection(
  command: StatusSelection,
): (target: Pick<TargetRecord, "kind" | "name">) => boolean {
  if (command.target === PREVIEW_SELECTOR || command.deployment) {
    const name = previewName(command);
    return (target) => target.kind === "preview" && target.name === name;
  }
  if (!command.target) return () => true;
  const { kind } = selectTarget(command);
  return (target) => target.kind === kind;
}
/** Adds configured-only capabilities without interpreting configuration as runtime evidence. Reads the current rig.yaml and
 * observes the selected Targets, then reports each recorded Target as `recordedReport` ranks its evidence, adds the Targets
 * only rig.yaml has, marks routes the host Caddy does not load, and last says what each Target and the Project refuse. */
export async function projectStatus(
  project: Pick<ProjectRecord, "id" | "name" | "repoPath">,
  targets: readonly TargetRecord[],
  command: StatusSelection,
  deps: Pick<
    RuntimeDependencies,
    | "observations"
    | "observationBudgetMs"
    | "observationDeadline"
    | "inspectProxy"
    | "healthResults"
    | "timeZone"
  > & {
    /** ISO timestamp; job reports count their next run from it. The system clock when absent. */
    now?(): string;
    /** What rigd recorded about job runs; absent, jobs show no runs. */
    jobRecords?: readonly JobRecord[];
    /** The kept backups rigd recorded; absent, backup jobs show none. */
    backupRecords?: readonly BackupRecord[];
    documents: Pick<RuntimeDependencies["documents"], "read">;
    /** Whether the daemon is executing this operation right now. */
    inProgress(operationId: string): boolean;
    /** Whether an Operation holds or waits for any Target of the Project right now. */
    projectBusy?(): boolean;
    /** Whether an Operation is waiting for this Target's Services to exit right now. */
    stopping?(targetId: string): boolean;
    /** The Services of this Target an Operation is waiting on right now, with when each is killed. */
    serviceStops?(targetId: string): ServiceStopView[];
    /** What runs of a build a daemon that died left for this Target; `stopped` for one this daemon runs itself. */
    leftoverBuild?(
      target: TargetRecord,
      signal: AbortSignal,
    ): Promise<ProcessObservation>;
  },
): Promise<ProjectStatusReport> {
  const current = await currentConfig(project, deps.documents);
  const config = current.config;
  const selects = targetSelection(command);
  const selected = targets.filter(selects);
  const { reports: observed, builds } = await observeTargetsAndBuilds(
    selected,
    deps.observations,
    deps.observationBudgetMs,
    deps.observationDeadline,
    deps.healthResults,
    deps.leftoverBuild,
  );
  const clock = { timeZone: deps.timeZone ?? hostTimeZone };
  const configured = config && {
    working: configuredTarget(config, "working", clock),
    stable: configuredTarget(config, "stable", clock),
  };
  // A job's runs are recorded, not observed: status reads them, and counts the next run from now.
  const now = deps.now ? Date.parse(deps.now()) : Date.now();
  // What the daemon is doing now (a live deploy, a stop, an Operation on the Project) is read here, once and before the
  // next await, so one report's states, warnings and refusals say what one moment saw, even should an Operation end
  // while the proxy is inspected.
  const recorded = selected.map((target, index) => {
    const live = transitionInProgress(target, deps.inProgress);
    const evidence: RecordedEvidence = {
      // An off Target shows what it recorded, not what the config would add to it.
      ...(config &&
      configured &&
      target.kind !== "preview" &&
      targetOn(config, target.kind)
        ? { configured: configured[target.kind].components }
        : {}),
      jobs: jobReports(
        target,
        deps.jobRecords,
        now,
        clock,
        config ? targetOn(config, target.kind) : undefined,
        deps.backupRecords,
      ),
      ...(deps.stopping?.(target.id)
        ? { stops: deps.serviceStops?.(target.id) ?? [] }
        : {}),
      recovery: target.recovery ? (live ? "live" : "abandoned") : undefined,
      build: builds[index],
    };
    return {
      target,
      evidence,
      live,
      report: recordedReport(observed[index]!, evidence),
    };
  });
  const registration = !command.target && !command.deployment;
  const busy = registration && (deps.projectBusy?.() ?? false);
  // A Target nothing has recorded is listed only while rig.yaml turns it on. A recorded one is listed either way, so a
  // Target the config turned off while it ran can still be seen, stopped and destroyed.
  const unrecorded =
    config && configured
      ? (["working", "stable"] as const)
          .filter(
            (role) =>
              targetOn(config, role) &&
              !targets.some((t) => t.kind === role) &&
              selects({ kind: role, name: role }),
          )
          .map((role) => unrecordedReport(role, configured[role], project.name))
      : [];
  const publication = await routePublication(
    [...recorded.map(({ report }) => report), ...unrecorded],
    deps.inspectProxy,
  );
  const published = (report: TargetReport) =>
    publication.unpublished ? unpublishedReport(report) : report;
  const reports = [
    ...recorded.map(({ target, live, report }) =>
      withRefusals(published(report), targetRefusals(target, config, live)),
    ),
    ...unrecorded.map(published),
  ];
  const refusals = registration
    ? registrationRefusals(project, targets, deps.jobRecords, reports, busy)
    : undefined;
  return {
    project: project.name,
    projectId: project.id,
    targets: reports,
    ...(refusals ? { refusals } : {}),
    warnings: [
      ...(current.warning ? [current.warning] : []),
      ...recordedWarnings(recorded),
      ...publication.warnings,
    ],
  };
}
/** The Project's current rig.yaml, or why status shows only what is recorded: it cannot be read, its directory moved, or
 * it names another Project. */
async function currentConfig(
  project: Pick<ProjectRecord, "name" | "repoPath">,
  documents: Pick<RuntimeDependencies["documents"], "read">,
): Promise<{ config?: ProjectConfig; warning?: string }> {
  try {
    const document = await documents.read(project.repoPath);
    if (document.config.name === project.name)
      return { config: document.config };
    return {
      warning: `Current configuration names Project '${document.config.name}', not '${project.name}'; showing recorded Targets. ${identityDriftHint(project.name, document.config.name)}`,
    };
  } catch (error) {
    const failure = registeredDirectoryMissing(error)
      ? movedProject(project)
      : asRigError(error);
    return { warning: `${failure.message} ${failure.hint}` };
  }
}
/** Whether the host Caddy loads the routes `reports` show: `unpublished` when it does not, with why, and a warning when it
 * could not be checked. Asks nothing when no report shows a route. */
async function routePublication(
  reports: readonly TargetReport[],
  inspectProxy: RuntimeDependencies["inspectProxy"],
): Promise<{ unpublished: boolean; warnings: string[] }> {
  if (!reports.some(showsRoute)) return { unpublished: false, warnings: [] };
  try {
    const publication = await inspectProxy();
    if (publication.state !== "unpublished")
      return { unpublished: false, warnings: [] };
    return {
      unpublished: true,
      warnings: [
        `Routes are unpublished: ${
          publication.hostCaddyfile
            ? `${publication.hostCaddyfile} does not import ${publication.proxyFile}`
            : `no host Caddyfile loads ${publication.proxyFile}`
        }. Run rig doctor.`,
      ],
    };
  } catch (error) {
    return {
      unpublished: false,
      warnings: [
        `Route publication could not be checked: ${asRigError(error).message}`,
      ],
    };
  }
}

/** A recovery record whose operation this daemon is still running is a live deploy, not an abandoned one. */
export function transitionInProgress(
  target: Pick<TargetRecord, "recovery">,
  inProgress: (operationId: string) => boolean,
): boolean {
  return (
    target.recovery?.operationId !== undefined &&
    inProgress(target.recovery.operationId)
  );
}
