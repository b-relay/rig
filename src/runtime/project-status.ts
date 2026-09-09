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
} from "./status";
import { targetName } from "./targets";
/** Adds configured-only capabilities without interpreting configuration as runtime evidence. */
export async function projectStatus(
  project: Pick<ProjectRecord, "name" | "repoPath">,
  targets: readonly TargetRecord[],
  command: StatusSelection,
  deps: Pick<RuntimeDependencies, "assertOwnershipReady" | "observations"> & {
    documents: Pick<RuntimeDependencies["documents"], "read">;
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
        route: target.plan.domain,
        state: "unknown",
        components: target.plan.components.map((c) => ({
          name: c.name,
          kind: c.kind,
          state: "unknown",
          reason: ownershipFailure,
        })),
      }))
    : await observeTargets(selected, deps.observations);
  let document: ConfigDocument<ProjectConfig> | undefined;
  try {
    document = await deps.documents.read(project.repoPath);
    if (document.config.name !== project.name) {
      document = undefined;
      warnings.push(
        "Current Project configuration has a different identity; showing recorded Targets.",
      );
    }
  } catch (error) {
    const failure = asRigError(error);
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
    if (target.recovery) {
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
  return { project: project.name, targets: reports, warnings };
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
