import { mkdir, rm } from "node:fs/promises";
import { parseProjectConfig } from "../../src/config";
import type { ProjectConfig } from "../../src/config/types";
import type { RouteRequest, Router } from "../../src/providers/caddy-router";
import {
  parseOwnedSites,
  renderOwnedBlock,
} from "../../src/providers/route-file";
import type {
  ProcessObservation,
  Supervisor,
} from "../../src/providers/contracts";
import { stopDetached } from "../../src/domain/stop-budget";
import type { RuntimeState, TargetRecord } from "../../src/domain/runtime";
import type { HostSession } from "../../src/domain/host-session";
import type { RuntimeDependencies } from "../../src/runtime/contracts";
import { ROUTE_LOOK_INTERVAL_MS } from "../../src/runtime/route-guard";
import type { createTargetEffects } from "../../src/adapters/target-effects";
import { createTargetLifecycle } from "../../src/runtime/lifecycle";
import { runtimeWorld } from "./runtime-world";

/** The stop side and the guard of ADR 0020, through the real runtime, lifecycle and effects over a scripted supervisor, a
 * recording router and a deadline only the test fires: a look runs when the test says, and no budget ever ends by itself. */

const roots: string[] = [];
/** Removes the Rig roots of every fixture made since the last call; each test file runs it after each test. */
export async function removeTailFixtures(): Promise<void> {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
}

export const WEB = 47501,
  API = 47502,
  MOVED = 47503;

/** Melody's shape: `search` comes last and no path needs it, so it is the tail. */
export function melody(): ProjectConfig {
  return parseProjectConfig({
    name: "shop",
    domain: "shop.test",
    proxy: {
      "/": "${services.web.ports.http}",
      "/api": "${services.api.ports.http}",
    },
    services: {
      db: { command: "db" },
      api: { command: "api", ports: { http: API }, depends_on: ["db"] },
      web: { command: "web", ports: { http: WEB } },
      search: { command: "search" },
    },
    targets: { stable: { domain: "shop.test" }, preview: true },
  });
}

/** A plan with no tail: its last Service has a path. */
export function noTail(): ProjectConfig {
  return parseProjectConfig({
    name: "shop",
    domain: "shop.test",
    proxy: {
      "/": "${services.web.ports.http}",
      "/api": "${services.api.ports.http}",
    },
    services: {
      db: { command: "db" },
      api: { command: "api", ports: { http: API }, depends_on: ["db"] },
      web: { command: "web", ports: { http: WEB } },
    },
    targets: { stable: { domain: "shop.test" } },
  });
}

/** A promise the test settles, and whether the code under test reached it. */
export function gate() {
  let open!: () => void;
  let reach!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const reached = new Promise<void>((resolve) => (reach = resolve));
  return { open, reach, opened, reached };
}

/** Lets everything already resolved run: the steps between two provider calls, none of which does I/O. */
export const settled = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

export async function fixture(config: ProjectConfig = melody()) {
  const processes = new Map<string, ProcessObservation>();
  const starts: string[] = [];
  const stops: string[] = [];
  /** Starts, Tool installations and route changes, in the order they were made. */
  const timeline: string[] = [];
  const exitsOnStart = new Set<string>();
  const name = (key: string) => key.split(":").at(-1)!;
  /** Stops held until released, or failed then, by Service. */
  const heldStops = new Map<
    string,
    ReturnType<typeof gate> & { detach?: boolean }
  >();
  const heldStarts = new Map<string, ReturnType<typeof gate>>();
  /** The supervisor's next observation of a Service after `skip` more, held until released. */
  const heldObserves = new Map<
    string,
    ReturnType<typeof gate> & { skip: number }
  >();
  const published = new Map<string, RouteRequest>();
  /** Each path's port or `503`, as the route stood when each Service began to stop. */
  const pathsAtStop = new Map<string, Record<string, number | "503">>();
  const pathsOf = (route: RouteRequest | undefined) =>
    Object.fromEntries(
      (route?.sites ?? []).flatMap((site) =>
        site.routes.map((path) => [
          path.prefix,
          path.upstream === null
            ? ("503" as const)
            : Number(path.upstream.split(":").at(-1)),
        ]),
      ),
    );
  const targetOf = (key: string) => key.split(":").slice(0, -1).join(":");
  let pid = 9000;
  const pids = new Map<number, string>();
  const supervisor: Supervisor = {
    async observe(key) {
      const held = heldObserves.get(name(key));
      if (held && held.skip-- <= 0) {
        heldObserves.delete(name(key));
        held.reach();
        await held.opened;
      }
      return processes.get(key) ?? { state: "stopped" };
    },
    async ensureRunning(request) {
      if (processes.get(request.key)?.state === "running")
        return { outcome: "unchanged" };
      const held = heldStarts.get(request.componentName);
      held?.reach();
      await held?.opened;
      starts.push(request.componentName);
      timeline.push(`start ${request.componentName}`);
      pids.set(++pid, request.componentName);
      // A Service set to exit on its next start is spawned, then gone before anything looks at it.
      processes.set(
        request.key,
        exitsOnStart.delete(request.componentName)
          ? { state: "stopped", incarnation: request.incarnation, exitCode: 1 }
          : { state: "running", pid, incarnation: request.incarnation },
      );
      return { outcome: "started" };
    },
    async stop(key) {
      const running = processes.get(key)?.state === "running";
      if (running)
        pathsAtStop.set(name(key), pathsOf(published.get(targetOf(key))));
      const held = heldStops.get(name(key));
      held?.reach();
      await held?.opened;
      if (held?.detach) throw stopDetached();
      if (running) stops.push(name(key));
      processes.delete(key);
      return { outcome: running ? "stopped" : "unchanged" };
    },
    async shutdown() {},
    async detach() {},
  };
  /** Every change asked of the router, as each path's port or `503`, in order. */
  const applied: Record<string, number | "503">[] = [];
  /** `refusals` refuses that many changes from now, then answers again. */
  const proxy: {
    refuses?: boolean;
    refusals?: number;
    hold?: ReturnType<typeof gate>;
  } = {};
  const router: Router = {
    async apply(route) {
      applied.push(pathsOf(route));
      timeline.push(
        `route ${Object.entries(pathsOf(route))
          .sort()
          .map(([path, port]) => `${path}=${port}`)
          .join(" ")}`,
      );
      const hold = proxy.hold;
      hold?.reach();
      await hold?.opened;
      if (proxy.refusals) {
        proxy.refusals--;
        throw new Error("caddy is down");
      }
      if (proxy.refuses) throw new Error("caddy is down");
      published.set(route.key, route);
    },
    async remove(key) {
      published.delete(key);
    },
    async withheld() {
      return [];
    },
    async checkpoint(key) {
      const route = published.get(key);
      return { key, value: route ? renderOwnedBlock(route, []) : null };
    },
    async restore(saved) {
      if (saved.value)
        published.set(saved.key, {
          key: saved.key,
          sites: parseOwnedSites(saved.value),
        });
      else published.delete(saved.key);
    },
    async withdrawUnowned() {
      return [];
    },
  };
  /** What each Service listens on, as ports, at loopback. */
  const listening: Record<string, number[]> = {
    web: [WEB],
    api: [API],
    db: [],
    search: [],
  };

  /** The next look, waiting to be fired by the test; a section or a look in flight leaves none. */
  const waiting = new Set<() => void>();
  let nextScheduled: (() => void) | undefined;
  /** How many looks the Operation scheduled, and how many waited at once at most: one guard, one look at a time. */
  const looks = { scheduled: 0, mostWaiting: 0 };
  const observationDeadline: RuntimeDependencies["observationDeadline"] = {
    schedule(ms, expire) {
      if (ms !== ROUTE_LOOK_INTERVAL_MS) return () => {};
      waiting.add(expire);
      looks.scheduled++;
      looks.mostWaiting = Math.max(looks.mostWaiting, waiting.size);
      nextScheduled?.();
      return () => waiting.delete(expire);
    },
  };
  /** Fires the waiting look, resolving once the next one is scheduled: that is, once this one has ended. */
  const look = async () => {
    const [fire] = waiting;
    if (!fire) throw new Error("no look is waiting");
    waiting.delete(fire);
    const ended = new Promise<void>((resolve) => (nextScheduled = resolve));
    fire();
    await ended;
    nextScheduled = undefined;
  };

  /** Observations answered as the test says, by Service, ignoring any cancellation. */
  const answer = new Map<
    string,
    | { kind: "unknown" | "rejected" }
    /** Seen stopped by the guard, whatever the supervisor says, with the signal it was asked under. */
    | { kind: "stopped"; signal?: AbortSignal }
    | {
        kind: "held";
        reached: () => void;
        late: Promise<ProcessObservation>;
        signal?: AbortSignal;
      }
  >();
  const observed: string[] = [];
  const said: { outcome: string; evidence?: string; errorCode?: string }[] = [];
  /** Route and journal effects in progress, and any that began while another was still in progress. */
  let inEffect = 0;
  const overlaps: string[] = [];
  const exclusiveEffect = async <T>(label: string, run: () => Promise<T>) => {
    if (inEffect) overlaps.push(label);
    inEffect++;
    try {
      return await run();
    } finally {
      inEffect--;
    }
  };
  /** The next write whose result `matches`, told apart by what it writes: failed, or held before it enters the store's
   * queue until the gate opens, so other writes go on meanwhile, then made unless it `fails`. */
  const failing: {
    matches?: (state: RuntimeState) => boolean;
    hold?: ReturnType<typeof gate>;
    fails?: boolean;
  } = {};
  const failWrite = (
    matches: (state: RuntimeState) => boolean,
    options: { hold?: ReturnType<typeof gate>; fails?: boolean } = {},
  ) => {
    failing.matches = matches;
    failing.fails = options.fails ?? !options.hold;
    if (options.hold) failing.hold = options.hold;
    else delete failing.hold;
  };
  /** Start checks held until released, by Service; a held one ignores its cancellation, as an uncooperative provider. */
  const heldHealth = new Map<
    string,
    ReturnType<typeof gate> & { signal?: AbortSignal }
  >();
  const tools: { fails?: Error } = {};
  /** The Host's boot and login session, which a test changes to stand for a Mac restart. */
  const host: { session: HostSession } = {
    session: {
      boot: "BOOT-1",
      bootedAt: "2026-11-05T07:00:00.000Z",
      login: "100002",
    },
  };
  const git = { head: "c1" };
  // Polls fire at once and no start check's deadline ever does, so a loaded machine fails nothing here.
  const timing = {
    schedule(delayMs: number, fire: () => void) {
      if (delayMs >= 1000) return () => {};
      const timer = setTimeout(fire, 0);
      return () => clearTimeout(timer);
    },
    startGraceMs: 0,
  };
  /** Once armed, the next `up` to resolve waits there, its start over, before it returns to the Operation. */
  const afterUp: { hold?: ReturnType<typeof gate> } = {};
  let wrapped!: ReturnType<typeof createTargetEffects>;
  const world = await runtimeWorld({
    name: "tail-stop",
    config,
    supervisor: () => supervisor,
    startsAt: "2026-11-05T08:00:00.000Z",
    readinessDeadlineMs: 0,
    timing,
    activation: {
      connect: async () => ({ ready: true }),
      listeners: {
        async inspect(owned) {
          return {
            state: "observed",
            listeners: (listening[pids.get(owned)!] ?? []).map((port) => ({
              pid: owned,
              address: "127.0.0.1",
              port,
            })),
          };
        },
      },
    },
    router,
    wrapEffects: (effects) =>
      (wrapped = {
        ...effects,
        observations: {
          ...effects.observations,
          process(target, component, signal) {
            observed.push(component.name);
            const answers = answer.get(component.name);
            if (answers?.kind === "unknown")
              return Promise.resolve<ProcessObservation>({ state: "unknown" });
            if (answers?.kind === "rejected")
              return Promise.reject(new Error("the supervisor did not answer"));
            if (answers?.kind === "stopped") {
              answers.signal = signal;
              return Promise.resolve<ProcessObservation>({
                state: "stopped",
                exitCode: 3,
              });
            }
            if (answers?.kind === "held") {
              answers.signal = signal;
              answers.reached();
              return answers.late;
            }
            return effects.observations.process(target, component, signal);
          },
        },
        // A Tool is published as asked, or fails once when the test says.
        async install(component) {
          timeline.push(`install ${component.name}`);
          const failure = tools.fails;
          delete tools.fails;
          if (failure) throw failure;
          return { outcome: "installed" };
        },
        async health(component, target, signal) {
          const held = heldHealth.get(component.name);
          if (!held) return effects.health(component, target, signal);
          heldHealth.delete(component.name);
          held.signal = signal;
          held.reach();
          await held.opened;
          return { ready: true };
        },
        route: (target, change) =>
          exclusiveEffect("route", () => effects.route(target, change)),
        withhold: (target, ports) =>
          exclusiveEffect("withhold", () => effects.withhold(target, ports)),
        restoreEffects: (target) =>
          exclusiveEffect("restore", () => effects.restoreEffects(target)),
        retireSuperseded: (previous, candidate) =>
          exclusiveEffect("retire", () =>
            effects.retireSuperseded(previous, candidate),
          ),
        async checkpoint(target, previous) {
          const checkpoint = await exclusiveEffect("checkpoint", () =>
            effects.checkpoint(target, previous),
          );
          return {
            ...checkpoint,
            commit: () => exclusiveEffect("commit", () => checkpoint.commit()),
            rollback: () =>
              exclusiveEffect("rollback", () => checkpoint.rollback()),
          };
        },
      }),
    dependencies: ({ store }) => ({
      lifecycle: ((lifecycle) => ({
        ...lifecycle,
        async up(...args: Parameters<typeof lifecycle.up>) {
          const started = await lifecycle.up(...args);
          const hold = afterUp.hold;
          delete afterUp.hold;
          hold?.reach();
          await hold?.opened;
          return started;
        },
      }))(createTargetLifecycle(wrapped, timing)),
      files: {
        /** Every Service gets the port it declares. */
        async selectPorts(input: {
          requests: { name: string; preferred?: number }[];
        }) {
          return Object.fromEntries(
            input.requests.map((request) => [request.name, request.preferred!]),
          );
        },
        async inspectPreviewDeletion() {},
        async destroyPreview() {},
      } as unknown as RuntimeDependencies["files"],
      observationBudgetMs: 600_000,
      observationDeadline,
      hostSession: {
        async current() {
          return { ...host.session };
        },
      },
      async diagnostic({ outcome, evidence, errorCode }) {
        if (outcome.startsWith("routes-"))
          said.push({
            outcome,
            ...(evidence !== undefined ? { evidence } : {}),
            ...(errorCode !== undefined ? { errorCode } : {}),
          });
      },
      // A write fails or waits when the test says: the write that decides a commit, say, so the candidate is rolled back.
      store: new Proxy(store, {
        get(real, property) {
          if (property === "update")
            return async (change: Parameters<typeof real.update>[0]) => {
              const matches = failing.matches;
              if (!matches) return await real.update(change);
              const matched = new Error("the write the test waits for");
              try {
                return await real.update(async (state) => {
                  await change(state);
                  if (matches(state)) throw matched;
                });
              } catch (error) {
                if (error !== matched) throw error;
              }
              const { hold, fails } = failing;
              delete failing.matches;
              if (hold) {
                hold.reach();
                await hold.opened;
              }
              if (fails) throw new Error("the disk is full");
              return await real.update(change);
            };
          const value = Reflect.get(real, property);
          return typeof value === "function" ? value.bind(real) : value;
        },
      }),
      sources: {
        async preflight() {
          return { commit: git.head, warnings: [] };
        },
        async resolve() {
          return git.head;
        },
        async currentBranch() {
          return "main";
        },
        async prepare(request: { destination: string }) {
          await mkdir(request.destination, { recursive: true });
          return { workspacePath: request.destination, commit: git.head };
        },
        async release() {},
        async changed() {
          return false;
        },
        async unmatched() {
          return [];
        },
      } as unknown as RuntimeDependencies["sources"],
    }),
  });
  roots.push(world.root);
  let runtime = world.open();
  await runtime.command({ action: "init", repoPath: world.repo });
  await runtime.reconcile();
  const stable = async (): Promise<TargetRecord> =>
    (await world.store.read()).targets.find((t) => t.kind === "stable")!;
  const deploy = (commit: string, extra: { noUp?: boolean } = {}) => {
    git.head = commit;
    return runtime.command({
      action: "deploy",
      repoPath: world.repo,
      target: "stable",
      branch: "main",
      ...extra,
    });
  };
  /** Forgets what the deploy before the one under test did. */
  const reset = () => {
    starts.length = 0;
    timeline.length = 0;
    stops.length = 0;
    applied.length = 0;
    observed.length = 0;
    pathsAtStop.clear();
    looks.scheduled = 0;
    looks.mostWaiting = 0;
  };
  /** `c1` deployed, then `services` changed so that they and what depends on them restart in the next deploy. */
  const deployedThenChanged = async (services: readonly string[]) => {
    await deploy("c1");
    for (const service of services)
      config.services![service]!.command = `${service}2`;
    reset();
  };
  return {
    config,
    processes,
    starts,
    stops,
    applied,
    observed,
    answer,
    said,
    overlaps,
    looks,
    waiting,
    look,
    proxy,
    listening,
    failWrite,
    timeline,
    tools,
    afterUp,
    exitsOnStart,
    host,
    /** The write that decides a deploy's commit (`recovery.stage` = `committing`): see `failWrite`. */
    failCommit: (options?: Parameters<typeof failWrite>[1]) =>
      failWrite(
        (state) =>
          state.targets.some((t) => t.recovery?.stage === "committing"),
        options,
      ),
    /** Stops of `service` from now on run at once; one already held stays held. */
    releaseStop(service: string) {
      heldStops.delete(service);
    },
    /** Starts of `service` from now on run at once; one already held stays held. */
    releaseStart(service: string) {
      heldStarts.delete(service);
    },
    clock: world.clock,
    root: world.root,
    store: world.store,
    /** The next start check of `service` waits until the test releases it, ignoring its cancellation. */
    holdHealth(service: string) {
      const held: ReturnType<typeof gate> & { signal?: AbortSignal } = gate();
      heldHealth.set(service, held);
      return held;
    },
    pathsAtStop,
    deploy,
    reset,
    deployedThenChanged,
    stable,
    holdStop(service: string, extra: { detach?: boolean } = {}) {
      const held = { ...gate(), ...extra };
      heldStops.set(service, held);
      return held;
    },
    holdStart(service: string) {
      const held = gate();
      heldStarts.set(service, held);
      return held;
    },
    /** The lifecycle's observation of `service` after the next `skip` waits until the test releases it. */
    holdObserve(service: string, skip = 0) {
      const held = { ...gate(), skip };
      heldObserves.set(service, held);
      return held;
    },
    /** The next observation of `service` waits, ignoring its cancellation, until the test answers. */
    holdObservation(service: string) {
      const reached = gate();
      let answerLate!: (seen: ProcessObservation) => void;
      const late = new Promise<ProcessObservation>(
        (resolve) => (answerLate = resolve),
      );
      const held = {
        kind: "held" as const,
        reached: reached.reach,
        late,
        signal: undefined as AbortSignal | undefined,
      };
      answer.set(service, held);
      return { held, reached: reached.reached, answerLate };
    },
    async paths() {
      return pathsOf(published.get((await stable()).id));
    },
    async exit(service: string, exitCode = 1) {
      const key = `${(await stable()).id}:${service}`;
      processes.set(key, {
        state: "stopped",
        incarnation: processes.get(key)?.incarnation,
        exitCode,
      });
    },
    command: (command: Parameters<typeof runtime.command>[0]) =>
      runtime.command(command),
    down: () =>
      runtime.command({ action: "down", project: "shop", target: "stable" }),
    restart: () =>
      runtime.command({ action: "restart", project: "shop", target: "stable" }),
    reopen() {
      runtime = world.open();
    },
    reconcile: () => runtime.reconcile(),
    supervise: () => runtime.supervise(),
  };
}

export const LIVE: Record<string, number | "503"> = { "/": WEB, "/api": API };
export const NONE: Record<string, number | "503"> = {
  "/": "503",
  "/api": "503",
};
