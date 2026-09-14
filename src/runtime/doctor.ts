import { isDeepStrictEqual } from "node:util";
import type { ProjectRecord, TargetRecord } from "../domain/runtime";
import type { RuntimeDependencies } from "./contracts";
import { RigError } from "../domain/errors";
import { observeTargets, OBSERVATION_EXPIRED } from "./status";
import type { ComponentReport } from "../domain/project-status";
import type { DoctorCheck } from "../daemon/offline-doctor";
import { ConfigError } from "../config/errors";
import { recordedPorts } from "./ports";
import { transitionInProgress } from "./project-status";

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
  deps: Pick<
    RuntimeDependencies,
    "inspectHost" | "assertOwnershipReady" | "store"
  >,
) {
  const checks = await deps.inspectHost();
  checks.unshift({ name: "rigd", ok: true, message: "Daemon is reachable." });
  try {
    await deps.store.read();
  } catch (error) {
    checks.push({
      name: "runtime-state",
      ok: false,
      message:
        error instanceof RigError
          ? error.message
          : "Runtime state is unreadable.",
      reason: "state-corrupt",
      hint:
        error instanceof RigError
          ? error.hint
          : "Inspect the runtime state file under the Rig root.",
    });
  }
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
      hint:
        error instanceof RigError
          ? error.hint
          : "Complete the explicit provider adoption before runtime control.",
    });
  }
  return checks;
}
export async function doctor(
  project: ProjectRecord,
  targets: TargetRecord[],
  deps: RuntimeDependencies & { inProgress(operationId: string): boolean },
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
    if (target.deploymentIncomplete && !target.recovery)
      checks.push({
        name: `${target.name}/deployment`,
        ok: false,
        message:
          "The last deploy did not complete; its executables and route were not committed.",
        reason: "deployment-incomplete",
        hint: "Run up for this Target to finish it, or redeploy the same commit.",
      });
    if (target.destructionPending)
      checks.push({
        name: `${target.name}/destruction`,
        ok: false,
        message:
          "Preview destruction is incomplete; its stopped inventory is retained.",
        reason: "destruction-pending",
        hint: "Retry down preview --destroy for this Preview to finish cleanup.",
      });
    if (transitionInProgress(target, deps.inProgress))
      checks.push({
        name: `${target.name}/deploy`,
        ok: true,
        message: `A deploy is in progress (operation ${target.recovery!.operationId}).`,
        reason: "deployment-in-progress",
      });
    else if (target.recovery)
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
              hint:
                target.kind === "local"
                  ? "Run rig restart local (or rig down local, then rig up local) to apply the current configuration."
                  : "Deploy to apply the current configuration; lifecycle commands preserve the recorded plan.",
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
  // A Preview awaiting destruction has already retired its inventory; the destruction check names it, its components are not failures.
  const reports = ownershipKnown
    ? await observeTargets(
        targets.filter(
          (target) => !target.recovery && !target.destructionPending,
        ),
        deps.observations,
      )
    : [];
  for (const report of reports)
    for (const component of report.components)
      checks.push(componentCheck(report.name, component));
  return { ok: checks.every((c) => c.ok), checks };
}
const HEALTHY_STATES = new Set([
  "running",
  "healthy",
  "ready",
  "installed",
  "stopped",
]);
/** A failing component's check keeps the observation's own reason and exit code; the hint follows what was observed. */
export function componentCheck(
  targetName: string,
  component: ComponentReport,
): DoctorCheck {
  const name = `${targetName}/${component.name}`;
  if (HEALTHY_STATES.has(component.state))
    return { name, ok: true, message: `Component is ${component.state}.` };
  const reason =
    component.reason ??
    (component.exitCode === undefined
      ? undefined
      : `The process exited with code ${component.exitCode}.`);
  return {
    name,
    ok: false,
    message: `Component is ${component.state}.${reason ? ` ${reason}` : ""}`,
    reason: component.state,
    hint: componentHint(targetName, component),
  };
}
function componentHint(targetName: string, component: ComponentReport): string {
  if (component.reason === OBSERVATION_EXPIRED)
    return "Run doctor again; the observation did not finish within the status budget.";
  if (component.state === "unknown")
    return "Inspect daemon state (rig activity, rigd status) before acting on this component.";
  if (component.state === "failed" || component.exitCode !== undefined)
    return `Inspect the Target logs (rig logs ${targetName}) for why it exited.`;
  if (component.state === "unhealthy")
    return `The health check failed; inspect the Target logs (rig logs ${targetName}) and the health URL.`;
  if (component.state === "missing")
    return "The installed artifact or storage is absent; run up or redeploy this Target.";
  return "Inspect Target logs and provider configuration.";
}
