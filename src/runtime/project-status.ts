import type {
  ProjectStatusReport,
  StatusSelection,
} from "../domain/project-status";
import type { ConfigDocument, ProjectConfig } from "../config/types";
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
import { targetSelector } from "../domain/target-selector";
import type { RuntimeDependencies } from "./contracts";
import {
  hostnameFields,
  observeTargets,
  type ComponentReport,
  type TargetReport,
} from "./status";
import { roleHostname, roleServiceDomains } from "../config/hostnames";
import { previewName, selectTarget } from "./targets";
import {
  PREVIEW_SELECTOR,
  patchedSettings,
  proxyUpstream,
  defaultProxy,
  rolePatch,
  targetOn,
} from "../config/schema";
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
/** Adds configured-only capabilities without interpreting configuration as runtime evidence. */
export async function projectStatus(
  project: Pick<ProjectRecord, "name" | "repoPath">,
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
    /** Whether an Operation is waiting for this Target's Services to exit right now. */
    stopping?(targetId: string): boolean;
    /** The Services of this Target an Operation is waiting on right now, with when each is killed. */
    serviceStops?(targetId: string): ServiceStopView[];
  },
): Promise<ProjectStatusReport> {
  let configWarning: string | undefined;
  let document: ConfigDocument<ProjectConfig> | undefined;
  try {
    document = await deps.documents.read(project.repoPath);
    if (document.config.name !== project.name) {
      configWarning = `Current configuration names Project '${document.config.name}', not '${project.name}'; showing recorded Targets. ${identityDriftHint(project.name, document.config.name)}`;
      document = undefined;
    }
  } catch (error) {
    const failure = registeredDirectoryMissing(error)
      ? movedProject(project)
      : asRigError(error);
    configWarning = `${failure.message} ${failure.hint}`;
  }
  const selects = targetSelection(command);
  const selected = targets.filter(selects);
  const warnings: string[] = [];
  const reports: TargetReport[] = await observeTargets(
    selected,
    deps.observations,
    deps.observationBudgetMs,
    deps.observationDeadline,
    deps.healthResults,
  );
  if (configWarning) warnings.push(configWarning);
  if (document) {
    for (const role of ["working", "stable"] as const) {
      const configured = configuredTarget(document.config, role);
      const definitions = configured.components;
      const report = reports.find((t) => t.kind === role);
      if (report) {
        // An off Target shows what it recorded, not what the config would add to it.
        if (!targetOn(document.config, role)) continue;
        const known = new Set(report.components.map((c) => c.name));
        report.components.push(
          ...definitions.filter((c) => !known.has(c.name)),
        );
      }
      // A Target nothing has recorded is listed only while rig.yaml turns it on. A recorded one is listed either way, so a
      // Target the config turned off while it ran can still be seen, stopped and destroyed.
      else if (
        targetOn(document.config, role) &&
        !targets.some((t) => t.kind === role) &&
        selects({ kind: role, name: role })
      )
        reports.push({
          name: role,
          kind: role,
          state: "configured",
          ...(configured.hostnames.length
            ? { hostnames: configured.hostnames }
            : {}),
          components: definitions,
        });
    }
  }
  // A job's runs are recorded, not observed: status reads them, and counts the next run from now.
  const now = deps.now ? Date.parse(deps.now()) : Date.now();
  for (const target of selected) {
    const report = reports.find(
      (r) => r.kind === target.kind && r.name === target.name,
    );
    const jobs = jobReports(
      target,
      deps.jobRecords,
      now,
      { timeZone: deps.timeZone ?? hostTimeZone },
      document ? targetOn(document.config, target.kind) : undefined,
      deps.backupRecords,
    );
    if (report && jobs) report.jobs = jobs;
  }
  // A stop in progress is a phase of an Operation, not something observation can see.
  for (const target of selected)
    if (deps.stopping?.(target.id)) {
      const report = reports.find(
        (r) => r.kind === target.kind && r.name === target.name,
      );
      if (!report) continue;
      report.state = "stopping";
      for (const stop of deps.serviceStops?.(target.id) ?? []) {
        const component = report.components.find(
          (c) => c.name === stop.service,
        );
        if (component) {
          component.state = "stopping";
          component.killAt = stop.killAt;
        }
      }
    }
  for (const target of selected)
    if (transitionInProgress(target, deps.inProgress))
      warnings.push(
        `${target.name}: deploy in progress (operation ${target.recovery!.operationId}).`,
      );
    else if (target.recovery) {
      const report = reports.find((r) => r.name === target.name)!;
      report.state = "unknown";
      report.components = report.components.map((c) => ({
        ...c,
        state: "unknown",
        reason: "Deployment recovery is unresolved.",
      }));
      warnings.push(
        `${target.name} has an unresolved deployment transition; run rig down ${targetSelector(target)} to stop both recorded plans.`,
      );
    }
  for (const target of selected)
    if (target.deploymentIncomplete && !target.recovery)
      warnings.push(
        `${target.name}: the last deploy did not complete; run rig up ${targetSelector(target)} to finish it, or redeploy.`,
      );
  for (const target of selected)
    if (target.destructionPending)
      warnings.push(
        `${target.name}: Preview destruction is incomplete; its stopped inventory is retained. Run rig down ${targetSelector(target)} --destroy to finish cleanup.`,
      );
  warnings.push(...(await markUnpublishedRoutes(reports, deps.inspectProxy)));
  return { project: project.name, targets: reports, warnings };
}
/** A route the host Caddy never loads is shown, but never presented as served. */
async function markUnpublishedRoutes(
  reports: TargetReport[],
  inspectProxy: RuntimeDependencies["inspectProxy"],
): Promise<string[]> {
  const routed = reports.filter(
    (report) => report.route || report.components.some((c) => c.route),
  );
  if (!routed.length) return [];
  try {
    const publication = await inspectProxy();
    if (publication.state !== "unpublished") return [];
    for (const report of routed) report.routePublished = false;
    return [
      `Routes are unpublished: ${
        publication.hostCaddyfile
          ? `${publication.hostCaddyfile} does not import ${publication.proxyFile}`
          : `no host Caddyfile loads ${publication.proxyFile}`
      }. Run rig doctor.`,
    ];
  } catch (error) {
    return [
      `Route publication could not be checked: ${asRigError(error).message}`,
    ];
  }
}
/** What rig.yaml gives a working or stable Target nothing has recorded: its Services and Tools, and every hostname it
 * would serve, by the same per-role rule planning uses. */
function configuredTarget(
  config: ProjectConfig,
  role: "working" | "stable",
): { components: ComponentReport[]; hostnames: string[] } {
  const settings = patchedSettings(config, role);
  const named = (pattern: string) => pattern.replaceAll("${rig.target}", role);
  const routed = roleHostname(
    config.domain,
    rolePatch(config, role).domain,
    role,
  );
  const domain = routed && named(routed.pattern);
  const proxy =
    settings.proxy ??
    (domain !== undefined ? defaultProxy(settings.services) : undefined);
  const root = proxy?.["/"]
    ? proxyUpstream(proxy["/"], settings.services ?? {})
    : undefined;
  const upstream = root && "service" in root ? root.service : undefined;
  const own = roleServiceDomains(
    config.services,
    rolePatch(config, role).services,
    settings.services,
    role,
  ).map((entry) => ({
    service: entry.service,
    hostname: named(entry.pattern),
  }));
  // Two settings that meet only once ${rig.target} is replaced are refused when the Target is planned; until then each
  // hostname is listed once.
  const reaching = (name: string) => [
    ...new Set([
      ...(upstream === name && domain ? [domain] : []),
      ...own.filter((entry) => entry.service === name).map((e) => e.hostname),
    ]),
  ];
  return {
    components: [
      ...Object.entries(settings.services ?? {}).map(
        ([name, service]): ComponentReport => {
          const port = Object.values(service.ports ?? {})[0];
          return {
            name,
            kind: "managed",
            state: "configured",
            ...(typeof port === "number" ? { port } : {}),
            ...hostnameFields(reaching(name)),
          };
        },
      ),
      ...Object.keys(settings.tools ?? {}).map((name): ComponentReport => ({
        name,
        kind: "installed",
        state: "configured",
      })),
    ],
    hostnames: [
      ...new Set([
        ...(domain && upstream ? [domain] : []),
        ...own.map((entry) => entry.hostname),
      ]),
    ],
  };
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
