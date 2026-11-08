import type { ConfigDocument, ProjectConfig } from "../config/types";
import { PREVIEW_SELECTOR } from "../config/schema";
import { readActions, type RuntimeCommand } from "../daemon/protocol";
import type {
  ProjectStatusReport,
  StatusSelection,
} from "../domain/project-status";
import { rigCommand } from "../domain/rig-command";
import type { TargetRecord } from "../domain/runtime";
import { RigError } from "../domain/errors";
import type { RuntimeDependencies } from "./contracts";
import { doctor } from "./doctor";
import {
  isReselect,
  type Admission,
  type CommandRun,
  type OperationCoordinator,
} from "./operation-coordinator";
import { operationOutcome, type OperationOutcome } from "./operation-outcome";
import type { LockScope } from "./operation-locks";
import { targetScope } from "./operation-locks";
import type { OrphanSweep } from "./orphan-routes";
import type { HostRestartRecords } from "./supervision-passes";
import type { StopTracking } from "./stop-progress";
import { checkoutConfig, selectProject } from "./projects";
import { assertTargetOn, selectTarget } from "./targets";
import { assertRecordedStopped, projectBusyError } from "./registration";
import { assertNotDestroying } from "./target-refusals";
import { previewsToReplace } from "./previews";
import {
  applyProxy,
  dnsCommand,
  hostActivity,
  hostUsage,
  initializationInfo,
  listProjects,
  prepareUninstall,
  proxyReport,
  unregisteredDoctor,
} from "./host-commands";
import {
  activityScopeError,
  deploymentContext,
  projectBackups,
  projectDeployments,
  projectUsage,
  selectActivity,
  targetLogs,
} from "./project-reads";
import {
  forgetCommand,
  initProject,
  updateProject,
} from "./registration-commands";
import { deployCommand } from "./deploy-command";
import {
  destroyCommand,
  lifecycleCommand,
  restoreBackup,
  runJob,
} from "./target-commands";

const reads = readActions;
/** One command as an Operation: what it runs with, what its outcome will record, and how it takes its Project's scopes. */
export interface CommandContext {
  readonly operationId: string;
  readonly admission: Admission;
  /** The Operation's own dependencies: its port claims, and its lifecycle under its kills and route guard. */
  readonly deps: RuntimeDependencies;
  readonly outcome: OperationOutcome;
  /** What rigd lists for the Operation; a read has nothing listed. */
  tracking(): StopTracking | undefined;
  /** Takes `scopes` within the selected Project and returns its Targets as recorded once they are held. A Project
   * renamed, repointed or forgotten while this command waited is selected again. */
  enter(
    scopes: readonly LockScope[],
    subject?: { target?: string },
  ): Promise<TargetRecord[]>;
  /** Refuses a Project-wide change at once while one of `targets` is recorded as running or mid-transition, instead of
   * queueing it behind that Target's operations (and every later operation of the Project behind it) only to refuse it
   * then. The refusal is an attempted Operation, recorded as one; the same check is made again once admitted. */
  refuseActive(targets: readonly TargetRecord[]): void;
}
/** The Target a command selected, once admitted: its role and name, the Project's rig.yaml as read for the whole action,
 * and the Project's selection. Its record, if any, is the outcome's `target`. */
export interface SelectedTarget {
  readonly kind: TargetRecord["kind"];
  readonly name: string;
  readonly configured: {
    document?: ConfigDocument<ProjectConfig>;
    failure?: unknown;
  };
  readonly selection: Awaited<ReturnType<typeof selectProject>>;
}
/** Every command's work, by family: the Host's, a Project's reads, its registration, and its Targets'. A mutation's
 * failure once attempted is recorded in Activity; one before that is a usage mistake, in the diagnostic log only. */
export function createCommandRunner(capabilities: {
  coordinator: Pick<
    OperationCoordinator,
    | "assertNotDraining"
    | "busy"
    | "cancelUninstall"
    | "inProgress"
    | "kill"
    | "prepareUninstall"
    | "previews"
    | "projectBusy"
    | "queueReport"
    | "tracking"
  >;
  restartRecords: HostRestartRecords;
  sweep: OrphanSweep;
  status: (selection: StatusSelection) => Promise<ProjectStatusReport>;
}): CommandRun {
  const { coordinator, restartRecords, sweep, status } = capabilities;
  return async (command, operationId, admission, deps) => {
    const tracking = () => coordinator.tracking(operationId);
    const outcome = operationOutcome(command, operationId, deps, tracking);
    const context: CommandContext = {
      operationId,
      admission,
      deps,
      outcome,
      tracking,
      async enter(scopes, subject = {}) {
        const selected = outcome.project!;
        await admission.admit(scopes, { project: selected.name, ...subject });
        const current = await deps.store.read();
        const now = current.projects.find((p) => p.id === selected.id);
        if (
          !now ||
          now.name !== selected.name ||
          now.repoPath !== selected.repoPath
        )
          throw admission.moved();
        outcome.project = now;
        return current.targets.filter((t) => t.projectId === now.id);
      },
      refuseActive(targets) {
        try {
          assertRecordedStopped(targets);
          // A stop records its Target stopped before it waits for the exit, so the record alone does not show it.
          if (coordinator.projectBusy(outcome.project!.id))
            throw projectBusyError();
        } catch (error) {
          outcome.attempted = true;
          throw error;
        }
      },
    };
    try {
      if (command.action === "cancel-uninstall") {
        coordinator.cancelUninstall();
        return { cancelled: true };
      }
      if (!reads.has(command.action)) coordinator.assertNotDraining();
      if (command.action === "prepare-uninstall")
        return await prepareUninstall(context, coordinator);
      if (command.action === "queue")
        return coordinator.queueReport(command.operation);
      if (command.action === "proxy-apply") return await applyProxy(deps);
      if (command.action === "proxy") return await proxyReport(deps);
      if (
        command.action === "dns" ||
        command.action === "dns-create" ||
        command.action === "dns-update" ||
        command.action === "dns-delete"
      )
        return await dnsCommand(command.action, command.dns ?? {}, context);
      if (command.action === "list") return await listProjects(deps);
      if (command.action === "monitor" && command.host)
        return await hostUsage(command, deps);
      // The whole Host when asked for, or when nothing names a Project (the dashboard's Host pages); rig sends the directory
      // it runs in, so it reads that Project's unless --all.
      if (
        command.action === "activity" &&
        (command.host === true || (!command.project && !command.repoPath))
      )
        return await hostActivity(command, deps);
      if (command.action === "initialization-info")
        return await initializationInfo(command, deps);
      if (command.action === "init") return await initProject(command, context);
      if (command.action === "forget")
        return await forgetCommand(command, context);
      if (command.action === "doctor" && !command.project) {
        const report = await unregisteredDoctor(command, deps);
        if (report) return report;
      }
      if (command.action === "status") return await status(command);
      return await projectCommand(command, context);
    } catch (error) {
      // Selecting again is not an outcome: nothing was changed and the command is not over.
      if (!isReselect(error) && !reads.has(command.action))
        await outcome.recordFailure(error);
      throw error;
    }
  };
  /** A command of the Project it selects: a read of it, a change of its registration, or a command on one of its
   * Targets, admitted on that Target. */
  async function projectCommand(
    command: RuntimeCommand,
    context: CommandContext,
  ): Promise<unknown> {
    const { deps, outcome } = context;
    const selection = await selectProject(
      command,
      deps,
      ["config", "deploy", "deployment-context", "rename"].includes(
        command.action,
      ),
    ).catch((error: unknown) => {
      throw command.action === "activity" && !command.project
        ? activityScopeError(error)
        : error;
    });
    const project = (outcome.project = selection.project);
    const state = await deps.store.read();
    const targets = state.targets.filter((t) => t.projectId === project.id);
    if (command.action === "deployment-context")
      return await deploymentContext(command, selection, deps);
    if (command.action === "config")
      return { project: project.name, ...selection.document };
    if (command.action === "monitor")
      return await projectUsage(command, project, targets, deps);
    if (command.action === "activity")
      return selectActivity(
        state.activity.filter((o) => o.projectId === project.id),
        command,
      );
    if (command.action === "deployments")
      return projectDeployments(command, project, targets, state);
    if (command.action === "doctor")
      return await doctor(project, targets, {
        ...deps,
        inProgress: coordinator.inProgress,
      });
    if (command.action === "backups")
      return await projectBackups(command, project, targets, state, deps);
    if (command.action === "rename" || command.action === "repoint")
      return await updateProject(command, targets, context);
    if (
      command.action === "deploy" &&
      command.target === PREVIEW_SELECTOR &&
      !command.branch
    )
      command = {
        ...command,
        branch: await deps.sources.currentBranch(selection.checkout),
      };
    // A job runs in the stable Target unless the command names another, as jobs are scheduled there by default; so does a
    // restore, a run of the job.
    if (
      (command.action === "run" || command.action === "restore") &&
      command.target === undefined
    )
      command = { ...command, target: "stable" };
    const selected = await admitTarget(command, selection, targets, context);
    if (command.action === "logs")
      return await targetLogs(
        command,
        outcome.project!,
        outcome.target,
        selected.name,
        deps,
      );
    if (command.action === "run")
      return await runJob(command, selected, context);
    if (command.action === "restore")
      return await restoreBackup(command, selected, context);
    if (command.action === "deploy")
      return await deployCommand(command, selected, context, {
        sweep,
        previews: coordinator.previews,
      });
    if (command.action === "destroy")
      return await destroyCommand(command, selected, context);
    return await lifecycleCommand(command, selected, context, sweep);
  }
  /** Selects the Target `command` names among the Project's `targets` and, for a mutation, waits for its lease (and those
   * of the Previews a new one will replace), then reads its record again. An off Target is never started, deployed or
   * published, and a never-run one has no logs to read; one still recorded can always be stopped, destroyed and read, so
   * a config change never strands a running process. An unreadable config cannot say, and leaves a recorded Target to
   * its record. A command that plans from rig.yaml plans from the file as it is once admitted, not as it was when it
   * arrived: one that changed sends it back to select again. */
  async function admitTarget(
    command: RuntimeCommand,
    selection: SelectedTarget["selection"],
    recorded: readonly TargetRecord[],
    context: CommandContext,
  ): Promise<SelectedTarget> {
    const { operationId, admission, deps, outcome } = context;
    // One document snapshot serves the whole action: whether the Target is on, and the plan made from it.
    const configured = await checkoutConfig(
      selection.document,
      outcome.project!,
      deps,
    );
    const { kind, name } = selectTarget(command);
    outcome.aimed = name;
    const find = (targets: readonly TargetRecord[]) =>
      kind === "preview"
        ? targets.find((t) => t.name === name)
        : targets.find((t) => t.kind === kind);
    let target = (outcome.target = find(recorded));
    if (
      configured.document &&
      (["up", "restart", "deploy", "run", "restore"].includes(command.action) ||
        (command.action === "logs" && !target))
    )
      assertTargetOn(configured.document.config, kind);
    if (!reads.has(command.action)) {
      const project = outcome.project!;
      // A new Preview over the limit also takes the Previews it will replace; the choice is made
      // again once they are held, and refused there when it must be.
      let replacing: TargetRecord[] = [];
      if (command.action === "deploy" && kind === "preview" && !target)
        try {
          replacing = previewsToReplace(
            recorded,
            coordinator.previews.claimedPreviews(project.id, operationId),
            (await deps.documents.host()).deploy.previews,
          );
        } catch {
          replacing = [];
        }
      // A kill does not wait its turn to cut short a stop already running on the Target; its own stop follows.
      if (command.kill && target) coordinator.kill(operationId, target);
      const admitted = await context.enter(
        [
          targetScope(project.id, { kind, name }),
          ...replacing.map((t) => targetScope(project.id, t)),
        ],
        { target: name },
      );
      target = outcome.target = find(admitted);
      // A failed start after a Host restart this daemon could not record yet is recorded before anything acts on the Target.
      if (target && !(await restartRecords.recordFailedStart(target)))
        throw new RigError(
          "STATE_WRITE",
          `${target.name}'s failed start after the Host restarted could not be recorded, so nothing was done.`,
          "rigd could not write its state under RIG_ROOT/runtime; rig doctor and the rigd diagnostic log show why. Free disk space or fix the permissions, then retry.",
          { target: target.name },
        );
      // So is a stop by a Host restart, so an explicit start after it supersedes it. Nothing starts on the Target while it
      // cannot be recorded: the restart's stop applies to the runs started before the restart was recorded, so a start
      // made before then would be taken for one the restart stopped. Stops and down go on.
      if (
        target &&
        !(await restartRecords.recordStop(target)) &&
        ["up", "restart", "deploy", "run", "restore"].includes(command.action)
      )
        throw new RigError(
          "STATE_WRITE",
          `Rig could not record that the Mac restarted for ${target.name}, so nothing was started.`,
          `Fix the state directory under RIG_ROOT/runtime, or the proxy when a route could not be withheld (rig doctor and the rigd diagnostic log show why; free disk space or fix the permissions), then run the command again. ${rigCommand("down", { target })} still works.`,
          { target: target.name },
        );
      if (
        command.action !== "down" &&
        command.action !== "destroy" &&
        (await checkoutConfig(undefined, outcome.project!, deps)).document
          ?.revision !== configured.document?.revision
      )
        throw admission.moved();
    }
    if (target && target.kind !== kind)
      throw new RigError(
        "TARGET_IDENTITY",
        "The selected Target kind does not match its recorded identity.",
        "Select the correct Target kind and name.",
      );
    if (target && !["destroy", "logs", "down"].includes(command.action))
      assertNotDestroying(target);
    return { kind, name, configured, selection };
  }
}
