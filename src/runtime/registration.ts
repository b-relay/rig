import type { RuntimeCommand } from "../daemon/protocol";
import type { ProjectRecord, TargetRecord } from "../domain/runtime";
import type { RuntimeDependencies } from "./contracts";
import { RigError, failureCauses } from "../domain/errors";
import { observeTargets } from "./status";
import { planTarget } from "./targets";
/** A registration changes only while nothing of the Project runs, is meant to run, or is mid-recovery. */
async function assertTargetsStopped(
  targets: TargetRecord[],
  deps: RuntimeDependencies,
): Promise<void> {
  const reports = await observeTargets(
    targets,
    deps.observations,
    deps.observationBudgetMs,
    deps.observationDeadline,
  );
  if (
    targets.some(
      (t) => t.desired === "running" || t.recovery || t.destructionPending,
    ) ||
    reports.some((t) =>
      t.components.some(
        (c) => c.kind === "managed" && !["stopped", "failed"].includes(c.state),
      ),
    )
  )
    throw new RigError(
      "PROJECT_ACTIVE",
      "Project registration can only change while every Target is stopped.",
      "Stop all Targets and retry.",
    );
}
/** Removes the registration and its stopped local/live records; Previews own data and must be destroyed first.
 * Returns a warning for every live workspace and data root left on disk. */
export async function forgetProject(
  project: ProjectRecord,
  targets: TargetRecord[],
  deps: RuntimeDependencies,
): Promise<string[]> {
  await assertTargetsStopped(targets, deps);
  const previews = targets.filter((t) => t.kind === "preview");
  if (previews.length)
    throw new RigError(
      "PROJECT_TARGETS",
      `Project '${project.name}' still has ${previews.length} Preview${previews.length === 1 ? "" : "s"}: ${previews.map((t) => t.branch ?? t.name).join(", ")}.`,
      `Run rig down preview <branch> --destroy for each Preview, then rig forget ${project.name}.`,
      { previews: previews.map((t) => t.name) },
    );
  await deps.store.update((state) => {
    state.projects = state.projects.filter((p) => p.id !== project.id);
    state.targets = state.targets.filter((t) => t.projectId !== project.id);
  });
  return targets
    .filter((t) => t.kind === "live")
    .map(
      (t) =>
        `Target ${t.name} was forgotten, but its workspace at ${t.plan.workspacePath} and data under ${t.plan.dataRoot} were not deleted.`,
    );
}
export async function updateRegistration(
  command: RuntimeCommand,
  project: ProjectRecord,
  targets: TargetRecord[],
  deps: RuntimeDependencies,
): Promise<"renamed" | "repointed" | "unchanged"> {
  // Renaming to the registered name is a no-op unless the config drifted from it.
  if (
    command.action === "rename" &&
    command.newName === project.name &&
    (await deps.documents.read(project.repoPath)).config.name === project.name
  )
    return "unchanged";
  await assertTargetsStopped(targets, deps);
  if (command.action === "rename") {
    if (
      !command.newName ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(command.newName)
    )
      throw new RigError(
        "PROJECT_NAME",
        "A valid new Project name is required.",
        "Use letters, digits, dashes, or underscores.",
      );
    if (
      (await deps.store.read()).projects.some(
        (p) => p.name === command.newName && p.id !== project.id,
      )
    )
      throw new RigError(
        "PROJECT_CONFLICT",
        "The new Project name is already registered.",
        "Choose another name.",
      );
    const document = await deps.documents.rename(project, command.newName);
    try {
      await deps.store.update((state) => {
        const current = state.projects.find((p) => p.id === project.id)!;
        current.name = command.newName!;
        current.configPath = document.path;
        for (const target of state.targets.filter(
          (t) => t.projectId === project.id,
        ))
          target.plan.project = command.newName!;
      });
    } catch (error) {
      try {
        await deps.documents.rename(
          { ...project, name: command.newName },
          project.name,
        );
      } catch (recoveryError) {
        throw new RigError(
          "RENAME_ROLLBACK",
          "Project rename could not restore its previous config and remote.",
          "Inspect the registered name, Project config, and Rig remote before retrying.",
          {},
          failureCauses(error, recoveryError),
        );
      }
      throw error;
    }
    project.name = command.newName;
    return "renamed";
  } else {
    if (!command.newPath)
      throw new RigError(
        "PROJECT_PATH",
        "A new repository path is required.",
        "Pass the new directory.",
      );
    const { repoPath, document, gitRequired } = await deps.documents.discover(
      command.newPath,
    );
    if (gitRequired)
      throw new RigError(
        "GIT_REQUIRED",
        `The new directory ${repoPath} is not a Git working repository.`,
        `Repoint to the moved repository, or run rig init --create-git in ${repoPath} for a new Project.`,
      );
    if (document.config.name !== project.name)
      throw new RigError(
        "PROJECT_IDENTITY",
        "The new repository declares a different Project.",
        "Choose the directory containing this Project config.",
      );
    if (
      (await deps.store.read()).projects.some(
        (p) => p.id !== project.id && p.repoPath === repoPath,
      )
    )
      throw new RigError(
        "PROJECT_CONFLICT",
        "Another Project already owns the new directory.",
        "Choose an unregistered directory.",
      );
    // The same planning as `up`: the moved config's ports are reserved against
    // every other Target, and recorded ports are kept where the config allows.
    const replanned = new Map<string, TargetRecord>();
    for (const target of targets.filter((t) => t.kind === "local"))
      replanned.set(
        target.id,
        await planTarget(
          {
            command: { ...command, target: "local" },
            project: { ...project, repoPath },
            document,
            existing: target,
          },
          deps,
        ),
      );
    await deps.store.update((state) => {
      const current = state.projects.find((p) => p.id === project.id)!;
      current.repoPath = repoPath;
      current.configPath = document.path;
      state.targets = state.targets.map(
        (target) => replanned.get(target.id) ?? target,
      );
    });
    return "repointed";
  }
}
