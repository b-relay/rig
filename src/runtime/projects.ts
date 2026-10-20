import { dirname, sep } from "node:path";
import type { RuntimeCommand } from "../daemon/protocol";
import type { ProjectRecord } from "../domain/runtime";
import type { ConfigDocument, ProjectConfig } from "../config/types";
import { RigError, failureCauses } from "../domain/errors";
import { ConfigError } from "../config/errors";
import type { DiscoverySearch, RuntimeDependencies } from "./contracts";
import { shellWord } from "../domain/target-selector";
/** The commands a Project's recorded state answers without its rig.yaml: stopping or destroying a Target, and reading its
 * status, logs and activity. */
const RECORDED_STATE_ACTIONS: ReadonlySet<RuntimeCommand["action"]> = new Set([
  "down",
  "destroy",
  "status",
  "logs",
  "activity",
]);
/** A current registration is authoritative; history is never a candidate path list. */
export async function selectProject(
  command: RuntimeCommand,
  deps: RuntimeDependencies,
  readConfig = true,
): Promise<{
  project: ProjectRecord;
  document?: ConfigDocument<ProjectConfig>;
  /** The checkout whose Branch "the current Branch" means: the directory the command ran in when
   * it selected the Project (a linked worktree keeps its own), else the registered directory. */
  checkout: string;
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
    if (!readConfig) return { project, checkout: project.repoPath };
    const document = await deps.documents
      .read(project.repoPath)
      .catch((error) => {
        if (registeredDirectoryMissing(error)) throw movedProject(project);
        throw error;
      });
    if (!adoptsConfigName(command, project, document))
      assertIdentity(project, document);
    return { project, document, checkout: project.repoPath };
  }
  if (!command.repoPath)
    throw new RigError(
      "PROJECT_REQUIRED",
      "Select a Project.",
      "Run inside a Project directory or pass --project.",
    );
  let found: Awaited<ReturnType<typeof deps.documents.discover>>;
  try {
    found = await deps.documents.discover(command.repoPath);
  } catch (error) {
    // A stop or a read of what was recorded still reaches the Project registered here when its rig.yaml cannot be read,
    // as --project does; anything that plans from rig.yaml keeps failing on it.
    const recorded = RECORDED_STATE_ACTIONS.has(command.action)
      ? workspaceOfFailure(error, state.projects)
      : undefined;
    if (!recorded) throw error;
    return { project: recorded, checkout: command.repoPath };
  }
  // A Project registered nearer than the config found has lost its own rig.yaml; what it recorded is its, not the outer
  // Project's, so a stop never falls through to an ancestor.
  const nearest = registeredWorkspace(state.projects, found.searched);
  if (
    RECORDED_STATE_ACTIONS.has(command.action) &&
    nearest &&
    nearest.repoPath !== found.repoPath &&
    within(nearest.repoPath, found.repoPath)
  )
    return { project: nearest, checkout: command.repoPath };
  const byName = state.projects.find(
    (p) => p.name === found.document.config.name,
  );
  // A registered directory whose config names an unregistered Project had its name edited; rename adopts the edit.
  const byPath = byName
    ? undefined
    : state.projects.find((p) => p.repoPath === found.repoPath);
  if (byPath) {
    if (adoptsConfigName(command, byPath, found.document))
      return {
        project: byPath,
        document: found.document,
        checkout: command.repoPath,
      };
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
  if (command.action !== "repoint" && project.repoPath !== found.repoPath)
    throw new RigError(
      "PROJECT_PATH_CONFLICT",
      `Project '${project.name}' is registered at ${project.repoPath}, not ${found.repoPath}.`,
      `Run rig repoint . from ${found.repoPath} to move the registration there, or run this command from ${project.repoPath}.`,
      { registeredPath: project.repoPath },
    );
  assertIdentity(project, found.document);
  return { project, document: found.document, checkout: command.repoPath };
}
/** The registered Project a failed discovery ran in: the nearest one around where it searched, whether its own rig.yaml
 * failed or is gone and an outer one failed instead. Undefined when none is registered there, or when the config that
 * failed lies nearer than it, which is another, unregistered Project's. */
function workspaceOfFailure(
  error: unknown,
  projects: readonly ProjectRecord[],
): ProjectRecord | undefined {
  if (!(error instanceof ConfigError)) return undefined;
  const { path, searched } = error.context;
  if (!isSearch(searched)) return undefined;
  const nearest = registeredWorkspace(projects, searched);
  if (!nearest || typeof path !== "string") return nearest;
  const failed = dirname(path);
  return failed !== nearest.repoPath && within(failed, nearest.repoPath)
    ? undefined
    : nearest;
}
/** The deepest Project registered between the repository root and where the search began; never one outside it. */
function registeredWorkspace(
  projects: readonly ProjectRecord[],
  searched: DiscoverySearch,
): ProjectRecord | undefined {
  return projects
    .filter(
      (p) =>
        within(p.repoPath, searched.repository) &&
        within(searched.from, p.repoPath),
    )
    .sort((a, b) => b.repoPath.length - a.repoPath.length)[0];
}
function isSearch(value: unknown): value is DiscoverySearch {
  const search = value as Partial<DiscoverySearch> | undefined;
  return (
    typeof search?.repository === "string" && typeof search.from === "string"
  );
}
/** `path` is `directory` or inside it. */
function within(path: string, directory: string): boolean {
  return path === directory || path.startsWith(directory + sep);
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
    `Run rig repoint <new path> --project ${shellWord(project.name)}, or rig repoint . from the moved repository.`,
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
  /** The config init would keep, when one already exists. */
  configPath?: string;
}
/** Writes the Project files and records the registration for an identity prepareRegistration accepted. Returns the
 * registration and the config document it was made from, so the caller can report on that document without reading it again. */
export async function registerProject(
  command: RuntimeCommand,
  identity: ProjectIdentity,
  deps: Pick<RuntimeDependencies, "documents" | "store" | "id" | "now">,
): Promise<{
  project: ProjectRecord;
  document: ConfigDocument<ProjectConfig>;
}> {
  const document = await deps.documents.initialize(command.repoPath!, command);
  const name = document.config.name;
  const repoPath = dirname(document.path);
  let result: ProjectRecord | undefined;
  try {
    if (name !== identity.name || repoPath !== identity.repoPath)
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
      "The Project config was preserved. Resolve the state error or registration conflict, then rerun rig init.",
      { repoPath, configPath: document.path },
      failureCauses(error),
    );
  }
  return { project: result!, document };
}
function assertRegistrationAvailable(
  projects: readonly ProjectRecord[],
  identity: ProjectIdentity,
): ProjectRecord | undefined {
  const existing = projects.find(
    (project) =>
      project.name === identity.name || project.repoPath === identity.repoPath,
  );
  if (
    existing &&
    (existing.name !== identity.name || existing.repoPath !== identity.repoPath)
  )
    throw new RigError(
      "PROJECT_CONFLICT",
      `Project '${existing.name}' is already registered at ${existing.repoPath}.`,
      existing.name === identity.name
        ? `Run rig repoint ${shellWord(identity.repoPath)} --project ${shellWord(existing.name)} to move it here, or ${anotherName(identity)}.`
        : `Run rig rename ${shellWord(identity.name)} --project ${shellWord(existing.name)} to rename the registered Project, or restore its config name.`,
      { registeredName: existing.name, registeredPath: existing.repoPath },
    );
  return existing;
}
/** How a second repository takes another name: its config decides when it has one. */
function anotherName(identity: ProjectIdentity): string {
  return identity.configPath
    ? `set another name in ${identity.configPath} and run rig init again`
    : `run rig init --project <other name> in ${identity.repoPath}`;
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
  return `Run rig rename ${shellWord(configName)} --project ${shellWord(registeredName)} to adopt the config name, or restore name: ${registeredName} in the config.`;
}
