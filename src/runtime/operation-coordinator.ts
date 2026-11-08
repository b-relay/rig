import { readActions, type RuntimeCommand } from "../daemon/protocol";
import type { TargetRecord } from "../domain/runtime";
import { RigError, internalInvariant } from "../domain/errors";
import {
  initialPhase,
  type DrainReason,
  type OperationPhase,
  type OperationPosition,
  type QueueReport,
} from "../domain/operation-progress";
import type { RuntimeDependencies } from "./contracts";
import { withStops, type TargetLifecycle } from "./lifecycle";
import { createRouteGuard, type RouteGuard } from "./route-guard";
import {
  activeStops,
  killSignal,
  killStops,
  stopObserver,
  type StopTracking,
} from "./stop-progress";
import {
  createHostReservations,
  type HostReservations,
} from "./host-reservations";
import {
  configScope,
  createOperationLocks,
  isWithin,
  projectTargetsScope,
  registrationScope,
  targetScope,
  type Lease,
  type LockScope,
} from "./operation-locks";

const reads = readActions;
/** How many times an Operation selects again because what it selected changed while it waited. */
const MAX_SELECTIONS = 3;
declare const reselection: unique symbol;
/** A selection that changed while its Operation waited, which the Operation answers by selecting again: a signal, not a
 * failure, so its type is no Error. The brand is the type's alone; `isReselect` tells one apart at run time. */
interface Reselection {
  readonly [reselection]: true;
}
/** What an Operation selected changed while it waited for its scopes; it selects again. */
class Reselect extends Error implements Reselection {
  declare readonly [reselection]: true;
  constructor() {
    super("The selection changed while the Operation waited.");
    reselections.add(this);
  }
}
const reselections = new WeakSet<object>();
/** Identity, not `instanceof`: a thrown value may be anything, even a Proxy whose prototype cannot be read. */
export function isReselect(error: unknown): boolean {
  return typeof error === "object" && error !== null && reselections.has(error);
}
/** How one Operation takes the scopes it works on. Reads take none. */
export interface Admission {
  /** Waits until this Operation holds `scopes`; `subject` names what it works on for waiting commands and status. */
  admit(
    scopes: readonly LockScope[],
    subject: { project?: string; target?: string },
  ): Promise<void>;
  /** Whether the admitted scopes cover `scopes`. */
  holds(scopes: readonly LockScope[]): boolean;
  /** Names what the Operation is doing now; `target` is the recorded Target it does it to. */
  phase(phase: OperationPhase, target?: Pick<TargetRecord, "id">): void;
  /** What to throw for a selection that changed while this Operation waited: a Reselection, or OPERATION_CONTENDED once
   * the Operation may select no more. */
  moved(): RigError | Reselection;
}
/** For reads, which run beside everything and never wait. */
const UNLOCKED: Admission = {
  async admit() {},
  holds: () => true,
  phase() {},
  moved: () => new Reselect(),
};
/** One command's work, given its Operation's admission and its own dependencies. A Reselection it throws makes the
 * Operation select again. */
export type CommandRun = (
  command: RuntimeCommand,
  operationId: string,
  admission: Admission,
  deps: RuntimeDependencies,
) => Promise<unknown>;
/** What status asks about the Operations running and waiting. */
export interface OperationQueries {
  /** Whether this daemon is executing the mutation `operationId`, so a transition it owns is in progress, not abandoned. */
  inProgress(operationId: string): boolean;
  /** Whether an Operation is stopping Services of the Target `targetId`. */
  stopping(targetId: string): boolean;
  /** The stops Operations are making of the Target `targetId`'s Services. */
  serviceStops(targetId: string): ReturnType<typeof activeStops>;
  /** Whether an Operation holds or waits for a Target of the Project `projectId`. */
  projectBusy(projectId: string): boolean;
  /** Whether an up, restart or deploy holds or waits for `target`, so a build running for it may be its own. */
  building(target: Pick<TargetRecord, "projectId" | "kind" | "name">): boolean;
}
/** The one owner of what Operations hold, wait for and show: their leases, the Operations listed for status, their kills,
 * the drain, and the gate that holds every start until rigd has read its state (ADR 0007). */
export interface OperationCoordinator extends OperationQueries {
  /** Runs `command` through `run`: a read at once, a mutation as an Operation that may select again, listed while it
   * runs, and waited for by a drain. */
  command(command: RuntimeCommand, run: CommandRun): Promise<unknown>;
  /** Runs `work` as rigd's own Operation `view.operationId` on the recorded Target `recorded`: listed from now, under the
   * Target's lease once it is free, and waited for by a drain. Resolves `skipped`, without working, when rigd began
   * draining while it waited. */
  onTarget<T>(
    recorded: TargetRecord,
    view: { operationId: string; action: string; phase: OperationPhase },
    skipped: T,
    work: (entry: StopTracking) => Promise<T>,
  ): Promise<T>;
  /** See `RigRuntime.exclusive`. */
  exclusive<T>(project: string, operation: () => Promise<T>): Promise<T>;
  /** The Operations running and waiting, and where `operationId` stands when one is named. */
  queueReport(operationId?: string): QueueReport;
  /** Whether an Operation that may start or stop a Service holds or waits for `target`. Neither a supervision pass that
   * only observes nor the sweep of held checkouts does. */
  targetBusy(
    target: Pick<TargetRecord, "projectId" | "kind" | "name">,
  ): boolean;
  /** Whether any lease held or waited for conflicts with `scope`. */
  busy(scope: LockScope): boolean;
  /** Why rigd refuses new work, while it does. */
  draining(): DrainReason | false;
  /** Throws DAEMON_DRAINING while rigd refuses new work. */
  assertNotDraining(): void;
  /** Calls off an uninstall's preparation; a shutdown cannot be. */
  cancelUninstall(): void;
  /** Refuses new work until the uninstall is cancelled, unless rigd already refuses it. */
  prepareUninstall(): void;
  /** Detaches every stop waiting for an exit, refuses new work, and resolves once nothing runs or waits. */
  drain(): Promise<void>;
  /** The gate that holds every start until a first pass has read the state. */
  readonly gate: { closed(): boolean; open(): void; close(): void };
  /** Lists `entry` until `unregister`. */
  register(entry: StopTracking): void;
  unregister(operationId: string): void;
  /** What is listed for `operationId`. */
  tracking(operationId: string): StopTracking | undefined;
  acquire(id: string, scopes: readonly LockScope[]): Promise<Lease>;
  tryAcquire(id: string, scopes: readonly LockScope[]): Lease | undefined;
  /** Makes a drain wait for `work`. */
  track(work: Promise<unknown>): void;
  /** `lifecycle` as the Operation `entry` uses it: its stops cut short by its kill, detached on shutdown, shown on it. */
  lifecycleOf(entry: StopTracking, guard?: RouteGuard): TargetLifecycle;
  /** Aborted when rigd drains for shutdown. */
  readonly detach: AbortSignal;
  /** Makes the `--kill` command `operationId` cut short every stop on `target`, now and while it runs, moving its request
   * there from a Target an earlier selection named. */
  kill(operationId: string, target: TargetRecord): void;
  /** The Preview claims of running Operations (ADR 0007). */
  readonly previews: Pick<
    HostReservations,
    "claimPreview" | "claimedPreviews" | "endedPreviewClaims"
  >;
}
/** Runs Operations over `deps`: mutations of one Target one at a time, other Targets and Projects side by side, reads
 * never waiting. */
export function createOperationCoordinator(
  deps: RuntimeDependencies,
): OperationCoordinator {
  const locks = createOperationLocks();
  const reservations = createHostReservations();
  let draining: DrainReason | false = false;
  /** The gate: closed until a first pass has read the state, and again while one cannot. No Service starts while it is
   * closed, so no run is journalled before a Host restart's record. See docs/reviews/2026-11-08-runtime-application-split.md. */
  let reconcilePending = deps.reconcileGate !== "open";
  /** Refuses a command that would start a Service while the gate above is closed. */
  const assertReconciled = (action: string) => {
    if (
      reconcilePending &&
      ["up", "restart", "deploy", "run", "restore"].includes(action)
    )
      throw new RigError(
        "HOST_STATE_PENDING",
        "rigd is still starting and has not read its state yet, so it cannot tell whether the Mac restarted, and nothing was started.",
        "Run the command again in a moment. If this keeps happening, rigd cannot read its state under RIG_ROOT/runtime: rig doctor and the rigd diagnostic log show why.",
      );
  };
  /** Every Operation this daemon is running or holding, its own supervision work included. */
  const operations = new Map<string, StopTracking>();
  /** Command executions still running, so a drain waits for them to answer. */
  const executing = new Set<Promise<unknown>>();
  /** Mutations this daemon is executing right now; a transition they own is in progress, not abandoned. */
  const inFlight = new Set<string>();
  const inProgress = (operationId: string) => inFlight.has(operationId);
  /** Aborted when rigd drains for shutdown: a stop waiting for a Service stops waiting, and the next daemon finishes it. */
  const detaching = new AbortController();
  /** Targets a running `--kill` asked every stop to be cut short on, with how many such commands run. */
  const killRequests = new Map<string, number>();
  const releaseKill = (targetId: string) => {
    const left = (killRequests.get(targetId) ?? 1) - 1;
    if (left > 0) killRequests.set(targetId, left);
    else killRequests.delete(targetId);
  };
  const lifecycleOf = (entry: StopTracking, guard?: RouteGuard) =>
    withStops(deps.lifecycle, {
      kill: (target) =>
        killSignal(entry, target.id, (id) => killRequests.has(id)),
      detach: detaching.signal,
      observer: stopObserver(entry, deps.now),
      ...(guard ? { guard } : {}),
    });
  const track = (work: Promise<unknown>) => {
    executing.add(work);
    void work.finally(() => executing.delete(work)).catch(() => {});
  };
  const stopping = (targetId: string) =>
    [...operations.values()].some(
      (entry) => entry.targetId === targetId && entry.view.phase === "stopping",
    );
  const drainingError = () =>
    draining === "uninstall-prepared"
      ? new RigError(
          "DAEMON_DRAINING",
          "rigd is prepared for uninstall and refuses new work until that is finished or cancelled.",
          `Finish it with rigd uninstall, press Cancel uninstall under Uninstall readiness on the dashboard's Monitor page, or clear it by restarting rigd: kill ${process.pid}, wait for process ${process.pid} to exit, then rigd install.`,
        )
      : new RigError(
          "DAEMON_DRAINING",
          "rigd is preparing to stop.",
          "Wait for administration to complete before retrying.",
        );
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
      ...(draining ? { draining } : {}),
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
          throw internalInvariant(
            `Operation ${operationId} was admitted twice.`,
            { operationId },
          );
        if (subject.project) entry.view.project = subject.project;
        if (subject.target) entry.view.target = subject.target;
        lease = await locks.acquire(operationId, scopes);
        if (draining) throw drainingError();
        // Checked once admitted: a first pass that failed while this waited behind it closes the gate.
        assertReconciled(entry.view.action);
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
  const execute = async (
    command: RuntimeCommand,
    run: CommandRun,
  ): Promise<unknown> => {
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
    const entry: StopTracking = {
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
    };
    operations.set(operationId, entry);
    try {
      for (let attempt = 1; ; attempt++) {
        const held = admission(operationId, attempt >= MAX_SELECTIONS);
        const routeGuard = createRouteGuard(deps, {
          operationId,
          action: command.action,
        });
        try {
          return await run(command, operationId, held, {
            ...deps,
            ports: reservations.ports(operationId),
            lifecycle: lifecycleOf(entry, routeGuard),
            routeGuard,
          });
        } catch (error) {
          if (!isReselect(error)) throw error;
        } finally {
          // Joined for the last time before the Target is released: from here supervision watches it again.
          await routeGuard.release();
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
  return {
    command(command, run) {
      const running = execute(command, run);
      if (!reads.has(command.action)) track(running);
      return running;
    },
    async onTarget(recorded, view, skipped, work) {
      const entry: StopTracking = {
        kills: new Map(),
        targetId: recorded.id,
        view: {
          operationId: view.operationId,
          action: view.action,
          target: recorded.name,
          phase: view.phase,
          startedAt: deps.now(),
        },
      };
      operations.set(view.operationId, entry);
      const running = (async () => {
        const lease = await locks.acquire(view.operationId, [
          targetScope(recorded.projectId, recorded),
        ]);
        try {
          if (draining) return skipped;
          return await work(entry);
        } finally {
          lease.release();
          operations.delete(view.operationId);
        }
      })();
      track(running);
      return await running;
    },
    async exclusive(projectName, operation) {
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
    queueReport,
    targetBusy(target) {
      return locks.busy(targetScope(target.projectId, target), (id) => {
        const entry = operations.get(id);
        return (
          (entry?.view.action === "supervise" &&
            entry.view.phase === initialPhase("supervise")) ||
          entry?.view.action === "held-checkout"
        );
      });
    },
    inProgress,
    stopping,
    serviceStops: (targetId) => activeStops(operations.values(), targetId),
    projectBusy: (projectId) => locks.busy(projectTargetsScope(projectId)),
    // Only an up, restart or deploy builds: while one holds or waits for the Target, what runs may be its own.
    building: (target) =>
      locks.busy(targetScope(target.projectId, target), (id) => {
        const action = operations.get(id)?.view.action;
        return !["up", "restart", "deploy"].includes(action ?? "");
      }),
    busy: (scope) => locks.busy(scope),
    draining: () => draining,
    assertNotDraining() {
      if (draining) throw drainingError();
    },
    cancelUninstall() {
      // A shutdown cannot be called off: only a preparation can.
      if (draining === "stopping") throw drainingError();
      draining = false;
    },
    prepareUninstall() {
      // A shutdown may have begun during the preparation's observation, and it stands.
      if (draining) throw drainingError();
      draining = "uninstall-prepared";
    },
    async drain() {
      draining = "stopping";
      // A stop in progress may wait an hour; shutdown leaves it to the Service and the next daemon.
      detaching.abort();
      // Commands already running answer; any that was waiting is refused once admitted.
      while (executing.size) await Promise.allSettled([...executing]);
      await locks.idle();
    },
    gate: {
      closed: () => reconcilePending,
      open() {
        reconcilePending = false;
      },
      close() {
        reconcilePending = true;
      },
    },
    register(entry) {
      operations.set(entry.view.operationId, entry);
    },
    unregister(operationId) {
      operations.delete(operationId);
    },
    tracking: (operationId) => operations.get(operationId),
    acquire: (id, scopes) => locks.acquire(id, scopes),
    tryAcquire: (id, scopes) => locks.tryAcquire(id, scopes),
    track,
    lifecycleOf,
    detach: detaching.signal,
    kill(operationId, target) {
      const entry = operations.get(operationId)!;
      // A reselection that lands on another Target moves the request there.
      if (entry.killing !== target.id) {
        if (entry.killing !== undefined) releaseKill(entry.killing);
        entry.killing = target.id;
        killRequests.set(target.id, (killRequests.get(target.id) ?? 0) + 1);
      }
      killStops(operations.values(), target, deps.now());
    },
    previews: {
      claimPreview: (operationId, projectId, name) =>
        reservations.claimPreview(operationId, projectId, name),
      claimedPreviews: (projectId, exceptOperation) =>
        reservations.claimedPreviews(projectId, exceptOperation),
      endedPreviewClaims: (projectId) =>
        reservations.endedPreviewClaims(projectId),
    },
  };
}
