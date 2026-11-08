import type {
  BuildUnit,
  InstalledComponent,
  ManagedComponent,
  PlanJob,
  TargetPlan,
} from "../config/types";
import type { PreparedEnvironment, TargetRecord } from "../domain/runtime";
import type {
  HealthCheck,
  ProcessObservation,
  StopResult,
  Supervisor,
} from "../providers/contracts";
import type { ListenerEvidence } from "../providers/listener-inspection";
import type { RouteGuard } from "./route-guard";
import { createBuildPreparation } from "./build-preparation";
import { effectsUnder } from "./guarded-effects";
import { createJobProcesses } from "./job-processes";
import { createServiceActivation } from "./service-activation";
import {
  defaultReadinessTiming,
  type ReadinessTiming,
} from "./service-readiness";
import { createTargetRetirement } from "./target-retirement";
import { createTargetStops } from "./target-stops";

// Owned by the phases, and still found here by the code that reached them through the lifecycle before they moved.
export { preparationProcessKey } from "./build-preparation";
export { assertSourceBuildsKnown } from "./preparation-evidence";
export { loopbackAddress, type ReadinessTiming } from "./service-readiness";

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
  /** Fails ENV_VALUE when a Service of `target` could not start for a value Rig refuses (see `TargetLifecycle.checkEnvironmentValues`). */
  checkEnvironmentValues?(target: TargetRecord): Promise<void>;
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
  /** The directory `unit`'s command runs in, checked now: it fails WORKING_DIR_MISSING as the build would. Absent: not
   * checked ahead of the build. */
  buildDirectory?(unit: BuildUnit, target: TargetRecord): Promise<string>;
  /** Publishes a Tool's executable; never builds. */
  install(
    component: InstalledComponent,
    target: TargetRecord,
  ): Promise<{ outcome: "installed" | "unchanged" }>;
  /** What the owned process `pid` and its descendants listen on now. May block or ignore cancellation. */
  listeners(pid: number, signal: AbortSignal): Promise<ListenerEvidence>;
  /** The ports a path of the Target's published route reaches now, whatever plan it was published for; read from the route
   * file, asking nothing of the proxy. Empty without a route. */
  livePorts(target: TargetRecord): Promise<Set<number>>;
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
  /** Told before a route change gives a path to a Service this start started (ADR 0020): from here it may serve. When it
   * rejects, nothing is published and the start fails. */
  publishing?(): Promise<void>;
  /** Told once the proxy confirmed that publication. Never rejects. */
  published?(): Promise<void>;
  /** Told once a confirmed route change removed the last path reaching a Service this start started, whichever change of
   * the Operation's it was; told only under a route guard. Never rejects. */
  withdrawn?(): Promise<void>;
}
/** What the lifecycle knows about a start before it spawns the process, for the journal to record with it. */
export interface StartEvidence {
  /** The keyed digest of the environment the process is started with; absent when it could not be computed. */
  environment?: string;
}
/** How the stops one Operation makes wait, and who hears about them. Every stop honours each Service's stop_timeout. */
export interface StopControl {
  /** The Operation's route guard: every route change it makes, and every write to the effect journal those changes share,
   * runs inside the guard's exclusive section. */
  readonly guard?: RouteGuard;
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
    stops?: StopControl,
  ): Promise<TargetEffectCheckpoint>;
  /** Rolls back the Target's interrupted effect transaction once its Services are down; the route comes back withheld
   * wherever the route as it is now reaches no upstream. */
  restoreEffects(target: TargetRecord, stops?: StopControl): Promise<void>;
  commitEffects(target: TargetRecord, stops?: StopControl): Promise<void>;
  retireSuperseded(
    previous: TargetRecord,
    candidate: TargetRecord,
    stops?: StopControl,
  ): Promise<void>;
  /** Installs the workspace's dependencies, then runs the selected build units in plan order, journaling each before and after.
   * A build a daemon that died left running is stopped first, so two never run in the workspace at once; each command's
   * process group is recorded before it runs, so the next daemon can stop it in turn.
   * Starts no Service and publishes nothing. The first failing unit stops preparation with BUILD_FAILED or BUILD_TIMEOUT.
   * BUILD_UNKNOWN means a command succeeded but its outcome could not be recorded; the journal still says `started`.
   * Answers with the units it ran and the keyed digests of the Project-scope environment dependency installation was given,
   * absent when it could not be composed or digested. */
  prepare(
    target: TargetRecord,
    request: PreparationRequest,
  ): Promise<{ built: string[] } & PreparedEnvironment>;
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
  /** Fails as composing the environment of the plan's first build unit fails (an unreadable env file, say), which nothing
   * runs before to write; runs nothing. */
  checkFirstBuild(target: TargetRecord): Promise<void>;
  /** Fails ENV_VALUE when a value in the plan or in an env file that exists now would refuse a Service's start, whichever file
   * holds it; no other failure, so a build may still write a file that is missing. Runs nothing. */
  checkEnvironmentValues(target: TargetRecord): Promise<void>;
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
  withhold(
    target: TargetRecord,
    services?: readonly string[],
    stops?: StopControl,
  ): Promise<void>;
  /** The ports a path of the Target's published route reaches now, whatever plan it was published for. */
  livePorts(target: TargetRecord): Promise<ReadonlySet<number>>;
  /** Withholds only the paths of the published route that reach `ports`, whichever plan's they are, confirmed in the proxy.
   * ROUTE_WITHHOLD when the proxy cannot be made to. */
  withholdPorts(
    target: TargetRecord,
    ports: ReadonlySet<number>,
    stops?: StopControl,
  ): Promise<void>;
  /** Stops every Service in reverse dependency order, each within its stop_timeout, then any build a daemon that died left
   * running (`observePreparation`). First every path the route publishes to
   * one of their ports is withheld, so no program that binds a freed port receives the Target's requests; a plan without
   * some Services (a deploy keeping them) leaves their paths as they are. Every Service is attempted, and STOP_INCOMPLETE
   * names the failures, except when the stop is detached: STOP_DETACHED ends it at once; ROUTE_WITHHOLD, with no Service
   * that has a path stopped, when the paths could not be withheld. A job run is not stopped here, so a deploy, which stops
   * the previous plan this way, never cuts one off: `stopJob` stops one.
   * `startFollows` is given only when a start comes next that replaces what stops (a deploy's stop of the previous
   * Deployment, `rig restart`), and is the whole plan, before any Service was removed from `target`'s: the Services at the
   * end of the list that no path needs (`tailOf`) then stop first with every path still live, and the paths are withheld
   * just before the first Service outside them stops. */
  down(
    target: TargetRecord,
    stops?: StopControl,
    startFollows?: TargetPlan,
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
  /** Stops the build a daemon that died left running for `target` (`observePreparation`), within the default stop grace or
   * less under a kill; `unchanged` when none runs. rigd's first pass does this for every Target. */
  stopPreparation(
    target: TargetRecord,
    stops?: StopControl,
  ): Promise<StopResult>;
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
    checkpoint: (target, previous, control) =>
      lifecycle.checkpoint(target, previous, control ?? stops),
    restoreEffects: (target, control) =>
      lifecycle.restoreEffects(target, control ?? stops),
    commitEffects: (target, control) =>
      lifecycle.commitEffects(target, control ?? stops),
    retireSuperseded: (previous, candidate, control) =>
      lifecycle.retireSuperseded(previous, candidate, control ?? stops),
    prepare: (target, request) => lifecycle.prepare(target, request),
    up: (target, checkpoint, journal, control) =>
      lifecycle.up(target, checkpoint, journal, control ?? stops),
    recover: (target, service, journal, control) =>
      lifecycle.recover(target, service, journal, control ?? stops),
    environmentDigest: (target, service) =>
      lifecycle.environmentDigest(target, service),
    checkFirstBuild: (target) => lifecycle.checkFirstBuild(target),
    checkEnvironmentValues: (target) =>
      lifecycle.checkEnvironmentValues(target),
    stop: (target, service, control) =>
      lifecycle.stop(target, service, control ?? stops),
    down: (target, control, startFollows) =>
      lifecycle.down(target, control ?? stops, startFollows),
    withhold: (target, services, control) =>
      lifecycle.withhold(target, services, control ?? stops),
    livePorts: (target) => lifecycle.livePorts(target),
    withholdPorts: (target, ports, control) =>
      lifecycle.withholdPorts(target, ports, control ?? stops),
    retire: (target, publishRemoval, control) =>
      lifecycle.retire(target, publishRemoval, control ?? stops),
    startJob: (target, job, incarnation, rigEnv) =>
      lifecycle.startJob(target, job, incarnation, rigEnv),
    observePreparation: (target, signal) =>
      lifecycle.observePreparation(target, signal),
    stopPreparation: (target, control) =>
      lifecycle.stopPreparation(target, control ?? stops),
    observeJob: (target, job, signal) =>
      lifecycle.observeJob(target, job, signal),
    stopJob: (target, job, control) =>
      lifecycle.stopJob(target, job, control ?? stops),
  };
}
/** Told about each Service's lifecycle transitions, synchronously and while the caller holds the Target: as a start or a
 * stop begins (`changing`), and when a start passed its start check, its healthcheck's first passing check (`activated`). */
export interface LifecycleObserver {
  changing(target: TargetRecord, service: string): void;
  activated(target: TargetRecord, service: string, incarnation: string): void;
}
/** Applies an already recorded plan. Changing config cannot change lifecycle identity or policy. Each phase has its own
 * owner: preparation and its build evidence, the activation of Services and the readiness it rests on, stops, retirement
 * and route withdrawal, and job runs; the methods here hand each call to its owner. */
export function createTargetLifecycle(
  effects: TargetEffects,
  timing: ReadinessTiming = defaultReadinessTiming,
  observer?: LifecycleObserver,
): TargetLifecycle {
  /** The effects an Operation under `stops` acts through. */
  const guarded = effectsUnder(effects);
  const preparation = createBuildPreparation(effects);
  const stopping = createTargetStops(
    effects,
    guarded,
    observer,
    preparation.stopPreparation,
  );
  const activation = createServiceActivation(
    effects,
    guarded,
    timing,
    observer,
    stopping,
  );
  const retirement = createTargetRetirement(
    effects,
    guarded,
    stopping,
    activation,
  );
  const jobs = createJobProcesses(effects);
  return {
    pruneCheckpoints: (live) => effects.pruneCheckpoints(live),
    async checkRoute(target) {
      await effects.checkRoute?.(target);
    },
    async releaseRoute(target) {
      await effects.releaseRoute?.(target);
    },
    withdrawRoutes: (targets) => retirement.withdrawRoutes(targets),
    pruneRoutes: (owners, confinement) =>
      effects.pruneRoutes(owners, confinement),
    async checkpoint(target, previous, stops) {
      return await guarded(stops).checkpoint(target, previous);
    },
    async restoreEffects(target, stops) {
      await guarded(stops).restoreEffects(target);
    },
    async commitEffects(target, stops) {
      await guarded(stops).commitEffects(target);
    },
    async retireSuperseded(previous, candidate, stops) {
      await guarded(stops).retireSuperseded(previous, candidate);
    },
    retire: (target, publishRemoval, stops) =>
      retirement.retire(target, publishRemoval, stops),
    prepare: (target, request) => preparation.prepare(target, request),
    up: (target, checkpoint, journal, stops) =>
      activation.up(target, checkpoint, journal, stops),
    recover: (target, service, journal, stops) =>
      activation.recover(target, service, journal, stops),
    environmentDigest: (target, service) =>
      preparation.environmentDigest(target, service),
    checkFirstBuild: (target) => preparation.checkFirstBuild(target),
    checkEnvironmentValues: (target) =>
      preparation.checkEnvironmentValues(target),
    stop: (target, service, stops) => stopping.stop(target, service, stops),
    startJob: (target, job, incarnation, rigEnv) =>
      jobs.startJob(target, job, incarnation, rigEnv),
    observeJob: (target, job, signal) => jobs.observeJob(target, job, signal),
    observePreparation: (target, signal) =>
      preparation.observePreparation(target, signal),
    stopPreparation: (target, stops) =>
      preparation.stopPreparation(target, stops),
    stopJob: (target, job, stops) => jobs.stopJob(target, job, stops),
    withhold: (target, services, stops) =>
      stopping.withhold(target, services, stops),
    livePorts: (target) => effects.livePorts(target),
    withholdPorts: (target, ports, stops) =>
      stopping.withholdPorts(target, ports, stops),
    down: (target, stops, startFollows) =>
      stopping.down(target, stops, startFollows),
  };
}
