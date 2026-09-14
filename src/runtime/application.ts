import type {
  ProjectStatusReader,
  ProjectStatusReport,
  StatusSelection,
} from "../domain/project-status";
import { stopBeforeRestart, stopRecordedTarget } from "./stop";
import { doctor, hostDoctor } from "./doctor";
import { updateRegistration } from "./registration";
import { ConfigError } from "../config/errors";
import type { ConfigDocument, ProjectConfig } from "../config/types";
import type { RuntimeCommand } from "../daemon/protocol";
import type {
  OperationRecord,
  ProjectRecord,
  TargetRecord,
} from "../domain/runtime";
import {
  RigError,
  diagnosticCauses,
  diagnosticErrorCode,
  type FailureCauses,
} from "../domain/errors";
import type { RuntimeDependencies } from "./contracts";
import { registerProject, selectProject } from "./projects";
import { persistTarget, planTarget, targetName } from "./targets";
import { observeTargets } from "./status";
import { projectStatus } from "./project-status";
import {
  activateDeployment,
  assertDeploymentRecovered,
  stopForRecovery,
} from "./deploy";
/**
 * Retire a Preview marked for destruction. `retire` leaves effects changed only
 * when it fails with RETIRE_COMMIT_PENDING or RETIRE_ROLLBACK; any other
 * refusal (missing provider, uncertain stop, ...) leaves the Target intact, so
 * the pending-destruction lock is released and the Preview may be restarted or
 * redeployed. The refusal is rethrown unchanged.
 */
async function retireForDestruction(
  target: TargetRecord,
  deps: RuntimeDependencies,
): Promise<void> {
  try {
    await deps.lifecycle.retire(target);
  } catch (error) {
    const effectsChanged =
      error instanceof RigError &&
      (error.code === "RETIRE_COMMIT_PENDING" ||
        error.code === "RETIRE_ROLLBACK");
    if (!effectsChanged) {
      delete target.destructionPending;
      target.updatedAt = deps.now();
      await persistTarget(target, deps.store);
    }
    throw error;
  }
}
export interface RigRuntime extends ProjectStatusReader {
  command(command: RuntimeCommand): Promise<unknown>;
  reconcile(): Promise<void>;
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
  drain(): Promise<void>;
}
const reads = new Set([
  "initialization-info",
  "deployment-context",
  "list",
  "status",
  "doctor",
  "config",
  "logs",
  "activity",
]);
/** One authority serializes mutations, while read-only requests probe the last committed inventory. */
export function createRuntime(deps: RuntimeDependencies): RigRuntime {
  let queue: Promise<unknown> = Promise.resolve();
  let draining = false;
  /** Mutations this daemon is executing right now; a transition they own is in progress, not abandoned. */
  const inFlight = new Set<string>();
  const inProgress = (operationId: string) => inFlight.has(operationId);
  const status = async (
    selection: StatusSelection,
  ): Promise<ProjectStatusReport> => {
    const command = { ...selection, action: "status" as const };
    const { project } = await selectProject(command, deps, false);
    const state = await deps.store.read();
    return projectStatus(
      project,
      state.targets.filter((target) => target.projectId === project.id),
      selection,
      { ...deps, inProgress },
    );
  };
  const execute = async (command: RuntimeCommand): Promise<unknown> => {
    const operationId = command.operationId ?? deps.id();
    if (reads.has(command.action)) return run(command, operationId);
    inFlight.add(operationId);
    try {
      return await run(command, operationId);
    } finally {
      inFlight.delete(operationId);
    }
  };
  const run = async (
    command: RuntimeCommand,
    operationId: string,
  ): Promise<unknown> => {
    let project: ProjectRecord | undefined, target: TargetRecord | undefined;
    try {
      if (command.action === "cancel-uninstall") {
        draining = false;
        return { cancelled: true };
      }
      if (draining && !reads.has(command.action))
        throw new RigError(
          "DAEMON_DRAINING",
          "rigd is preparing to stop.",
          "Wait for administration to complete before retrying.",
        );
      if (!reads.has(command.action)) await deps.assertOwnershipReady();
      if (command.action === "prepare-uninstall") {
        const state = await deps.store.read();
        if (state.targets.some((t) => t.recovery || t.destructionPending))
          throw new RigError(
            "DEPLOY_RECOVERY",
            "Cannot uninstall rigd while Targets have unresolved recovery or destruction.",
            "Finish recovery with rig down, or retry Preview --destroy when deletion is pending, then retry uninstall.",
          );
        const reports = await observeTargets(state.targets, deps.observations);
        if (
          state.targets.some((t) => t.desired === "running") ||
          reports.some((t) =>
            t.components.some((c) =>
              ["running", "healthy", "unhealthy", "unknown"].includes(c.state),
            ),
          )
        )
          throw new RigError(
            "TARGETS_RUNNING",
            "Cannot uninstall rigd while Targets are running or uncertain.",
            "Stop all Targets and verify status first.",
          );
        draining = true;
        return { ready: true };
      }
      if (command.action === "list") {
        const state = await deps.store.read();
        let ownership = true;
        try {
          await deps.assertOwnershipReady();
        } catch {
          ownership = false;
        }
        const reports = ownership
          ? await observeTargets(state.targets, deps.observations)
          : [];
        return {
          ownership: ownership ? "ready" : "unknown",
          projects: state.projects.map((p) => ({
            name: p.name,
            repoPath: p.repoPath,
            targetCount: state.targets.filter((t) => t.projectId === p.id)
              .length,
          })),
          runningTargets: ownership
            ? reports.filter((t) =>
                t.components.some((c) =>
                  ["running", "healthy", "unhealthy", "unknown"].includes(
                    c.state,
                  ),
                ),
              ).length
            : null,
        };
      }
      if (command.action === "activity" && !command.project) {
        const [state, admin] = await Promise.all([
          deps.store.read(),
          deps.readAdminActivity(),
        ]);
        return {
          operations: [...state.activity, ...admin]
            .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
            .slice(-(command.lines ?? 100)),
        };
      }
      if (command.action === "initialization-info") {
        if (!command.repoPath)
          throw new RigError(
            "PATH_REQUIRED",
            "A Project directory is required.",
            "Run init from the Project directory.",
          );
        return await deps.documents.initializationInfo(command.repoPath);
      }
      if (command.action === "init") {
        project = await registerProject(command, deps);
        return await finish("registered", { path: project.configPath });
      }
      if (command.action === "doctor" && !command.project) {
        try {
          if (!command.repoPath)
            throw new ConfigError("No Project selected.", "missing_config");
          await deps.documents.discover(command.repoPath);
        } catch (error) {
          return await hostDoctor(deps, error);
        }
      }
      if (command.action === "status") return await status(command);
      const selection = await selectProject(
        command,
        deps,
        [
          "config",
          "deploy",
          "deployment-context",
          "git-push",
          "rename",
        ].includes(command.action),
      );
      project = selection.project;
      const state = await deps.store.read();
      const targets = state.targets.filter((t) => t.projectId === project!.id);
      if (command.action === "deployment-context") {
        let currentBranch: string | null;
        try {
          currentBranch = await deps.sources.currentBranch(project.repoPath);
        } catch (error) {
          if (!(error instanceof RigError) || error.code !== "GIT_DETACHED")
            throw error;
          currentBranch = null;
        }
        return {
          project: project.name,
          repoPath: project.repoPath,
          productionBranch:
            selection.document!.config.live?.deployBranch ??
            (await deps.documents.host()).deploy.productionBranch,
          currentBranch,
        };
      }
      if (command.action === "config")
        return { project: project.name, ...selection.document };
      if (command.action === "activity")
        return {
          operations: state.activity
            .filter((o) => o.projectId === project!.id)
            .slice(-(command.lines ?? 100)),
        };
      if (command.action === "doctor")
        return await doctor(project, targets, { ...deps, inProgress });
      if (command.action === "rename" || command.action === "repoint") {
        await updateRegistration(command, project, targets, deps);
        return await finish(
          command.action === "rename" ? "renamed" : "repointed",
        );
      }
      if (command.action === "git-push") {
        if (command.repoPath !== project.repoPath)
          throw new RigError(
            "PROJECT_PATH_CONFLICT",
            "The pushed repository is not the registered Project directory.",
            "Push from the registered repository or use repoint first.",
          );
        if (!command.branch || !command.commit)
          throw new RigError(
            "GIT_PUSH",
            "A push requires a destination Branch and source Commit.",
            "Push a local Branch to the rig remote.",
          );
        const production =
          selection.document!.config.live?.deployBranch ??
          (await deps.documents.host()).deploy.productionBranch;
        command = {
          ...command,
          target: command.branch === production ? "live" : "preview",
        };
      }
      if (
        command.action === "deploy" &&
        command.target === "preview" &&
        !command.branch
      )
        command = {
          ...command,
          branch: await deps.sources.currentBranch(project.repoPath),
        };
      const name = targetName(command);
      target = targets.find((t) => t.name === name);
      if (target && target.kind !== (command.target ?? "local"))
        throw new RigError(
          "TARGET_IDENTITY",
          "The selected Target kind does not match its recorded identity.",
          "Select the correct Target kind and name.",
        );
      if (
        target?.destructionPending &&
        !["destroy", "logs", "down"].includes(command.action)
      )
        throw new RigError(
          "DESTROY_PENDING",
          "Preview destruction is incomplete.",
          "Retry down preview --destroy for this Preview.",
        );
      if (command.action === "logs") {
        if (!target) throw missingTarget(name);
        return {
          project: project.name,
          target: target.name,
          ...(await deps.files.logs(
            target,
            command.after,
            command.lines ?? 100,
          )),
        };
      }
      if (command.action === "deploy" || command.action === "git-push") {
        if ((command.target ?? "local") === "local")
          throw new RigError(
            "DEPLOY_TARGET",
            "Deploy needs live or preview.",
            "Use rig up for the Working copy Target.",
          );
        const document = selection.document!;
        const branch =
          command.branch ??
          (command.target === "live"
            ? (document.config.live?.deployBranch ??
              (await deps.documents.host()).deploy.productionBranch)
            : await deps.sources.currentBranch(project.repoPath));
        const preflight =
          command.action === "git-push"
            ? {
                commit: await deps.sources.resolve(
                  project.repoPath,
                  command.commit!,
                ),
                warnings: [],
              }
            : await deps.sources.preflight({
                repoPath: project.repoPath,
                branch,
                productionBranch:
                  document.config.live?.deployBranch ??
                  (await deps.documents.host()).deploy.productionBranch,
              });
        const commit = command.commit
          ? await deps.sources.resolve(project.repoPath, command.commit)
          : preflight.commit;
        assertDeploymentRecovered(target);
        const previous = target?.commit
          ? { previousCommit: target.commit }
          : {};
        if (
          target?.commit === commit &&
          target.branch === branch &&
          !target.deploymentIncomplete &&
          !command.force
        )
          return await finish("unchanged", {
            warnings: preflight.warnings,
            ...previous,
          });
        const replacements =
          command.target === "preview" && !target
            ? previewsToReplace(
                targets,
                (await deps.documents.host()).deploy.generated,
              )
            : [];
        const candidate = await planTarget(
          {
            command: { ...command, branch, commit },
            project,
            document,
            existing: target,
          },
          deps,
        );
        const wasRunning = target?.desired === "running";
        target = await activateDeployment(
          candidate,
          target,
          { activation: command.noUp ? "prepare" : "start", operationId },
          deps,
        );
        const warnings = [
          ...preflight.warnings,
          ...(command.noUp ? [preparedWarning(target, wasRunning)] : []),
        ];
        warnings.push(...(await retireReplacedPreviews(replacements, deps)));
        return await finish("deployed", { warnings, ...previous });
      }
      if (command.action === "destroy") {
        if (command.target !== "preview")
          throw new RigError(
            "DESTROY_TARGET",
            "Only Previews can be destroyed.",
            "Use down to stop local or live.",
          );
        if (!target) throw missingTarget(name);
        if (target.recovery) target = await stopForRecovery(target, deps);
        await deps.files.inspectPreviewDeletion({
          root: deps.root,
          target,
          state: await deps.store.read(),
        });
        target.desired = "stopped";
        target.destructionPending = true;
        target.updatedAt = deps.now();
        await persistTarget(target, deps.store);
        // Commit route/artifact retirement before irreversible storage cleanup.
        // Inventory remains the retry handle until all owned bytes are gone.
        await retireForDestruction(target, deps);
        await deps.files.destroyPreview({
          root: deps.root,
          target,
          state: await deps.store.read(),
        });
        await deps.store.update((s) => {
          s.targets = s.targets.filter((t) => t.id !== target!.id);
        });
        return await finish("stopped");
      }
      if (!target) {
        if (command.action !== "up" || (command.target ?? "local") !== "local")
          throw missingTarget(name);
        target = await planTarget(
          { command, project, document: await workingCopyDocument(project, deps) },
          deps,
        );
        await persistTarget(target, deps.store);
      } else if (
        command.action === "up" &&
        target.kind === "local" &&
        target.desired === "stopped"
      )
        target = await replanWorkingCopy(target, command, project, deps);
      if (target.recovery) {
        if (command.action !== "down")
          throw new RigError(
            "DEPLOY_RECOVERY",
            "This Target has an unresolved deployment transition.",
            "Run down for this Target to stop both recorded plans first.",
          );
        target = await stopForRecovery(target, deps);
      }
      let outcome: OperationRecord["outcome"];
      let warnings: string[] = [];
      if (command.action === "down") {
        target.desired = "stopped";
        target.updatedAt = deps.now();
        await persistTarget(target, deps.store);
        outcome = (await stopRecordedTarget(target, deps.lifecycle)).outcome;
      } else {
        if (command.action === "restart") {
          target.desired = "stopped";
          target.updatedAt = deps.now();
          await persistTarget(target, deps.store);
          warnings = (await stopBeforeRestart(target, deps.lifecycle)).warnings;
          if (target.kind === "local")
            target = await replanWorkingCopy(target, command, project, deps);
        }
        outcome = (await deps.lifecycle.up(target)).outcome;
        // up installs, routes, and starts the recorded plan under its own
        // committed checkpoint, which is everything an incomplete deployment lacked.
        delete target.deploymentIncomplete;
        target.desired = "running";
      }
      target.updatedAt = deps.now();
      await persistTarget(target, deps.store);
      return await finish(outcome, warnings.length ? { warnings } : {});
    } catch (error) {
      if (!reads.has(command.action)) {
        const errorCode = diagnosticErrorCode(error);
        const causes = diagnosticCauses(error);
        try {
          await record("failed", errorCode, causes);
        } catch {
          try {
            await deps.diagnostic({
              operationId,
              action: command.action,
              outcome: "failed",
              errorCode,
              ...causes,
            });
          } catch {
            /* Neither synchronous nor asynchronous diagnostic failures replace the operation outcome. */
          }
        }
      }
      throw error;
    }
    async function record(
      outcome: OperationRecord["outcome"],
      errorCode?: string,
      causes: FailureCauses = {},
    ): Promise<void> {
      await deps.store.update((state) => {
        state.activity.push({
          id: operationId,
          projectId: project?.id,
          project: project?.name,
          target: target?.name,
          action: command.action,
          outcome,
          occurredAt: deps.now(),
          ...(errorCode ? { message: errorCode } : {}),
        });
      });
      try {
        await deps.diagnostic({
          operationId,
          action: command.action,
          outcome,
          project: project?.name,
          target: target?.name,
          errorCode,
          ...causes,
        });
      } catch {
        /* Diagnostic failure cannot change an already recorded operation. */
      }
    }
    async function finish(
      outcome: OperationRecord["outcome"],
      extra: Record<string, unknown> = {},
    ): Promise<unknown> {
      await record(outcome);
      return {
        operationId,
        project: project?.name,
        target: target?.name,
        action: command.action,
        outcome,
        branch: target?.branch,
        commit: target?.commit,
        ...extra,
      };
    }
  };
  return {
    status,
    async drain() {
      draining = true;
      await queue.catch(() => {});
    },
    exclusive<T>(operation: () => Promise<T>): Promise<T> {
      const result = queue
        .catch(() => {})
        .then(async () => {
          if (draining)
            throw new RigError(
              "DAEMON_DRAINING",
              "rigd is preparing to stop.",
              "Wait for administration to complete.",
            );
          await deps.assertOwnershipReady();
          return await operation();
        });
      queue = result;
      return result;
    },
    command(command) {
      if (reads.has(command.action)) return execute(command);
      const operation = queue.catch(() => {}).then(() => execute(command));
      queue = operation;
      return operation;
    },
    async reconcile() {
      const operation = queue
        .catch(() => {})
        .then(async () => {
          if (draining) return;
          try {
            await deps.assertOwnershipReady();
          } catch (error) {
            await deps
              .diagnostic({
                operationId: deps.id(),
                action: "reconcile",
                outcome: "failed",
                errorCode:
                  error instanceof RigError ? error.code : "OWNERSHIP_UNKNOWN",
              })
              .catch(() => {});
            return;
          }
          const state = await deps.store.read();
          for (const target of state.targets) {
            if (draining) break;
            if (target.recovery || target.destructionPending) continue;
            try {
              if (target.desired === "running") await deps.lifecycle.up(target);
              else await deps.lifecycle.down(target);
            } catch (error) {
              await deps
                .diagnostic({
                  operationId: deps.id(),
                  action: "reconcile",
                  outcome: "failed",
                  target: target.name,
                  errorCode:
                    error instanceof RigError ? error.code : "UNEXPECTED",
                })
                .catch(() => {});
            }
          }
        });
      queue = operation;
      await operation;
    },
  };
}
function missingTarget(name: string): RigError {
  return new RigError(
    "TARGET_MISSING",
    `Target '${name}' has no recorded deployment.`,
    "Use rig up for local, or deploy this Target first.",
  );
}
/** A --no-up deploy leaves nothing serving; the warning carries the exact command that starts the new deployment. */
function preparedWarning(
  target: Pick<TargetRecord, "name" | "kind">,
  wasRunning: boolean,
): string {
  const up =
    target.kind === "preview"
      ? `rig up preview --deployment ${target.name}`
      : `rig up ${target.name}`;
  return wasRunning
    ? `${target.name} was running and is now stopped on the new deployment. Run ${up} to start it.`
    : `${target.name} is deployed but stopped. Run ${up} to start it.`;
}
/** The Working copy Target follows the registered repository's rig.yaml, whose name must still match the Project. */
async function workingCopyDocument(
  project: ProjectRecord,
  deps: RuntimeDependencies,
): Promise<ConfigDocument<ProjectConfig>> {
  const document = await deps.documents.read(project.repoPath);
  if (document.config.name !== project.name)
    throw new RigError(
      "PROJECT_IDENTITY",
      "Project config identity changed.",
      "Use rig rename to update registration.",
    );
  return document;
}
/** A stopped Working copy Target is re-planned from the current rig.yaml before it starts, keeping its id, data root, and recorded ports. */
async function replanWorkingCopy(
  target: TargetRecord,
  command: RuntimeCommand,
  project: ProjectRecord,
  deps: RuntimeDependencies,
): Promise<TargetRecord> {
  const document = await workingCopyDocument(project, deps);
  const replanned = await planTarget(
    { command, project, document, existing: target },
    deps,
  );
  await persistTarget(replanned, deps.store);
  return replanned;
}
/** The oldest Previews that must leave so a new Preview fits under the Host limit; none while the Project is under it.
 * Rejects PREVIEW_LIMIT under the reject policy and DEPLOY_RECOVERY when a chosen Preview is mid-transition. */
function previewsToReplace(
  targets: readonly TargetRecord[],
  policy: { maxActive: number; replacePolicy: "oldest" | "reject" },
): TargetRecord[] {
  const previews = targets.filter((t) => t.kind === "preview");
  const overflow = previews.length - policy.maxActive + 1;
  if (overflow <= 0) return [];
  if (policy.replacePolicy === "reject")
    throw new RigError(
      "PREVIEW_LIMIT",
      "The Project has reached its Preview limit.",
      "Remove an existing Preview or change the Host Preview limit.",
    );
  const oldest = [...previews]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, overflow);
  if (oldest.some((t) => t.recovery || t.destructionPending))
    throw new RigError(
      "DEPLOY_RECOVERY",
      "The oldest Preview has an unresolved transition.",
      "Stop that Preview before replacing it.",
    );
  return oldest;
}
/** Retire replaced Previews after the new one is committed; a retirement that fails leaves the new Preview deployed and is reported as a warning, so the next Preview deploy or a destroy retries it. */
async function retireReplacedPreviews(
  replacements: readonly TargetRecord[],
  deps: RuntimeDependencies,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const replacement of replacements) {
    try {
      await deps.lifecycle.retire(replacement, () =>
        deps.store.update((s) => {
          s.targets = s.targets.filter((t) => t.id !== replacement.id);
        }),
      );
    } catch (error) {
      const failure =
        error instanceof RigError
          ? `${error.message} ${error.hint}`
          : error instanceof Error
            ? error.message
            : String(error);
      warnings.push(
        `Preview ${replacement.branch ?? replacement.name} was not retired: ${failure} The Project is over its Preview limit until it is destroyed or replaced.`,
      );
    }
  }
  return warnings;
}
