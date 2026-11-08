import type { ManagedComponent } from "../config/types";
import { diagnosticErrorCode, failureReason } from "../domain/errors";
import type { TargetRecord } from "../domain/runtime";
import type { ProcessObservation } from "../providers/contracts";
import { boundedObservations } from "./bounded-observations";
import type { RuntimeDependencies } from "./contracts";
import { plannedRoutes } from "./ports";

/** How long the guard waits between one look and the next. */
export const ROUTE_LOOK_INTERVAL_MS = 1000;

type ObservingDeps = Pick<
  RuntimeDependencies,
  "observations" | "observationBudgetMs" | "observationDeadline"
>;

/** What was seen of the Services `forms` route to the ports `live`: the ports to withhold, whose every such Service was seen
 * stopped, so a path never goes for a Service that may still serve it; those Services, with what was seen of each; and the
 * Services whose state could not be established (unknown, no answer within the budget, or a failed observation), which
 * decide nothing. Later forms win: a Service in two forms is one process, observed once, as the last. Aborting `cancel`
 * drops every answer not yet in. */
export async function observeLivePorts(
  forms: readonly TargetRecord[],
  live: ReadonlySet<number>,
  deps: ObservingDeps,
  cancel?: AbortSignal,
): Promise<{
  ports: Set<number>;
  services: string[];
  exits: Map<string, ProcessObservation>;
  uncertain: string[];
}> {
  const owners = new Map<number, Set<string>>();
  const jobs = new Map<
    string,
    (signal: AbortSignal) => Promise<ProcessObservation>
  >();
  for (const form of forms)
    for (const { port, service } of plannedRoutes(form.plan)) {
      const component = form.plan.components.find(
        (candidate): candidate is ManagedComponent =>
          candidate.kind === "managed" && candidate.name === service,
      );
      if (!component || !live.has(port)) continue;
      owners.set(port, (owners.get(port) ?? new Set()).add(service));
      jobs.set(service, (signal) =>
        deps.observations.process(form, component, signal),
      );
    }
  const services = [...jobs.keys()];
  const observed = await boundedObservations(
    [...jobs.values()],
    deps.observationBudgetMs,
    deps.observationDeadline,
    cancel,
  );
  const seenAs = (state: ProcessObservation["state"]) =>
    new Set(
      services.filter((_service, index) => {
        const seen = observed[index]!;
        return seen.kind === "completed" && seen.value.state === state;
      }),
    );
  const [running, stopped] = [seenAs("running"), seenAs("stopped")];
  const withheld = [...owners].filter(([, behind]) =>
    [...behind].every((name) => stopped.has(name)),
  );
  const gone = [...new Set(withheld.flatMap(([, behind]) => [...behind]))];
  const seen = (service: string) =>
    observed[services.indexOf(service)] as { value: ProcessObservation };
  return {
    ports: new Set(withheld.map(([port]) => port)),
    services: gone,
    exits: new Map(gone.map((service) => [service, seen(service).value])),
    uncertain: services.filter(
      (service) => !running.has(service) && !stopped.has(service),
    ),
  };
}

/** What watches a Target's live paths while an Operation holds it (ADR 0020), when supervision skips the Target and health
 * checks pause. One guard belongs to one Operation, from its first stop until it releases the Target. */
export interface RouteGuard {
  /** Starts looking, once a second, at the Services behind the paths of `target`'s route, published under its plan. A Service
   * seen stopped has its paths withheld; one that is unknown or does not answer decides nothing, and neither does a proxy
   * that refuses: the next look tries again. A later call changes nothing. */
  watch(target: TargetRecord): void;
  /** Runs one change of the Operation's that a look must not race: it ends the look in flight, dropping any answer not yet
   * in and waiting for a route change the look has begun, runs `change`, and only then lets looks go on, each of them reading
   * the live paths afresh. Enter it before the router queue, for the whole of the effects call. May be nested. */
  exclusive<T>(change: () => Promise<T>): Promise<T>;
  /** The route of the Target it watches is now published under the plan of `target`. Call it from inside `exclusive`. */
  publishedUnder(target: TargetRecord): void;
  /** Follows a start of `target` until release. Once it says what it published to the Services it started, the first
   * withholding that leaves none of those paths live, a look's or one of the Operation's own (`withheld`), calls
   * `withdrawn`, whose failure changes nothing. Until its commit is decided (`decide`), and while no later start began, a
   * look that sees a Service it started stopped fails it with `exited` for that Service, withheld or not. */
  start(target: TargetRecord, follow: StartFollowing): GuardedStart;
  /** A route change of the Operation's withheld the paths of `target`'s route that reach `ports` (every path, without
   * them), confirmed in the proxy. Call it from inside `exclusive`. Never rejects. */
  withheld(target: TargetRecord, ports?: ReadonlySet<number>): Promise<void>;
  /** Runs `write`, which decides the commit of the last start, inside the exclusive section: first it rejects with any
   * failure a look latched for that start, and once `write` resolves, a Service seen stopped fails nothing (ADR 0020). */
  decide<T>(write: () => Promise<T>): Promise<T>;
  /** Ends looking and waits for the look in flight, so nothing is left running once the Target is released. Never rejects. */
  release(): Promise<void>;
}
/** What the guard tells a start it follows. */
export interface StartFollowing {
  withdrawn(): Promise<void>;
  /** The failure of the start for `service`, which a look saw stopped as `seen`. */
  exited(service: string, seen: ProcessObservation): Error;
}
/** A start the guard follows (`RouteGuard.start`). */
export interface GuardedStart {
  /** The proxy confirmed paths to `ports`, which reach Services this start started. */
  published(ports: ReadonlySet<number>): void;
  /** `service` was spawned by this start, and its process is the start's to stop. */
  started(service: string): void;
  /** Rejects with the failure a look latched; pending until then, and handled, so nothing need wait for it. */
  readonly failure: Promise<never>;
  /** Throws the failure a look latched, if any. */
  check(): void;
}

/** A guard that does nothing until `watch`. `deps.lifecycle` must not be under this guard (`StopControl.guard`): a look's own
 * withholding is part of the look, and entering `exclusive` it would wait for itself. */
export function createRouteGuard(
  deps: ObservingDeps & Pick<RuntimeDependencies, "lifecycle" | "diagnostic">,
  operation: { readonly operationId: string; readonly action: string },
): RouteGuard {
  let watched: TargetRecord | undefined;
  let released = false;
  /** How many exclusive changes run or wait for the look in flight. */
  let sections = 0;
  let cancelWait: (() => void) | undefined;
  let round:
    | { readonly controller: AbortController; readonly settled: Promise<void> }
    | undefined;
  /** What the last refused withholding said, so the next look's identical refusal says nothing new. */
  let refused: string | undefined;
  /** The starts followed, each with the ports of its own Services still live and the Services it started. */
  const starts: {
    readonly targetId: string;
    readonly serving: Set<number>;
    readonly started: Set<string>;
    readonly follow: StartFollowing;
    readonly fail: (error: Error) => void;
    failed?: Error;
    decided?: true;
  }[] = [];
  /** The last start, the only one a stopped Service can still fail. */
  const current = () => starts.at(-1);
  const withheld = async (
    target: TargetRecord,
    ports?: ReadonlySet<number>,
  ) => {
    for (const start of starts) {
      if (start.targetId !== target.id || !start.serving.size) continue;
      for (const port of ports ?? [...start.serving])
        start.serving.delete(port);
      if (!start.serving.size) await start.follow.withdrawn().catch(() => {});
    }
  };
  /** Fails the last start for the first of `services` it started, seen stopped as `exits` says, until its commit is
   * decided; the first failure stands. */
  const latch = (
    target: TargetRecord,
    services: readonly string[],
    exits: ReadonlyMap<string, ProcessObservation>,
  ) => {
    const start = current();
    if (!start || start.targetId !== target.id || start.decided || start.failed)
      return;
    const service = services.find((name) => start.started.has(name));
    if (service === undefined) return;
    start.failed = start.follow.exited(service, exits.get(service)!);
    start.fail(start.failed);
  };

  const tell = async (
    target: TargetRecord,
    event: { outcome: string; errorCode?: string; evidence?: string },
  ) => {
    try {
      await deps.diagnostic({ ...operation, target: target.name, ...event });
    } catch {
      /* The diagnostic log never changes what the guard does. */
    }
  };
  /** One look; never rejects. Once its withholding has begun, it finishes through the journal's capture. */
  const look = async (target: TargetRecord, signal: AbortSignal) => {
    try {
      // Read through the router's queue, behind any other Target's reload, so it is bounded like an observation.
      const [read] = await boundedObservations(
        [() => deps.lifecycle.livePorts(target)],
        deps.observationBudgetMs,
        deps.observationDeadline,
        signal,
      );
      if (read?.kind === "rejected") throw read.error;
      if (read?.kind !== "completed" || !read.value.size) return;
      const seen = await observeLivePorts([target], read.value, deps, signal);
      // A section that ended the look dropped only the answers not yet in: a Service already seen stopped still goes, and
      // the section waits for it before its change.
      if (!seen.ports.size) return;
      try {
        await deps.lifecycle.withholdPorts(target, seen.ports);
        await withheld(target, seen.ports);
      } finally {
        // Published and gone, whether its paths could be withheld or not.
        latch(target, seen.services, seen.exits);
      }
      refused = undefined;
      await tell(target, {
        outcome: "routes-withheld",
        evidence: `${seen.services.join(", ")} stopped while the Operation held the Target, so its paths were withheld.`,
      });
    } catch (error) {
      const reason = failureReason(error);
      if (reason === refused) return;
      refused = reason;
      await tell(target, {
        outcome: "routes-withhold-failed",
        errorCode: diagnosticErrorCode(error),
        evidence: reason,
      });
    }
  };
  const lookLater = () => {
    if (!watched || released || sections || round || cancelWait) return;
    cancelWait = deps.observationDeadline.schedule(
      ROUTE_LOOK_INTERVAL_MS,
      () => {
        cancelWait = undefined;
        const controller = new AbortController();
        round = {
          controller,
          settled: look(watched!, controller.signal).finally(() => {
            round = undefined;
            lookLater();
          }),
        };
      },
    );
  };
  /** Ends the wait for the next look, or the look in flight. */
  const quiet = async () => {
    cancelWait?.();
    cancelWait = undefined;
    round?.controller.abort();
    await round?.settled;
  };
  const exclusive = async <T>(change: () => Promise<T>): Promise<T> => {
    sections++;
    try {
      await quiet();
      return await change();
    } finally {
      sections--;
      lookLater();
    }
  };
  return {
    watch(target) {
      watched ??= target;
      lookLater();
    },
    exclusive,
    publishedUnder(target) {
      if (watched?.id === target.id) watched = target;
    },
    start(target, follow) {
      let fail!: (error: Error) => void;
      const failure = new Promise<never>((_resolve, reject) => (fail = reject));
      failure.catch(() => {});
      const start: (typeof starts)[number] = {
        targetId: target.id,
        serving: new Set(),
        started: new Set(),
        follow,
        fail,
      };
      starts.push(start);
      return {
        published(ports) {
          for (const port of ports) start.serving.add(port);
        },
        started(service) {
          start.started.add(service);
        },
        failure,
        check() {
          if (start.failed) throw start.failed;
        },
      };
    },
    withheld,
    decide: (write) =>
      exclusive(async () => {
        const start = current();
        if (start?.failed) throw start.failed;
        const decided = await write();
        if (start) start.decided = true;
        return decided;
      }),
    async release() {
      released = true;
      await quiet();
    },
  };
}
