import type { RuntimeState, TargetRecord } from "../domain/runtime";
import { diagnosticCauses, diagnosticErrorCode } from "../domain/errors";
import { supervisionScope } from "../domain/restart-policy";
import { isStopDetached } from "../domain/stop-budget";
import { initialPhase } from "../domain/operation-progress";
import type { RuntimeDependencies } from "./contracts";
import type { TargetLifecycle } from "./lifecycle";
import { createRouteGuard } from "./route-guard";
import type { StopTracking } from "./stop-progress";
import { recordStopKills } from "./stop-progress";
import {
  superviseTarget,
  withholdRecoveryPaths,
  withholdStoppedServices,
  type RestartMarks,
} from "./supervision";
import {
  findHostRestart,
  recordFailedAfterHostRestart,
  recordHostRestart,
  recordStoppedAfterHostRestart,
  restartMark,
  saveHostSession,
  startAfterHostRestart,
  type HostSessionFinding,
  type RestartMark,
} from "./host-restart";
import { trackedWorkReport } from "./work-report";
import { boundedObservations } from "./bounded-observations";
import { stopJobRuns } from "./jobs";
import { persistTarget } from "./targets";
import { releaseHeldCheckouts } from "./revisions";
import { HOST_SCOPE, targetScope, type Lease } from "./operation-locks";
import type { OperationCoordinator } from "./operation-coordinator";

/** `nextRetryAt` is when the earliest scheduled automatic restart is due, in Unix milliseconds. */
export interface SupervisionPass {
  nextRetryAt?: number;
}
/** What a Host restart left that this daemon could not record yet, which an Operation records under its Target's lease
 * before it acts on the Target. Each resolves whether none is left unrecorded. */
export interface HostRestartRecords {
  /** Records the failed start after a Host restart of a stable Target, if one is waiting; a failure is in the diagnostic
   * log. */
  recordFailedStart(target: TargetRecord): Promise<boolean>;
  /** Whether a failed start after a Host restart waits to be recorded for the Target `targetId`. */
  failedStartPending(targetId: string): boolean;
  /** Records the stop by a Host restart of a working Target's or Preview's Services, if one is waiting, so an explicit
   * start that follows supersedes it and a later pass never applies it to the new process. */
  recordStop(target: TargetRecord): Promise<boolean>;
}
export interface SupervisionPasses {
  /** One pass over the recorded Targets; see `RigRuntime.reconcile` and `RigRuntime.supervise`. */
  pass(requested: "reconcile" | "supervise"): Promise<SupervisionPass>;
  readonly restartRecords: HostRestartRecords;
}
/** The supervision work that reads the runtime state, beside each Target's share (by its id). */
const STATE_WORK = "state";

/** The daemon's passes over its Targets, run under `coordinator`'s leases: the first one reconciles the Host session,
 * later ones apply restart policy. */
export function createSupervisionPasses(
  deps: RuntimeDependencies,
  coordinator: Pick<
    OperationCoordinator,
    | "acquire"
    | "draining"
    | "gate"
    | "lifecycleOf"
    | "register"
    | "track"
    | "tryAcquire"
    | "unregister"
  >,
): SupervisionPasses {
  /** Where on the elapsed clock this daemon saw each Service's exits and automatic attempts. */
  const restartMarks: RestartMarks = new Map();
  /** How supervision went: reading the state (`STATE_WORK`), and each Target's share by its id. */
  const supervision = trackedWorkReport(deps.supervision);
  let passes = 0;
  /** working Targets and Previews whose Services this daemon could not all record as stopped by the Host restart it found,
   * by Target id, with that restart as the first pass identified it; each pass, and each Operation admitted on the Target,
   * tries again (see `recordUnmarked`). Only the write is retried: which runs it applies to is in the runs themselves. */
  const unmarked = new Map<string, RestartMark>();
  /** Records, under the caller's lease of `target`, the stop by a Host restart this daemon could not record yet, if there is
   * one, so an explicit start that follows supersedes it and a later pass never applies it to the new process. Resolves
   * whether none is left unrecorded. */
  const recordUnmarked = async (target: TargetRecord): Promise<boolean> => {
    const pending = unmarked.get(target.id);
    if (!pending) return true;
    if (!(await recordStoppedAfterHostRestart(target, pending, deps)))
      return false;
    unmarked.delete(target.id);
    return true;
  };
  /** The routed Services of each Target meant to run that this daemon saw stopped and had withheld, while their record keeps
   * them stopped (see `withholdStoppedServices`), by Target id. */
  const routesChecked = new Map<string, Set<string>>();
  /** The Services of each Target whose state `routesChecked` could not establish at its last look, as last recorded. */
  const routesUnchecked = new Map<string, string>();
  /** Records in the diagnostic log when the Services of `target` whose state could not be established change, and when none
   * is left: every pass looks again, and one unchanged look says nothing new. */
  const noteRoutesUnchecked = async (
    target: TargetRecord,
    action: string,
    uncertain: readonly string[],
  ): Promise<void> => {
    const services = uncertain.join(", ");
    if (services === (routesUnchecked.get(target.id) ?? "")) return;
    routesUnchecked.set(target.id, services);
    await deps
      .diagnostic({
        operationId: deps.id(),
        action,
        outcome: services ? "routes-unchecked" : "routes-checked",
        target: target.name,
        ...(services
          ? {
              evidence: `Whether ${services} still run could not be established, so their paths are left as published until they can.`,
            }
          : {}),
      })
      .catch(() => {});
  };
  /** stable Targets whose start after a Host restart failed and could not be recorded, by Target id, with the failure and
   * the restart. Each pass, and each Operation admitted on the Target, records it first (see `recordUnrecorded`). */
  const unrecorded = new Map<string, { error: unknown; mark: RestartMark }>();
  /** Records the failed start after a Host restart that this daemon could not record yet for `target`, if there is one,
   * under the caller's lease of the Target. Resolves whether none is left unrecorded; a failure is in the diagnostic log. */
  const recordUnrecorded = async (target: TargetRecord): Promise<boolean> => {
    const failure = unrecorded.get(target.id);
    if (!failure) return true;
    if (
      !(await recordFailedAfterHostRestart(
        target,
        failure.error,
        failure.mark,
        deps,
      ))
    )
      return false;
    unrecorded.delete(target.id);
    return true;
  };
  return {
    pass,
    restartRecords: {
      recordFailedStart: recordUnrecorded,
      failedStartPending: (targetId) => unrecorded.has(targetId),
      recordStop: recordUnmarked,
    },
  };
  /** One pass over the recorded Targets. Both passes supervise the Targets meant to run and check the paths of an unresolved
   * recovery; only `reconcile`, the daemon's first pass, also re-stops the Targets meant to be stopped and reclaims orphaned
   * checkpoints. Each Target is worked on under its own lease, side by side with the others. `supervise` skips a Target
   * another Operation holds: that Operation owns it now and the next pass looks again. `reconcile` holds the whole Host while it reclaims checkpoints, then hands each Target its
   * own lease before anything queued behind it runs. */
  async function pass(
    requested: "reconcile" | "supervise",
  ): Promise<SupervisionPass> {
    if (coordinator.draining()) return {};
    const action = coordinator.gate.closed() ? "reconcile" : requested;
    // Requested before anything is awaited, so a reconcile called at startup is ahead of every command.
    const hostId = `reconcile:${++passes}`;
    if (action === "reconcile")
      coordinator.register({
        kills: new Map(),
        view: {
          operationId: hostId,
          action,
          phase: initialPhase(action),
          startedAt: deps.now(),
        },
      });
    const host =
      action === "reconcile"
        ? coordinator.acquire(hostId, [HOST_SCOPE])
        : undefined;
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
      // Unreadable state is recorded, reported and left alone; the daemon keeps serving so doctor and status can show it.
      let state: RuntimeState;
      let revision: string | undefined;
      try {
        // Before the read: a write in between only makes each Target read again.
        revision = await deps.store.revision?.();
        state = await deps.store.read();
      } catch (error) {
        lease?.release();
        coordinator.unregister(hostId);
        if (action === "reconcile") coordinator.gate.close();
        await failed(error);
        supervision.failed(STATE_WORK, "Reading the runtime state", error);
        return {};
      }
      supervision.succeeded(STATE_WORK);
      if (action === "reconcile") coordinator.gate.open();
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
      const supervised = new Set(eligible.map((target) => target.id));
      // An unresolved recovery is not supervised, but every pass takes it for one duty, whatever it is meant to do: withholding
      // the paths of its Services that stopped (`withholdRecoveryPaths`).
      const recovering = state.targets.filter((target) => target.recovery);
      const reported = new Set(recovering.map((target) => target.id));
      // A Target gone, stopped or in another transition is not worked on: a failure about it no longer stands.
      supervision.only(
        (work) =>
          work === STATE_WORK || supervised.has(work) || reported.has(work),
      );
      // The first pass also takes each Target in a transition, to stop a build left running.
      const passed =
        action === "reconcile"
          ? [...eligible, ...state.targets.filter((t) => !supervised.has(t.id))]
          : [...eligible, ...recovering];
      const parts = passed.map((target) => ({
        id: `${action}:${target.id}`,
        scopes: [targetScope(target.projectId, target)],
      }));
      const leases = lease
        ? lease.split(parts)
        : parts.map((part) =>
            coordinator.draining()
              ? undefined
              : coordinator.tryAcquire(part.id, part.scopes),
          );
      const mark =
        finding?.restart !== undefined
          ? restartMark({ ...finding, restart: finding.restart })
          : undefined;
      // A drain may already have begun: a Target skipped for it is not settled, so the restart is found again.
      expected = eligible.map((target) => target.id);
      // Until its stop by the restart is recorded, each working Target and Preview is held as not yet recorded: a job that
      // fails before it records it (a read that fails, say) leaves it so, and later passes, Operations and health restarts
      // keep holding it until it is.
      if (mark)
        for (const target of eligible)
          if (target.kind !== "stable" && !finding?.settled.has(target.id))
            unmarked.set(target.id, mark);
      // Each job works on its own Target only, so all of them can share this read while nothing has been written since.
      const read = state;
      const current = async () =>
        action === "supervise" &&
        revision !== undefined &&
        (await deps.store.revision?.()) === revision
          ? read
          : await deps.store.read();
      // A Target another Operation holds is skipped: neither a failure nor a recovery of its supervision.
      jobs = passed.flatMap((target, index) => {
        const held = leases[index];
        if (!held) return [];
        const about = `Supervising ${target.name} of ${state.projects.find((p) => p.id === target.projectId)?.name ?? target.projectId}`;
        let failure = false;
        return [
          superviseJob(
            target.id,
            held,
            action,
            current,
            async (error, name) => {
              failure = true;
              supervision.failed(target.id, about, error);
              await failed(error, name);
            },
            settled,
            finding?.settled,
            mark,
          ).then((due) => {
            if (!failure) supervision.succeeded(target.id);
            return due;
          }),
        ];
      });
    } finally {
      lease?.release();
      coordinator.unregister(hostId);
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
    coordinator.track(recording);
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
  /** One Target's share of a pass, under `lease`, which it releases. The record comes from `current` under the lease, since a
   * read made before it may predate what the Operation that last held the Target recorded. After the Host restart `mark` the
   * first pass found, a Stable Target meant to run is started again as by `rig up`, and the Working copy's or a Preview's stopped
   * Services are recorded as stopped by the restart, which keeps them stopped until `rig up`. Adds `targetId` to `settled`
   * once that is done, or once nothing about a restart is left to do for the Target. Never rejects; failures are
   * recorded. */
  async function superviseJob(
    targetId: string,
    lease: Lease,
    action: "reconcile" | "supervise",
    current: () => Promise<RuntimeState>,
    failed: (error: unknown, target?: string) => Promise<void>,
    settled?: Set<string>,
    /** Targets an earlier daemon already settled for this same restart: stable Targets started again (or failed to), and
     * working Targets and Previews whose stopped Services it recorded as stopped by the restart. */
    startedBefore?: ReadonlySet<string>,
    /** The Host restart the first pass found, as it is identified in state; a later pass has none. */
    mark?: RestartMark,
  ): Promise<number | undefined> {
    const entry: StopTracking = {
      kills: new Map(),
      view: {
        operationId: lease.id,
        action,
        phase: initialPhase(action),
        startedAt: deps.now(),
      },
      targetId,
    };
    coordinator.register(entry);
    let name: string | undefined;
    try {
      if (coordinator.draining()) return undefined;
      const state = await current();
      const target = state.targets.find((t) => t.id === targetId);
      if (
        !target ||
        target.recovery ||
        target.destructionPending ||
        target.desired !== "running"
      )
        settled?.add(targetId);
      // Gone, or meant to be stopped: nothing of it waits for a restart's stop to be recorded.
      if (!target || target.desired !== "running") unmarked.delete(targetId);
      if (!target) return undefined;
      name = target.name;
      entry.view.target = target.name;
      const project = state.projects.find((p) => p.id === target.projectId);
      if (project) entry.view.project = project.name;
      const observing = coordinator.lifecycleOf(entry);
      // A build a daemon that died left running is stopped first, whatever the Target is meant to do. One that cannot be
      // is reported, and status lists it; it holds up nothing else of the Target.
      if (action === "reconcile")
        await observing
          .stopPreparation(target)
          .catch(async (error: unknown) => {
            if (isStopDetached(error)) throw error;
            await failed(error, name);
          });
      // A proxy that refuses is reported, and it and a Service whose state cannot be established are tried again by the next
      // pass.
      if (target.recovery) {
        await withholdRecoveryPaths(target, {
          ...deps,
          lifecycle: observing,
        }).then(
          (uncertain) => noteRoutesUnchecked(target, action, uncertain),
          (error: unknown) => failed(error, name),
        );
        return undefined;
      }
      if (target.destructionPending) return undefined;
      // While it starts a Service again the pass is starting, not observing, so a command queued behind it says so.
      const lifecycle: TargetLifecycle = {
        ...observing,
        async recover(recovering, service, journal, stops) {
          entry.view.phase = "starting";
          try {
            return await observing.recover(recovering, service, journal, stops);
          } finally {
            entry.view.phase = initialPhase(action);
          }
        },
      };
      if (target.desired === "running") {
        // A Stable Target whose failed start after a Host restart could not be recorded has it recorded by each later pass
        // of this daemon until that succeeds, and nothing of it is started or supervised until then.
        if (unrecorded.has(targetId)) {
          await recordUnrecorded(target);
          return undefined;
        }
        if (mark && target.kind === "stable" && !startedBefore?.has(targetId)) {
          entry.view.phase = "starting";
          // The start publishes before the end of its plan has started, so its paths are watched as an Operation's are,
          // until the Target's lease ends.
          const routeGuard = createRouteGuard(deps, {
            operationId: lease.id,
            action: "up",
          });
          let started: Awaited<ReturnType<typeof startAfterHostRestart>>;
          try {
            started = await startAfterHostRestart(target, mark, {
              ...deps,
              lifecycle: coordinator.lifecycleOf(entry, routeGuard),
            });
          } finally {
            await routeGuard.release();
          }
          if (started.outcome === "settled") settled?.add(targetId);
          if (started.outcome === "unrecorded")
            unrecorded.set(targetId, { error: started.error, mark });
          return undefined;
        }
        // A Working copy or Preview whose stopped Services could not all be recorded as stopped by the restart is tried
        // again by each pass of this daemon, and nothing of it is supervised until then. One an earlier daemon already
        // recorded is not recorded again: an explicit start since then has ended the restart's hold on it.
        // A later pass has no restart of its own, so it records the one the first pass kept, as that pass would have.
        const stoppedBy =
          target.kind === "stable" || startedBefore?.has(targetId)
            ? undefined
            : (mark ?? unmarked.get(targetId));
        if (stoppedBy) {
          if (
            !(await recordStoppedAfterHostRestart(target, stoppedBy, {
              ...deps,
              lifecycle,
            }))
          ) {
            unmarked.set(targetId, stoppedBy);
            return undefined;
          }
          unmarked.delete(targetId);
        }
        settled?.add(targetId);
        // A Service its record keeps stopped is not withheld by supervision, so paths an earlier rigd left published to it go
        // here rather than at the Target's next rig up, once for each stop. One whose state cannot be established yet, or a
        // proxy that does not answer yet, is tried again by the next pass.
        const checked = routesChecked.get(targetId) ?? new Set<string>();
        routesChecked.set(targetId, checked);
        await withholdStoppedServices(target, checked, {
          ...deps,
          lifecycle,
        }).then(
          (uncertain) => noteRoutesUnchecked(target, action, uncertain),
          (error: unknown) => failed(error, name),
        );
        return await superviseTarget(
          target,
          { ...deps, lifecycle },
          supervisionScope(target),
          restartMarks,
        );
      }
      if (action === "reconcile") {
        entry.view.phase = "stopping";
        // A job that cannot be stopped is a failure of this pass, after the Services stopped.
        let jobFailure: unknown;
        try {
          await stopJobRuns(target, { ...deps, lifecycle });
          await releaseHeldCheckouts(target, deps);
        } catch (error) {
          if (isStopDetached(error)) throw error;
          jobFailure = error;
        }
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
        if (jobFailure !== undefined) throw jobFailure;
      }
      return undefined;
    } catch (error) {
      await failed(error, name);
      return undefined;
    } finally {
      coordinator.unregister(lease.id);
      lease.release();
    }
  }
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
