import type { RuntimeCommand } from "../daemon/protocol";
import type { ProjectRecord, TargetRecord } from "../domain/runtime";
import type { RuntimeDependencies } from "./contracts";
import { RigError, failureCauses } from "../domain/errors";
import { observeTargets } from "./status";
import { recordedPorts } from "./ports";
export async function updateRegistration(
  command: RuntimeCommand,
  project: ProjectRecord,
  targets: TargetRecord[],
  deps: RuntimeDependencies,
) {
  const reports = await observeTargets(targets, deps.observations);
  if (
    targets.some((t) => t.recovery) ||
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
  } else {
    if (!command.newPath)
      throw new RigError(
        "PROJECT_PATH",
        "A new repository path is required.",
        "Pass the new directory.",
      );
    const { repoPath, document } = await deps.documents.discover(
      command.newPath,
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
    const plans = new Map(
      targets
        .filter((t) => t.kind === "local")
        .map((target) => [
          target.id,
          deps.documents.resolve({
            config: document.config,
            target: "local",
            workspacePath: repoPath,
            dataRoot: target.plan.dataRoot,
            deploymentName: target.name,
            assignedPorts: recordedPorts(target.plan.components),
          }),
        ]),
    );
    await deps.store.update((state) => {
      const current = state.projects.find((p) => p.id === project.id)!;
      current.repoPath = repoPath;
      current.configPath = document.path;
      for (const target of state.targets) {
        const plan = plans.get(target.id);
        if (plan) target.plan = plan;
      }
    });
  }
}
