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
import { targetName } from "./targets";
import {
  identityDriftHint,
  movedProject,
  registeredDirectoryMissing,
} from "./projects";
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
  const selected =
    command.target || command.deployment
      ? targets.filter((t) => t.name === targetName(command))
      : targets;
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
  let document: ConfigDocument<ProjectConfig> | undefined;
  try {
    document = await deps.documents.read(project.repoPath);
    if (document.config.name !== project.name) {
      warnings.push(
        `Current configuration names Project '${document.config.name}', not '${project.name}'; showing recorded Targets. ${identityDriftHint(project.name, document.config.name)}`,
      );
      document = undefined;
    }
  } catch (error) {
    const failure = registeredDirectoryMissing(error)
      ? movedProject(project)
      : asRigError(error);
    warnings.push(`${failure.message} ${failure.hint}`);
  }
  if (document) {
    const kinds: ("local" | "live")[] = command.target
      ? command.target === "preview"
        ? []
        : [command.target]
      : ["local", "live"];
    for (const kind of kinds) {
      const definitions = configuredComponents(document.config, kind);
      const report = reports.find((t) => t.name === kind);
      if (report) {
        const names = new Set(report.components.map((c) => c.name));
        report.components.push(
          ...definitions.filter((c) => !names.has(c.name)),
        );
      } else
        reports.push({
          name: kind,
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
  kind: "local" | "live",
): ComponentReport[] {
  const lane = kind === "local" ? config.local : config.live;
  return Object.entries(config.components).map(([name, base]) => {
    const component = { ...base, ...lane?.components?.[name] };
    const componentKind =
      "mode" in component
        ? component.mode === "installed"
          ? "installed"
          : "managed"
        : "uses" in component && component.uses === "sqlite"
          ? "persistent"
          : "managed";
    const domain = lane?.domain ?? config.domain;
    return {
      name,
      kind: componentKind,
      state: "configured",
      ...("port" in component && component.port
        ? { port: component.port }
        : {}),
      ...(lane?.proxy?.upstream === name && domain && !domain.includes("${")
        ? { route: domain }
        : {}),
    };
  });
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
