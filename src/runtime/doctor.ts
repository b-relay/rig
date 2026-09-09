import { isDeepStrictEqual } from "node:util";
import type { ProjectRecord, TargetRecord } from "../domain/runtime";
import type { RuntimeDependencies } from "./contracts";
import { RigError } from "../domain/errors";
import { observeTargets } from "./status";
import { ConfigError } from "../config/errors";
import { recordedPorts } from "./ports";

/** Host checks and ownership evidence remain available when Project discovery fails. */
export async function hostDoctor(
  deps: RuntimeDependencies,
  discoveryFailure?: unknown,
) {
  const checks = await inspectRuntimeHost(deps);
  if (
    discoveryFailure !== undefined &&
    !(
      discoveryFailure instanceof ConfigError &&
      discoveryFailure.code === "missing_config"
    )
  )
    checks.push({
      name: "project-config",
      ok: false,
      message:
        discoveryFailure instanceof ConfigError
          ? discoveryFailure.message
          : "Project discovery failed.",
      reason: "config-invalid",
      hint:
        discoveryFailure instanceof ConfigError
          ? discoveryFailure.hint
          : "Inspect the Project directory.",
    });
  return { ok: checks.every((check) => check.ok), checks };
}

async function inspectRuntimeHost(
  deps: Pick<RuntimeDependencies, "inspectHost" | "assertOwnershipReady">,
) {
  const checks = await deps.inspectHost();
  checks.unshift({ name: "rigd", ok: true, message: "Daemon is reachable." });
  try {
    await deps.assertOwnershipReady();
  } catch (error) {
    checks.push({
      name: "runtime-ownership",
      ok: false,
      message:
        error instanceof RigError
          ? error.message
          : "Runtime ownership is unknown.",
      reason: "ownership-pending",
      hint: "Complete the explicit provider adoption before runtime control.",
    });
  }
  return checks;
}
export async function doctor(
  project: ProjectRecord,
  targets: TargetRecord[],
  deps: RuntimeDependencies,
) {
  const checks = await inspectRuntimeHost(deps);
  try {
    const document = await deps.documents.read(project.repoPath);
    const ok = document.config.name === project.name;
    checks.push(
      ok
        ? {
            name: "project-config",
            ok: true,
            message: "Project config is valid.",
          }
        : {
            name: "project-config",
            ok: false,
            message: "Project identity differs from registration.",
            reason: "identity-drift",
            hint: "Use rig rename.",
          },
    );
  } catch {
    checks.push({
      name: "project-config",
      ok: false,
      message: "Project config is missing or invalid.",
      reason: "config-invalid",
      hint: "Correct the registered Project configuration.",
    });
  }
  for (const target of targets) {
    if (target.recovery)
      checks.push({
        name: `${target.name}/recovery`,
        ok: false,
        message:
          "Deployment recovery is unresolved; Component ownership is uncertain.",
        reason: "deployment-recovery",
        hint: "Run down for this Target to stop both recorded plans before retrying deployment.",
      });
    try {
      const document = await deps.documents.read(project.repoPath);
      const current = deps.documents.resolve({
        config: document.config,
        target: target.kind,
        workspacePath: target.plan.workspacePath,
        dataRoot: target.plan.dataRoot,
        deploymentName: target.name,
        branchSlug: target.plan.branchSlug,
        branch: target.branch,
        commit: target.commit,
        assignedPorts: recordedPorts(target.plan.components),
      });
      const ok = isDeepStrictEqual(current, target.plan);
      checks.push(
        ok
          ? {
              name: `${target.name}/config`,
              ok: true,
              message: "Recorded Target policy matches current configuration.",
            }
          : {
              name: `${target.name}/config`,
              ok: false,
              message:
                "Current configuration differs from the recorded Target policy.",
              reason: "config-drift",
              hint: "Deploy to apply the current configuration; lifecycle commands preserve the recorded plan.",
            },
      );
    } catch {
      checks.push({
        name: `${target.name}/config`,
        ok: false,
        message: "Current Target policy could not be resolved.",
        reason: "config-invalid",
        hint: "Correct Project configuration before deploying.",
      });
    }
  }
  const ownershipKnown = !checks.some(
    (check) => check.name === "runtime-ownership" && !check.ok,
  );
  const reports = ownershipKnown
    ? await observeTargets(
        targets.filter((target) => !target.recovery),
        deps.observations,
      )
    : [];
  for (const report of reports)
    for (const component of report.components) {
      const ok = [
        "running",
        "healthy",
        "ready",
        "installed",
        "stopped",
      ].includes(component.state);
      checks.push(
        ok
          ? {
              name: `${report.name}/${component.name}`,
              ok: true,
              message: `Component is ${component.state}.`,
            }
          : {
              name: `${report.name}/${component.name}`,
              ok: false,
              message: `Component is ${component.state}.`,
              reason: component.state,
              hint: "Inspect Target logs and provider configuration.",
            },
      );
    }
  return { ok: checks.every((c) => c.ok), checks };
}
