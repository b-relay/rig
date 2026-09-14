import { dirname, resolve } from "node:path";
import type { RuntimeCommand } from "../daemon/protocol";
import type { ProjectRecord } from "../domain/runtime";
import type { ConfigDocument, ProjectConfig } from "../config/types";
import { RigError, failureCauses } from "../domain/errors";
import { ConfigError } from "../config/errors";
import type { RuntimeDependencies } from "./contracts";
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
    const document = await deps.documents
      .read(project.repoPath)
      .catch((error) => {
        if (registeredDirectoryMissing(error)) throw movedProject(project);
        throw error;
      });
    if (!adoptsConfigName(command, project, document))
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
  const byName = state.projects.find(
    (p) => p.name === found.document.config.name,
  );
  // A registered directory whose config names an unregistered Project had its name edited; rename adopts the edit.
  const byPath = byName
    ? undefined
    : state.projects.find(
        (p) => resolve(p.repoPath) === resolve(found.repoPath),
      );
  if (byPath) {
    if (adoptsConfigName(command, byPath, found.document))
      return { project: byPath, document: found.document };
    throw identityDrift(byPath, found.document);
  }
  const project = byName;
  if (!project)
    throw new RigError(
      "PROJECT_MISSING",
      `Project '${found.document.config.name}' is not registered.`,
      "Run rig init in this Project directory.",
    );
  // repoint is how a registration follows a moved repository, so the config name alone selects it.
  if (
    command.action !== "repoint" &&
    resolve(project.repoPath) !== resolve(found.repoPath)
  )
    throw new RigError(
      "PROJECT_PATH_CONFLICT",
      `Project '${project.name}' is registered at ${project.repoPath}, not ${found.repoPath}.`,
      `Run rig repoint . from ${found.repoPath} to move the registration there, or run this command from ${project.repoPath}.`,
      { registeredPath: project.repoPath },
    );
  assertIdentity(project, found.document);
  return { project, document: found.document };
}
/** A config read that found no directory at all, as opposed to a directory without a config. */
export function registeredDirectoryMissing(error: unknown): boolean {
  return error instanceof ConfigError && error.code === "missing_directory";
}
/** The registration outlived its directory; only repoint can reconcile them. */
export function movedProject(
  project: Pick<ProjectRecord, "name" | "repoPath">,
): RigError {
  return new RigError(
    "PROJECT_MOVED",
    `Project '${project.name}' is registered at ${project.repoPath}, which no longer exists.`,
    `Run rig repoint <new path> --project ${project.name}, or rig repoint . from the moved repository.`,
    { registeredPath: project.repoPath },
  );
}
/** Everything init checks before it touches the repository: a directory was given, the
 * Project it would create has an identity, and no registered Project conflicts with it. */
export async function prepareRegistration(
  command: RuntimeCommand,
  deps: Pick<RuntimeDependencies, "documents" | "store">,
): Promise<ProjectIdentity> {
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
  return identity;
}
export interface ProjectIdentity {
  repoPath: string;
  name: string;
}
/** Writes the Project files and records the registration for an identity prepareRegistration accepted. */
export async function registerProject(
  command: RuntimeCommand,
  identity: ProjectIdentity,
  deps: Pick<RuntimeDependencies, "documents" | "store" | "id" | "now">,
): Promise<ProjectRecord> {
  const document = await deps.documents.initialize(command.repoPath!, command);
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
  } catch (error) {
    throw new RigError(
      "REGISTRATION_INCOMPLETE",
      "Project files were initialized, but registration could not be completed.",
      "The Project config and Rig remote were preserved. Resolve the state error or registration conflict, then rerun rig init.",
      { repoPath, configPath: document.path },
      failureCauses(error),
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
      `Project '${existing.name}' is already registered at ${existing.repoPath}.`,
      existing.name === identity.name
        ? `Run rig repoint ${identity.repoPath} --project ${existing.name} to move it here, or initialize with another Project name.`
        : `Run rig rename ${identity.name} --project ${existing.name} to rename the registered Project, or restore its config name.`,
      { registeredName: existing.name, registeredPath: existing.repoPath },
    );
  return existing;
}
export function assertIdentity(
  project: Pick<ProjectRecord, "name" | "repoPath">,
  document: ConfigDocument<ProjectConfig>,
): void {
  if (document.config.name !== project.name)
    throw identityDrift(project, document);
}
/** `rig rename <new>` on a config that already declares `<new>` adopts the edit instead of refusing it. */
function adoptsConfigName(
  command: RuntimeCommand,
  project: Pick<ProjectRecord, "name">,
  document: ConfigDocument<ProjectConfig>,
): boolean {
  return (
    command.action === "rename" &&
    document.config.name !== project.name &&
    command.newName === document.config.name
  );
}
/** The config's name and the registration disagree; rename adopts the config, or the config is restored. */
export function identityDrift(
  project: Pick<ProjectRecord, "name" | "repoPath">,
  document: ConfigDocument<ProjectConfig>,
): RigError {
  return new RigError(
    "PROJECT_IDENTITY",
    `The config at ${project.repoPath} names Project '${document.config.name}', but it is registered as '${project.name}'.`,
    identityDriftHint(project.name, document.config.name),
    { project: project.name, path: document.path },
  );
}
export function identityDriftHint(
  registeredName: string,
  configName: string,
): string {
  return `Run rig rename ${configName} --project ${registeredName} to adopt the config name, or restore name: ${registeredName} in the config.`;
}
