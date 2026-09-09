import { dirname, resolve } from "node:path";
import type { RuntimeCommand } from "../daemon/protocol";
import type { ProjectRecord } from "../domain/runtime";
import type { ConfigDocument, ProjectConfig } from "../config/types";
import { RigError } from "../domain/errors";
import type { RuntimeDependencies } from "./contracts";
export interface SelectedProject {
  project: ProjectRecord;
  document: ConfigDocument<ProjectConfig>;
}
/** A current registration is authoritative; history is never a candidate path list. */
export async function selectProject(
  command: RuntimeCommand,
  deps: RuntimeDependencies,
  readConfig = true,
): Promise<{
  project: ProjectRecord;
  document?: ConfigDocument<ProjectConfig>;
}> {
  const state = await deps.store.read();
  if (command.project) {
    const project = state.projects.find((p) => p.name === command.project);
    if (!project)
      throw new RigError(
        "PROJECT_MISSING",
        `Project '${command.project}' is not registered.`,
        "Run rig init in the Project directory.",
      );
    if (!readConfig) return { project };
    const document = await deps.documents.read(project.repoPath);
    assertIdentity(project, document);
    return { project, document };
  }
  if (!command.repoPath)
    throw new RigError(
      "PROJECT_REQUIRED",
      "Select a Project.",
      "Run inside a Project directory or pass --project.",
    );
  const found = await deps.documents.discover(command.repoPath);
  const project = state.projects.find(
    (p) => p.name === found.document.config.name,
  );
  if (!project)
    throw new RigError(
      "PROJECT_MISSING",
      `Project '${found.document.config.name}' is not registered.`,
      "Run rig init in this Project directory.",
    );
  if (resolve(project.repoPath) !== resolve(found.repoPath))
    throw new RigError(
      "PROJECT_PATH_CONFLICT",
      "This Project is registered at another directory.",
      "Use rig repoint to update the registered directory.",
      { registeredPath: project.repoPath },
    );
  assertIdentity(project, found.document);
  return { project, document: found.document };
}
export async function registerProject(
  command: RuntimeCommand,
  deps: Pick<RuntimeDependencies, "documents" | "store" | "id" | "now">,
): Promise<ProjectRecord> {
  if (!command.repoPath)
    throw new RigError(
      "PATH_REQUIRED",
      "Project initialization needs a directory.",
      "Pass --path or run in the intended repository.",
    );
  const identity = await deps.documents.identifyInitialization(
    command.repoPath,
    command,
  );
  assertRegistrationAvailable((await deps.store.read()).projects, identity);
  const document = await deps.documents.initialize(command.repoPath, command);
  const name = document.config.name;
  const repoPath = dirname(document.path);
  let result: ProjectRecord | undefined;
  try {
    if (
      name !== identity.name ||
      resolve(repoPath) !== resolve(identity.repoPath)
    )
      throw new RigError(
        "PROJECT_IDENTITY",
        "Project identity changed during initialization.",
        "Check the Project config and retry.",
      );
    await deps.store.update((state) => {
      const existing = assertRegistrationAvailable(state.projects, {
        name,
        repoPath,
      });
      if (existing) {
        result = existing;
        return;
      }
      result = {
        id: deps.id(),
        name,
        repoPath,
        configPath: document.path,
        createdAt: deps.now(),
      };
      state.projects.push(result);
    });
  } catch {
    throw new RigError(
      "REGISTRATION_INCOMPLETE",
      "Project files were initialized, but registration could not be completed.",
      "The Project config and Rig remote were preserved. Resolve the state error or registration conflict, then rerun rig init.",
      { repoPath, configPath: document.path },
    );
  }
  return result!;
}
function assertRegistrationAvailable(
  projects: readonly ProjectRecord[],
  identity: { name: string; repoPath: string },
): ProjectRecord | undefined {
  const existing = projects.find(
    (project) =>
      project.name === identity.name ||
      resolve(project.repoPath) === resolve(identity.repoPath),
  );
  if (
    existing &&
    (existing.name !== identity.name ||
      resolve(existing.repoPath) !== resolve(identity.repoPath))
  )
    throw new RigError(
      "PROJECT_CONFLICT",
      "A different Project registration already uses this name or path.",
      "Use explicit rename or repoint to change an existing Project.",
    );
  return existing;
}
export function assertIdentity(
  project: ProjectRecord,
  document: ConfigDocument<ProjectConfig>,
): void {
  if (document.config.name !== project.name)
    throw new RigError(
      "PROJECT_IDENTITY",
      "The registered Project name differs from its config.",
      "Use rig rename to change the Project identity.",
      { project: project.name, path: document.path },
    );
}
