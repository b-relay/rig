import type {
  BuildUnit,
  InstalledComponent,
  ManagedComponent,
  PlanJob,
} from "../config/types";
import type { PreparedEnvironment, TargetRecord } from "../domain/runtime";
import { withoutReferenceVariables } from "../domain/process-environment";
import { targetSelector } from "../domain/target-selector";
import { rigCommand } from "../domain/rig-command";
import type {
  HealthCheck,
  ProcessObservation,
  StopResult,
  Supervisor,
} from "../providers/contracts";
import { isStopDetached, serviceGraceMs } from "../domain/stop-budget";
import type { ListenerEvidence } from "../providers/listener-inspection";
import {
  RigError,
  failureCauses,
  failureReason,
  retainFailureCauses,
} from "../domain/errors";
import { declaredPorts, plannedRoutes } from "./ports";
import {
  UPSTREAM_HOST,
  routeUpstream,
  takesUpstream,
} from "../domain/route-upstream";
import { componentDirectory, jobDirectory } from "../config/working-dir";
import { randomUUID } from "node:crypto";

export interface TargetEffectCheckpoint {
  readonly targetId: string;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
/** One effect checkpoint found without a live Target during pruning. */
export interface PrunedCheckpoint {
  path: string;
  /** Known when the journal or claim could be read. */
  targetId?: string;
  outcome: "removed" | "retained";
  /** Why a checkpoint was kept: only a pending journal that recorded a change is retained. */
  reason?: string;
}
export interface TargetEffects {
  /** Remove effect checkpoints and preparation claims whose Target id is not in `live`.
   * A pending journal that recorded a change is retained, since only rollback may undo it. */
  pruneCheckpoints(live: ReadonlySet<string>): Promise<PrunedCheckpoint[]>;
  checkpoint(
    target: TargetRecord,
    previous?: TargetRecord,
  ): Promise<TargetEffectCheckpoint>;
  restoreEffects(target: TargetRecord): Promise<void>;
  commitEffects(target: TargetRecord): Promise<void>;
  retireSuperseded(
    previous: TargetRecord,
    candidate: TargetRecord,
  ): Promise<void>;
  retireArtifacts(target: TargetRecord): Promise<void>;
  supervisor(target: TargetRecord): Supervisor;
  /** Prepares the workspace: storage, and dependency installation once per workspace, which runs in `environment` when
   * given (the Project scope, composed by the caller) and otherwise in one composed now. */
  prepare(
    target: TargetRecord,
    environment?: Readonly<Record<string, string>>,
  ): Promise<void>;
  /** One invocation's composed environment; without a Component, the Project scope the shared build and dependency
   * installation run in. */
  environment(
    target: TargetRecord,
    component?: ManagedComponent | InstalledComponent | PlanJob,
  ): Promise<Record<string, string>>;
  /** The keyed digest of a composed environment `env` of `target`, its checkout path normalized (ADR 0016): equal for two
   * environments that differ only in the checkout they name, and never reversible to a value. Absent: no digest is
   * recorded, so a deploy keeps no Service running. */
  digestEnvironment?(
    target: TargetRecord,
    env: Readonly<Record<string, string>>,
  ): Promise<string>;
  /** The Service's own check, or without one a connection to every port it declares.
   * May block or ignore cancellation. A not-ready result retries after 100ms and its reason is kept for the failure; rejection fails startup. */
  health(
    component: ManagedComponent,
    target: TargetRecord,
    signal: AbortSignal,
  ): Promise<HealthCheck>;
  /** Runs one build command in the Target workspace within the unit's budget, in its Component's environment scope
   * (the Project scope for the shared unit). Fails BUILD_FAILED or BUILD_TIMEOUT; a build past its budget has been killed. */
  build(
    unit: BuildUnit,
    target: TargetRecord,
    /** The environment `buildEnvironment` composed for this unit; one is composed now when absent. */
    environment?: Readonly<Record<string, string>>,
  ): Promise<void>;
  /** The environment `unit`'s command runs in, composed now (its env files read now): its Component's scope, or the
   * Project's for the shared unit, with the unit's guarded inputs checked. Absent: none is composed ahead of the build. */
  buildEnvironment?(
    unit: BuildUnit,
    target: TargetRecord,
  ): Promise<Record<string, string>>;
  /** Publishes a Tool's executable; never builds. */
  install(
    component: InstalledComponent,
    target: TargetRecord,
  ): Promise<{ outcome: "installed" | "unchanged" }>;
  /** What the owned process `pid` and its descendants listen on now. May block or ignore cancellation. */
  listeners(pid: number, signal: AbortSignal): Promise<ListenerEvidence>;
  /** Publishes the Target's whole route map, or removes its route when the plan has none. A path reaches its port only while
   * that port is live: one the published route reaches now, less `withhold`, plus `verified`; every other path answers 503
   * instead of reaching a process. A port is verified only by its own Service's start gate or ownership inspection, so a path
   * moved to another Service follows that Service's port, and nothing a withheld port had carries over to another. */
  route(target: TargetRecord, change: RouteChange): Promise<void>;
  /** Withholds every path of the Target's published route whose upstream is one of `ports` (every path, without `ports`),
   * and leaves its other paths as published. Resolves only once the proxy is confirmed to serve that, even when the route
   * file already said so (a publication a crash cut short). Read from the route as published, not from the plan, so a plan
   * without some of its Services still withholds the rest. */
  withhold(target: TargetRecord, ports?: ReadonlySet<number>): Promise<void>;
  removeRoute(target: TargetRecord): Promise<void>;
  /** Withdraws the Target's route, confirmed in the proxy before it resolves, and says how to publish it again exactly as it
   * was; undefined when the Target has no route, and then nothing is asked of the proxy. Fails as removing a route fails
   * (PROXY_UNREACHABLE, ROUTE_RELOAD, …) with the route as it was. */
  withdrawRoute(target: TargetRecord): Promise<RouteWithdrawal | undefined>;
  /** Withdraws every route whose Target `owners` does not name; see `Router.withdrawUnowned`. Resolves with the hostnames
   * withdrawn. */
  pruneRoutes(
    owners: () => Promise<ReadonlySet<string>>,
    confinement?: { readonly within: string },
  ): Promise<string[]>;
  /** Refuses the Target's route map as publishing it would (ROUTE_INVALID, ROUTE_CONFLICT), changing nothing. */
  checkRoute?(target: TargetRecord): Promise<void>;
  /** Lets go of what `checkRoute` reserved for the Target. */
  releaseRoute?(target: TargetRecord): Promise<void>;
}
/** Routes taken out of the proxy, and the way to publish them again. */
export interface RouteWithdrawal {
  /** Every hostname the withdrawn routes served, in the order the Targets were given. */
  readonly hostnames: readonly string[];
  /** Publishes the withdrawn routes again as they were, confirmed in the proxy. A route that changed since it was withdrawn
   * (ROUTE_CHANGED) or cannot be published fails it; every route is still tried, and the failure (ROUTE_RESTORE from a
   * lifecycle) names in `details.hostnames` those not published again. */
  restore(): Promise<void>;
}
/** Ports of the Target's plan to take out of the route, or to publish because their Service was just verified. */
export type RouteChange =
  | { readonly withhold: ReadonlySet<number> }
  | { readonly verified: ReadonlySet<number> };
/** Where build outcomes are kept. `started` must be durable before it returns: it is the only evidence a crashed build leaves. */
export interface BuildJournal {
  /** `evidence` holds the keyed digests of the environment the unit's command is about to run in. */
  started(unit: BuildUnit, evidence?: PreparedEnvironment): Promise<void>;
  finished(unit: BuildUnit, state: "succeeded" | "failed"): Promise<void>;
}
/** The runtime's say over each process start, and what it learns before a route is published.
 * `starting` is asked before a stopped Service is spawned and answers with the incarnation its process will carry; when it
 * rejects, nothing is spawned. `activated` is told once that process is verified ready (alive, when it has no check) and before
 * the Target's route is published; when it rejects, the start fails like a failed readiness check. */
export interface ActivationJournal {
  starting(service: string, evidence?: StartEvidence): Promise<string>;
  activated(service: string, incarnation: string): Promise<void>;
}
/** What the lifecycle knows about a start before it spawns the process, for the journal to record with it. */
export interface StartEvidence {
  /** The keyed digest of the environment the process is started with; absent when it could not be computed. */
  environment?: string;
}
/** How the stops one Operation makes wait, and who hears about them. Every stop honours each Service's stop_timeout. */
export interface StopControl {
  /** The kill for stops of `target`: aborted before or during a stop, it cuts the remaining grace to the kill wait
   * (`rig down --kill`). Asked as each stop begins, and as each start begins for the stop of a start that fails. */
  readonly kill?: (target: TargetRecord) => AbortSignal | undefined;
  /** Aborted when rigd shuts down: the stop waiting now fails STOP_DETACHED, no further Service is signalled, and the
   * Services keep stopping on their own for the next daemon to finish. */
  readonly detach?: AbortSignal;
  /** Hears each Service's stop begin and end, so status and the waiting command can show it. */
  readonly observer?: StopObserver;
}
export interface StopObserver {
  /** `service` of `target` is being asked to stop and has `graceMs` to exit before SIGKILL. */
  stopping(target: TargetRecord, service: string, graceMs: number): void;
  /** Its stop ended as the supervisor said, or failed. */
  stopped(
    target: TargetRecord,
    service: string,
    ended: StopResult | { readonly outcome: "failed" },
  ): void;
}
export interface PreparationRequest {
  /** `all` runs every unit. `stopped` is a Working copy up: the units of Services that are not running and of every Tool,
   * after the shared unit when any Service is to start or any Tool exists; nothing when every Service runs and there is no Tool. */
  select: "all" | "stopped";
  journal: BuildJournal;
}
export interface TargetLifecycle {
  pruneCheckpoints(live: ReadonlySet<string>): Promise<PrunedCheckpoint[]>;
  checkpoint(
    target: TargetRecord,
    previous?: TargetRecord,
  ): Promise<TargetEffectCheckpoint>;
  /** Rolls back the Target's interrupted effect transaction once its Services are down; the route comes back withheld
   * wherever the route as it is now reaches no upstream. */
  restoreEffects(target: TargetRecord): Promise<void>;
  commitEffects(target: TargetRecord): Promise<void>;
  retireSuperseded(
    previous: TargetRecord,
    candidate: TargetRecord,
  ): Promise<void>;
  /** Installs the workspace's dependencies, then runs the selected build units in plan order, journaling each before and after.
   * A build a daemon that died left running is stopped first, so two never run in the workspace at once; each command's
   * process group is recorded before it runs, so the next daemon can stop it in turn.
   * Starts no Service and publishes nothing. The first failing unit stops preparation with BUILD_FAILED or BUILD_TIMEOUT.
   * BUILD_UNKNOWN means a command succeeded but its outcome could not be recorded; the journal still says `started`. */
  prepare(
    target: TargetRecord,
    request: PreparationRequest,
  ): Promise<
    {
      built: string[];
    } /** The keyed digests of the Project-scope environment dependency installation was given; absent when it could not
     * be composed or digested. */ & PreparedEnvironment
  >;
  /** Starts the recorded plan and publishes its Tools; never builds. A deployed Target whose recorded preparation is not
   * complete is refused with PREPARATION_INCOMPLETE, or BUILD_UNKNOWN when a unit's outcome is unknown.
   * Every stopped Service is started, whatever its restart policy: this is the explicit start. Without a journal each start
   * carries a fresh incarnation nobody records. */
  up(
    target: TargetRecord,
    checkpoint?: TargetEffectCheckpoint,
    journal?: ActivationJournal,
    /** How the stop of Services a failed start started waits. */
    stops?: StopControl,
  ): Promise<{ outcome: "started" | "unchanged" }>;
  /** Starts one stopped Service of a running Target again under the same rules as `up`: fresh environment, readiness, then the
   * route. Never builds, installs or starts another Service. SERVICE_DEPENDENCY when a Service it depends on is not running;
   * a process started by a failed attempt has been stopped. Once the start was journalled, the failure says how the process
   * ended: the step's own error when it was still running and this rollback stopped it; PROCESS_EXITED, with the `exitCode` or
   * `signal` recorded for this start if any, when it had ended on its own; START_UNVERIFIED when it could not be observed. */
  recover(
    target: TargetRecord,
    service: string,
    journal: ActivationJournal,
    stops?: StopControl,
  ): Promise<{ outcome: "started" | "unchanged" }>;
  /** Refuses the Target's route as publishing it would, changing nothing; a deploy asks before it stops the previous
   * Deployment, so a route that cannot be published never takes a running one offline. Required, so a wrapper cannot drop
   * it. */
  checkRoute(target: TargetRecord): Promise<void>;
  /** Lets go of the hostnames `checkRoute` reserved for the Target; required, so a wrapper cannot drop it. */
  releaseRoute(target: TargetRecord): Promise<void>;
  /** Withdraws the route of each of `targets` in turn, each confirmed in the proxy before the next; a Target without one is
   * skipped. When one cannot be withdrawn, those already withdrawn are published again and its failure is rethrown, so the
   * proxy serves what it served; WITHDRAW_ROLLBACK when publishing them again fails too. Changes no Target record. */
  withdrawRoutes(targets: readonly TargetRecord[]): Promise<RouteWithdrawal>;
  /** Withdraws every route whose Target `owners` does not name, reading `owners` after every route change queued before
   * it; resolves with the hostnames withdrawn. */
  pruneRoutes(
    owners: () => Promise<ReadonlySet<string>>,
    confinement?: { readonly within: string },
  ): Promise<string[]>;
  /** The keyed digest of the environment `service` of `target` would start with now (its env files read now), as a start
   * records it, the checkout path normalized. Fails as composing that environment fails (an unreadable env file, say), or
   * ENV_DIGEST when no digest can be taken. A deploy compares it with the running process's. */
  environmentDigest(target: TargetRecord, service?: string): Promise<string>;
  /** Stops one Service within its stop_timeout, telling the stop's observer, and leaves the others as they are; its routed
   * paths are withheld first, and a stop whose paths cannot be withheld is not made. SERVICE_UNKNOWN when the plan has no
   * such Service. A health restart stops a Service this way before `recover` starts it again. */
  stop(
    target: TargetRecord,
    service: string,
    stops?: StopControl,
  ): Promise<{ outcome: "stopped" | "unchanged" }>;
  /** Withholds every path of the Target's published route, whatever plan it was published for, confirmed in the proxy. A
   * recovery that stops two plans' processes withholds this way first. With `services`, only the paths the plan routes to
   * them, as supervision does for a Service that exited on its own; its next verified start publishes them again.
   * ROUTE_WITHHOLD when the proxy cannot be made to. */
  withhold(target: TargetRecord, services?: readonly string[]): Promise<void>;
  /** Stops every Service in reverse dependency order, each within its stop_timeout, then any build a daemon that died left
   * running (`observePreparation`). First every path the route publishes to
   * one of their ports is withheld, so no program that binds a freed port receives the Target's requests; a plan without
   * some Services (a deploy keeping them) leaves their paths as they are. Every Service is attempted, and STOP_INCOMPLETE
   * names the failures, except when the stop is detached: STOP_DETACHED ends it at once; ROUTE_WITHHOLD, once every
   * Service stopped, when the paths could not be withheld. A job run is not stopped here, so a deploy, which stops the
   * previous plan this way, never cuts one off: `stopJob` stops one. */
  down(
    target: TargetRecord,
    stops?: StopControl,
  ): Promise<{ outcome: "stopped" | "unchanged" }>;
  /** Stop, unroute, and uninstall a Target under one checkpoint.
   * Fails with RETIRE_COMMIT_PENDING (retirement done, finalization unfinished)
   * or RETIRE_ROLLBACK (rollback itself failed) when effects are left changed;
   * any other failure has rolled back or never started, leaving the Target intact. */
  retire(
    target: TargetRecord,
    publishRemoval?: () => Promise<void>,
    stops?: StopControl,
  ): Promise<void>;
  /** Starts one run of `job` of the recorded plan as `incarnation`: a freshly composed environment (its env files read
   * now), then its command under the Target's supervisor, with its output in the Target log under the job's name. Returns
   * once the process started; never waits for it to end. Fails PROCESS_START (and the like) with nothing left running.
   * `rigEnv` is set last, over the env files, as values only Rig decides (a backup job's $RIG_BACKUP_DIR). */
  startJob(
    target: TargetRecord,
    job: PlanJob,
    incarnation: string,
    rigEnv?: Readonly<Record<string, string>>,
  ): Promise<void>;
  /** The process group of the build or dependency installation recorded for `target` (see `preparationProcessKey`):
   * running only while one a daemon that died left behind still runs, since a live daemon's own ends before the Target is
   * free. */
  observePreparation(
    target: TargetRecord,
    signal?: AbortSignal,
  ): Promise<ProcessObservation>;
  /** What runs for `job` of `target` now: its process while one runs, or how the last one ended when that was recorded. */
  observeJob(
    target: TargetRecord,
    job: string,
    signal?: AbortSignal,
  ): Promise<ProcessObservation>;
  /** Stops the run of `job` in progress within its stop_timeout (the one it started with), telling the stop's observer;
   * `unchanged` when none runs, or with `incarnation` when what runs is not that run's process. */
  stopJob(
    target: TargetRecord,
    job: JobStop,
    stops?: StopControl,
  ): Promise<StopResult>;
}
/** Which job's run a stop is for: its name, the stop_timeout it started with, and the run (its process's incarnation) that
 * alone may be signalled. */
export type JobStop = Pick<PlanJob, "name" | "stopTimeout"> & {
  incarnation?: string;
};
export interface ReadinessTiming {
  /** Schedule once after delayMs; never inline. Return an idempotent cancellation.
   * Callbacks and cancellation must not throw. Elapsed callbacks run in deadline order.
   */
  schedule(delayMs: number, fire: () => void): () => void;
  /** How long a component without a health check must stay alive before up counts it as started; default 500 ms. */
  readonly startGraceMs?: number;
}

/** Production scheduling effect owner; lifecycle callers may substitute controlled time. */
const readinessTiming: ReadinessTiming = {
  schedule(delayMs, fire) {
    const timer = setTimeout(fire, delayMs);
    return () => clearTimeout(timer);
  },
};
const DEFAULT_START_GRACE_MS = 500;
/** Cadence for health retries and for confirming the supervised process is still alive. */
const OBSERVATION_INTERVAL_MS = 100;

/** Observes every managed Component before anything starts; an unknown owner aborts before any install runs. */
async function observeManaged(
  target: TargetRecord,
  supervisor: Supervisor,
  only?: string[],
): Promise<Map<string, ProcessObservation>> {
  const observations = new Map<string, ProcessObservation>();
  for (const component of target.plan.components) {
    if (component.kind !== "managed") continue;
    if (only && !only.includes(component.name)) continue;
    const observation = await supervisor.observe(
      `${target.id}:${component.name}`,
    );
    if (observation.state === "unknown")
      throw new RigError(
        "PROCESS_UNKNOWN",
        `Cannot safely start ${component.name}.`,
        "Run rig doctor to inspect process ownership.",
      );
    observations.set(`${target.id}:${component.name}`, observation);
  }
  return observations;
}

/** `lifecycle` with `stops` as the stop control of every call that names none, so code handed the result (a deploy, a
 * Preview destroy, an automatic restart) waits and reports its stops as the Operation running it decided. */
export function withStops(
  lifecycle: TargetLifecycle,
  stops: StopControl,
): TargetLifecycle {
  return {
    pruneCheckpoints: (live) => lifecycle.pruneCheckpoints(live),
    checkRoute: (target) => lifecycle.checkRoute(target),
    releaseRoute: (target) => lifecycle.releaseRoute(target),
    withdrawRoutes: (targets) => lifecycle.withdrawRoutes(targets),
    pruneRoutes: (owners, confinement) =>
      lifecycle.pruneRoutes(owners, confinement),
    checkpoint: (target, previous) => lifecycle.checkpoint(target, previous),
    restoreEffects: (target) => lifecycle.restoreEffects(target),
    commitEffects: (target) => lifecycle.commitEffects(target),
    retireSuperseded: (previous, candidate) =>
      lifecycle.retireSuperseded(previous, candidate),
    prepare: (target, request) => lifecycle.prepare(target, request),
    up: (target, checkpoint, journal, control) =>
      lifecycle.up(target, checkpoint, journal, control ?? stops),
    recover: (target, service, journal, control) =>
      lifecycle.recover(target, service, journal, control ?? stops),
    environmentDigest: (target, service) =>
      lifecycle.environmentDigest(target, service),
    stop: (target, service, control) =>
      lifecycle.stop(target, service, control ?? stops),
    down: (target, control) => lifecycle.down(target, control ?? stops),
    withhold: (target, services) => lifecycle.withhold(target, services),
    retire: (target, publishRemoval, control) =>
      lifecycle.retire(target, publishRemoval, control ?? stops),
    startJob: (target, job, incarnation, rigEnv) =>
      lifecycle.startJob(target, job, incarnation, rigEnv),
    observePreparation: (target, signal) =>
      lifecycle.observePreparation(target, signal),
    observeJob: (target, job, signal) =>
      lifecycle.observeJob(target, job, signal),
    stopJob: (target, job, control) =>
      lifecycle.stopJob(target, job, control ?? stops),
  };
}
/** The supervisor key a Target's build and dependency installation commands are recorded under, one at a time. A Service
 * name never holds ':', so it never collides with a Service's, nor with a job's. */
export function preparationProcessKey(
  target: Pick<TargetRecord, "id">,
): string {
  return `${target.id}:preparation:run`;
}
/** The supervisor key of a Target's job runs. A Service name never holds ':', so it never collides with a Service's. */
export function jobProcessKey(
  target: Pick<TargetRecord, "id">,
  job: string,
): string {
  return `${target.id}:job:${job}`;
}
/** Applies an already recorded plan. Changing config cannot change lifecycle identity or policy. */
/** Told about each Service's lifecycle transitions, synchronously and while the caller holds the Target: as a start or a
 * stop begins (`changing`), and when a start passed its start check, its healthcheck's first passing check (`activated`). */
export interface LifecycleObserver {
  changing(target: TargetRecord, service: string): void;
  activated(target: TargetRecord, service: string, incarnation: string): void;
}
export function createTargetLifecycle(
  effects: TargetEffects,
  timing: ReadinessTiming = readinessTiming,
  observer?: LifecycleObserver,
): TargetLifecycle {
  const lifecycle: TargetLifecycle = {
    pruneCheckpoints: (live) => effects.pruneCheckpoints(live),
    async checkRoute(target) {
      await effects.checkRoute?.(target);
    },
    async releaseRoute(target) {
      await effects.releaseRoute?.(target);
    },
    async withdrawRoutes(targets) {
      const withdrawn: RouteWithdrawal[] = [];
      /** Publishes again, in the order they were withdrawn, every route this call took out; each is its own block, so
       * the order only keeps the route file as it was. Every route is tried; ROUTE_RESTORE names the hostnames of those
       * that could not be published again. */
      const restore = async () => {
        const failed: string[] = [];
        let first: unknown;
        for (const withdrawal of withdrawn)
          try {
            await withdrawal.restore();
          } catch (error) {
            first ??= error;
            failed.push(...withdrawal.hostnames);
          }
        if (failed.length)
          throw new RigError(
            "ROUTE_RESTORE",
            `The routes for ${failed.join(", ")} could not be published again.`,
            "Their Targets are stopped; rig up or rig deploy of each publishes its route again. Run rig doctor before retrying.",
            { hostnames: failed },
            failureCauses(first),
          );
      };
      try {
        for (const target of targets) {
          const withdrawal = await effects.withdrawRoute(target);
          if (withdrawal) withdrawn.push(withdrawal);
        }
      } catch (error) {
        /** The hostnames a failure names as withdrawn and not published again (WITHDRAW_ROLLBACK, ROUTE_RESTORE). */
        const missing = (failure: unknown): string[] =>
          failure instanceof RigError &&
          Array.isArray(failure.details.hostnames)
            ? failure.details.hostnames.map(String)
            : [];
        try {
          await restore();
        } catch (recovery) {
          throw new RigError(
            "WITHDRAW_ROLLBACK",
            `A route could not be withdrawn (${failureReason(error)}), and the routes for ${[...missing(error), ...missing(recovery)].join(", ")} withdrawn meanwhile could not be published again.`,
            "Their Targets are stopped, so nothing was served through them; rig up or rig deploy of each publishes its route again. Run rig doctor before retrying.",
            { hostnames: [...missing(error), ...missing(recovery)] },
            failureCauses(error, recovery),
          );
        }
        throw error;
      }
      return {
        hostnames: withdrawn.flatMap((withdrawal) => withdrawal.hostnames),
        restore,
      };
    },
    pruneRoutes: (owners, confinement) =>
      effects.pruneRoutes(owners, confinement),
    async checkpoint(target, previous) {
      return await effects.checkpoint(target, previous);
    },
    async restoreEffects(target) {
      await effects.restoreEffects(target);
    },
    async commitEffects(target) {
      await effects.commitEffects(target);
    },
    async retireSuperseded(previous, candidate) {
      await effects.retireSuperseded(previous, candidate);
    },
    async retire(target, publishRemoval, stops) {
      const checkpoint = await effects.checkpoint(target);
      let finalizationPending = false;
      try {
        await lifecycle.down(target, stops);
        await effects.removeRoute(target);
        await effects.retireArtifacts(target);
        await publishRemoval?.();
        finalizationPending = true;
        await checkpoint.commit();
      } catch (error) {
        if (finalizationPending)
          throw new RigError(
            "RETIRE_COMMIT_PENDING",
            publishRemoval
              ? "The Target inventory was removed but checkpoint finalization failed."
              : "The Target inventory is retained, but retirement checkpoint finalization failed.",
            publishRemoval
              ? "Preserve its effect checkpoint; the retired Target must not be restarted."
              : "Preserve its effect checkpoint and retry the operation; the Target must not be restarted.",
            {},
            failureCauses(error),
          );
        // A detached stop is left as a crash leaves it: the Services keep stopping and the checkpoint stays for the retry.
        if (isStopDetached(error)) throw error;
        try {
          await checkpoint.rollback();
          if (target.desired === "running") await lifecycle.up(target);
        } catch (recovery) {
          throw new RigError(
            "RETIRE_ROLLBACK",
            "Target retirement failed and its saved effects could not be restored.",
            `Run ${rigCommand("down", { target })} and inspect its effect checkpoint.`,
            {},
            failureCauses(error, recovery),
          );
        }
        throw error;
      }
    },
    async prepare(target, { select, journal }) {
      // Each environment is composed once and handed to the command it is for, so what is digested is what ran, even when
      // an env file changes meanwhile. One that cannot be composed here is composed by the command itself, which fails as
      // it always did; nothing is digested for it.
      const install = await effects.environment(target).catch(() => undefined);
      await stopPreparation(target);
      await effects.prepare(target, install);
      const installed = await digestsOf(target, install);
      const units = await selectUnits(target, select, effects);
      for (const unit of units) {
        const env = await effects
          .buildEnvironment?.(unit, target)
          .catch(() => undefined);
        // Best effort: a build never fails for its digest, and a unit recorded without one keeps no Service running.
        await journal.started(unit, await digestsOf(target, env));
        try {
          await effects.build(unit, target, env);
        } catch (error) {
          try {
            await journal.finished(unit, "failed");
          } catch (recordError) {
            throw retainFailureCauses(error, error, recordError);
          }
          throw error;
        }
        try {
          await journal.finished(unit, "succeeded");
        } catch (error) {
          throw new RigError(
            "BUILD_UNKNOWN",
            `The ${unitLabel(unit)} finished, but its outcome could not be recorded.`,
            forceHint(target),
            { unit: unit.id },
            failureCauses(error),
          );
        }
      }
      return { built: units.map((unit) => unit.id), ...installed };
    },
    async up(target, providedCheckpoint, journal, stops) {
      assertPrepared(target);
      if (providedCheckpoint && providedCheckpoint.targetId !== target.id)
        throw new RigError(
          "EFFECTS_SCOPE",
          "The effect checkpoint belongs to another Target.",
          "Use the checkpoint for the selected Target.",
        );
      const supervisor = effects.supervisor(target);
      const checkpoint =
        providedCheckpoint ?? (await effects.checkpoint(target));
      const started: string[] = [];
      let installed = false;
      try {
        await effects.prepare(target);
        const observations = await observeManaged(target, supervisor);
        // A route that survives from an earlier start would hand requests to the new process the moment it binds its port.
        const unverified = routedServices(
          target,
          (name) =>
            observations.get(`${target.id}:${name}`)?.state === "stopped",
        );
        if (unverified.size)
          await effects.route(target, {
            withhold: routedPorts(target, unverified),
          });
        /** The Services this start verified, in order, each with the process it verified, and those it left running and only
         * inspects. */
        const activated: Activated[] = [];
        const kept: ManagedComponent[] = [];
        const processOf = (component: ManagedComponent) => ({
          observe: () => supervisor.observe(`${target.id}:${component.name}`),
        });
        const verifiedNow = async (component: ManagedComponent) =>
          activated.push({
            component,
            process: processOf(component),
            seen: await processOf(component).observe(),
          });
        // Dependencies are ordered during plan resolution, before any process starts.
        for (const component of target.plan.components) {
          if (component.kind === "persistent") continue;
          if (component.kind === "installed") {
            const result = await effects.install(component, target);
            installed = result.outcome === "installed" || installed;
            continue;
          }
          const key = `${target.id}:${component.name}`;
          if (observations.get(key)!.state === "running") {
            // A dependency that is already running must still be ready before a dependent starts against it.
            if (hasDependents(target, component.name)) {
              await awaitActivation(
                component,
                target,
                effects,
                timing,
                processOf(component),
              );
              await verifiedNow(component);
            } else kept.push(component);
            continue;
          }
          await startService(
            target,
            component,
            supervisor,
            journal,
            started,
            stops,
          );
          await verifiedNow(component);
        }
        // A Service verified before a later one started may have ended while that one took its time: each is verified
        // again, and one that no longer passes fails the start before anything of it is published.
        for (const { component, process } of activated.slice(0, -1))
          await confirmActivated(component, target, effects, timing, process);
        const verified = routedPorts(
          target,
          activated.map(({ component }) => component.name),
        );
        // A Service left running (a deploy keeps it) may have been given ports it was never verified on: each of them is
        // published only once its own process is found listening there.
        for (const component of kept)
          for (const port of await ownedRoutedPorts(
            component,
            target,
            effects,
            processOf(component),
          ))
            verified.add(port);
        // Those checks took time too: right before publication, every Service of the start is still the process it verified.
        await assertStillActive(activated, target);
        // A path an earlier failed start left withheld is released only by its own Service passing the gate.
        await effects.route(target, { verified });
        if (!providedCheckpoint) await checkpoint.commit();
        return {
          outcome: started.length || installed ? "started" : "unchanged",
        };
      } catch (error) {
        // A start whose clean-up rigd's shutdown detached is left as a crash leaves it: its Service keeps stopping, and
        // the Services and effects before it stay for the next daemon, checkpoint included.
        if (isStopDetached(error)) throw error;
        const rollbackErrors: unknown[] = [];
        // What this start started may already be published (a failure after the route was), so it is withheld first.
        await withholdServices(
          target,
          started.map((key) => componentOf(target, key).name),
        ).catch((failure: unknown) => rollbackErrors.push(failure));
        if (!rollbackErrors.length)
          for (const key of started.reverse())
            try {
              await stopService(target, componentOf(target, key), stops);
            } catch (failure) {
              // rigd is shutting down: the Services left are stopping, and the next daemon finishes the stop.
              if (isStopDetached(failure)) throw failure;
              rollbackErrors.push(failure);
            }
        if (!providedCheckpoint && !rollbackErrors.length)
          try {
            await checkpoint.rollback();
          } catch (failure) {
            rollbackErrors.push(failure);
          }
        if (rollbackErrors.length)
          throw new RigError(
            "START_ROLLBACK_FAILED",
            "Startup failed and process or executable rollback could not be verified.",
            `Run rig doctor and ${rigCommand("down", { target })} before retrying.`,
            { cause: error, rollbackErrors },
          );
        throw error;
      }
    },
    async recover(target, service, journal, stops) {
      assertPrepared(target);
      const component = target.plan.components.find(
        (candidate): candidate is ManagedComponent =>
          candidate.kind === "managed" && candidate.name === service,
      );
      if (!component)
        throw new RigError(
          "SERVICE_UNKNOWN",
          `${target.name} has no Service named '${service}'.`,
          "Select a Service of the recorded plan.",
          { service },
        );
      const supervisor = effects.supervisor(target);
      // Only what this start depends on decides it; a sibling that cannot be observed is not its concern.
      const observations = await observeManaged(target, supervisor, [
        service,
        ...component.dependsOn,
      ]);
      if (observations.get(`${target.id}:${service}`)!.state === "running")
        return { outcome: "unchanged" };
      const missing = component.dependsOn.find(
        (name) => observations.get(`${target.id}:${name}`)?.state !== "running",
      );
      if (missing)
        throw new RigError(
          "SERVICE_DEPENDENCY",
          `${service} depends on ${missing}, which is not running.`,
          `Run ${rigCommand("up", { target })} to start both.`,
          { service, dependency: missing },
        );
      const process = (name: string) => ({
        observe: () => supervisor.observe(`${target.id}:${name}`),
      });
      for (const name of component.dependsOn)
        await awaitActivation(
          target.plan.components.find(
            (candidate): candidate is ManagedComponent =>
              candidate.kind === "managed" && candidate.name === name,
          )!,
          target,
          effects,
          timing,
          process(name),
        );
      const started: string[] = [];
      let incarnation: string | undefined;
      const tracked: ActivationJournal = {
        async starting(name, evidence) {
          return (incarnation = await journal.starting(name, evidence));
        },
        activated: (name, started) => journal.activated(name, started),
      };
      try {
        await effects.prepare(target);
        // Withdrawn before the spawn: the route published for the process that ended must not reach its unverified replacement.
        const ports = routedPorts(target, [service]);
        if (ports.size) await effects.route(target, { withhold: ports });
        await startService(
          target,
          component,
          supervisor,
          tracked,
          started,
          stops,
        );
        // What it depends on may have ended while it started; and right before publication, all of them still run.
        const activated: Activated[] = [
          {
            component,
            process: process(service),
            seen: await process(service).observe(),
          },
        ];
        for (const name of component.dependsOn) {
          const dependency = managedComponent(target, name);
          await confirmActivated(
            dependency,
            target,
            effects,
            timing,
            process(name),
          );
          activated.push({
            component: dependency,
            process: process(name),
            seen: await process(name).observe(),
          });
        }
        await assertStillActive(activated, target);
        await effects.route(target, {
          verified: routedPorts(target, [service, ...component.dependsOn]),
        });
        return { outcome: started.length ? "started" : "unchanged" };
      } catch (error) {
        // The supervisor's clean-up of this start was detached by rigd's shutdown: the Service keeps stopping on its own.
        if (isStopDetached(error)) throw error;
        // Nothing was asked of the supervisor: the refusal itself says how the attempt ended.
        if (incarnation === undefined) throw error;
        // Seen before the cleanup below removes the evidence, because only a process found running here is one Rig ended.
        const key = `${target.id}:${service}`;
        const seen = await supervisor.observe(key).catch(() => undefined);
        try {
          await withholdServices(target, [service]);
          await stopService(target, component, stops);
        } catch (failure) {
          if (isStopDetached(failure)) throw failure;
          throw new RigError(
            "START_ROLLBACK_FAILED",
            "The Service could not be started again and its new process could not be verified stopped.",
            `Run rig doctor and ${rigCommand("down", { target })} before retrying.`,
            {},
            failureCauses(error, failure),
          );
        }
        if (seen?.state === "running") throw error;
        if (seen?.state !== "stopped")
          throw new RigError(
            "START_UNVERIFIED",
            `${service} was asked to start, but how that start ended could not be established.`,
            `Inspect Target logs, then run ${rigCommand("up", { target })} to start it again.`,
            { service },
            failureCauses(error),
          );
        const evidence = seen.incarnation === incarnation ? seen : undefined;
        throw new RigError(
          "PROCESS_EXITED",
          `${service} ended on its own before its start was complete.`,
          "Inspect Target logs for the start-up failure.",
          {
            component: service,
            ...(evidence?.exitCode === undefined
              ? {}
              : { exitCode: evidence.exitCode }),
            ...(evidence?.signal === undefined
              ? {}
              : { signal: evidence.signal }),
          },
          failureCauses(error),
        );
      }
    },
    async environmentDigest(target, service) {
      const component =
        service === undefined ? undefined : managedComponent(target, service);
      if (!effects.digestEnvironment)
        throw new RigError(
          "ENV_DIGEST",
          "This rigd cannot take a digest of a Service's environment.",
          `Run ${rigCommand("restart", { target })} to start every Service again.`,
          service === undefined ? {} : { service },
        );
      return await effects.digestEnvironment(
        target,
        await effects.environment(target, component),
      );
    },
    async stop(target, service, stops) {
      const component = target.plan.components.find(
        (candidate): candidate is ManagedComponent =>
          candidate.kind === "managed" && candidate.name === service,
      );
      if (!component)
        throw new RigError(
          "SERVICE_UNKNOWN",
          `${target.name} has no Service named '${service}'.`,
          "Select a Service of the recorded plan.",
          { service },
        );
      await withholdServices(target, [service]);
      const result = await stopService(target, component, stops);
      return {
        outcome: result.outcome === "stopped" ? "stopped" : "unchanged",
      };
    },
    async startJob(target, job, incarnation, rigEnv) {
      // Read before anything is spawned, so an unreadable env file leaves nothing running.
      const env = { ...(await effects.environment(target, job)), ...rigEnv };
      const result = await effects.supervisor(target).ensureRunning({
        key: jobProcessKey(target, job.name),
        componentName: job.name,
        command: ["/bin/sh", "-c", job.command],
        cwd: jobDirectory(target.plan, job),
        ...(job.workingDir !== undefined
          ? { cwdWithin: target.plan.workspacePath }
          : {}),
        env,
        logRoot: target.logRoot,
        incarnation,
        stopGraceMs: serviceGraceMs(job.stopTimeout),
      });
      // A process already running under the job's key is another run's, which this run must never be recorded as.
      if (result.outcome !== "started")
        throw new RigError(
          "JOB_RUNNING",
          `A process of ${job.name} is already running on ${target.name}, so no new run was started.`,
          `Wait for it to end, or stop it with ${rigCommand("down", { target })}.`,
          { job: job.name },
        );
    },
    observeJob: (target, job, signal) =>
      effects.supervisor(target).observe(jobProcessKey(target, job), signal),
    observePreparation: (target, signal) =>
      effects.supervisor(target).observe(preparationProcessKey(target), signal),
    stopJob: (target, job, stops) => stopJob(target, job, stops),
    withhold: (target, services) =>
      services ? withholdServices(target, services) : effects.withhold(target),
    async down(target, stops) {
      let changed = false;
      const processFailures: unknown[] = [];
      const services = target.plan.components.filter(
        (component): component is ManagedComponent =>
          component.kind === "managed",
      );
      // Withheld, and served so, before anything stops: once a process ends, any program may bind its port.
      await withholdServices(target, managedServices(target));
      for (const component of [...services].reverse()) {
        try {
          const result = await stopService(target, component, stops);
          changed = result.outcome === "stopped" || changed;
        } catch (error) {
          if (isStopDetached(error)) throw error;
          processFailures.push(error);
        }
      }
      try {
        const result = await stopPreparation(target, stops);
        changed = result.outcome === "stopped" || changed;
      } catch (error) {
        if (isStopDetached(error)) throw error;
        processFailures.push(error);
      }
      if (processFailures.length)
        throw new RigError(
          "STOP_INCOMPLETE",
          "One or more managed processes could not be stopped.",
          "All managed Components were attempted. Inspect Target logs and status before retrying.",
          { processFailures },
        );
      return { outcome: changed ? "stopped" : "unchanged" };
    },
  };
  /** Withholds the paths the plan routes to `services`, served so, before any of them is stopped. ROUTE_WITHHOLD, with
   * nothing stopped, when the proxy cannot be made to: it may still reach those ports, which any program could bind once
   * freed. */
  async function withholdServices(
    target: TargetRecord,
    services: Iterable<string>,
  ): Promise<void> {
    const ports = routedPorts(target, services);
    if (!ports.size) return;
    try {
      await effects.withhold(target, ports);
    } catch (error) {
      throw new RigError(
        "ROUTE_WITHHOLD",
        `The route of ${target.name} could not be withheld (${failureReason(error)}), so nothing was stopped: the proxy may still reach its Services' ports, which any program could bind once they are freed.`,
        `Run rig doctor to check the proxy, then retry once it answers (or once it is stopped).`,
        {},
        failureCauses(error),
      );
    }
  }
  /** The keyed digests of `env`, a composed environment of `target` a preparation runs a command in: as it is, and without
   * its `_RIG_` variables when it has any. Empty when it was not composed or no digest can be taken. */
  async function digestsOf(
    target: TargetRecord,
    env: Readonly<Record<string, string>> | undefined,
  ): Promise<PreparedEnvironment> {
    const digest = (env: Readonly<Record<string, string>>) =>
      effects.digestEnvironment?.(target, env).catch(() => undefined);
    if (env === undefined) return {};
    const environment = await digest(env);
    if (environment === undefined) return {};
    const written = withoutReferenceVariables(env);
    const writtenEnvironment =
      Object.keys(written).length < Object.keys(env).length
        ? await digest(written)
        : undefined;
    return {
      environment,
      ...(writtenEnvironment !== undefined ? { writtenEnvironment } : {}),
    };
  }
  /** Stops the build a daemon that died left running for `target`, within the default stop grace (a build has no
   * stop_timeout) or less under a kill; `unchanged` when none runs. */
  async function stopPreparation(
    target: TargetRecord,
    stops: StopControl = {},
  ): Promise<StopResult> {
    const supervisor = effects.supervisor(target),
      key = preparationProcessKey(target);
    if ((await supervisor.observe(key)).state === "stopped")
      return { outcome: "unchanged" };
    const kill = stops.kill?.(target);
    return await supervisor.stop(key, {
      graceMs: serviceGraceMs(undefined),
      ...(kill ? { kill } : {}),
      ...(stops.detach ? { detach: stops.detach } : {}),
    });
  }
  /** Stops `job`'s run in progress within its stop_timeout under `stops`, telling the observers as the stop begins and ends;
   * a job with nothing running is left alone, unannounced. */
  async function stopJob(
    target: TargetRecord,
    job: JobStop,
    stops: StopControl = {},
  ): Promise<StopResult> {
    const supervisor = effects.supervisor(target),
      key = jobProcessKey(target, job.name);
    if ((await supervisor.observe(key)).state === "stopped")
      return { outcome: "unchanged" };
    const graceMs = serviceGraceMs(job.stopTimeout);
    const kill = stops.kill?.(target);
    stops.observer?.stopping(target, job.name, graceMs);
    try {
      const result = await supervisor.stop(key, {
        graceMs,
        ...(job.incarnation !== undefined
          ? { incarnation: job.incarnation }
          : {}),
        ...(kill ? { kill } : {}),
        ...(stops.detach ? { detach: stops.detach } : {}),
      });
      stops.observer?.stopped(target, job.name, result);
      return result;
    } catch (error) {
      stops.observer?.stopped(target, job.name, { outcome: "failed" });
      throw error;
    }
  }
  /** Stops one Service within its stop_timeout under `stops`, telling its observer as the stop begins and ends. */
  async function stopService(
    target: TargetRecord,
    component: ManagedComponent,
    stops: StopControl = {},
  ): Promise<StopResult> {
    const graceMs = serviceGraceMs(component.stopTimeout);
    const kill = stops.kill?.(target);
    observer?.changing(target, component.name);
    stops.observer?.stopping(target, component.name, graceMs);
    try {
      const result = await effects
        .supervisor(target)
        .stop(`${target.id}:${component.name}`, {
          graceMs,
          ...(kill ? { kill } : {}),
          ...(stops.detach ? { detach: stops.detach } : {}),
        });
      stops.observer?.stopped(target, component.name, result);
      return result;
    } catch (error) {
      stops.observer?.stopped(target, component.name, { outcome: "failed" });
      throw error;
    }
  }
  /** One Service start: approval, spawn with a fresh environment, readiness, report. `started` gains the process key
   * as soon as a process was spawned, so the caller can stop it when a later step fails. A spawn that never confirmed it
   * started is stopped by the supervisor itself, under `stops` like the caller's own stops. */
  async function startService(
    target: TargetRecord,
    component: ManagedComponent,
    supervisor: Supervisor,
    journal: ActivationJournal | undefined,
    started: string[],
    stops: StopControl = {},
  ): Promise<void> {
    const key = `${target.id}:${component.name}`;
    // Read before the start is journalled, so an unreadable env file leaves no record of a start that never was.
    const env = await effects.environment(target, component);
    // Best effort: a start never fails for its digest, and a run recorded without one is never kept by a deploy.
    const environment = await effects
      .digestEnvironment?.(target, env)
      .catch(() => undefined);
    observer?.changing(target, component.name);
    const incarnation = journal
      ? await journal.starting(
          component.name,
          environment !== undefined ? { environment } : {},
        )
      : randomUUID();
    const kill = stops.kill?.(target);
    const result = await supervisor.ensureRunning(
      {
        key,
        componentName: component.name,
        command: ["/bin/sh", "-c", component.command],
        cwd: componentDirectory(target.plan, component),
        ...(component.workingDir !== undefined
          ? { cwdWithin: target.plan.workspacePath }
          : {}),
        env,
        logRoot: target.logRoot,
        incarnation,
        stopGraceMs: serviceGraceMs(component.stopTimeout),
      },
      {
        ...(kill ? { kill } : {}),
        observer: {
          stopping: (graceMs) =>
            stops.observer?.stopping(target, component.name, graceMs),
          stopped: (ended) =>
            stops.observer?.stopped(target, component.name, ended),
        },
      },
    );
    if (result.outcome === "started") started.push(key);
    const process = { observe: () => supervisor.observe(key) };
    if (!hasReadiness(component))
      await awaitSurvival(component, timing, process);
    await awaitActivation(component, target, effects, timing, process);
    observer?.activated(target, component.name, incarnation);
    await journal?.activated(component.name, incarnation);
  }
  return lifecycle;
}
/** The units one preparation runs, in plan order. */
async function selectUnits(
  target: TargetRecord,
  select: PreparationRequest["select"],
  effects: Pick<TargetEffects, "supervisor">,
): Promise<BuildUnit[]> {
  const units = target.plan.builds ?? [];
  if (select === "all") return units;
  const observations = await observeManaged(target, effects.supervisor(target));
  // The work an explicit Working copy up does: start each Service that is not running, and publish every Tool.
  const work = new Set(
    target.plan.components
      .filter(
        (component) =>
          component.kind === "installed" ||
          (component.kind === "managed" &&
            observations.get(`${target.id}:${component.name}`)?.state !==
              "running"),
      )
      .map((component) => component.name),
  );
  if (!work.size) return [];
  return units.filter(
    (unit) => unit.component === undefined || work.has(unit.component),
  );
}
function unitLabel(unit: Pick<BuildUnit, "component">): string {
  return unit.component === undefined
    ? "shared build"
    : `${unit.component} build`;
}
/** Only a forced deployment gives an incomplete or uncertain preparation a fresh scope. */
function forceHint(
  target: Pick<TargetRecord, "kind" | "name" | "branch" | "plan">,
): string {
  if (target.kind === "working")
    return `Run ${rigCommand("restart", { target })} to build it again.`;
  return `Run ${rigCommand("deploy", { target }, "--force")} to build a fresh Deployment; rig never reruns a build whose outcome it does not know.`;
}
/** The outcomes recorded for the Target's current workspace; another workspace's outcomes prove nothing here. */
function recordedUnits(
  target: Pick<TargetRecord, "preparation" | "plan">,
): NonNullable<TargetRecord["preparation"]>["units"] {
  return target.preparation?.deployment === target.plan.workspacePath
    ? target.preparation.units
    : {};
}
/** The unit of the recorded plan that was started and never recorded as finished, if any. */
export function unknownUnit(target: TargetRecord): BuildUnit | undefined {
  const recorded = recordedUnits(target);
  return (target.plan.builds ?? []).find(
    (unit) => recorded[unit.id]?.state === "started",
  );
}
/** Rejects BUILD_UNKNOWN when a unit of the recorded plan was started and never recorded as finished. */
export function assertBuildsKnown(target: TargetRecord): void {
  const unit = unknownUnit(target);
  if (unit)
    throw new RigError(
      "BUILD_UNKNOWN",
      `Whether the ${unitLabel(unit)} of ${target.name} finished is unknown.`,
      forceHint(target),
      { unit: unit.id },
    );
}
/** Rejects BUILD_UNKNOWN when deploying `source` without force would repeat an attempt, recorded or rolled back, that left a build's outcome unknown. */
export function assertSourceBuildsKnown(
  target: TargetRecord,
  source: { branch?: string; commit?: string },
): void {
  if (target.commit === source.commit && target.branch === source.branch)
    assertBuildsKnown(target);
  const attempt = target.uncertainBuild;
  if (
    attempt &&
    attempt.commit === source.commit &&
    attempt.branch === source.branch
  )
    throw new RigError(
      "BUILD_UNKNOWN",
      `Whether build unit ${attempt.unit} finished in the last deployment attempt of this Commit to ${target.name} is unknown.`,
      forceHint(target),
      { unit: attempt.unit },
    );
}
/** What a record restored over `attempt` keeps of it: the attempted source, when one of its builds has an unknown outcome. */
export function uncertainAttempt(
  attempt: TargetRecord,
): TargetRecord["uncertainBuild"] {
  const unit = unknownUnit(attempt);
  return unit
    ? {
        ...(attempt.branch ? { branch: attempt.branch } : {}),
        ...(attempt.commit ? { commit: attempt.commit } : {}),
        unit: unit.id,
      }
    : undefined;
}
/** A deployed Target starts only from a preparation whose every unit is recorded as succeeded for this workspace. */
function assertPrepared(target: TargetRecord): void {
  if (target.kind === "working") return;
  assertBuildsKnown(target);
  const recorded = recordedUnits(target);
  for (const unit of target.plan.builds ?? []) {
    const state = recorded[unit.id]?.state;
    if (state === "succeeded") continue;
    throw new RigError(
      "PREPARATION_INCOMPLETE",
      state === "failed"
        ? `The ${unitLabel(unit)} of ${target.name} failed, so this Deployment was never prepared.`
        : `The ${unitLabel(unit)} of ${target.name} never ran, so this Deployment was never prepared.`,
      forceHint(target),
      { unit: unit.id },
    );
  }
}
/** The supervised process behind one component; readiness only counts while it is alive. */
export interface SupervisedProcess {
  observe(): Promise<ProcessObservation>;
}
/** Whether the Service has something to be ready on: its own check, or declared ports to connect to. */
function hasReadiness(component: ManagedComponent): boolean {
  return (
    component.health !== undefined ||
    Object.keys(declaredPorts(component)).length > 0
  );
}
/** The names of the Services of the Target's plan. */
function managedServices(target: TargetRecord): string[] {
  return target.plan.components.flatMap((component) =>
    component.kind === "managed" ? [component.name] : [],
  );
}
/** The ports the plan routes to the Services named `services`: what a route reaches them at. */
function routedPorts(
  target: TargetRecord,
  services: Iterable<string>,
): Set<number> {
  const names = new Set(services);
  return new Set(
    plannedRoutes(target.plan)
      .filter((route) => names.has(route.service))
      .map((route) => route.port),
  );
}
/** The routed Services that `select` picks: the ones whose paths a caller withholds. */
function routedServices(
  target: TargetRecord,
  select: (service: string) => boolean,
): Set<string> {
  return new Set(
    plannedRoutes(target.plan)
      .map((route) => route.service)
      .filter(select),
  );
}
/** One Service is verified within its `readyTimeout`: ready, then listening only locally. Ready is its own check, else a
 * connection to every declared port, else nothing beyond being alive. Readiness passes only while rig's own process is running:
 * a foreign listener on the port never certifies a dead component, and a process that exits fails fast with its exit code.
 * HEALTH_FAILED says how the budget ended: `unanswered` when no check ever answered, `unready` with the last answer otherwise.
 * A rejecting provider fails with its own error at once; LISTENER_NONLOCAL and LISTENER_UNKNOWN are not waited out either. */
async function awaitActivation(
  component: ManagedComponent,
  target: TargetRecord,
  effects: Pick<TargetEffects, "health" | "listeners">,
  timing: ReadinessTiming,
  process: SupervisedProcess,
): Promise<void> {
  const controller = new AbortController();
  let cancelDeadline = () => {};
  let cancelRetry = () => {};
  // Expiry settles independently of provider cooperation.
  const expired = new Promise<false>((resolve) => {
    cancelDeadline = timing.schedule(component.readyTimeout * 1000, () => {
      resolve(false);
      controller.abort();
    });
  });
  let lastCheck: string | undefined;
  try {
    while (!controller.signal.aborted) {
      // An observation that never answers is bounded like any other check.
      if (
        (await Promise.race([assertAlive(component, process), expired])) ===
        false
      )
        break;
      const check = await Promise.race([
        hasReadiness(component)
          ? effects.health(component, target, controller.signal)
          : ALIVE,
        expired,
      ]);
      if (controller.signal.aborted || check === false) break;
      const verified = check.ready
        ? await Promise.race([
            ownedListeners(
              component,
              target,
              effects,
              process,
              controller.signal,
            ),
            expired,
          ])
        : check;
      if (controller.signal.aborted || verified === false) break;
      if (verified.ready) return;
      lastCheck = verified.reason;
      await Promise.race([
        new Promise<void>((resolve) => {
          cancelRetry = timing.schedule(OBSERVATION_INTERVAL_MS, resolve);
        }),
        expired,
      ]);
    }
  } finally {
    cancelDeadline();
    cancelRetry();
  }
  throw new RigError(
    "HEALTH_FAILED",
    lastCheck === undefined
      ? `${component.name} did not become ready.`
      : `${component.name} did not become ready (last check: ${lastCheck}).`,
    "Inspect the Target logs and the Service's healthcheck.",
    {
      component: component.name,
      outcome: lastCheck === undefined ? "unanswered" : "unready",
      ...(lastCheck === undefined ? {} : { lastCheck }),
    },
  );
}
/** A Service a start verified, with the process it verified. */
interface Activated {
  component: ManagedComponent;
  process: SupervisedProcess;
  seen: ProcessObservation;
}
/** A Service a start verified, verified again once a later part of the start is done, as `awaitActivation`: one that ended
 * meanwhile fails PROCESS_EXITED, saying it did so after it was ready. */
async function confirmActivated(
  component: ManagedComponent,
  target: TargetRecord,
  effects: Pick<TargetEffects, "health" | "listeners">,
  timing: ReadinessTiming,
  process: SupervisedProcess,
): Promise<void> {
  try {
    await awaitActivation(component, target, effects, timing, process);
  } catch (error) {
    if (!(error instanceof RigError) || error.code !== "PROCESS_EXITED")
      throw error;
    throw exitedAfterReady(component, target, error.details ?? {});
  }
}
/** Each of `activated` observed once more: still running as the process it verified (same pid and incarnation), else the
 * start fails PROCESS_EXITED before anything is published. */
async function assertStillActive(
  activated: readonly Activated[],
  target: TargetRecord,
): Promise<void> {
  for (const { component, process, seen } of activated) {
    const now = await process.observe();
    if (
      now.state === "running" &&
      now.pid === seen.pid &&
      now.incarnation === seen.incarnation
    )
      continue;
    throw exitedAfterReady(component, target, {
      component: component.name,
      ...(now.exitCode === undefined ? {} : { exitCode: now.exitCode }),
      ...(now.signal === undefined ? {} : { signal: now.signal }),
    });
  }
}
function exitedAfterReady(
  component: ManagedComponent,
  target: TargetRecord,
  details: Record<string, unknown>,
): RigError {
  const exitCode = details.exitCode;
  return new RigError(
    "PROCESS_EXITED",
    `${component.name} was ready, then exited${typeof exitCode === "number" ? ` with code ${exitCode}` : ""} before ${targetSelector(target)} finished starting.`,
    "Inspect the Target logs for why it ended; nothing of this start was published.",
    details,
  );
}
const ALIVE: HealthCheck = { ready: true };
/** The listener half of activation, and of an ongoing check of a Service's ports, asked of the process that is running now.
 * Not ready while a port the check rests on (every routed port, and every declared port when connections were the evidence)
 * has no listener among the owned processes: whatever answered there was someone else. Nor while a routed port is owned
 * only at an address other than the route's upstream (::1 rather than 127.0.0.1), where the proxy would reach whoever
 * binds it. Throws LISTENER_NONLOCAL for a listener bound beyond loopback and LISTENER_UNKNOWN when the owner or its
 * sockets cannot be established; PROCESS_EXITED when the process ended meanwhile. */
export async function ownedListeners(
  component: ManagedComponent,
  target: TargetRecord,
  effects: Pick<TargetEffects, "listeners">,
  process: SupervisedProcess,
  signal: AbortSignal,
): Promise<HealthCheck> {
  const owner = await process.observe();
  const evidence =
    owner.state === "running" && owner.pid !== undefined
      ? await effects.listeners(owner.pid, signal)
      : undefined;
  await assertAlive(component, process);
  const still = await process.observe();
  if (
    evidence?.state !== "observed" ||
    still.state !== "running" ||
    still.pid !== owner.pid
  )
    throw new RigError(
      "LISTENER_UNKNOWN",
      `What ${component.name} listens on could not be established${evidence?.state === "unknown" ? `: ${evidence.reason}` : "."}`,
      "Rig publishes nothing it cannot inspect. Run rig doctor to check process ownership, then start the Service again.",
      { component: component.name },
    );
  const exposed = evidence.listeners.find(
    (listener) => !loopbackAddress(listener.address),
  );
  if (exposed)
    throw new RigError(
      "LISTENER_NONLOCAL",
      `${component.name} listens on ${exposed.address}:${exposed.port}, which is reachable from outside this machine.`,
      "Bind the Service to 127.0.0.1 or ::1; Rig's proxy is the only public way in.",
      {
        component: component.name,
        address: exposed.address,
        port: exposed.port,
      },
    );
  const routed = routedPorts(target, [component.name]);
  const evidencePorts = new Set([
    ...(component.health ? [] : Object.values(declaredPorts(component))),
    ...routed,
  ]);
  const on = (port: number) =>
    evidence.listeners.filter((listener) => listener.port === port);
  const missing = [...evidencePorts].find((port) => !on(port).length);
  if (missing !== undefined)
    return {
      ready: false,
      reason: `port ${missing} has no listener owned by ${component.name}`,
    };
  // A routed port is reached at the route's upstream address; a listener on another one (::1) leaves that address to
  // whichever program binds it.
  const unreachable = [...routed].find(
    (port) => !on(port).some((listener) => takesUpstream(listener.address)),
  );
  return unreachable === undefined
    ? ALIVE
    : {
        ready: false,
        reason: `${component.name} listens on port ${unreachable} only at ${on(unreachable)[0]!.address}, but Rig's proxy connects to ${routeUpstream(unreachable)}; bind it to ${UPSTREAM_HOST}`,
      };
}
/** The routed ports of a running Service that its own process tree listens on at the route's upstream address now, with
 * nothing of it listening beyond loopback; none when that cannot be established. Never throws: a port it cannot verify
 * stays withheld, and the process is left running as it was. */
async function ownedRoutedPorts(
  component: ManagedComponent,
  target: TargetRecord,
  effects: Pick<TargetEffects, "listeners">,
  process: SupervisedProcess,
): Promise<number[]> {
  const routed = routedPorts(target, [component.name]);
  if (!routed.size) return [];
  const owner = await process.observe().catch(() => undefined);
  if (owner?.state !== "running" || owner.pid === undefined) return [];
  const evidence = await effects.listeners(
    owner.pid,
    new AbortController().signal,
  );
  const still = await process.observe().catch(() => undefined);
  if (
    evidence.state !== "observed" ||
    still?.state !== "running" ||
    still.pid !== owner.pid ||
    evidence.listeners.some((listener) => !loopbackAddress(listener.address))
  )
    return [];
  return [...routed].filter((port) =>
    evidence.listeners.some(
      (listener) => listener.port === port && takesUpstream(listener.address),
    ),
  );
}
/** IPv4 127.0.0.0/8 and IPv6 ::1, also as an IPv4-mapped address; a wildcard or any other address is reachable from elsewhere. */
export function loopbackAddress(address: string): boolean {
  const mapped = /^::ffff:(.+)$/i.exec(address)?.[1] ?? address;
  return (
    /^127(?:\.\d{1,3}){3}$/.test(mapped) ||
    /^(?:0{0,4}:){2,7}0{0,3}1$/.test(address)
  );
}
/** The Service `service` of `target`'s plan; SERVICE_UNKNOWN when the plan has none. */
function managedComponent(
  target: TargetRecord,
  service: string,
): ManagedComponent {
  const component = target.plan.components.find(
    (candidate): candidate is ManagedComponent =>
      candidate.kind === "managed" && candidate.name === service,
  );
  if (!component)
    throw new RigError(
      "SERVICE_UNKNOWN",
      `${target.name} has no Service named '${service}'.`,
      "Select a Service of the recorded plan.",
      { service },
    );
  return component;
}
/** The Service a process key of `target` names. */
function componentOf(target: TargetRecord, key: string): ManagedComponent {
  return target.plan.components.find(
    (candidate): candidate is ManagedComponent =>
      candidate.kind === "managed" && key === `${target.id}:${candidate.name}`,
  )!;
}
function hasDependents(target: TargetRecord, name: string): boolean {
  return target.plan.components.some(
    (component) =>
      component.kind === "managed" && component.dependsOn.includes(name),
  );
}
/** Without a health check, a component counts as started only once it has outlived the start grace period. */
async function awaitSurvival(
  component: ManagedComponent,
  timing: ReadinessTiming,
  process: SupervisedProcess,
): Promise<void> {
  const grace = timing.startGraceMs ?? DEFAULT_START_GRACE_MS;
  const cancels: (() => void)[] = [];
  const checks: Promise<void>[] = [];
  // Every observation is scheduled up front so a crash-and-restart loop cannot hide between polls.
  for (const at of observationTimes(grace))
    checks.push(
      new Promise<void>((resolve) => {
        cancels.push(timing.schedule(at, resolve));
      }).then(() => assertAlive(component, process)),
    );
  try {
    await Promise.all(checks);
  } finally {
    for (const cancel of cancels) cancel();
  }
}
/** Poll instants within the grace period at the observation cadence, always ending at the grace itself. */
function observationTimes(graceMs: number): number[] {
  const times: number[] = [];
  for (
    let at = OBSERVATION_INTERVAL_MS;
    at < graceMs;
    at += OBSERVATION_INTERVAL_MS
  )
    times.push(at);
  if (graceMs > 0) times.push(graceMs);
  return times;
}
async function assertAlive(
  component: ManagedComponent,
  process: SupervisedProcess,
): Promise<void> {
  const observation = await process.observe();
  if (observation.state !== "stopped") return;
  const exitCode = observation.exitCode;
  // The shell's own exit codes: 127 names a command it could not find, 126 one it could not run.
  const shellFailure =
    exitCode === 127
      ? "the shell found no executable for its command"
      : exitCode === 126
        ? "the shell could not run its command (not executable)"
        : undefined;
  throw new RigError(
    "PROCESS_EXITED",
    exitCode === undefined
      ? `${component.name} exited before it became ready.`
      : `${component.name} exited with code ${exitCode} before it became ready${shellFailure ? `: ${shellFailure}` : ""}.`,
    shellFailure
      ? "Install the missing tool where rigd can find it (rigd uses the PATH it was installed from), or fix the command, then retry."
      : "Inspect Target logs for the start-up failure before retrying.",
    {
      component: component.name,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(observation.signal === undefined
        ? {}
        : { signal: observation.signal }),
    },
  );
}
