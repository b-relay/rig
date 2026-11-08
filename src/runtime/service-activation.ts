import type { ManagedComponent } from "../config/types";
import type { TargetRecord } from "../domain/runtime";
import { rigCommand } from "../domain/rig-command";
import type { Supervisor } from "../providers/contracts";
import { isStopDetached, serviceGraceMs } from "../domain/stop-budget";
import { RigError, failureCauses } from "../domain/errors";
import type { GuardedStart } from "./route-guard";
import { tailOf } from "./tail";
import { componentDirectory } from "../config/working-dir";
import { randomUUID } from "node:crypto";
import type {
  ActivationJournal,
  LifecycleObserver,
  StopControl,
  TargetEffects,
  TargetLifecycle,
} from "./lifecycle";
import {
  componentOf,
  hasDependents,
  managedComponent,
  managedServices,
  observeManaged,
  routedPorts,
  routedServices,
} from "./plan-services";
import { assertPrepared } from "./preparation-evidence";
import {
  type Activated,
  type ReadinessTiming,
  assertStillActive,
  awaitActivation,
  awaitSurvival,
  confirmActivated,
  exitDetails,
  exitedAfterReady,
  hasReadiness,
  ownedRoutedPorts,
} from "./service-readiness";
import type { TargetStops } from "./target-stops";

/** Starting a Target's Services: its whole plan (`up`), or one stopped Service of a running Target (`recover`). Each start
 * is approved by the journal, spawned, verified ready, and only then published; a start that fails stops what it started,
 * paths withheld first, and rolls its effects back. */
export type ServiceActivation = Pick<TargetLifecycle, "up" | "recover">;

export function createServiceActivation(
  effects: TargetEffects,
  guarded: (stops: StopControl | undefined) => TargetEffects,
  timing: ReadinessTiming,
  observer: LifecycleObserver | undefined,
  /** How a failed start stops what it started. */
  stopping: Pick<TargetStops, "stopService" | "withholdServices">,
): ServiceActivation {
  const activation: ServiceActivation = {
    async up(target, providedCheckpoint, journal, stops) {
      assertPrepared(target);
      if (providedCheckpoint && providedCheckpoint.targetId !== target.id)
        throw new RigError(
          "EFFECTS_SCOPE",
          "The effect checkpoint belongs to another Target.",
          "Use the checkpoint for the selected Target.",
        );
      const effects = guarded(stops);
      const guard = stops?.guard;
      const supervisor = effects.supervisor(target);
      const checkpoint =
        providedCheckpoint ?? (await effects.checkpoint(target));
      const started: string[] = [];
      let installed = false;
      /** Once this start's paths are published, a failure of it has served. */
      let published = false;
      // The guard follows this start (ADR 0020): whichever change of the Operation's takes its last path away ends what it
      // served, and until its commit is decided, a Service it started that a look sees stopped fails it.
      const watching =
        guard?.start(target, {
          withdrawn: async () => await journal?.withdrawn?.(),
          exited: (service, seen) =>
            exitedAfterReady(
              managedComponent(target, service),
              target,
              exitDetails(service, seen),
              true,
            ),
        }) ?? UNGUARDED;
      try {
        await effects.prepare(target);
        const observations = await observeManaged(target, supervisor);
        const stopped = (name: string) =>
          observations.get(`${target.id}:${name}`)?.state === "stopped";
        // A route that survives from an earlier start would hand requests to the new process the moment it binds its port.
        const unverified = routedServices(target, stopped);
        if (unverified.size)
          await effects.route(target, {
            withhold: routedPorts(target, unverified),
          });
        // A lone `up`, a Mac restart and a first deploy watch from here; a deploy or a restart since its first stop.
        guard?.watch(target);
        // The Services at the end of the plan that no path needs start once every path is published.
        const tail = new Set(
          tailOf(target.plan, managedServices(target).filter(stopped)),
        );
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
            seen: await raced(processOf(component).observe(), watching),
          });
        const startOne = async (component: ManagedComponent) => {
          if (!stopped(component.name)) {
            // A dependency that is already running must still be ready before a dependent starts against it.
            if (hasDependents(target, component.name)) {
              await awaitActivation(
                component,
                target,
                effects,
                timing,
                processOf(component),
                watching.failure,
              );
              await verifiedNow(component);
            } else kept.push(component);
            return;
          }
          await startService(
            target,
            component,
            supervisor,
            journal,
            started,
            stops,
            watching,
          );
          await verifiedNow(component);
        };
        // A Service verified before a later one started may have ended while that one took its time: each is verified
        // again, but the last, just verified.
        const confirmAgain = async () => {
          for (const { component, process } of activated.slice(0, -1))
            await confirmActivated(
              component,
              target,
              effects,
              timing,
              process,
              watching.failure,
              published,
            );
        };
        // Those checks took time too: right after them, every Service of the start is still the process it verified.
        const stillActive = async () => {
          await assertStillActive(
            activated,
            target,
            published,
            watching.failure,
          );
          watching.check();
        };
        // Dependencies are ordered during plan resolution, before any process starts.
        for (const component of target.plan.components)
          if (component.kind === "managed" && !tail.has(component.name))
            await startOne(component);
        // Tools come before publication, so that a failure of theirs never follows it.
        for (const component of target.plan.components)
          if (component.kind === "installed") {
            const result = await effects.install(component, target);
            installed = result.outcome === "installed" || installed;
          }
        await confirmAgain();
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
        await stillActive();
        // A path an earlier failed start left withheld is released only by its own Service passing the gate. What this start
        // started serves from here: recorded first, so a rigd that dies meanwhile still says it may have.
        const serving = routedPorts(
          target,
          started.map((key) => componentOf(target, key).name),
        );
        if (serving.size) await journal?.publishing?.();
        await effects.route(target, { verified });
        published = true;
        if (serving.size) {
          watching.published(serving);
          await journal?.published?.();
        }
        // The tail starts with every path live; then everything is verified again, and only then may a commit follow.
        for (const name of tail) await startOne(managedComponent(target, name));
        if (tail.size) {
          await confirmAgain();
          await stillActive();
        }
        if (!providedCheckpoint) {
          const commit = () => checkpoint.commit();
          await (guard ? guard.decide(commit) : commit());
        }
        return {
          outcome: started.length || installed ? "started" : "unchanged",
        };
      } catch (error) {
        // A start whose clean-up rigd's shutdown detached is left as a crash leaves it: its Service keeps stopping, and
        // the Services and effects before it stay for the next daemon, checkpoint included.
        if (isStopDetached(error)) throw error;
        const rollbackErrors: unknown[] = [];
        // What this start started may already be published (a failure after the route was), so it is withheld first.
        await stopping
          .withholdServices(
            target,
            started.map((key) => componentOf(target, key).name),
            stops,
          )
          .catch((failure: unknown) => rollbackErrors.push(failure));
        if (!rollbackErrors.length)
          for (const key of started.reverse())
            try {
              await stopping.stopService(
                target,
                componentOf(target, key),
                stops,
              );
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
      const component = managedComponent(target, service);
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
            undefined,
            false,
          );
          activated.push({
            component: dependency,
            process: process(name),
            seen: await process(name).observe(),
          });
        }
        await assertStillActive(activated, target, false);
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
          await stopping.withholdServices(target, [service]);
          await stopping.stopService(target, component, stops);
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
  };
  /** One Service start: approval, spawn with a fresh environment, readiness, report. `started` gains the process key
   * as soon as a process was spawned, so the caller can stop it when a later step fails. A spawn that never confirmed it
   * started is stopped by the supervisor itself, under `stops` like the caller's own stops. A failure `watching` latches
   * ends the start check at once; a spawn already underway settles first, into `started`. */
  async function startService(
    target: TargetRecord,
    component: ManagedComponent,
    supervisor: Supervisor,
    journal: ActivationJournal | undefined,
    started: string[],
    stops: StopControl = {},
    watching: GuardedStart = UNGUARDED,
  ): Promise<void> {
    const key = `${target.id}:${component.name}`;
    // Read before the start is journalled, so an unreadable env file leaves no record of a start that never was.
    // Nothing is spawned yet, so a failure the guard latched ends these reads at once.
    const env = await raced(effects.environment(target, component), watching);
    // Best effort: a start never fails for its digest, and a run recorded without one is never kept by a deploy.
    const environment = await raced(
      effects.digestEnvironment?.(target, env).catch(() => undefined) ??
        Promise.resolve(undefined),
      watching,
    );
    observer?.changing(target, component.name);
    const incarnation = journal
      ? await journal.starting(
          component.name,
          environment !== undefined ? { environment } : {},
        )
      : randomUUID();
    watching.check();
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
    if (result.outcome === "started") {
      started.push(key);
      watching.started(component.name);
    }
    watching.check();
    const process = { observe: () => supervisor.observe(key) };
    if (!hasReadiness(component))
      await awaitSurvival(component, timing, process, watching.failure);
    await awaitActivation(
      component,
      target,
      effects,
      timing,
      process,
      watching.failure,
    );
    observer?.activated(target, component.name, incarnation);
    await journal?.activated(component.name, incarnation);
  }
  return activation;
}
/** `work`, ended at once by a failure `watching` latched: for read-only waits a start may abandon. */
function raced<T>(work: Promise<T>, watching: GuardedStart): Promise<T> {
  return Promise.race([work, watching.failure]);
}
/** The start of a lifecycle no route guard follows: nothing latches, and nothing is followed. */
const UNGUARDED: GuardedStart = {
  published() {},
  started() {},
  failure: new Promise<never>(() => {}),
  check() {},
};
