import { stopRecordedTarget } from "./stop";
import { doctor, hostDoctor } from "./doctor";
import { updateRegistration } from "./registration";
import { ConfigError } from "../config/errors";
import type { RuntimeCommand } from "../daemon/protocol";
import type {
  OperationRecord,
  ProjectRecord,
  TargetRecord,
} from "../domain/runtime";
import { RigError } from "../domain/errors";
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
export interface RigRuntime {
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
  const execute = async (command: RuntimeCommand): Promise<unknown> => {
    const operationId = command.operationId ?? deps.id();
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
        if (state.targets.some((t) => t.recovery))
          throw new RigError(
            "DEPLOY_RECOVERY",
            "Cannot uninstall rigd while Targets have unresolved deployment recovery.",
            "Run rig down for each affected Target to finish recovery, then retry uninstall.",
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
      if (command.action === "status")
        return await projectStatus(project, targets, command, deps);
      if (command.action === "doctor")
        return await doctor(project, targets, deps);
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
        if (
          target?.commit === commit &&
          target.branch === branch &&
          !command.force
        )
          return await finish("unchanged", { warnings: preflight.warnings });
        let replacement: TargetRecord | undefined;
        if (command.target === "preview" && !target) {
          const policy = (await deps.documents.host()).deploy.generated;
          const previews = targets.filter((t) => t.kind === "preview");
          if (previews.length >= policy.maxActive) {
            if (policy.replacePolicy === "reject")
              throw new RigError(
                "PREVIEW_LIMIT",
                "The Project has reached its Preview limit.",
                "Remove an existing Preview or change the Host Preview limit.",
              );
            replacement = [...previews].sort((a, b) =>
              a.createdAt.localeCompare(b.createdAt),
            )[0];
            if (replacement?.recovery)
              throw new RigError(
                "DEPLOY_RECOVERY",
                "The oldest Preview has an unresolved transition.",
                "Stop that Preview before replacing it.",
              );
          }
        }
        const candidate = await planTarget(
          {
            command: { ...command, branch, commit },
            project,
            document,
            existing: target,
          },
          deps,
        );
        target = await activateDeployment(
          candidate,
          target,
          command.noUp ?? false,
          deps,
        );
        if (replacement) {
          await deps.lifecycle.retire(replacement, () =>
            deps.store.update((s) => {
              s.targets = s.targets.filter((t) => t.id !== replacement!.id);
            }),
          );
        }
        return await finish("deployed", { warnings: preflight.warnings });
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
        // Keep data, logs, and source history. Effect retirement spans inventory publication.
        await deps.lifecycle.retire(target, () =>
          deps.store.update((s) => {
            s.targets = s.targets.filter((t) => t.id !== target!.id);
          }),
        );
        return await finish("stopped");
      }
      if (!target) {
        if (command.action !== "up" || (command.target ?? "local") !== "local")
          throw missingTarget(name);
        const document = await deps.documents.read(project.repoPath);
        if (document.config.name !== project.name)
          throw new RigError(
            "PROJECT_IDENTITY",
            "Project config identity changed.",
            "Use rig rename to update registration.",
          );
        target = await planTarget({ command, project, document }, deps);
        await persistTarget(target, deps);
      }
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
      if (command.action === "down") {
        target.desired = "stopped";
        target.updatedAt = deps.now();
        await persistTarget(target, deps);
        outcome = (await stopRecordedTarget(target, deps.lifecycle)).outcome;
      } else {
        if (command.action === "restart") {
          target.desired = "stopped";
          target.updatedAt = deps.now();
          await persistTarget(target, deps);
          await stopRecordedTarget(target, deps.lifecycle);
        }
        outcome = (await deps.lifecycle.up(target)).outcome;
        target.desired = "running";
      }
      target.updatedAt = deps.now();
      await persistTarget(target, deps);
      return await finish(outcome);
    } catch (error) {
      if (!reads.has(command.action))
        try {
          await record(
            "failed",
            error instanceof RigError ? error.code : "UNEXPECTED",
          );
        } catch {
          await deps
            .diagnostic({
              operationId,
              action: command.action,
              outcome: "failed",
              errorCode: error instanceof RigError ? error.code : "UNEXPECTED",
            })
            .catch(() => {});
        }
      throw error;
    }
    async function record(
      outcome: OperationRecord["outcome"],
      errorCode?: string,
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
      await deps
        .diagnostic({
          operationId,
          action: command.action,
          outcome,
          project: project?.name,
          target: target?.name,
          errorCode,
        })
        .catch(() => {});
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
            if (target.recovery) continue;
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
