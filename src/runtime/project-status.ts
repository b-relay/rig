import type {
  ProjectStatusReport,
  StatusSelection,
} from "../domain/project-status";
import type { ConfigDocument, ProjectConfig } from "../config/types";
import type { ServiceStopView } from "../domain/operation-progress";
import type { ProjectRecord, TargetRecord } from "../domain/runtime";
import { asRigError } from "../domain/errors";
import { targetSelector } from "../domain/target-selector";
import type { RuntimeDependencies } from "./contracts";
import {
  observeTargets,
  type ComponentReport,
  type TargetReport,
} from "./status";
import { previewName, selectTarget } from "./targets";
import {
  PREVIEW_SELECTOR,
  patchedSettings,
  proxyUpstream,
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
  > & {
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
  );
  if (configWarning) warnings.push(configWarning);
  if (document) {
    for (const role of ["working", "stable"] as const) {
      const definitions = configuredComponents(document.config, role);
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
          components: definitions,
        });
    }
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
function configuredComponents(
  config: ProjectConfig,
  role: "working" | "stable",
): ComponentReport[] {
  const settings = patchedSettings(config, role);
  const routed =
    role === "stable" || rolePatch(config, role).domain !== undefined
      ? settings.domain?.replaceAll("${rig.target}", role)
      : undefined;
  const upstream = settings.proxy?.["/"]
    ? proxyUpstream(settings.proxy["/"])?.service
    : undefined;
  return [
    ...Object.entries(settings.services ?? {}).map(
      ([name, service]): ComponentReport => {
        const port = Object.values(service.ports ?? {})[0];
        return {
          name,
          kind: "managed",
          state: "configured",
          ...(typeof port === "number" ? { port } : {}),
          ...(upstream === name && routed && !routed.includes("${")
            ? { route: routed }
            : {}),
        };
      },
    ),
    ...Object.keys(settings.tools ?? {}).map((name): ComponentReport => ({
      name,
      kind: "installed",
      state: "configured",
    })),
  ];
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
