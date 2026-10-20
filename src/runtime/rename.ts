import { join, sep } from "node:path";
import type { EnvFileRef, TargetPlan } from "../config/types";
import type { ProjectRecord, RuntimeState } from "../domain/runtime";
import { RigError, failureCauses, failureReason } from "../domain/errors";
import { MAX_NAME_LENGTH, nameKey, nameProblem } from "../domain/names";
import type { EnvCarry, RuntimeDependencies } from "./contracts";

/** What a rename did: the record as stored, and what the operator should know about the files it carried. */
export interface RenameResult {
  project: ProjectRecord;
  warnings: string[];
}
/** Renames a stopped Project as one operation: its rig.yaml, its operator env directory, and its registration with every
 * recorded plan's Project name and env-file paths. The rename is first marked on the registration (`renaming`), so one
 * interrupted by a crash is finished or replaced by the next rename, which looks for the env files under that name too.
 * A failure before the registration is saved puts the env files and rig.yaml back; a save that may have reached the disk
 * is never undone. The caller holds the Project's scope and the new name's, and has checked every Target is stopped. */
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
  const holder = (projects: readonly ProjectRecord[]) =>
    projects.find(
      (p) => p.id !== project.id && nameKey(p.name) === nameKey(newName),
    );
  const state = await deps.store.read();
  const taken = holder(state.projects);
  if (taken) throw nameTaken(taken.name, newName);
  const current = (state: RuntimeState) =>
    state.projects.find((p) => p.id === project.id)!;
  const pending = current(state).renaming;
  // Every name its env files may be under: its own, then the one an interrupted rename began to give it.
  const from = [
    project.name,
    ...(pending && pending !== project.name ? [pending] : []),
  ];
  const sharedWith = state.projects
    .filter(
      (p) =>
        p.id !== project.id &&
        from.some((name) => nameKey(name) === nameKey(p.name)),
    )
    .map((p) => p.name);
  // The name rig.yaml has now, which a failed rename puts back.
  const configName = (await deps.documents.read(project.repoPath)).config.name;
  await deps.store.update((state) => {
    // Checked again in the write itself: an init running beside this rename may have taken the name since.
    const taken = holder(state.projects);
    if (taken) throw nameTaken(taken.name, newName);
    current(state).renaming = newName;
  });
  let configPath: string | undefined;
  let carry: EnvCarry = { kind: "none" };
  /** Puts back what this rename changed before the registration was saved, then fails with `error`; RENAME_ROLLBACK when
   * something cannot be put back, and the mark stays, so the next rename finds the env files under either name. */
  const undo = async (error: unknown): Promise<never> => {
    try {
      await deps.operatorEnv?.undo(carry);
      // rig.yaml gets back the name it had; a rename that adopted a hand edit leaves it.
      if (configPath !== undefined && configName !== newName)
        await deps.documents.rename({ ...project, name: newName }, configName);
    } catch (recovery) {
      throw new RigError(
        "RENAME_ROLLBACK",
        `Project '${project.name}' was not renamed, and its rig.yaml or env files could not be put back.`,
        `Run rig rename ${newName} --project ${project.name} again to finish the rename; it finds the env files under either name.`,
        { from: project.name, to: newName },
        failureCauses(error, recovery),
      );
    }
    await deps.store
      .update((state) => {
        if (current(state).renaming === newName) delete current(state).renaming;
      })
      .catch(() => {});
    throw error;
  };
  try {
    configPath = (await deps.documents.rename(project, newName)).path;
    carry =
      (await deps.operatorEnv?.carry({ from, to: newName, sharedWith })) ??
      carry;
  } catch (error) {
    await undo(error);
  }
  const envRoot = join(deps.root, "env");
  const path = configPath!;
  try {
    await deps.store.update((state) => {
      const taken = holder(state.projects);
      if (taken) throw nameTaken(taken.name, newName);
      const record = current(state);
      const formerNames = formerNamesAfter(record, newName);
      if (formerNames) record.formerNames = formerNames;
      record.name = newName;
      record.configPath = path;
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
        project: renamed(project, newName, path),
        warnings: [
          ...carryWarnings(carry, envRoot),
          `The rename was saved, but confirming it on disk failed: ${failureReason(error)} If the Host lost power since, run rig list; should ${project.name} be listed again, run rig rename ${newName} --project ${project.name} again.`,
        ],
      };
    if (saved === undefined)
      throw new RigError(
        "RENAME_UNCERTAIN",
        `Project '${project.name}' may or may not be renamed '${newName}': its rig.yaml and env files have the new name, saving the registration failed, and the state could not be read back.`,
        `Run rig list. If ${project.name} is still listed, run rig rename ${newName} --project ${project.name} again to finish the rename.`,
        { from: project.name, to: newName },
        failureCauses(error),
      );
    await undo(error);
  }
  return {
    project: renamed(project, newName, path),
    warnings: carryWarnings(carry, envRoot),
  };
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
/** The rename's new name is another registered Project's, or differs from it only in case. */
function nameTaken(registered: string, wanted: string): RigError {
  return new RigError(
    "PROJECT_CONFLICT",
    registered === wanted
      ? "The new Project name is already registered."
      : `The new Project name differs only in case from Project '${registered}', and a Mac's disk does not tell them apart: they would share operator env files and Tool paths.`,
    "Choose another name.",
    { registeredName: registered },
  );
}
/** What the operator should know of a copied env directory: the other Project keeps the original. */
function carryWarnings(carry: EnvCarry, envRoot: string): string[] {
  return carry.kind === "copied"
    ? [
        `Its operator env files in ${join(envRoot, carry.from)} were also Project '${carry.sharedWith}''s, whose name differs only in case; they stay there for it, and ${carry.to} now has its own copy in ${join(envRoot, carry.to)}. Remove from each what belongs to the other Project.`,
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
