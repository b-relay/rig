import type {
  ProjectStatusReport,
  StatusSelection,
} from "../domain/project-status";
import type { ConfigDocument, ProjectConfig } from "../config/types";
import type { ProjectRecord, TargetRecord } from "../domain/runtime";
import { asRigError } from "../domain/errors";
import type { RuntimeDependencies } from "./contracts";
import {
  observeTargets,
  type ComponentReport,
  type TargetReport,
  deploymentFlags,
} from "./status";
import { previewName, selectTarget } from "./targets";
import {
  PREVIEW_SELECTOR,
  patchedSettings,
  proxyUpstream,
  targetNames,
} from "../config/schema";
import {
  identityDriftHint,
  movedProject,
  registeredDirectoryMissing,
} from "./projects";
/** Which Targets a status selector means: every Target without one, one Preview by name, or the Working copy or Stable
 * Target by the same naming rule every other command uses, so an unknown name rejects TARGET_UNKNOWN instead of reporting nothing. */
function targetSelection(
  command: StatusSelection,
  configured: Parameters<typeof selectTarget>[1],
  recorded: readonly Pick<TargetRecord, "kind" | "name">[],
): (target: Pick<TargetRecord, "kind" | "name">) => boolean {
  if (command.target === PREVIEW_SELECTOR || command.deployment) {
    const name = previewName(command);
    return (target) => target.kind === "preview" && target.name === name;
  }
  if (!command.target) return () => true;
  const { kind } = selectTarget(command, configured, recorded);
  return (target) => target.kind === kind;
}
/** Adds configured-only capabilities without interpreting configuration as runtime evidence. */
export async function projectStatus(
  project: Pick<ProjectRecord, "name" | "repoPath">,
  targets: readonly TargetRecord[],
  command: StatusSelection,
  deps: Pick<
    RuntimeDependencies,
    | "assertOwnershipReady"
    | "observations"
    | "observationBudgetMs"
    | "observationDeadline"
    | "inspectProxy"
  > & {
    documents: Pick<RuntimeDependencies["documents"], "read">;
    /** Whether the daemon is executing this operation right now. */
    inProgress(operationId: string): boolean;
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
  const selects = targetSelection(
    command,
    document && targetNames(document.config),
    targets,
  );
  const selected = targets.filter(selects);
  const warnings: string[] = [];
  let ownershipFailure: string | undefined;
  try {
    await deps.assertOwnershipReady();
  } catch (error) {
    ownershipFailure = asRigError(error).message;
    warnings.push(ownershipFailure);
  }
  const reports: TargetReport[] = ownershipFailure
    ? selected.map((target) => ({
        name: target.name,
        kind: target.kind,
        branch: target.branch,
        commit: target.commit,
        ...deploymentFlags(target),
        route: target.plan.domain,
        state: "unknown",
        components: target.plan.components.map((c) => ({
          name: c.name,
          kind: c.kind,
          state: "unknown",
          reason: ownershipFailure,
        })),
      }))
    : await observeTargets(
        selected,
        deps.observations,
        deps.observationBudgetMs,
        deps.observationDeadline,
      );
  if (configWarning) warnings.push(configWarning);
  if (document) {
    const names = targetNames(document.config);
    for (const [role, kind] of [
      ["working", "local"],
      ["stable", "live"],
    ] as const) {
      const definitions = configuredComponents(document.config, role);
      // A recorded Target keeps reporting under its recorded name until it is planned from the renamed config.
      const report = reports.find((t) => t.kind === kind);
      if (report) {
        const known = new Set(report.components.map((c) => c.name));
        report.components.push(
          ...definitions.filter((c) => !known.has(c.name)),
        );
      } else if (
        !targets.some((t) => t.kind === kind) &&
        selects({ kind, name: names[role] })
      )
        reports.push({
          name: names[role],
          kind,
          state: "configured",
          components: definitions,
        });
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
        `${target.name} has an unresolved deployment transition; run down to stop both recorded plans.`,
      );
    }
  for (const target of selected)
    if (target.deploymentIncomplete && !target.recovery)
      warnings.push(
        `${target.name}: the last deploy did not complete; run up to finish it or redeploy.`,
      );
  for (const target of selected)
    if (target.destructionPending)
      warnings.push(
        `${target.name}: Preview destruction is incomplete; its stopped inventory is retained. Run down preview ${target.branch ?? target.name} --destroy to finish cleanup.`,
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
    role === "stable" || config.targets?.[role]?.domain
      ? settings.domain
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
