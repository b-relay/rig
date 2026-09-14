import { isDeepStrictEqual } from "node:util";
import type { ProjectRecord, TargetRecord } from "../domain/runtime";
import type { ConfigDocument, ProjectConfig } from "../config/types";
import type { RuntimeDependencies } from "./contracts";
import { RigError } from "../domain/errors";
import { observeTargets, OBSERVATION_EXPIRED } from "./status";
import type { ComponentReport } from "../domain/project-status";
import type { DoctorCheck } from "../daemon/offline-doctor";
import { ConfigError } from "../config/errors";
import { recordedPorts } from "./ports";
import { transitionInProgress } from "./project-status";
import {
  identityDriftHint,
  movedProject,
  registeredDirectoryMissing,
} from "./projects";

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
    "inspectHost" | "assertOwnershipReady" | "store" | "notices"
  >,
) {
  const checks = await deps.inspectHost();
  checks.unshift({ name: "rigd", ok: true, message: "Daemon is reachable." });
  for (const notice of deps.notices?.() ?? [])
    checks.push({
      name: `rigd/${notice.channel}`,
      ok: false,
      message: `${notice.message} (${notice.count} ${notice.count === 1 ? "time" : "times"} since ${notice.firstAt}, last ${notice.lastAt}). ${notice.consequence}`,
      reason: `${notice.channel}-failing`,
      hint: notice.hint,
    });
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
  // One acquisition serves identity and every Working copy comparison, so a concurrent edit cannot split one report across revisions.
  const repository = await acquireDocument(
    project.repoPath,
    project.name,
    deps.documents,
  );
  checks.push(projectConfigCheck(project, repository));
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
    checks.push(
      await configCheck(
        project,
        target,
        target.kind === "local"
          ? repository
          : // A deployed Target is planned from the committed config in its checkout; the working copy never reaches it.
            await acquireDocument(
              target.plan.workspacePath,
              project.name,
              deps.documents,
            ),
        deps,
      ),
    );
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
/** One read of a config document, kept apart by why it cannot serve a comparison. */
type AcquiredDocument =
  | { outcome: "usable"; document: ConfigDocument<ProjectConfig> }
  | { outcome: "foreign"; document: ConfigDocument<ProjectConfig> }
  | { outcome: "invalid"; failure: ConfigError }
  | { outcome: "unreadable"; failure: Error };
/** Reads one config document once; a parser rejection and a failed read are different findings. */
async function acquireDocument(
  path: string,
  projectName: string,
  documents: Pick<RuntimeDependencies["documents"], "read">,
): Promise<AcquiredDocument> {
  try {
    const document = await documents.read(path);
    return document.config.name === projectName
      ? { outcome: "usable", document }
      : { outcome: "foreign", document };
  } catch (error) {
    if (error instanceof ConfigError)
      return { outcome: "invalid", failure: error };
    return {
      outcome: "unreadable",
      failure: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
const UNREADABLE_HINT =
  "Inspect the Project directory and file permissions, then run doctor again.";
function projectConfigCheck(
  project: Pick<ProjectRecord, "name" | "repoPath">,
  repository: AcquiredDocument,
): DoctorCheck {
  const name = "project-config";
  if (
    repository.outcome === "invalid" &&
    registeredDirectoryMissing(repository.failure)
  ) {
    const moved = movedProject(project);
    return {
      name,
      ok: false,
      message: moved.message,
      reason: "directory-missing",
      hint: moved.hint,
    };
  }
  switch (repository.outcome) {
    case "usable":
      return { name, ok: true, message: "Project config is valid." };
    case "foreign":
      return {
        name,
        ok: false,
        message: `The config names Project '${repository.document.config.name}', but it is registered as '${project.name}'.`,
        reason: "identity-drift",
        hint: identityDriftHint(project.name, repository.document.config.name),
      };
    case "invalid":
      return {
        name,
        ok: false,
        message: repository.failure.message,
        reason: "config-invalid",
        hint: repository.failure.hint,
      };
    case "unreadable":
      return {
        name,
        ok: false,
        message: `Project config could not be read. ${repository.failure.message}`,
        reason: "config-unreadable",
        hint: UNREADABLE_HINT,
      };
  }
}
/** Compares the acquired config, resolved against the recorded ports, with the recorded plan.
 * A config that parses but adds components the record has no port for is drift, not an invalid config. */
async function configCheck(
  project: Pick<ProjectRecord, "name">,
  target: TargetRecord,
  source: AcquiredDocument,
  deps: Pick<RuntimeDependencies, "documents">,
): Promise<DoctorCheck> {
  const name = `${target.name}/config`;
  const label =
    target.kind === "local"
      ? "Current configuration"
      : "The deployed revision's configuration";
  const failing = (
    message: string,
    reason: string,
    hint: string,
  ): DoctorCheck => ({ name, ok: false, message, reason, hint });
  const drift = (message: string) =>
    failing(
      message,
      "config-drift",
      target.kind === "local"
        ? "Run rig restart local (or rig down local, then rig up local) to apply the current configuration."
        : `Run rig deploy ${deployArguments(target)} --force to re-record the plan from the deployed revision; a same-Commit deploy without --force leaves the Target unchanged.`,
    );
  const invalid = (failure: ConfigError) =>
    failing(
      `Current Target policy could not be resolved. ${failure.message}`,
      "config-invalid",
      failure.hint,
    );
  switch (source.outcome) {
    case "unreadable":
      return failing(
        `${label} could not be read. ${source.failure.message}`,
        "config-unreadable",
        target.kind === "local"
          ? UNREADABLE_HINT
          : `Inspect the Target's checkout at ${target.plan.workspacePath}, or run rig deploy ${deployArguments(target)} --force to prepare it again.`,
      );
    case "invalid":
      return invalid(source.failure);
    case "foreign":
      return failing(
        `${label} names Project '${source.document.config.name}', not '${project.name}'; its policy was not compared.`,
        "identity-drift",
        identityDriftHint(project.name, source.document.config.name),
      );
    case "usable":
      break;
  }
  const { config } = source.document;
  const recorded = new Set(target.plan.components.map((c) => c.name));
  const added = Object.keys(config.components).filter(
    (component) => !recorded.has(component),
  );
  try {
    const current = deps.documents.resolve({
      config,
      target: target.kind,
      workspacePath: target.plan.workspacePath,
      dataRoot: target.plan.dataRoot,
      deploymentName: target.name,
      branchSlug: target.plan.branchSlug,
      branch: target.branch,
      commit: target.commit,
      assignedPorts: recordedPorts(target.plan.components),
    });
    return isDeepStrictEqual(current, target.plan)
      ? {
          name,
          ok: true,
          message:
            target.kind === "local"
              ? "Recorded Target policy matches current configuration."
              : "Recorded Target policy matches the deployed revision's configuration.",
        }
      : drift(`${label} differs from the recorded Target policy.`);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return error.code === "missing_port" && added.length
      ? drift(
          `${label} adds components the recorded Target policy does not have (${added.join(", ")}).`,
        )
      : invalid(error);
  }
}
/** The deploy arguments that select this deployed Target again. */
function deployArguments(
  target: Pick<TargetRecord, "kind" | "name" | "branch">,
): string {
  return target.kind === "live"
    ? "live"
    : `preview ${target.branch ?? target.name}`;
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
