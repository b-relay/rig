import { recipeReport } from "./recipes";
import type {
  ProjectStatusReader,
  ProjectStatusReport,
  StatusSelection,
} from "../domain/project-status";
import { stopRecordedTarget } from "./stop";
import { doctor, hostDoctor } from "./doctor";
import {
  assertRecordedStopped,
  forgetProject,
  updateRegistration,
} from "./registration";
import { recordActivity } from "../domain/activity";
import { ConfigError } from "../config/errors";
import type { MutationInFlight } from "./alert-policy";
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
  failureCauses,
} from "../domain/errors";
import { resolve as resolvePath } from "node:path";
import {
  activationJournal,
  intendRunning,
  intendStopped,
  recordStoppedByHostRestart,
  superviseTarget,
  supervisionScope,
} from "./supervision";
import {
  findHostRestart,
  noteMarkedForHostRestart,
  recordHostRestart,
  restartMark,
  saveHostSession,
  startAfterHostRestart,
  type HostSessionFinding,
  type RestartMark,
} from "./host-restart";
import type { HostRestart } from "../domain/host-session";
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
import { assertSourceBuildsKnown, withStops } from "./lifecycle";
import {
  activeStops,
  killSignal,
  killStops,
  killedMessage,
  recordStopKills,
  stopObserver,
  type StopTracking,
} from "./stop-progress";
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
import {
  HOST_SCOPE,
  configScope,
  createOperationLocks,
  isWithin,
  projectScope,
  projectTargetsScope,
  registrationScope,
  targetScope,
  type Lease,
  type LockScope,
} from "./operation-locks";
import { createHostReservations } from "./host-reservations";
import { boundedObservations } from "./bounded-observations";
import {
  initialPhase,
  type OperationPhase,
  type OperationPosition,
  type QueueReport,
} from "../domain/operation-progress";
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
    // A stop detached by rigd's shutdown is still under way: the pending destroy is kept for the retry that finishes it.
    const effectsChanged =
      error instanceof RigError &&
      (error.code === "RETIRE_COMMIT_PENDING" ||
        error.code === "RETIRE_ROLLBACK" ||
        error.code === "STOP_DETACHED");
    if (!effectsChanged) {
      delete target.destructionPending;
      target.updatedAt = deps.now();
      await persistTarget(target, deps.store);
    }
    throw error;
  }
}
/** `nextRetryAt` is when the earliest scheduled automatic restart is due, in Unix milliseconds. */
export interface SupervisionPass {
  nextRetryAt?: number;
}
export interface RigRuntime extends ProjectStatusReader {
  command(command: RuntimeCommand): Promise<unknown>;
  /** The daemon's first pass: adopts what survived, re-stops what was meant to stop, and applies restart policy. */
  reconcile(): Promise<SupervisionPass>;
  /** A later pass: applies restart policy to the Targets meant to run. Never raises; failures go to the diagnostic log. */
  supervise(): Promise<SupervisionPass>;
  /** Runs `operation`, a config edit, while no other config edit, `init`, `rename`, `repoint` or `forget` of the named
   * Project runs. It does not wait for the Project's Target operations, which run beside it and plan from rig.yaml as it
   * is once they are admitted. A name no Project is registered under is serialized with that name's registration instead. */
  exclusive<T>(project: string, operation: () => Promise<T>): Promise<T>;
  drain(): Promise<void>;
  /** Every mutation this daemon has accepted and not yet answered, running or waiting for its Target, as its command
   * selected the Project and Target so far; empty while none is. Config edits and supervision passes are not listed,
   * except the first pass's work on a Stable Target it may be starting again after a Host restart. */
  mutations(): MutationInFlight[];
}
const reads = readActions;
/** How many times an Operation selects again because what it selected changed while it waited. */
const MAX_SELECTIONS = 3;
/** What an Operation selected changed while it waited for its scopes; it selects again. */
class Reselect extends Error {
  constructor() {
    super("The selection changed while the Operation waited.");
    reselections.add(this);
  }
}
const reselections = new WeakSet<object>();
/** Identity, not `instanceof`: a thrown value may be anything, even a Proxy whose prototype cannot be read. */
function isReselect(error: unknown): boolean {
  return typeof error === "object" && error !== null && reselections.has(error);
}
/** How one Operation takes the scopes it works on. Reads take none. */
interface Admission {
  /** Waits until this Operation holds `scopes`; `subject` names what it works on for waiting commands and status. */
  admit(
    scopes: readonly LockScope[],
    subject: { project?: string; target?: string },
  ): Promise<void>;
  /** Whether the admitted scopes cover `scopes`. */
  holds(scopes: readonly LockScope[]): boolean;
  /** Names what the Operation is doing now; `target` is the recorded Target it does it to. */
  phase(phase: OperationPhase, target?: Pick<TargetRecord, "id">): void;
  /** The failure for a selection that changed while this Operation waited. */
  moved(): Error;
}
/** For reads, which run beside everything and never wait. */
const UNLOCKED: Admission = {
  async admit() {},
  holds: () => true,
  phase() {},
  moved: () => new Reselect(),
};
/** An Operation this daemon is running or holding, the Target it works on when that is known, and its stops; and what
 * the operator alert monitor sees of its mutation, absent for config edits and most supervision work. */
type Running = StopTracking & { mutation?: MutationInFlight };
/** rigd is the one authority over lifecycle state. Mutations of one Target run one at a time; other
 * Targets and Projects run side by side and share Host resources through short critical sections.
 * Read-only requests never wait. See docs/adr/0007-per-target-operation-queue.md. */
export function createRuntime(deps: RuntimeDependencies): RigRuntime {
  const locks = createOperationLocks();
  const reservations = createHostReservations();
  let draining = false;
  let passes = 0;
  /** Every Operation this daemon is running or holding, its own supervision work included. */
  const operations = new Map<string, Running>();
  /** Command executions still running, so a drain waits for them to answer. */
  const executing = new Set<Promise<unknown>>();
  /** Shows the alert monitor more of what `operationId`'s command selected; a read, which is not listed, is left alone. */
  const selectedForAlerts = (
    operationId: string,
    selected: Partial<MutationInFlight>,
  ) => {
    const entry = operations.get(operationId);
    if (entry?.mutation) entry.mutation = { ...entry.mutation, ...selected };
  };
  /** Mutations this daemon is executing right now; a transition they own is in progress, not abandoned. */
  const inFlight = new Set<string>();
  const inProgress = (operationId: string) => inFlight.has(operationId);
  /** Aborted when rigd drains for shutdown: a stop waiting for a Service stops waiting, and the next daemon finishes it. */
  const detaching = new AbortController();
  /** `lifecycle` as the Operation `entry` uses it: its stops cut short by its kill, detached on shutdown, shown on it. */
  /** Targets a running `--kill` asked every stop to be cut short on, with how many such commands run. */
  const killRequests = new Map<string, number>();
  const releaseKill = (targetId: string) => {
    const left = (killRequests.get(targetId) ?? 1) - 1;
    if (left > 0) killRequests.set(targetId, left);
    else killRequests.delete(targetId);
  };
  const lifecycleOf = (entry: Running) =>
    withStops(deps.lifecycle, {
      kill: (target) =>
        killSignal(entry, target.id, (id) => killRequests.has(id)),
      detach: detaching.signal,
      observer: stopObserver(entry, deps.now),
    });
  /** Working copies and Previews whose Services this daemon could not all record as stopped by the Host restart it found,
   * by Target id; each pass tries again. */
  const unmarked = new Map<string, HostRestart>();
  const stopping = (targetId: string) =>
    [...operations.values()].some(
      (entry) => entry.targetId === targetId && entry.view.phase === "stopping",
    );
  const drainingError = () =>
    new RigError(
      "DAEMON_DRAINING",
      "rigd is preparing to stop.",
      "Wait for administration to complete before retrying.",
    );
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
      {
        ...deps,
        inProgress,
        stopping,
        serviceStops: (targetId) => activeStops(operations.values(), targetId),
      },
    );
  };
  /** The Operations running and waiting, and where `operationId` stands when one is named. */
  const queueReport = (operationId?: string): QueueReport => {
    const running = [...operations.values()]
      .filter((entry) => !locks.position(entry.view.operationId))
      .map((entry) => ({ ...entry.view }));
    // Older readers show `running` as the one thing rigd is busy with; rigd's own brief supervision work is not that.
    const command = running.find(
      (view) => view.action !== "supervise" && view.action !== "reconcile",
    );
    return {
      ...(command ? { running: command } : {}),
      waiting: locks.waiting(),
      operations: running,
      ...(operationId ? { operation: positionOf(operationId) } : {}),
    };
  };
  const positionOf = (operationId: string): OperationPosition => {
    const entry = operations.get(operationId);
    if (!entry) return { state: "unknown" };
    const position = locks.position(operationId);
    if (!position)
      return {
        state: "running",
        phase: entry.view.phase,
        ...(entry.view.project ? { project: entry.view.project } : {}),
        ...(entry.view.target ? { target: entry.view.target } : {}),
        ...(entry.view.stops ? { stops: [...entry.view.stops] } : {}),
      };
    const view = (id: string) => {
      const found = operations.get(id);
      return found ? [{ ...found.view }] : [];
    };
    // Held behind nothing that runs, only behind earlier requests: the first of them is what it waits for.
    const blocking = position.holders.length
      ? position.holders
      : position.queued.slice(0, 1);
    return {
      state: "waiting",
      waitingOn: blocking.flatMap(view),
      ahead:
        position.queued.length -
        (position.holders.length ? 0 : blocking.length),
    };
  };
  /** One selection attempt's hold on its scopes; `release` ends it. The last attempt fails instead of selecting again. */
  const admission = (
    operationId: string,
    final: boolean,
  ): Admission & { release(): void } => {
    let lease: Lease | undefined;
    const entry = operations.get(operationId)!;
    return {
      async admit(scopes, subject) {
        // One admission per selection: a second would hold two leases, and nothing could release the first.
        if (lease)
          throw new Error(`Operation ${operationId} was admitted twice.`);
        if (subject.project) entry.view.project = subject.project;
        if (subject.target) entry.view.target = subject.target;
        lease = await locks.acquire(operationId, scopes);
        if (draining) throw drainingError();
      },
      holds: (scopes) =>
        scopes.every((scope) =>
          lease?.scopes.some((held) => isWithin(scope, held)),
        ),
      phase(phase, target) {
        entry.view.phase = phase;
        if (target) entry.targetId = target.id;
      },
      moved: () =>
        final
          ? new RigError(
              "OPERATION_CONTENDED",
              "What this command selected kept changing while it waited for other operations.",
              "Run rig status to see the current Targets, then run the command again.",
            )
          : new Reselect(),
      release() {
        lease?.release();
        lease = undefined;
        delete entry.targetId;
        entry.view.phase = initialPhase(entry.view.action);
      },
    };
  };
  const execute = async (command: RuntimeCommand): Promise<unknown> => {
    const operationId = command.operationId ?? deps.id();
    if (reads.has(command.action))
      return run(command, operationId, UNLOCKED, deps);
    // Operations now run side by side, so an id must name one of them at a time.
    if (operations.has(operationId))
      throw new RigError(
        "OPERATION_DUPLICATE",
        `Operation ${operationId} is already running.`,
        "Send each command with its own operation id; rig does this for you.",
        { operationId },
      );
    inFlight.add(operationId);
    if (
      command.kill &&
      !["down", "restart", "destroy"].includes(command.action)
    ) {
      inFlight.delete(operationId);
      throw new RigError(
        "USAGE",
        "--kill applies to rig down and rig restart only.",
        "Run rig down <target> --kill or rig restart <target> --kill.",
      );
    }
    // What the alert monitor sees before the command selects anything: its Project and Target as the command names them.
    const requested: MutationInFlight = {
      operationId,
      action: command.action,
      ...(command.project ? { project: command.project } : {}),
      ...(command.repoPath ? { repoPath: command.repoPath } : {}),
      ...(command.target ? { target: command.target } : {}),
    };
    const entry: Running = {
      kills: new Map(),
      ...(command.kill ? { killAll: true } : {}),
      view: {
        operationId,
        action: command.action,
        ...(command.project ? { project: command.project } : {}),
        ...(command.target ? { target: command.target } : {}),
        phase: initialPhase(command.action),
        startedAt: deps.now(),
      },
      mutation: requested,
    };
    operations.set(operationId, entry);
    try {
      for (let attempt = 1; ; attempt++) {
        const held = admission(operationId, attempt >= MAX_SELECTIONS);
        // Each attempt selects again, so what an earlier one selected no longer says what this one works on.
        entry.mutation = requested;
        try {
          return await run(command, operationId, held, {
            ...deps,
            ports: reservations.ports(operationId),
            lifecycle: lifecycleOf(entry),
          });
        } catch (error) {
          if (!isReselect(error)) throw error;
        } finally {
          held.release();
          reservations.release(operationId);
        }
      }
    } finally {
      const killing = operations.get(operationId)?.killing;
      if (killing) releaseKill(killing);
      inFlight.delete(operationId);
      operations.delete(operationId);
    }
  };
  const run = async (
    command: RuntimeCommand,
    operationId: string,
    admission: Admission,
    deps: RuntimeDependencies,
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
      if (command.action === "prepare-uninstall") {
        // Refused rather than queued: waiting for the whole Host would hold every later operation, automatic restarts
        // included, behind whatever runs now, only to refuse once it ended with Targets still running.
        if (locks.busy(HOST_SCOPE))
          throw new RigError(
            "TARGETS_RUNNING",
            "Cannot uninstall rigd while operations are running.",
            "Wait for them to finish (rig activity shows them), stop all Targets, then retry.",
          );
        await admission.admit([HOST_SCOPE], {});
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
      if (command.action === "queue") return queueReport(command.operation);
      if (command.action === "list") {
        const state = await deps.store.read();
        // An inventory listing reads the record only; Target liveness is status's job and is not observed here.
        return {
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
        // Initializing a registered Project again writes at most its rig.yaml, as a config edit does, and adds the
        // Project's `rig` Git remote when it is missing; neither is a Target's. So it takes the Project's config scope and
        // never waits for (or holds the Project's other Targets behind) a Target's stop. A new Project takes only its name.
        const registered = (await deps.store.read()).projects.find(
          (p) => p.name === identity.name && p.repoPath === identity.repoPath,
        );
        await admission.admit(
          [
            registered
              ? configScope(registered.id)
              : registrationScope(identity.name),
          ],
          { project: identity.name },
        );
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
        refuseActive(
          (await deps.store.read()).targets.filter(
            (t) => t.projectId === project!.id,
          ),
        );
        const targets = await enter([projectScope(project.id)]);
        attempted = true;
        const warnings = await forgetProject(project, targets, deps);
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
          "recipe-diff",
          "deploy",
          "deployment-context",
          "git-push",
          "rename",
        ].includes(command.action),
      );
      project = selection.project;
      const state = await deps.store.read();
      let targets = state.targets.filter((t) => t.projectId === project!.id);
      if (command.action === "deployment-context") {
        let currentBranch: string | null;
        try {
          currentBranch = await deps.sources.currentBranch(selection.checkout);
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
            (await deps.documents.host()).deploy.production_branch,
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
      if (command.action === "recipe-diff")
        return recipeReport(
          project.name,
          selection.document!,
          command,
          deps.recipes,
        );
      if (command.action === "activity")
        return selectActivity(
          state.activity.filter((o) => o.projectId === project!.id),
          command,
        );
      if (command.action === "doctor")
        return await doctor(project, targets, { ...deps, inProgress });
      if (command.action === "rename" || command.action === "repoint") {
        if (command.action === "repoint" || command.newName !== project.name)
          refuseActive(targets);
        targets = await enter([
          projectScope(project.id),
          // A rename also takes its new name, so a registration of that name cannot race it.
          ...(command.action === "rename" && command.newName
            ? [registrationScope(command.newName)]
            : []),
        ]);
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
          (await deps.documents.host()).deploy.production_branch;
        // A push selects by role: the Production Branch is the Stable Target whatever it is named.
        command = {
          ...command,
          target:
            command.branch === production
              ? targetNames(selection.document!.config).stable
              : PREVIEW_SELECTOR,
        };
        // The alert monitor sees the Target the push selected from here on: a Preview push leaves the Stable Target alone.
        selectedForAlerts(operationId, { target: command.target! });
      }
      if (
        command.action === "deploy" &&
        command.target === PREVIEW_SELECTOR &&
        !command.branch
      )
        command = {
          ...command,
          branch: await deps.sources.currentBranch(selection.checkout),
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
      // The alert monitor sees which Target the command selected, by role, so a configured name that differs from the
      // recorded one (mid-rename) still reads as the Stable Target, and in which Project, so a command run from a
      // directory no Project is registered at (a linked worktree) holds back no other Project's Stable Target.
      selectedForAlerts(operationId, { project: project.name, kind });
      const name = selected.name ?? command.target ?? "the Working copy";
      aimed = name;
      const find = (recorded: readonly TargetRecord[]) =>
        kind === "preview"
          ? recorded.find((t) => t.name === name)
          : recorded.find((t) => t.kind === kind);
      target = find(targets);
      if (!reads.has(command.action)) {
        // A new Preview over the limit also takes the Previews it will replace; the choice is made
        // again once they are held, and refused there when it must be.
        let replacing: TargetRecord[] = [];
        if (
          (command.action === "deploy" || command.action === "git-push") &&
          kind === "preview" &&
          !target
        )
          try {
            replacing = previewsToReplace(
              targets,
              reservations.claimedPreviews(project.id, operationId),
              (await deps.documents.host()).deploy.previews,
            );
          } catch {
            replacing = [];
          }
        // A kill does not wait its turn to cut short a stop already running on the Target; its own stop follows.
        if (command.kill && target) {
          const entry = operations.get(operationId)!;
          // A reselection that lands on another Target moves the request there.
          if (entry.killing !== target.id) {
            if (entry.killing !== undefined) releaseKill(entry.killing);
            entry.killing = target.id;
            killRequests.set(target.id, (killRequests.get(target.id) ?? 0) + 1);
          }
          killStops(operations.values(), target, deps.now());
        }
        targets = await enter(
          [
            targetScope(project.id, { kind, name }),
            ...replacing.map((t) => targetScope(project!.id, t)),
          ],
          { target: name },
        );
        target = find(targets);
        // A command that plans from rig.yaml plans from the file as it is once admitted, not as it was when it arrived.
        if (
          command.action !== "down" &&
          command.action !== "destroy" &&
          (await checkoutConfig(undefined, project, deps)).document
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
              (await deps.documents.host()).deploy.production_branch)
            : await deps.sources.currentBranch(selection.checkout));
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
                  (await deps.documents.host()).deploy.production_branch,
              });
        const commit = command.commit
          ? await deps.sources.resolve(project.repoPath, command.commit)
          : preflight.commit;
        assertDeploymentRecovered(target);
        const previous = target?.commit
          ? { previousCommit: target.commit }
          : {};
        // An uncertain attempt of this source is neither a completed no-op nor an ordinary retry of an incomplete deployment.
        if (target && !command.force)
          assertSourceBuildsKnown(target, { branch, commit });
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
          kind === "preview" && !target ? await claimPreviewSlot(name) : [];
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
        admission.phase("stopping", target);
        if (target.recovery) target = await stopForRecovery(target, deps);
        await destroyPreview(target, deps, admission.phase);
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
        target.desired === "stopped" &&
        // An unresolved transition is settled by down before anything plans over it.
        !target.recovery
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
        admission.phase("stopping", target);
        target = await stopForRecovery(target, deps);
      }
      let outcome: OperationRecord["outcome"];
      const warnings: string[] = [];
      if (command.action === "down") {
        target.desired = "stopped";
        intendStopped(target);
        target.updatedAt = deps.now();
        await persistTarget(target, deps.store);
        admission.phase("stopping", target);
        outcome = (await stopKeepingKills(target)).outcome;
        recordStopKills(target, operations.get(operationId)!.view);
      } else {
        if (command.action === "restart") {
          target.desired = "stopped";
          intendStopped(target);
          target.updatedAt = deps.now();
          await persistTarget(target, deps.store);
          admission.phase("stopping", target);
          await stopKeepingKills(target);
          admission.phase("starting", target);
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
        const journal = activationJournal(target, "explicit", deps);
        try {
          outcome = (await deps.lifecycle.up(target, undefined, journal))
            .outcome;
        } catch (error) {
          // The rolled-back Services are recorded as not started; failing to say so leaves their outcome unknown, never retried.
          await journal.failed(error).catch(() => {});
          throw error;
        }
        intendRunning(target);
        // up installs, routes, and starts the recorded plan under its own
        // committed checkpoint, which is everything an incomplete deployment lacked.
        delete target.deploymentIncomplete;
        target.desired = "running";
      }
      target.updatedAt = deps.now();
      await persistTarget(target, deps.store);
      return await finish(outcome, warnings.length ? { warnings } : {});
    } catch (error) {
      // Selecting again is not an outcome: nothing was changed and the command is not over.
      if (isReselect(error)) throw error;
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
          ...((message) => (message ? { message } : {}))(
            [errorCode, killedMessage(operations.get(operationId)!)]
              .filter((part) => part !== undefined)
              .join(": "),
          ),
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
      const stops = operations.get(operationId)?.view.stops;
      return {
        ...(stops?.length ? { stops } : {}),
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
    /** Stops `stopped` as `rig down` and `rig restart` do, and saves which Services it had to SIGKILL on the saved record as
     * soon as the stop is over, whether it succeeded or failed part-way, so status says so while they stay stopped: after
     * a down, or a restart that fails before it starts them again. The next start clears it. */
    async function stopKeepingKills(stopped: TargetRecord) {
      const view = operations.get(operationId)!.view;
      // Marked on the Operation's own record as well, since what it saves later (a replan, the final record) starts from it.
      const keep = () =>
        !recordStopKills(stopped, view)
          ? Promise.resolve()
          : deps.store
              .update((state) => {
                const saved = state.targets.find((t) => t.id === stopped.id);
                if (saved) recordStopKills(saved, view);
              })
              .catch(() => {});
      try {
        const result = await stopRecordedTarget(stopped, deps.lifecycle);
        await keep();
        return result;
      } catch (error) {
        await keep();
        throw error;
      }
    }
    /** Refuses a Project-wide change at once while a Target is recorded as running or mid-transition, instead of queueing
     * it behind that Target's operations (and every later operation of the Project behind it) only to refuse it then.
     * The refusal is an attempted Operation, recorded as one; the same check is made again once admitted. */
    function refuseActive(targets: readonly TargetRecord[]): void {
      try {
        assertRecordedStopped(targets);
        // A stop records its Target stopped before it waits for the exit, so the record alone does not show it.
        if (locks.busy(projectTargetsScope(project!.id)))
          throw new RigError(
            "PROJECT_ACTIVE",
            "Project registration can only change while no Target of the Project has an operation running.",
            "Wait for the running operations to finish (rig status shows a stopping Target), then retry.",
          );
      } catch (error) {
        attempted = true;
        throw error;
      }
    }
    /** Takes `scopes` within the selected Project and returns its Targets as recorded once they are
     * held. A Project renamed, repointed or forgotten while this command waited is selected again. */
    async function enter(
      scopes: readonly LockScope[],
      subject: { target?: string } = {},
    ): Promise<TargetRecord[]> {
      const selected = project!;
      await admission.admit(scopes, { project: selected.name, ...subject });
      const current = await deps.store.read();
      const now = current.projects.find((p) => p.id === selected.id);
      if (
        !now ||
        now.name !== selected.name ||
        now.repoPath !== selected.repoPath
      )
        throw admission.moved();
      project = now;
      return current.targets.filter((t) => t.projectId === now.id);
    }
    /** Counts a new Preview against its Project's limit and returns the Previews that must leave to
     * make room. The count and the claim happen with nothing awaited between them, so two deploys
     * of new Previews always see each other. A replacement chosen now that this command did not
     * take before it was admitted sends it back to select again. */
    async function claimPreviewSlot(name: string): Promise<TargetRecord[]> {
      const policy = (await deps.documents.host()).deploy.previews;
      // Claims are read after the state, so a deploy that failed meanwhile is not counted and no Preview is destroyed for
      // it. A claim that ended during the read may belong to a deploy that recorded its Preview after the read began, so
      // the state is read again until no claim ended across the read: every deploy is then counted by its record or its
      // claim.
      let recorded: TargetRecord[];
      for (;;) {
        const ended = reservations.endedPreviewClaims(project!.id);
        recorded = (await deps.store.read()).targets.filter(
          (t) => t.projectId === project!.id,
        );
        if (reservations.endedPreviewClaims(project!.id) === ended) break;
      }
      const replacements = previewsToReplace(
        recorded,
        reservations.claimedPreviews(project!.id, operationId),
        policy,
      );
      if (
        !admission.holds(
          replacements.map((replacement) =>
            targetScope(project!.id, replacement),
          ),
        )
      )
        throw admission.moved();
      reservations.claimPreview(operationId, project!.id, name);
      return replacements;
    }
  };
  return {
    status,
    mutations: () =>
      [...operations.values()].flatMap((entry) =>
        entry.mutation ? [{ ...entry.mutation }] : [],
      ),
    async drain() {
      draining = true;
      // A stop in progress may wait an hour; shutdown leaves it to the Service and the next daemon.
      detaching.abort();
      // Commands already running answer; any that was waiting is refused once admitted.
      while (executing.size) await Promise.allSettled([...executing]);
      await locks.idle();
    },
    async exclusive<T>(
      projectName: string,
      operation: () => Promise<T>,
    ): Promise<T> {
      if (draining) throw drainingError();
      const project = (await deps.store.read()).projects.find(
        (p) => p.name === projectName,
      );
      const id = `config:${deps.id()}`;
      operations.set(id, {
        kills: new Map(),
        view: {
          operationId: id,
          action: "config",
          project: projectName,
          phase: "editing config",
          startedAt: deps.now(),
        },
      });
      const lease = await locks.acquire(id, [
        project ? configScope(project.id) : registrationScope(projectName),
      ]);
      try {
        if (draining) throw drainingError();
        return await operation();
      } finally {
        lease.release();
        operations.delete(id);
      }
    },
    command(command) {
      const running = execute(command);
      if (!reads.has(command.action)) {
        executing.add(running);
        void running.finally(() => executing.delete(running)).catch(() => {});
      }
      return running;
    },
    reconcile: () => pass("reconcile"),
    supervise: () => pass("supervise"),
  };
  /** One pass over the recorded Targets. Both passes supervise the Targets meant to run; only `reconcile`, the daemon's first
   * pass, also re-stops the Targets meant to be stopped and reclaims orphaned checkpoints. Each Target is worked on under its
   * own lease, side by side with the others. `supervise` skips a Target another Operation holds: that Operation owns it now
   * and the next pass looks again. `reconcile` holds the whole Host while it reclaims checkpoints, then hands each Target its
   * own lease before anything queued behind it runs. */
  async function pass(
    action: "reconcile" | "supervise",
  ): Promise<SupervisionPass> {
    if (draining) return {};
    // Requested before anything is awaited, so a reconcile called at startup is ahead of every command.
    const hostId = `reconcile:${++passes}`;
    if (action === "reconcile")
      operations.set(hostId, {
        kills: new Map(),
        view: {
          operationId: hostId,
          action,
          phase: initialPhase(action),
          startedAt: deps.now(),
        },
      });
    const host =
      action === "reconcile" ? locks.acquire(hostId, [HOST_SCOPE]) : undefined;
    // Read while the pass waits for the Host, so a command waits for the read at most for what is left of it.
    const hostSession =
      action === "reconcile"
        ? deps.hostSession?.current().catch(() => undefined)
        : undefined;
    const failed = (error: unknown, target?: string) =>
      deps
        .diagnostic({
          operationId: deps.id(),
          action,
          outcome: "failed",
          ...(target ? { target } : {}),
          errorCode: diagnosticErrorCode(error),
          ...diagnosticCauses(error),
        })
        .catch(() => {});
    const lease = await host;
    let jobs: Promise<number | undefined>[];
    let finding: HostSessionFinding | undefined;
    /** The Host restart's Activity entry could not be written before the pass acted on it. */
    let announceLater = false;
    /** The Targets of this pass, and those whose share of it is done (after a Host restart: acted on). */
    let expected: string[] = [];
    const settled = new Set<string>();
    try {
      // Unreadable state is recorded and left alone; the daemon keeps serving so doctor and status can show it.
      let state;
      try {
        state = await deps.store.read();
      } catch (error) {
        lease?.release();
        operations.delete(hostId);
        await failed(error);
        return {};
      }
      if (action === "reconcile") {
        await pruneCheckpoints(state, deps);
        const current = await hostSession;
        if (current) finding = findHostRestart(state, current);
        if (finding?.restart && !finding.announced) {
          const found = finding;
          await recordHostRestart(
            { ...found, restart: found.restart! },
            deps,
          ).catch(async (error) => {
            // The pass still acts on the restart; the entry is written once it has, with what it settled.
            announceLater = true;
            await failed(error);
          });
        }
      }
      const eligible = state.targets.filter(
        (target) =>
          !target.recovery &&
          !target.destructionPending &&
          (action === "reconcile" || target.desired === "running"),
      );
      const parts = eligible.map((target) => ({
        id: `${action}:${target.id}`,
        scopes: [targetScope(target.projectId, target)],
      }));
      const leases = lease
        ? lease.split(parts)
        : parts.map((part) =>
            draining ? undefined : locks.tryAcquire(part.id, part.scopes),
          );
      const restart = finding?.restart;
      const mark =
        finding?.restart !== undefined
          ? restartMark({ ...finding, restart: finding.restart })
          : undefined;
      // A drain may already have begun: a Target skipped for it is not settled, so the restart is found again.
      expected = eligible.map((target) => target.id);
      jobs = eligible.flatMap((target, index) => {
        const held = leases[index];
        return held
          ? [
              superviseJob(
                target.id,
                held,
                action,
                failed,
                restart,
                settled,
                finding?.settled,
                mark,
              ),
            ]
          : [];
      });
    } finally {
      lease?.release();
      operations.delete(hostId);
    }
    const recorded =
      finding &&
      recordSessionAfter(
        jobs,
        finding,
        () => expected.every((id) => settled.has(id)),
        failed,
        announceLater ? settled : undefined,
      );
    const due = (await passResults(jobs)).filter(
      (value): value is number => value !== undefined,
    );
    if (!deps.supervisionPassBudget) await recorded;
    return due.length ? { nextRetryAt: Math.min(...due) } : {};
  }
  /** Records the Host session as acted on once every Target's share of the first pass is over, and only when `complete`
   * says each one was done and rigd is not draining: a daemon that stopped, drained or failed before it acted on a Host
   * restart for every Target finds the same restart again at its next start. A restart whose Activity entry could not be
   * written before the pass acted on it is recorded now, with the Targets `unannounced` holds as settled; while it cannot
   * be, the session is not recorded, so the next start still announces it. A drain waits for it. Never rejects. */
  function recordSessionAfter(
    jobs: readonly Promise<unknown>[],
    finding: HostSessionFinding,
    complete: () => boolean,
    failed: (error: unknown) => Promise<void>,
    unannounced?: ReadonlySet<string>,
  ): Promise<void> {
    const recording = Promise.allSettled(jobs)
      .then(async () => {
        if (unannounced && finding.restart)
          await recordHostRestart(
            { ...finding, restart: finding.restart },
            deps,
            [...unannounced],
          );
        // A drain that began before a Target was acted on left it unsettled; one that began later changes nothing.
        if (!finding.record || (finding.restart && !complete())) return;
        await saveHostSession(finding.session, deps);
      })
      .catch(failed);
    executing.add(recording);
    void recording.finally(() => executing.delete(recording));
    return recording;
  }
  /** What a pass waits for: every Target's work, or with a pass budget only what finishes within it. The rest carries on
   * under its Target's lease. */
  async function passResults(
    jobs: Promise<number | undefined>[],
  ): Promise<(number | undefined)[]> {
    const budget = deps.supervisionPassBudget;
    if (!budget) return await Promise.all(jobs);
    const results = await boundedObservations(
      jobs.map((job) => () => job),
      budget.ms,
      budget.deadline,
    );
    return results.map((result) =>
      result.kind === "completed" ? result.value : undefined,
    );
  }
  /** One Target's share of a pass, under `lease`, which it releases. The record is read again under the lease, since a read
   * made before it may predate what the Operation that last held the Target recorded. After a Host `restart` the first pass
   * found, a Stable Target meant to run is started again as by `rig up`, and the Working copy's or a Preview's stopped
   * Services are recorded as stopped by the restart, which keeps them stopped until `rig up`. Adds `targetId` to `settled`
   * once that is done, or once nothing about a restart is left to do for the Target. Never rejects; failures are
   * recorded. */
  async function superviseJob(
    targetId: string,
    lease: Lease,
    action: "reconcile" | "supervise",
    failed: (error: unknown, target?: string) => Promise<void>,
    restart?: HostRestart,
    settled?: Set<string>,
    /** Targets an earlier daemon already settled for this same restart: Stable Targets started again (or failed to), and
     * Working copies and Previews whose stopped Services it recorded as stopped by the restart. */
    startedBefore?: ReadonlySet<string>,
    /** The restart a Stable Target's start is noted in. */
    mark?: RestartMark,
  ): Promise<number | undefined> {
    const entry: Running = {
      kills: new Map(),
      view: {
        operationId: lease.id,
        action,
        phase: initialPhase(action),
        startedAt: deps.now(),
      },
      targetId,
      // Until the first pass after a Host restart has started a Stable Target again, its Services' last exits predate
      // the restart; the alert monitor holds back judgement of it rather than count it down since then.
      ...(mark && !startedBefore?.has(targetId)
        ? { mutation: { operationId: lease.id, action, targetId } }
        : {}),
    };
    operations.set(lease.id, entry);
    let name: string | undefined;
    try {
      if (draining) return undefined;
      const state = await deps.store.read();
      const target = state.targets.find((t) => t.id === targetId);
      // Only a Stable Target meant to run is started again; the alert monitor judges any other Target as usual.
      if (target?.kind !== "live" || target.desired !== "running")
        delete entry.mutation;
      if (
        !target ||
        target.recovery ||
        target.destructionPending ||
        target.desired !== "running"
      )
        settled?.add(targetId);
      if (!target || target.recovery || target.destructionPending)
        return undefined;
      name = target.name;
      entry.view.target = target.name;
      const project = state.projects.find((p) => p.id === target.projectId);
      if (project) entry.view.project = project.name;
      const lifecycle = lifecycleOf(entry);
      if (target.desired === "running") {
        if (mark && target.kind === "live" && !startedBefore?.has(targetId)) {
          entry.view.phase = "starting";
          if (await startAfterHostRestart(target, mark, { ...deps, lifecycle }))
            settled?.add(targetId);
          return undefined;
        }
        // A Working copy or Preview whose stopped Services could not all be recorded as stopped by the restart is tried
        // again by each pass of this daemon, and nothing of it is supervised until then. One an earlier daemon already
        // recorded is not recorded again: an explicit start since then has ended the restart's hold on it.
        const stoppedBy =
          target.kind === "live" || startedBefore?.has(targetId)
            ? undefined
            : (restart ?? unmarked.get(targetId));
        if (stoppedBy) {
          if (!(await recordStoppedByHostRestart(target, stoppedBy, deps))) {
            unmarked.set(targetId, stoppedBy);
            return undefined;
          }
          unmarked.delete(targetId);
          if (mark)
            await noteMarkedForHostRestart(targetId, mark, deps).catch(
              (error: unknown) => failed(error, target.name),
            );
        }
        settled?.add(targetId);
        return await superviseTarget(
          target,
          { ...deps, lifecycle },
          supervisionScope(target),
        );
      }
      if (action === "reconcile") {
        entry.view.phase = "stopping";
        // A stop that fails part-way still records the SIGKILL of a Service it stopped before.
        try {
          await lifecycle.down(target);
        } catch (error) {
          if (recordStopKills(target, entry.view))
            await persistTarget(target, deps.store).catch(() => {});
          throw error;
        }
        if (recordStopKills(target, entry.view))
          await persistTarget(target, deps.store);
      }
      return undefined;
    } catch (error) {
      await failed(error, name);
      return undefined;
    } finally {
      operations.delete(lease.id);
      lease.release();
    }
  }
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
  // A Service a failed down left running is adopted by the next up, not started; its record is what explains its later exit.
  if (target.services) replanned.services = target.services;
  // The plan being replaced is stopped; an executable only it names (a removed Tool, or an alias under the old Target name) goes with it.
  // Retirement and the new plan are published together or not at all.
  const checkpoint = await deps.lifecycle.checkpoint(replanned, target);
  try {
    await deps.lifecycle.retireSuperseded(target, replanned);
    // Saved with the plan, the decision makes an interrupted finalization finish the commit instead of restoring retired executables.
    await persistTarget(
      {
        ...replanned,
        recovery: {
          plan: target.plan,
          desired: "stopped",
          stage: "committing",
        },
      },
      deps.store,
    );
  } catch (error) {
    try {
      await checkpoint.rollback();
    } catch (recoveryError) {
      throw retainFailureCauses(error, error, recoveryError);
    }
    throw error;
  }
  try {
    await checkpoint.commit();
    await persistTarget(replanned, deps.store);
  } catch (error) {
    throw new RigError(
      "REPLAN_COMMIT_PENDING",
      `The new plan of ${replanned.name} was saved, but its commit finalization is incomplete.`,
      `Run rig down ${replanned.name} to finish the recorded commit, then run the command again.`,
      {},
      failureCauses(error),
    );
  }
  return replanned;
}
/** The oldest Previews that must leave so a new Preview fits under the Host limit; none while the Project is under it.
 * `creating` names the Previews other deploys are creating right now: they count against the limit whether or not they
 * are recorded yet, and are never chosen to leave. Rejects PREVIEW_LIMIT under the reject policy or when only Previews
 * being created could make room, and DEPLOY_RECOVERY when a chosen Preview is mid-transition. */
function previewsToReplace(
  targets: readonly TargetRecord[],
  creating: ReadonlySet<string>,
  policy: { max: number; replace_policy: "oldest" | "reject" },
): TargetRecord[] {
  const previews = targets.filter((t) => t.kind === "preview");
  const unrecorded = [...creating].filter(
    (name) => !previews.some((preview) => preview.name === name),
  );
  const overflow = previews.length + unrecorded.length - policy.max + 1;
  if (overflow <= 0) return [];
  if (policy.replace_policy === "reject")
    throw new RigError(
      "PREVIEW_LIMIT",
      "The Project has reached its Preview limit.",
      "Remove an existing Preview or change the Host Preview limit.",
    );
  const oldest = previews
    .filter((preview) => !creating.has(preview.name))
    .sort(
      (a, b) =>
        evictionRank(a) - evictionRank(b) ||
        a.createdAt.localeCompare(b.createdAt),
    )
    .slice(0, overflow);
  if (oldest.length < overflow)
    throw new RigError(
      "PREVIEW_LIMIT",
      "The Project's Preview limit is taken by Previews that are being deployed right now.",
      "Wait for those deploys to finish, then retry; the oldest Preview is replaced then.",
    );
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
  /** Told when the Preview has stopped and its storage is being deleted. */
  progress: (phase: OperationPhase) => void = () => {},
): Promise<void> {
  await deps.files.inspectPreviewDeletion({
    root: deps.root,
    target,
    state: await deps.store.read(),
  });
  target.desired = "stopped";
  intendStopped(target);
  target.destructionPending = true;
  target.updatedAt = deps.now();
  await persistTarget(target, deps.store);
  await retireForDestruction(target, deps);
  progress("destroying");
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
