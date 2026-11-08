import type { UsageWindow } from "../domain/usage-summary";
import type {
  ProjectStatusReport,
  StatusSelection,
} from "../domain/project-status";
import { deploymentHistory } from "../domain/deployments";
import { ConfigError } from "../config/errors";
import {
  PREVIEW_SELECTOR,
  TARGET_ROLES,
  targetOn,
} from "../config/target-roles";
import type {
  ActivityResult,
  BackupsResult,
  LogsResult,
  RuntimeCommand,
} from "../daemon/protocol";
import type {
  OperationRecord,
  ProjectRecord,
  RuntimeState,
  TargetRecord,
} from "../domain/runtime";
import { RigError } from "../domain/errors";
import type { RuntimeDependencies } from "./contracts";
import type { OperationQueries } from "./operation-coordinator";
import type { UsageMonitor } from "./usage-report";
import { projectStatus } from "./project-status";
import { selectProject } from "./projects";
import { assertTargetOn, selectTarget } from "./targets";
import { deployTargetError, missingTarget } from "./target-refusals";
import { backupReports } from "./backups";
import { assertLogServices } from "./log-services";

/* The reads of one selected Project: they take no scope and never wait. */

/** The Project selected by what `rig` sent, as `selectProject` resolves it. */
type Selection = Awaited<ReturnType<typeof selectProject>>;

/** `rig status` of the Project `selection` names, with what the running and waiting Operations say of its Targets. */
export function statusReader(
  deps: RuntimeDependencies,
  operations: OperationQueries,
): (selection: StatusSelection) => Promise<ProjectStatusReport> {
  return async (selection) => {
    const command = { ...selection, action: "status" as const };
    const { project } = await selectProject(command, deps, false);
    const state = await deps.store.read();
    return projectStatus(
      project,
      state.targets.filter((target) => target.projectId === project.id),
      selection,
      {
        ...deps,
        inProgress: operations.inProgress,
        stopping: operations.stopping,
        projectBusy: () => operations.projectBusy(project.id),
        serviceStops: (targetId) => operations.serviceStops(targetId),
        leftoverBuild: (target, signal) =>
          operations.building(target)
            ? Promise.resolve({ state: "stopped" })
            : deps.lifecycle.observePreparation(target, signal),
        ...(state.jobs ? { jobRecords: state.jobs } : {}),
        ...(state.backups ? { backupRecords: state.backups } : {}),
      },
    );
  };
}
/** What a deploy form needs before it asks anything: the Branches, and which Targets rig.yaml turns on. A selector names
 * the role it means under the daemon's own rule, and an off one is refused before anything is asked of the user. */
export async function deploymentContext(
  command: RuntimeCommand,
  { project, document, checkout }: Selection,
  deps: Pick<RuntimeDependencies, "sources" | "documents">,
): Promise<unknown> {
  let currentBranch: string | null;
  try {
    currentBranch = await deps.sources.currentBranch(checkout);
  } catch (error) {
    if (!(error instanceof RigError) || error.code !== "GIT_DETACHED")
      throw error;
    currentBranch = null;
  }
  const selected =
    command.target === undefined
      ? undefined
      : command.target === PREVIEW_SELECTOR
        ? "preview"
        : selectTarget(command).kind;
  // Refused here as the deploy itself refuses it, so nothing announces a deploy that cannot happen.
  if (selected === "working") throw deployTargetError(project.name);
  if (selected) assertTargetOn(document!.config, selected);
  return {
    project: project.name,
    repoPath: project.repoPath,
    productionBranch:
      document!.config.production_branch ??
      (await deps.documents.host()).deploy.production_branch,
    currentBranch,
    // Which Targets rig.yaml turns on, so a deploy form offers only those.
    on: Object.fromEntries(
      TARGET_ROLES.map((role) => [role, targetOn(document!.config, role)]),
    ),
    ...(selected ? { selected } : {}),
  };
}
/** Monitor's history of the Project's Targets. */
export async function projectUsage(
  command: RuntimeCommand,
  project: ProjectRecord,
  targets: readonly TargetRecord[],
  deps: Pick<RuntimeDependencies, "usage" | "now">,
): Promise<unknown> {
  return {
    project: project.name,
    targets: targets.map((each) => each.name),
    ...(await usage(deps).report({
      filter: { kind: "project", projectId: project.id },
      window: usageWindow(command, deps.now()),
    })),
  };
}
/** The Project's deployment history. */
export function projectDeployments(
  command: RuntimeCommand,
  project: ProjectRecord,
  targets: readonly TargetRecord[],
  state: Pick<RuntimeState, "deployments" | "activity">,
): unknown {
  return {
    project: project.name,
    deployments: deploymentHistory(
      state.deployments,
      project.id,
      command.lines ?? 100,
      targets,
      state.activity,
    ),
  };
}
/** The Project's backups: without a Target every Target's are listed; with one, only that Target's, whether or not it
 * still runs. */
export async function projectBackups(
  command: RuntimeCommand,
  project: ProjectRecord,
  targets: readonly TargetRecord[],
  state: Pick<RuntimeState, "backups">,
  deps: Pick<RuntimeDependencies, "backups">,
): Promise<BackupsResult> {
  const selected =
    command.target === undefined
      ? undefined
      : (({ kind, name }) =>
          targets.find((t) =>
            kind === "preview" ? t.name === name : t.kind === kind,
          ) ?? null)(selectTarget(command));
  return {
    project: project.name,
    backups: await backupReports(
      state,
      targets,
      {
        ...(selected === undefined ? {} : { target: selected?.id ?? "" }),
        ...(command.job ? { job: command.job } : {}),
      },
      deps,
    ),
  } satisfies BackupsResult;
}
/** A page of `target`'s logs; `name` is what the command selected, for a Target never recorded. */
export async function targetLogs(
  command: RuntimeCommand,
  project: ProjectRecord,
  target: TargetRecord | undefined,
  name: string,
  deps: Pick<RuntimeDependencies, "store" | "files">,
): Promise<LogsResult> {
  if (!target) throw missingTarget(command, name, project.name);
  // Checked on the first page only: a follow carries on when a deploy removes a Service it filters by.
  if (command.after === undefined)
    assertLogServices(
      target,
      command.logFilter,
      (await deps.store.read()).jobs,
    );
  const lines = command.lines ?? 100;
  // A first page reads one entry more than it keeps, so it can say older ones match too; the cursor is the
  // newest position either way.
  const asked = command.after === undefined ? lines + 1 : lines;
  const page = await deps.files.logs(
    target,
    command.after,
    asked,
    command.logFilter,
  );
  const more = page.entries.length > lines;
  return {
    project: project.name,
    target: target.name,
    ...page,
    ...(more ? { entries: page.entries.slice(-lines), more } : {}),
    ...(command.logFilter ? { filtered: true } : {}),
  } satisfies LogsResult;
}
/** Every record the requested Operation id (or prefix) names; otherwise the newest `lines` the filter keeps, with how
 * many it kept in all. */
export function selectActivity(
  records: readonly OperationRecord[],
  command: Pick<RuntimeCommand, "operation" | "lines" | "activityFilter">,
): { operations: OperationRecord[]; operation?: string; total?: number } {
  if (command.operation)
    return {
      operations: records.filter((record) =>
        record.id.startsWith(command.operation!),
      ),
      operation: command.operation,
    } satisfies ActivityResult;
  const filter = command.activityFilter ?? {};
  const since =
    filter.since === undefined ? undefined : Date.parse(filter.since);
  const until =
    filter.until === undefined ? undefined : Date.parse(filter.until);
  const kept = records.filter((record) => {
    const at = Date.parse(record.occurredAt);
    return (
      (filter.target === undefined || record.target === filter.target) &&
      (filter.action === undefined || record.action === filter.action) &&
      (filter.outcome === undefined || record.outcome === filter.outcome) &&
      (since === undefined || at >= since) &&
      (until === undefined || at <= until)
    );
  });
  return {
    operations: kept.slice(-(command.lines ?? 100)),
    total: kept.length,
  } satisfies ActivityResult;
}
/** An activity read from a directory that names no registered Project: the reason, with how to read another Project's or
 * every Project's instead. */
export function activityScopeError(error: unknown): unknown {
  const noProject =
    (error instanceof ConfigError && error.code === "missing_config") ||
    (error instanceof RigError && error.code === "PROJECT_MISSING");
  if (!noProject) return error;
  return new RigError(
    "PROJECT_REQUIRED",
    error.message,
    "Run rig activity inside a Project directory, pass --project <name>, or pass --all for every Project.",
  );
}
/** Monitor's history, or the failure a monitor read gets where rigd samples nothing. */
export function usage(deps: Pick<RuntimeDependencies, "usage">): UsageMonitor {
  if (deps.usage) return deps.usage;
  throw new RigError(
    "MONITOR_UNAVAILABLE",
    "This rigd does not sample CPU and memory.",
    "Upgrade rigd with rigd install, then try again.",
  );
}
/** The window a monitor read covers, in Unix seconds: the last hour when no `since` was given. Fails USAGE when `since`
 * is not before `until`. */
export function usageWindow(command: RuntimeCommand, now: string): UsageWindow {
  // Kept to the millisecond: a window starting between two samples must not take in the one before it.
  const seconds = (iso: string) => Date.parse(iso) / 1000;
  const since =
    command.window?.since === undefined
      ? seconds(now) - 3600
      : seconds(command.window.since);
  const until =
    command.window?.until === undefined
      ? undefined
      : seconds(command.window.until);
  if (until !== undefined && until <= since)
    throw new RigError(
      "USAGE",
      "The window's since is not before its until.",
      "Pass a since earlier than until.",
    );
  return { since, ...(until === undefined ? {} : { until }) };
}
