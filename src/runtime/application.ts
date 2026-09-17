import type {
  ProjectStatusReader,
  ProjectStatusReport,
  StatusSelection,
} from "../domain/project-status";
import { stopBeforeRestart, stopRecordedTarget } from "./stop";
import { doctor, hostDoctor } from "./doctor";
import { forgetProject, updateRegistration } from "./registration";
import { recordActivity } from "../domain/activity";
import { ConfigError } from "../config/errors";
import type { ConfigDocument, ProjectConfig } from "../config/types";
import {
  readActions,
  type ActivityResult,
  type ListResult,
  type LogsResult,
  type RuntimeCommand,
} from "../daemon/protocol";
import type {
  OperationRecord,
  ProjectRecord,
  RuntimeState,
  TargetRecord,
} from "../domain/runtime";
import {
  RigError,
  diagnosticCauses,
  failureReason,
  diagnosticErrorCode,
  diagnosticEvidence,
  type FailureCauses,
  retainFailureCauses,
} from "../domain/errors";
import { resolve as resolvePath } from "node:path";
import type { RuntimeDependencies } from "./contracts";
import {
  prepareRegistration,
  registerProject,
  selectProject,
  assertIdentity,
  registeredDirectoryMissing,
} from "./projects";
import { persistTarget, planTarget, selectTarget } from "./targets";
import { PREVIEW_SELECTOR, targetNames } from "../config/schema";
import { assertSourceBuildsKnown } from "./lifecycle";
import { prepareTarget } from "./preparation";
import { observeTargets } from "./status";
import { projectStatus } from "./project-status";
import {
  activateDeployment,
  assertDeploymentRecovered,
  ownedRevision,
  releaseUnreferencedRevisions,
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
const reads = readActions;
/** What one serialized mutation looks like from outside while it runs. */
interface RunningOperation {
  operationId: string;
  action: RuntimeCommand["action"];
  project?: string;
  target?: string;
  startedAt: string;
}
/** One authority serializes mutations, while read-only requests probe the last committed inventory. */
export function createRuntime(deps: RuntimeDependencies): RigRuntime {
  let queue: Promise<unknown> = Promise.resolve();
  let draining = false;
  // The mutation executing now and how many are queued behind it: the answer to
  // "what is holding the host" for a caller whose command has not returned.
  let running: RunningOperation | undefined;
  let waiting = 0;
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
    running = {
      operationId,
      action: command.action,
      ...(command.project ? { project: command.project } : {}),
      ...(command.target ? { target: command.target } : {}),
      startedAt: deps.now(),
    };
    try {
      return await run(command, operationId);
    } finally {
      inFlight.delete(operationId);
      running = undefined;
    }
  };
  const run = async (
    command: RuntimeCommand,
    operationId: string,
  ): Promise<unknown> => {
    let project: ProjectRecord | undefined, target: TargetRecord | undefined;
    // The Target a command aimed at, so a failure before its record exists is still filed under its name.
    let aimed: string | undefined;
    // Set once selection and argument checks are done: a failure after this point is an
    // Operation outcome and is recorded in activity; one before it is a usage mistake and is not.
    let attempted = false;
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
        const reports = await observeTargets(
          state.targets,
          deps.observations,
          deps.observationBudgetMs,
          deps.observationDeadline,
        );
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
      if (command.action === "queue")
        return { ...(running ? { running } : {}), waiting };
      if (command.action === "list") {
        const state = await deps.store.read();
        let ownership = true;
        try {
          await deps.assertOwnershipReady();
        } catch {
          ownership = false;
        }
        // An inventory listing reads the record only; Target liveness is status's job and is not observed here.
        return {
          ownership: ownership ? "ready" : "unknown",
          projects: await Promise.all(
            state.projects.map(async (p) => ({
              name: p.name,
              repoPath: p.repoPath,
              targetCount: state.targets.filter((t) => t.projectId === p.id)
                .length,
              ...((await directoryMissing(p.repoPath, deps))
                ? { missing: true }
                : {}),
            })),
          ),
        } satisfies ListResult;
      }
      if (command.action === "activity" && !command.project) {
        const [state, admin] = await Promise.all([
          deps.store.read(),
          deps.readAdminActivity(),
        ]);
        return selectActivity(
          [...state.activity, ...admin].sort((a, b) =>
            a.occurredAt.localeCompare(b.occurredAt),
          ),
          command,
        );
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
        const identity = await prepareRegistration(command, deps);
        attempted = true;
        project = await registerProject(command, identity, deps);
        const kept = identity.configPath ? unappliedInitFlags(command) : [];
        return await finish("registered", {
          path: project.configPath,
          ...(kept.length
            ? {
                warnings: [
                  `The existing config at ${identity.configPath} was kept; ${listed(kept)} ${kept.length === 1 ? "was" : "were"} not applied. Edit the config to change it.`,
                ],
              }
            : {}),
        });
      }
      if (command.action === "forget") {
        project = (await selectProject(command, deps, false)).project;
        attempted = true;
        const warnings = await forgetProject(
          project,
          (await deps.store.read()).targets.filter(
            (t) => t.projectId === project!.id,
          ),
          deps,
        );
        return await finish("forgotten", warnings.length ? { warnings } : {});
      }
      if (command.action === "doctor" && !command.project) {
        try {
          if (!command.repoPath)
            throw new ConfigError("No Project selected.", "missing_config");
          const found = await deps.documents.discover(command.repoPath);
          const state = await deps.store.read();
          // A directory whose config names no registered Project still gets Host checks, with the reason Project checks are absent.
          if (
            !state.projects.some(
              (p) =>
                p.name === found.document.config.name ||
                resolvePath(p.repoPath) === resolvePath(found.repoPath),
            )
          )
            throw new RigError(
              "PROJECT_MISSING",
              `Project '${found.document.config.name}' is not registered.`,
              "Run rig init in this Project directory.",
            );
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
        const names = targetNames(selection.document!.config);
        return {
          project: project.name,
          repoPath: project.repoPath,
          productionBranch:
            selection.document!.config.production_branch ??
            (await deps.documents.host()).deploy.productionBranch,
          currentBranch,
          targets: names,
          // The role the selector means under the daemon's own rule, so a recorded name is confirmed like the configured one.
          ...(command.target === undefined
            ? {}
            : {
                selected:
                  command.target === PREVIEW_SELECTOR
                    ? "preview"
                    : selectTarget(command, names, targets).kind === "live"
                      ? "stable"
                      : "working",
              }),
        };
      }
      if (command.action === "config")
        return { project: project.name, ...selection.document };
      if (command.action === "activity")
        return selectActivity(
          state.activity.filter((o) => o.projectId === project!.id),
          command,
        );
      if (command.action === "doctor")
        return await doctor(project, targets, { ...deps, inProgress });
      if (command.action === "rename" || command.action === "repoint") {
        attempted = true;
        const updated = await updateRegistration(
          command,
          project,
          targets,
          deps,
        );
        project = updated.project;
        return await finish(updated.outcome, { repoPath: project.repoPath });
      }
      if (command.action === "git-push") {
        if (command.repoPath !== project.repoPath)
          throw pushedFromElsewhere(command.repoPath, project, state.projects);
        if (!command.branch || !command.commit)
          throw new RigError(
            "GIT_PUSH",
            "A push requires a destination Branch and source Commit.",
            "Push a local Branch to the rig remote.",
          );
        const production =
          selection.document!.config.production_branch ??
          (await deps.documents.host()).deploy.productionBranch;
        // A push selects by role: the Production Branch is the Stable Target whatever it is named.
        command = {
          ...command,
          target:
            command.branch === production
              ? targetNames(selection.document!.config).stable
              : PREVIEW_SELECTOR,
        };
      }
      if (
        command.action === "deploy" &&
        command.target === PREVIEW_SELECTOR &&
        !command.branch
      )
        command = {
          ...command,
          branch: await deps.sources.currentBranch(project.repoPath),
        };
      // One document snapshot serves the whole action: the names that select the Target and the plan made from it.
      const configured = await checkoutConfig(
        selection.document,
        project,
        deps,
      );
      const workingCopyDocument = (): ConfigDocument<ProjectConfig> => {
        if (!configured.document) throw configured.failure;
        return configured.document;
      };
      const selected = ((): ReturnType<typeof selectTarget> => {
        try {
          return selectTarget(
            command,
            configured.document && targetNames(configured.document.config),
            targets,
          );
        } catch (error) {
          // A name only the unreadable config could define is that config's failure, not an unknown Target.
          throw error instanceof RigError &&
            error.code === "TARGET_UNKNOWN" &&
            configured.failure
            ? configured.failure
            : error;
        }
      })();
      const kind = selected.kind;
      const name = selected.name ?? command.target ?? "the Working copy";
      aimed = name;
      target =
        kind === "preview"
          ? targets.find((t) => t.name === name)
          : targets.find((t) => t.kind === kind);
      if (target && target.kind !== kind)
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
        if (!target) throw missingTarget(command, name);
        return {
          project: project.name,
          target: target.name,
          ...(await deps.files.logs(
            target,
            command.after,
            command.lines ?? 100,
          )),
        } satisfies LogsResult;
      }
      if (command.action === "deploy" || command.action === "git-push") {
        if (kind === "local")
          throw new RigError(
            "DEPLOY_TARGET",
            "Deploy needs the Stable Target or a Preview.",
            "Use rig up for the Working copy Target.",
          );
        const document = selection.document!;
        const branch =
          command.branch ??
          (kind === "live"
            ? (document.config.production_branch ??
              (await deps.documents.host()).deploy.productionBranch)
            : await deps.sources.currentBranch(project.repoPath));
        attempted = true;
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
                  document.config.production_branch ??
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
        // The same source again would otherwise look like an ordinary retry of an incomplete deployment.
        if (target && !command.force)
          assertSourceBuildsKnown(target, { branch, commit });
        const replacements =
          kind === "preview" && !target
            ? previewsToReplace(
                targets,
                (await deps.documents.host()).deploy.generated,
              )
            : [];
        const candidate = await planTarget(
          {
            command: { ...command, branch, commit },
            kind,
            project,
            document,
            existing: target,
          },
          deps,
        );
        const wasRunning = target?.desired === "running";
        const revisions = [...(target ? [target] : []), candidate];
        try {
          target = await activateDeployment(
            candidate,
            target,
            { activation: command.noUp ? "prepare" : "start", operationId },
            deps,
          );
        } catch (error) {
          // A rejected candidate's checkout is reclaimed; the deployment failure stays the outcome.
          for (const retained of await releaseUnreferencedRevisions(
            revisions,
            deps,
          ))
            await deps
              .diagnostic({
                operationId,
                action: command.action,
                outcome: "revision-retained",
                project: project.name,
                target: candidate.name,
                ...retained.causes,
              })
              .catch(() => {});
          throw error;
        }
        const warnings = [
          ...preflight.warnings,
          ...(command.noUp ? [preparedWarning(target, wasRunning)] : []),
          ...(await releaseUnreferencedRevisions(revisions, deps)).map(
            (retained) => retained.warning,
          ),
        ];
        const replaced = await destroyReplacedPreviews(
          replacements,
          project,
          operationId,
          deps,
        );
        warnings.push(...replaced.warnings);
        return await finish("deployed", {
          warnings,
          retired: replaced.retired,
          ...(target.plan.domain ? { route: target.plan.domain } : {}),
          ...previous,
        });
      }
      if (command.action === "destroy") {
        if (kind !== "preview")
          throw new RigError(
            "DESTROY_TARGET",
            "Only Previews can be destroyed.",
            "Use down to stop the Working copy or Stable Target.",
          );
        if (!target) throw missingTarget(command, name);
        attempted = true;
        if (target.recovery) target = await stopForRecovery(target, deps);
        await destroyPreview(target, deps);
        return await finish("stopped");
      }
      if (!target && (command.action !== "up" || kind !== "local"))
        throw missingTarget(command, name);
      attempted = true;
      if (!target) {
        target = await planTarget(
          {
            command,
            kind,
            project,
            document: workingCopyDocument(),
          },
          deps,
        );
        await persistTarget(target, deps.store);
      } else if (
        command.action === "up" &&
        target.kind === "local" &&
        target.desired === "stopped"
      )
        target = await replanWorkingCopy(
          target,
          command,
          project,
          workingCopyDocument(),
          deps,
        );
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
            target = await replanWorkingCopy(
              target,
              command,
              project,
              workingCopyDocument(),
              deps,
            );
        }
        // Only the Working copy builds here, from current source; a deployed Target starts from its deployment's preparation.
        if (target.kind === "local")
          await prepareTarget(
            target,
            command.action === "restart" ? "all" : "stopped",
            deps,
          );
        const drift =
          target.kind === "local" &&
          target.configRevision !== undefined &&
          configured.document !== undefined &&
          configured.document.revision !== target.configRevision;
        if (drift)
          warnings.push(
            `rig.yaml changed since ${target.name} was planned, and its running Services still use the earlier plan. Run rig restart ${target.name} to apply the current rig.yaml.`,
          );
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
        const providerEvidence = diagnosticEvidence(error);
        const evidence = {
          operationId,
          action: command.action,
          errorCode,
          ...causes,
          ...(providerEvidence ? { evidence: providerEvidence } : {}),
        };
        try {
          if (attempted)
            await record("failed", errorCode, causes, providerEvidence);
          else await deps.diagnostic({ ...evidence, outcome: "rejected" });
        } catch {
          try {
            await deps.diagnostic({ ...evidence, outcome: "failed" });
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
      providerEvidence?: string,
    ): Promise<void> {
      await deps.store.update((state) => {
        recordActivity(state, {
          id: operationId,
          projectId: project?.id,
          project: project?.name,
          target: target?.name ?? aimed,
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
          target: target?.name ?? aimed,
          errorCode,
          ...causes,
          ...(providerEvidence ? { evidence: providerEvidence } : {}),
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
      waiting++;
      const operation = queue
        .catch(() => {})
        .then(() => {
          waiting--;
          return execute(command);
        });
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
          // Unreadable state is recorded and left alone; the daemon keeps serving so doctor and status can show it.
          let state;
          try {
            state = await deps.store.read();
          } catch (error) {
            await deps
              .diagnostic({
                operationId: deps.id(),
                action: "reconcile",
                outcome: "failed",
                errorCode:
                  error instanceof RigError ? error.code : "UNEXPECTED",
                ...diagnosticCauses(error),
              })
              .catch(() => {});
            return;
          }
          await pruneCheckpoints(state, deps);
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
/** A push whose repository is another registered Project must be told which remote to use; repoint would hijack the named Project. */
function pushedFromElsewhere(
  repoPath: string | undefined,
  named: Pick<ProjectRecord, "name" | "repoPath">,
  projects: readonly Pick<ProjectRecord, "name" | "repoPath">[],
): RigError {
  const pushed = repoPath ?? "(unknown)";
  const owner = projects.find(
    (candidate) =>
      repoPath !== undefined &&
      resolvePath(candidate.repoPath) === resolvePath(repoPath),
  );
  if (owner)
    return new RigError(
      "PROJECT_PATH_CONFLICT",
      `The pushed repository ${pushed} is registered as Project '${owner.name}', but the remote names Project '${named.name}' (registered at ${named.repoPath}).`,
      `Push to rig://localhost/${owner.name} from ${pushed} (git remote set-url rig rig://localhost/${owner.name}), or push from ${named.repoPath}.`,
      { registeredPath: named.repoPath, pushedProject: owner.name },
    );
  return new RigError(
    "PROJECT_PATH_CONFLICT",
    `The pushed repository ${pushed} is not the registered directory of Project '${named.name}' (${named.repoPath}).`,
    `Push from ${named.repoPath} or one of its linked worktrees, or run rig repoint . in ${pushed} if the Project moved there.`,
    { registeredPath: named.repoPath },
  );
}
/** Effect checkpoints of Targets no longer in state are reclaimed; each result and any failure is recorded, never raised. */
async function pruneCheckpoints(
  state: Pick<RuntimeState, "targets">,
  deps: Pick<RuntimeDependencies, "lifecycle" | "diagnostic" | "id">,
): Promise<void> {
  const operationId = deps.id();
  const record = (event: Parameters<RuntimeDependencies["diagnostic"]>[0]) =>
    deps.diagnostic(event).catch(() => {});
  try {
    const live = new Set(state.targets.map((target) => target.id));
    for (const pruned of await deps.lifecycle.pruneCheckpoints(live))
      await record({
        operationId,
        action: "reconcile",
        outcome: `checkpoint-${pruned.outcome}`,
        ...(pruned.targetId ? { target: pruned.targetId } : {}),
        path: pruned.path,
        ...(pruned.reason ? { reason: pruned.reason } : {}),
      });
  } catch (error) {
    await record({
      operationId,
      action: "reconcile",
      outcome: "failed",
      errorCode: diagnosticErrorCode(error),
      ...diagnosticCauses(error),
    });
  }
}
/** The Project's current rig.yaml, read once per action. A config that cannot be read, or that names another Project,
 * yields its failure instead so recorded names keep selecting Targets to stop or inspect. */
async function checkoutConfig(
  document: ConfigDocument<ProjectConfig> | undefined,
  project: ProjectRecord,
  deps: Pick<RuntimeDependencies, "documents">,
): Promise<{
  document?: ConfigDocument<ProjectConfig>;
  failure?: unknown;
}> {
  try {
    const current = document ?? (await deps.documents.read(project.repoPath));
    assertIdentity(project, current);
    return { document: current };
  } catch (failure) {
    return { failure };
  }
}
/** Names the Preview by the Branch or deployment the user typed; the hashed slug stays internal. */
function missingTarget(
  command: Pick<RuntimeCommand, "target" | "deployment" | "branch">,
  name: string,
): RigError {
  const label =
    command.target === PREVIEW_SELECTOR
      ? `Preview '${command.deployment ?? command.branch ?? name}'`
      : `Target '${name}'`;
  return new RigError(
    "TARGET_MISSING",
    `${label} has no recorded deployment.`,
    "Use rig up for the Working copy, or deploy this Target first.",
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
/** A stopped Working copy Target is re-planned from the current rig.yaml before it starts, keeping its id, data root, and recorded ports. */
async function replanWorkingCopy(
  target: TargetRecord,
  command: RuntimeCommand,
  project: ProjectRecord,
  document: ConfigDocument<ProjectConfig>,
  deps: RuntimeDependencies,
): Promise<TargetRecord> {
  const replanned = await planTarget(
    { command, kind: "local", project, document, existing: target },
    deps,
  );
  // The plan being replaced is stopped; an executable only it names (a removed Tool, or an alias under the old Target name) goes with it.
  // Retirement and the new plan are published together or not at all.
  const checkpoint = await deps.lifecycle.checkpoint(replanned, target);
  try {
    await deps.lifecycle.retireSuperseded(target, replanned);
    await persistTarget(replanned, deps.store);
  } catch (error) {
    try {
      await checkpoint.rollback();
    } catch (recoveryError) {
      throw retainFailureCauses(error, error, recoveryError);
    }
    throw error;
  }
  await checkpoint.commit();
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
    .sort(
      (a, b) =>
        evictionRank(a) - evictionRank(b) ||
        a.createdAt.localeCompare(b.createdAt),
    )
    .slice(0, overflow);
  if (oldest.some((t) => t.recovery || t.destructionPending))
    throw new RigError(
      "DEPLOY_RECOVERY",
      "The oldest Preview has an unresolved transition.",
      "Finish that Preview's pending down or destroy before replacing it.",
    );
  return oldest;
}
/** Verified shutdown, then committed route/artifact retirement, then deletion of the Preview's owned storage.
 * Inventory (marked destructionPending) remains the retry handle until every owned byte is gone. */
async function destroyPreview(
  target: TargetRecord,
  deps: RuntimeDependencies,
): Promise<void> {
  await deps.files.inspectPreviewDeletion({
    root: deps.root,
    target,
    state: await deps.store.read(),
  });
  target.desired = "stopped";
  target.destructionPending = true;
  target.updatedAt = deps.now();
  await persistTarget(target, deps.store);
  await retireForDestruction(target, deps);
  await deps.files.destroyPreview({
    root: deps.root,
    target,
    state: await deps.store.read(),
  });
  // The checkout left with the Preview root; this drops its worktree registration from the mirror.
  const workspacePath = ownedRevision(target);
  if (workspacePath)
    await deps.sources.release({ project: target.projectId, workspacePath });
  await deps.store.update((s) => {
    s.targets = s.targets.filter((t) => t.id !== target.id);
  });
}
/** Previews leave in this order at the limit: ones whose deploy never completed, then stopped ones, then running ones. */
function evictionRank(target: TargetRecord): number {
  if (target.deploymentIncomplete) return 0;
  return target.desired === "stopped" ? 1 : 2;
}
/** A Preview removed to make room for another, as reported to the user. */
export interface RetiredPreview {
  target: string;
  branch?: string;
  reason: "Preview limit";
}
/** Destroy replaced Previews after the new one is committed, recording each removal as its own destroy operation.
 * A removal that fails leaves the new Preview deployed and the old record in place for an explicit destroy, and is reported as a warning. */
async function destroyReplacedPreviews(
  replacements: readonly TargetRecord[],
  project: ProjectRecord,
  operationId: string,
  deps: RuntimeDependencies,
): Promise<{ retired: RetiredPreview[]; warnings: string[] }> {
  const retired: RetiredPreview[] = [];
  const warnings: string[] = [];
  for (const replacement of replacements) {
    try {
      await destroyPreview(replacement, deps);
      retired.push({
        target: replacement.name,
        ...(replacement.branch ? { branch: replacement.branch } : {}),
        reason: "Preview limit",
      });
      await deps.store.update((state) => {
        recordActivity(state, {
          id: `${operationId}:${replacement.id}`,
          projectId: project.id,
          project: project.name,
          target: replacement.name,
          action: "destroy",
          outcome: "stopped",
          occurredAt: deps.now(),
          message: "Preview limit",
        });
      });
    } catch (error) {
      const failure = failureReason(error);
      const selector = replacement.branch
        ? `preview ${replacement.branch}`
        : `preview --deployment ${replacement.name}`;
      warnings.push(
        `Preview ${replacement.branch ?? replacement.name} was not removed: ${failure} Run rig down ${selector} --destroy to finish; the Project is over its Preview limit until then.`,
      );
    }
  }
  return { retired, warnings };
}
/** The most recent records, or every record the requested Operation id (or prefix) names. */
function selectActivity(
  records: readonly OperationRecord[],
  command: Pick<RuntimeCommand, "operation" | "lines">,
): { operations: OperationRecord[]; operation?: string } {
  if (command.operation)
    return {
      operations: records.filter((record) =>
        record.id.startsWith(command.operation!),
      ),
      operation: command.operation,
    } satisfies ActivityResult;
  return {
    operations: records.slice(-(command.lines ?? 100)),
  } satisfies ActivityResult;
}

/** A registered directory that is gone entirely, as opposed to one whose config is unreadable. */
async function directoryMissing(
  repoPath: string,
  deps: Pick<RuntimeDependencies, "documents">,
): Promise<boolean> {
  try {
    await deps.documents.read(repoPath);
    return false;
  } catch (error) {
    return registeredDirectoryMissing(error);
  }
}
/** The scaffold flags an init carried that an existing config keeps out. */
function unappliedInitFlags(command: RuntimeCommand): string[] {
  const flags: [keyof RuntimeCommand, string][] = [
    ["productionBranch", "--production-branch"],
    ["domain", "--domain"],
    ["service", "--service"],
    ["tool", "--tool"],
  ];
  return flags
    .filter(([field]) => command[field] !== undefined)
    .map(([, flag]) => flag);
}
function listed(items: string[]): string {
  return items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
