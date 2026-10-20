import { dirname, join } from "node:path";
import type { RuntimeCommand } from "../daemon/protocol";
import type { ProjectRecord, TargetRecord } from "../domain/runtime";
import type { RuntimeDependencies } from "./contracts";
import { rigCommand } from "../domain/rig-command";
import { shellWord } from "../domain/target-selector";
import { RigError, failureCauses, failureReason } from "../domain/errors";
import { observeTargets } from "./status";
import { keepPublishedNames, planTarget } from "./targets";
/** A registration changes only while nothing of the Project runs, is meant to run, or is mid-recovery. */
async function assertTargetsStopped(
  targets: TargetRecord[],
  deps: RuntimeDependencies,
): Promise<void> {
  assertRecordedStopped(targets);
  // A job run may outlive its Target's Services, as after a deploy; the Project is active until it ends.
  if (
    (await deps.store.read()).jobs?.some(
      (record) =>
        record.running && targets.some((target) => target.id === record.target),
    )
  )
    throw projectActive();
  const reports = await observeTargets(
    targets,
    deps.observations,
    deps.observationBudgetMs,
    deps.observationDeadline,
    deps.healthResults,
  );
  if (
    reports.some((t) =>
      t.components.some(
        (c) => c.kind === "managed" && !["stopped", "failed"].includes(c.state),
      ),
    )
  )
    throw projectActive();
}
/** Rejects PROJECT_ACTIVE when a Target is recorded as meant to run or mid-transition. Reads the records only, so a
 * registration change can refuse at once instead of waiting for the Project's operations to finish. */
export function assertRecordedStopped(
  targets: readonly Pick<
    TargetRecord,
    "desired" | "recovery" | "destructionPending"
  >[],
): void {
  if (
    targets.some(
      (t) => t.desired === "running" || t.recovery || t.destructionPending,
    )
  )
    throw projectActive();
}
function projectActive(): RigError {
  return new RigError(
    "PROJECT_ACTIVE",
    "Project registration can only change while every Target is stopped.",
    "Stop all Targets and retry.",
  );
}
/** Removes the registration and its stopped working and stable records; Previews own data and must be destroyed first.
 * Every route its Targets own is withdrawn first, confirmed in the proxy: a route left behind would be keyed by a Target
 * nothing records any more and would hold its hostnames from every later owner (#336). When a route cannot be withdrawn
 * (Caddy unreachable, a reload refused) the forget is refused with that failure and nothing changes; when the records
 * cannot be removed, the routes are published again. Its published Tools stay in `<RIG_ROOT>/bin` untouched (#343): the
 * write that drops the records releases them, so the next Target that publishes a Tool of the same name takes it over
 * while its bytes are the ones Rig published. Nothing else is changed for them, so nothing about them needs undoing when
 * the write fails. Returns a warning for every live workspace, data root and Tool left on disk. */
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
      `Destroy ${previews.length === 1 ? "it" : "them"} with ${previews.map((target) => rigCommand("down", { target }, "--destroy")).join(", ")}, then run rig forget ${shellWord(project.name)}.`,
      { previews: previews.map((t) => t.name) },
    );
  let withdrawal;
  try {
    withdrawal = await deps.lifecycle.withdrawRoutes(targets);
  } catch (error) {
    throw notForgotten(project, error);
  }
  // Its backups stay on disk, as its data does; their records go, since nothing could reach them by a forgotten Project.
  const kept = new Set<string>();
  try {
    await deps.store.update((state) => {
      state.projects = state.projects.filter((p) => p.id !== project.id);
      state.targets = state.targets.filter((t) => t.projectId !== project.id);
      for (const backup of state.backups ?? [])
        if (backup.project === project.id)
          kept.add(dirname(dirname(dirname(backup.path))));
      if (kept.size)
        state.backups = state.backups!.filter(
          (backup) => backup.project !== project.id,
        );
    });
  } catch (error) {
    // A write can fail after it committed (the state file renamed into place, then its directory not synced): the
    // registration is gone then, and its routes must stay withdrawn, or they would be orphans again. Read back, the state
    // says which; routes are published again only while their Project is still registered.
    const registered = await deps.store
      .read()
      .then((state) => state.projects.some((p) => p.id === project.id))
      .catch(() => undefined);
    if (registered === false)
      return [
        ...(await forgottenWarnings(targets, kept, deps)),
        ...(await forgetUsage(project, deps)),
        `The forget was saved, but confirming it on disk failed: ${failureReason(error)} If the Host lost power since, run rig list; should ${project.name} be listed again, run rig forget ${shellWord(project.name)} again.`,
      ];
    if (registered === undefined)
      throw new RigError(
        "FORGET_UNCERTAIN",
        `Project '${project.name}' may or may not be forgotten: ${withdrawal.hostnames.length ? `its routes (${withdrawal.hostnames.join(", ")}) were withdrawn, ` : ""}saving the forget failed, and the state could not be read back.`,
        `Run rig list. If ${project.name} is still registered, run rig forget ${shellWord(project.name)} again${withdrawal.hostnames.length ? "; rig up or rig deploy of a Target publishes its route again otherwise" : ""}.`,
        { hostnames: [...withdrawal.hostnames] },
        failureCauses(error),
      );
    try {
      await withdrawal.restore();
    } catch (recovery) {
      // Only the routes the restore could not publish again are named; the others serve as they did.
      const unpublished =
        recovery instanceof RigError &&
        Array.isArray(recovery.details.hostnames)
          ? recovery.details.hostnames.map(String)
          : [...withdrawal.hostnames];
      throw new RigError(
        "FORGET_ROLLBACK",
        `Project '${project.name}' is still registered, but the routes for ${unpublished.join(", ")} were withdrawn and could not be published again.`,
        `Its Targets are stopped, so nothing was served through them; rig up or rig deploy of a Target publishes its route again. Run rig forget ${shellWord(project.name)} to retry.`,
        { hostnames: unpublished },
        failureCauses(error, recovery),
      );
    }
    throw error;
  }
  return [
    ...(await forgottenWarnings(targets, kept, deps)),
    ...(await forgetUsage(project, deps)),
  ];
}
/** Removes a forgotten Project's CPU and memory history. The forget is already saved, so a failure is a warning: the
 * history is then left until retention removes it. */
async function forgetUsage(
  project: ProjectRecord,
  deps: Pick<RuntimeDependencies, "usage">,
): Promise<string[]> {
  try {
    await deps.usage?.forget(project.id);
    return [];
  } catch (error) {
    return [
      `${project.name}'s CPU and memory history could not be removed (${failureReason(error)}); it is removed with other old history once monitor.retention_days have passed.`,
    ];
  }
}
/** What a forget leaves on disk: the stable Target's workspace and data, the backup directories in `kept`, and the Tools
 * `targets` published, now released. Read after the forget was saved; a Tool that cannot be read is left unnamed. */
async function forgottenWarnings(
  targets: readonly TargetRecord[],
  kept: ReadonlySet<string>,
  deps: Pick<RuntimeDependencies, "orphanedTools" | "store" | "root">,
): Promise<string[]> {
  const forgotten = new Set(targets.map((target) => target.id));
  const left = (
    (await deps
      .orphanedTools?.(
        async () =>
          new Set((await deps.store.read()).targets.map((target) => target.id)),
      )
      .catch(() => undefined)) ?? []
  ).filter((tool) => forgotten.has(tool.owner.targetId));
  const tools = left
    .filter((tool) => !tool.changed)
    .map((tool) => tool.destination);
  const changed = left
    .filter((tool) => tool.changed)
    .map((tool) => tool.destination);
  // rigd's system job runs <RIG_ROOT>/bin/rigd: forgetting Rig's own Project must never lead anyone to delete it, and only
  // this Project registered again takes rig and rigd over.
  const daemon = join(deps.root, "bin", "rigd");
  const rigBinaries = [join(deps.root, "bin", "rig"), daemon];
  const rigItself = tools.some((path) => rigBinaries.includes(path));
  return [
    ...targets
      .filter((t) => t.kind === "stable")
      .map(
        (t) =>
          `Target ${t.name} was forgotten, but its workspace at ${t.plan.workspacePath} and data under ${t.plan.dataRoot} were not deleted.`,
      ),
    ...[...kept].map(
      (directory) =>
        `Its backups in ${directory} were kept on disk; Rig no longer lists them.`,
    ),
    ...(tools.length
      ? [
          `Its Tools stay installed: ${tools.join(", ")}. Rig no longer owns them: the next Target that publishes a Tool of the same name replaces ${tools.length === 1 ? "it" : "each"}${rigItself ? " (rig and rigd only from a clone of this repository registered again)" : ""}, and you may delete any you no longer want${rigItself ? `, except ${rigBinaries.filter((path) => tools.includes(path)).join(" and ")}: Rig itself, and rigd's system job runs ${daemon}` : ""}.`,
        ]
      : []),
    ...(changed.length
      ? (() => {
          // rig and rigd are never to be moved or deleted (launchd runs bin/rigd): only replaced atomically, in place.
          const own = changed.filter((path) => rigBinaries.includes(path));
          const other = changed.filter((path) => !rigBinaries.includes(path));
          return [
            ...(other.length
              ? [
                  `Its Tools ${other.join(", ")} changed since Rig published them and stay as they are: Rig never replaces or removes them, so publishing a Tool there is refused (ARTIFACT_CHANGED) until you move or delete ${other.length === 1 ? "it" : "them"}.`,
                ]
              : []),
            ...(own.length
              ? [
                  `${own.join(" and ")} changed since Rig published ${own.length === 1 ? "it" : "them"} and ${own.length === 1 ? "stays" : "stay"} as ${own.length === 1 ? "it is" : "they are"}. Never move or delete ${own.length === 1 ? "it" : "them"}: rigd's system job runs ${daemon}. Rig publishes Rig there again only over the bytes it recorded: put back the bytes whose SHA-256 ${own.length === 1 ? "its" : "each one's"} ownership record in installed/owners names, by copying them to a temporary name beside it and renaming that over it, then deploy (the rig:rigd skill's upgrade reference).`,
                ]
              : []),
          ];
        })()
      : []),
  ];
}
/** The refusal of a forget whose routes could not be withdrawn: the provider's failure, with its code and details kept, said
 * as a forget that changed nothing and can be run again. A failure that is no RigError becomes ROUTE_WITHDRAW, keeping
 * only its category. */
function notForgotten(project: ProjectRecord, error: unknown): RigError {
  if (!(error instanceof RigError))
    return new RigError(
      "ROUTE_WITHDRAW",
      `Project '${project.name}' was not forgotten: its routes could not be withdrawn.`,
      `Its registration and routes are unchanged. Run rig doctor and read the diagnostic log, then run rig forget ${shellWord(project.name)} again.`,
      {},
      failureCauses(error),
    );
  // Routes were withdrawn and could not all be put back: a failed rollback, which names the hostnames still missing.
  if (error.code === "WITHDRAW_ROLLBACK")
    return new RigError(
      "FORGET_ROLLBACK",
      `Project '${project.name}' was not forgotten, and its routes could not all be put back. ${error.message}`,
      `${error.hint} Or run rig forget ${shellWord(project.name)} again to finish forgetting it.`,
      error.details,
      error.causes,
    );
  // The route file changed under Rig: what was applied is unknown, so nothing is claimed about the routes.
  if (error.code === "ROUTE_CHANGED")
    return new RigError(
      error.code,
      `Project '${project.name}' was not forgotten. ${error.message}`,
      `${error.hint} Its registration is unchanged; run rig forget ${shellWord(project.name)} again once rig doctor is clean.`,
      error.details,
      error.causes,
    );
  return new RigError(
    error.code,
    `Project '${project.name}' was not forgotten: its routes could not be withdrawn. ${error.message}`,
    `${error.hint} Its registration and routes are unchanged: fix that, then run rig forget ${shellWord(project.name)} again.`,
    error.details,
    error.causes,
  );
}
/** What a registration change left behind; `project` is the record as stored, never the argument mutated. */
export interface RegistrationUpdate {
  outcome: "renamed" | "repointed" | "unchanged";
  project: ProjectRecord;
}
/** Renames or repoints a registration and returns the updated record; the `project` argument is read only. */
export async function updateRegistration(
  command: RuntimeCommand,
  project: ProjectRecord,
  targets: TargetRecord[],
  deps: RuntimeDependencies,
): Promise<RegistrationUpdate> {
  // Renaming to the registered name is a no-op unless the config drifted from it.
  if (
    command.action === "rename" &&
    command.newName === project.name &&
    (await deps.documents.read(project.repoPath)).config.name === project.name
  )
    return { outcome: "unchanged", project };
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
    const nameTaken = (projects: readonly ProjectRecord[]) =>
      projects.some((p) => p.name === command.newName && p.id !== project.id);
    if (nameTaken((await deps.store.read()).projects)) throw conflict("name");
    const document = await deps.documents.rename(project, command.newName);
    try {
      await deps.store.update((state) => {
        // Checked again in the write itself: an init running beside this rename may have taken the name since.
        if (nameTaken(state.projects)) throw conflict("name");
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
          "Project rename could not restore its previous config.",
          "Inspect the registered name and Project config before retrying.",
          {},
          failureCauses(error, recoveryError),
        );
      }
      throw error;
    }
    return {
      outcome: "renamed",
      project: { ...project, name: command.newName, configPath: document.path },
    };
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
    const pathTaken = (projects: readonly ProjectRecord[]) =>
      projects.some((p) => p.id !== project.id && p.repoPath === repoPath);
    if (pathTaken((await deps.store.read()).projects)) throw conflict("path");
    // The same planning as `up`: the moved config's ports are reserved against
    // every other Target, and recorded ports are kept where the config allows.
    const replanned = new Map<string, TargetRecord>();
    for (const target of targets.filter((t) => t.kind === "working"))
      replanned.set(
        target.id,
        keepPublishedNames(
          target,
          await planTarget(
            {
              command,
              kind: "working",
              project: { ...project, repoPath },
              document,
              existing: target,
            },
            deps,
          ),
        ),
      );
    await deps.store.update((state) => {
      // Checked again in the write itself: an init running beside this repoint may have taken the directory since.
      if (pathTaken(state.projects)) throw conflict("path");
      const current = state.projects.find((p) => p.id === project.id)!;
      current.repoPath = repoPath;
      current.configPath = document.path;
      state.targets = state.targets.map(
        (target) => replanned.get(target.id) ?? target,
      );
    });
    return {
      outcome: "repointed",
      project: { ...project, repoPath, configPath: document.path },
    };
  }
}
/** A rename or repoint whose new name or directory another registered Project holds. */
function conflict(taken: "name" | "path"): RigError {
  return taken === "name"
    ? new RigError(
        "PROJECT_CONFLICT",
        "The new Project name is already registered.",
        "Choose another name.",
      )
    : new RigError(
        "PROJECT_CONFLICT",
        "Another Project already owns the new directory.",
        "Choose an unregistered directory.",
      );
}
