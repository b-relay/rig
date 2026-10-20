import { join, sep } from "node:path";
import type { EnvFileRef, TargetPlan } from "../config/types";
import type {
  PendingRename,
  ProjectRecord,
  RuntimeState,
} from "../domain/runtime";
import { RigError, failureCauses, failureReason } from "../domain/errors";
import { MAX_NAME_LENGTH, nameKey, nameProblem } from "../domain/names";
import type { RuntimeDependencies } from "./contracts";

/** What a rename did: the record as stored, and what the operator should know about the files it carried. */
export interface RenameResult {
  project: ProjectRecord;
  warnings: string[];
}
/** The registered Project other than `except` that holds `name` in any case: as its name, or as the name an unfinished
 * rename of it gives it, whose env files may already be there. Undefined when none does. */
export function nameHolder(
  projects: readonly ProjectRecord[],
  name: string,
  except?: string,
): { project: ProjectRecord; pending: boolean } | undefined {
  for (const project of projects) {
    if (project.id === except) continue;
    if (nameKey(project.name) === nameKey(name))
      return { project, pending: false };
    if (project.renaming && nameKey(project.renaming.to) === nameKey(name))
      return { project, pending: true };
  }
  return undefined;
}
/** Renames a stopped Project as one operation: its rig.yaml, its operator env directory, and its registration with every
 * recorded plan's Project name and env-file paths. Before anything changes, the rename is recorded on the registration
 * (`renaming`): the new name, which no other Project may take from then on, how the env directory is carried, and what
 * rig.yaml said. Every step can run again, so after a crash `rig rename <to>` finishes it and `rig rename <name>` undoes it;
 * no other rename starts meanwhile. A failure before the registration is saved puts rig.yaml and the env files back and
 * clears the record; a save that may have reached the disk is never undone. The caller holds the Project's scope and the
 * new name's, and has checked every Target is stopped. */
export async function renameProject(
  project: ProjectRecord,
  newName: string,
  deps: Pick<
    RuntimeDependencies,
    "store" | "documents" | "operatorEnv" | "root"
  >,
): Promise<RenameResult> {
  const problem = nameProblem(newName);
  if (problem)
    throw new RigError(
      "PROJECT_NAME",
      `The new Project name ${problem}.`,
      `Choose a name of 1 to ${MAX_NAME_LENGTH} letters, digits, dashes or underscores, starting with a letter or digit.`,
      { name: newName },
    );
  const current = (state: RuntimeState) =>
    state.projects.find((p) => p.id === project.id)!;
  // Its own name is never taken from it, even by a Project registered before names were compared without case.
  const assertFree = (state: RuntimeState) => {
    const holder =
      newName === project.name
        ? undefined
        : nameHolder(state.projects, newName, project.id);
    if (holder) throw nameTaken(holder, newName);
  };
  const state = await deps.store.read();
  assertFree(state);
  const sharedWith = state.projects
    .filter(
      (p) => p.id !== project.id && nameKey(p.name) === nameKey(project.name),
    )
    .map((p) => p.name);
  const pending = current(state).renaming;
  if (pending && newName !== pending.to && newName !== project.name)
    throw new RigError(
      "RENAME_PENDING",
      `Project '${project.name}' has an unfinished rename to '${pending.to}', so it cannot be renamed '${newName}' yet.`,
      `${pendingRenameAdvice(project, pending)} Then rename it again.`,
      { to: pending.to },
    );
  // Renaming to its own name undoes the pending rename, unless that rename was the repair of rig.yaml back to that name.
  if (pending && newName !== pending.to)
    return await undoRename(project, pending, deps);
  let record = pending;
  if (!record) {
    record = {
      to: newName,
      env:
        (await deps.operatorEnv?.plan({
          from: project.name,
          to: newName,
          sharedWith,
        })) ?? "none",
      config: (await deps.documents.read(project.repoPath)).config.name,
    };
    const begun = record;
    await deps.store.update((state) => {
      // Checked again in the write itself: an init running beside this rename may have taken the name since.
      assertFree(state);
      current(state).renaming = begun;
    });
  }
  const carried = record;
  const envRoot = join(deps.root, "env");
  const fail = async (error: unknown): Promise<never> => {
    await putBack(project, carried, error, deps);
    throw error;
  };
  let configPath: string;
  try {
    configPath = (await deps.documents.rename(project, newName)).path;
    await deps.operatorEnv?.carry({
      from: project.name,
      to: newName,
      how: carried.env,
    });
  } catch (error) {
    return await fail(error);
  }
  try {
    await deps.store.update((state) => {
      assertFree(state);
      const record = current(state);
      const formerNames = formerNamesAfter(record, newName);
      if (formerNames) record.formerNames = formerNames;
      record.name = newName;
      record.configPath = configPath;
      delete record.renaming;
      for (const target of state.targets)
        if (target.projectId === project.id)
          target.plan = renamedPlan(
            target.plan,
            envRoot,
            project.name,
            newName,
          );
    });
  } catch (error) {
    // A write can fail after it committed (the state file renamed into place, then its directory not synced): the rename
    // is saved then, and undoing its files would leave the env files under a name nothing uses. The state says which.
    const saved = await deps.store
      .read()
      .then((state) => {
        const record = current(state);
        return record.name === newName && record.renaming === undefined;
      })
      .catch(() => undefined);
    if (saved === true)
      return {
        project: renamed(project, newName, configPath),
        warnings: [
          ...copyWarnings(project, newName, carried, sharedWith, envRoot),
          `The rename was saved, but confirming it on disk failed: ${failureReason(error)} If the Host lost power since, run rig list; should ${project.name} be listed again, run rig rename ${newName} --project ${project.name} to finish the rename.`,
        ],
      };
    if (saved === undefined)
      throw new RigError(
        "RENAME_UNCERTAIN",
        `Project '${project.name}' may or may not be renamed '${newName}': its rig.yaml and env files have the new name, saving the registration failed, and the state could not be read back.`,
        `Run rig list. If ${project.name} is still listed, run rig rename ${newName} --project ${project.name} to finish the rename.`,
        { from: project.name, to: newName },
        failureCauses(error),
      );
    return await fail(error);
  }
  return {
    project: renamed(project, newName, configPath),
    warnings: copyWarnings(project, newName, carried, sharedWith, envRoot),
  };
}
/** `rig rename <name>` of a Project with an unfinished rename: rig.yaml and the env files are put back, then the record of
 * the rename is cleared. */
async function undoRename(
  project: ProjectRecord,
  pending: PendingRename,
  deps: Pick<RuntimeDependencies, "store" | "documents" | "operatorEnv">,
): Promise<RenameResult> {
  await putBack(project, pending, undefined, deps);
  return {
    project: { ...project, renaming: undefined },
    warnings: [],
  };
}
/** The commands that finish an unfinished rename, and undo it when it is a rename: one that only repairs rig.yaml back to
 * the registered name is finished by the same command, and has nothing to undo. A registered name no selector carries
 * (one over 128 characters, from before the limit) is left out: the rename is finished from the repository, and cannot
 * be undone to that name. */
export function pendingRenameAdvice(
  project: Pick<ProjectRecord, "name" | "repoPath">,
  pending: Pick<PendingRename, "to">,
): string {
  const { name } = project;
  if (nameProblem(name))
    return `Run rig rename ${pending.to} in ${project.repoPath} to finish the rename.`;
  return pending.to === name
    ? `Run rig rename ${name} --project ${name} to finish writing name: ${name} to rig.yaml.`
    : `Run rig rename ${pending.to} --project ${name} to finish the rename, or rig rename ${name} --project ${name} to undo it.`;
}
/** Puts rig.yaml and the env files back as they were before `pending` began, then clears its record, so nothing is left
 * half done. Fails RENAME_ROLLBACK, keeping the record, when something cannot be put back: running the rename again
 * finishes it, or undoes it. `error` is the failure that called for it, if any. */
async function putBack(
  project: ProjectRecord,
  pending: PendingRename,
  error: unknown,
  deps: Pick<RuntimeDependencies, "store" | "documents" | "operatorEnv">,
): Promise<void> {
  try {
    await deps.operatorEnv?.undo({
      from: project.name,
      to: pending.to,
      how: pending.env,
    });
    if (
      (await deps.documents.read(project.repoPath)).config.name !==
      pending.config
    )
      await deps.documents.rename(
        { ...project, name: pending.to },
        pending.config,
      );
    await deps.store.update((state) => {
      const record = state.projects.find((p) => p.id === project.id);
      if (record?.renaming?.to === pending.to) delete record.renaming;
    });
  } catch (recovery) {
    // Env files in two places are named as they are; nothing was put back, and the record stays.
    if (recovery instanceof RigError && recovery.code === "ENV_SPLIT")
      throw recovery;
    throw new RigError(
      "RENAME_ROLLBACK",
      `Project '${project.name}' was not renamed '${pending.to}', and its rig.yaml or env files could not all be put back.`,
      pendingRenameAdvice(project, pending),
      { from: project.name, to: pending.to },
      error === undefined
        ? failureCauses(recovery)
        : failureCauses(error, recovery),
    );
  }
}
function renamed(
  project: ProjectRecord,
  name: string,
  configPath: string,
): ProjectRecord {
  const { renaming: _, ...rest } = project;
  const formerNames = formerNamesAfter(project, name);
  return { ...rest, name, configPath, ...(formerNames ? { formerNames } : {}) };
}
/** Pure: `project`'s former names once it is renamed `name`, its current one last; undefined when the name stays. */
function formerNamesAfter(
  project: Pick<ProjectRecord, "name" | "formerNames">,
  name: string,
): string[] | undefined {
  if (project.name === name) return undefined;
  return [
    ...(project.formerNames ?? []).filter(
      (former) => former !== project.name && former !== name,
    ),
    project.name,
  ];
}
/** The rename's new name is another registered Project's, a spelling of it that differs only in case, or the name an
 * unfinished rename gives another Project. */
function nameTaken(
  holder: { project: ProjectRecord; pending: boolean },
  wanted: string,
): RigError {
  const { project, pending } = holder;
  return new RigError(
    "PROJECT_CONFLICT",
    pending
      ? `Project '${project.name}' has an unfinished rename to '${project.renaming!.to}', so its env files may be under that name already.`
      : project.name === wanted
        ? "The new Project name is already registered."
        : `The new Project name differs only in case from Project '${project.name}', and a Mac's disk does not tell them apart: they would share operator env files and Tool paths.`,
    pending
      ? `Choose another name, or finish or undo that rename first (rig rename ${project.renaming!.to} --project ${project.name}, or rig rename ${project.name} --project ${project.name}).`
      : "Choose another name.",
    { registeredName: project.name },
  );
}
/** What the operator should know of a copied env directory: the Projects that share the original keep it. */
function copyWarnings(
  project: ProjectRecord,
  to: string,
  carried: PendingRename,
  sharedWith: readonly string[],
  envRoot: string,
): string[] {
  return carried.env === "copy"
    ? [
        `Its operator env files in ${join(envRoot, project.name)} were also Project ${sharedWith.map((name) => `'${name}'`).join(", ")}'s, whose name differs only in case; they stay there, and ${to} now has its own copy in ${join(envRoot, to)}. Remove from each what belongs to the other Project.`,
      ]
    : [];
}
/** Pure: `plan` recorded under Project `to`: its name, and every operator convention env file under `<envRoot>/<from>`
 * moved under `<envRoot>/<to>`. A file rig.yaml lists (`env_file`) is left as written: it must exist, so a moved one fails
 * loudly when the Target starts. */
export function renamedPlan(
  plan: TargetPlan,
  envRoot: string,
  from: string,
  to: string,
): TargetPlan {
  const prefix = join(envRoot, from) + sep;
  const moved = (files: EnvFileRef[] | undefined) =>
    files?.map((file) =>
      !file.required && file.path.startsWith(prefix)
        ? { ...file, path: join(envRoot, to, file.path.slice(prefix.length)) }
        : file,
    );
  return {
    ...plan,
    project: to,
    ...(plan.envFiles ? { envFiles: moved(plan.envFiles) } : {}),
    components: plan.components.map((component) =>
      component.envFiles
        ? { ...component, envFiles: moved(component.envFiles) }
        : component,
    ),
    ...(plan.jobs
      ? {
          jobs: plan.jobs.map((job) =>
            job.envFiles ? { ...job, envFiles: moved(job.envFiles) } : job,
          ),
        }
      : {}),
  };
}
