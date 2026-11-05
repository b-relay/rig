import { afterEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { parseProjectConfig } from "../src/config";
import type { ProjectConfig } from "../src/config/types";
import type { RigError } from "../src/domain/errors";
import type { RouteRequest, Router } from "../src/providers/caddy-router";
import { parseOwnedSites, renderOwnedBlock } from "../src/providers/route-file";
import type {
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import { stopDetached } from "../src/domain/stop-budget";
import type { TargetRecord } from "../src/domain/runtime";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import { ROUTE_LOOK_INTERVAL_MS } from "../src/runtime/route-guard";
import { runtimeWorld } from "./support/runtime-world";

/** The stop side and the guard of ADR 0020, through the real runtime, lifecycle and effects over a scripted supervisor, a
 * recording router and a deadline only the test fires: a look runs when the test says, and no budget ever ends by itself. */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const WEB = 47501,
  API = 47502,
  MOVED = 47503;

/** Melody's shape: `search` comes last and no path needs it, so it is the tail. */
function melody(): ProjectConfig {
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
function noTail(): ProjectConfig {
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
function gate() {
  let open!: () => void;
  let reach!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const reached = new Promise<void>((resolve) => (reach = resolve));
  return { open, reach, opened, reached };
}

/** Lets everything already resolved run: the steps between two provider calls, none of which does I/O. */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(config: ProjectConfig = melody()) {
  const processes = new Map<string, ProcessObservation>();
  const starts: string[] = [];
  const stops: string[] = [];
  const name = (key: string) => key.split(":").at(-1)!;
  /** Stops held until released, or failed then, by Service. */
  const heldStops = new Map<
    string,
    ReturnType<typeof gate> & { detach?: boolean }
  >();
  const heldStarts = new Map<string, ReturnType<typeof gate>>();
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
      return processes.get(key) ?? { state: "stopped" };
    },
    async ensureRunning(request) {
      if (processes.get(request.key)?.state === "running")
        return { outcome: "unchanged" };
      const held = heldStarts.get(request.componentName);
      held?.reach();
      await held?.opened;
      starts.push(request.componentName);
      pids.set(++pid, request.componentName);
      processes.set(request.key, {
        state: "running",
        pid,
        incarnation: request.incarnation,
      });
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
  const proxy: { refuses?: boolean; hold?: ReturnType<typeof gate> } = {};
  const router: Router = {
    async apply(route) {
      applied.push(pathsOf(route));
      const hold = proxy.hold;
      hold?.reach();
      await hold?.opened;
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
  /** The write that decides a commit, once the candidate is published: failed, or held until the gate opens. */
  const failNextWrite: {
    armed?: boolean;
    afterPublish?: boolean;
    hold?: ReturnType<typeof gate>;
  } = {};
  const git = { head: "c1" };
  const world = await runtimeWorld({
    name: "tail-stop",
    config,
    supervisor: () => supervisor,
    startsAt: "2026-11-05T08:00:00.000Z",
    readinessDeadlineMs: 0,
    // Polls fire at once and no start check's deadline ever does, so a loaded machine fails nothing here.
    timing: {
      schedule(delayMs, fire) {
        if (delayMs >= 1000) return () => {};
        const timer = setTimeout(fire, 0);
        return () => clearTimeout(timer);
      },
      startGraceMs: 0,
    },
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
    wrapEffects: (effects) => ({
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
          if (answers?.kind === "held") {
            answers.signal = signal;
            answers.reached();
            return answers.late;
          }
          return effects.observations.process(target, component, signal);
        },
      },
      route: (target, change) =>
        exclusiveEffect("route", async () => {
          await effects.route(target, change);
          if ("verified" in change && failNextWrite.afterPublish)
            failNextWrite.armed = true;
        }),
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
      async diagnostic({ outcome, evidence, errorCode }) {
        if (outcome.startsWith("routes-"))
          said.push({
            outcome,
            ...(evidence !== undefined ? { evidence } : {}),
            ...(errorCode !== undefined ? { errorCode } : {}),
          });
      },
      // The write that decides a commit fails when asked to: the published candidate is rolled back.
      store: new Proxy(store, {
        get(real, property) {
          if (property === "update")
            return (change: Parameters<typeof real.update>[0]) => {
              if (failNextWrite.armed) {
                failNextWrite.armed = failNextWrite.afterPublish = false;
                const hold = failNextWrite.hold;
                if (!hold) return Promise.reject(new Error("the disk is full"));
                delete failNextWrite.hold;
                hold.reach();
                return hold.opened.then(() => real.update(change));
              }
              return real.update(change);
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
    failNextWrite,
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

const LIVE: Record<string, number | "503"> = { "/": WEB, "/api": API };
const NONE: Record<string, number | "503"> = { "/": "503", "/api": "503" };

test("a deploy: with search's stop blocked every path stays live and no route changes, and they are withheld before web stops", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["api", "web", "search"]);
  const search = f.holdStop("search");
  const deploying = f.deploy("c2");
  await search.reached;
  expect(await f.paths()).toEqual(LIVE);
  expect(f.applied).toEqual([]);
  expect(f.stops).toEqual([]);

  search.open();
  await deploying;
  expect(f.stops).toEqual(["search", "web", "api"]);
  expect(f.pathsAtStop.get("search")).toEqual(LIVE);
  expect(f.pathsAtStop.get("web")).toEqual(NONE);
  expect(await f.paths()).toEqual(LIVE);
  // Melody's three publishes, as today: the stop's withhold, the start's, and the publish.
  expect(f.applied).toEqual([NONE, NONE, LIVE]);
  expect(f.overlaps).toEqual([]);
});

test("rig restart: with search's stop blocked every path stays live, and they are withheld before web stops", async () => {
  const f = await fixture();
  await f.deployedThenChanged([]);
  const search = f.holdStop("search");
  const restarting = f.restart();
  await search.reached;
  expect(await f.paths()).toEqual(LIVE);
  expect(f.stops).toEqual([]);

  search.open();
  await restarting;
  expect(f.pathsAtStop.get("search")).toEqual(LIVE);
  expect(f.pathsAtStop.get("web")).toEqual(NONE);
  expect(f.stops).toEqual(["search", "web", "api", "db"]);
  expect(await f.paths()).toEqual(LIVE);
  expect(f.overlaps).toEqual([]);
});

test("plain rig down withholds before its first stop, the tail's too, and nothing looks", async () => {
  const f = await fixture();
  await f.deployedThenChanged([]);
  await f.down();
  expect(f.stops).toEqual(["search", "web", "api", "db"]);
  expect(f.pathsAtStop.get("search")).toEqual(NONE);
  expect(f.looks.scheduled).toBe(0);
});

test("deploy --no-up withholds before its first stop, as nothing replaces what it stops, and nothing looks", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web"]);
  await f.deploy("c2", { noUp: true });
  expect(f.stops).toEqual(["search", "web", "api", "db"]);
  expect(f.pathsAtStop.get("search")).toEqual(NONE);
  expect(f.looks.scheduled).toBe(0);
});

test("destroying a Preview withholds before its first stop, and nothing looks", async () => {
  const f = await fixture();
  await f.command({
    action: "deploy",
    project: "shop",
    target: "preview",
    branch: "feature",
  });
  f.reset();
  const preview = (await f.command({
    action: "status",
    project: "shop",
  })) as { targets: { name: string; kind: string }[] };
  const name = preview.targets.find((t) => t.kind === "preview")!.name;
  await f.command({
    action: "destroy",
    project: "shop",
    target: "preview",
    deployment: name,
  });
  expect(f.stops).toEqual(["search", "web", "api", "db"]);
  expect(f.pathsAtStop.get("search")).toEqual(NONE);
  expect(f.looks.scheduled).toBe(0);
});

test("the rollback of a candidate that was published withholds before it stops the candidate's tail", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  f.failNextWrite.afterPublish = true;
  await expect(f.deploy("c2")).rejects.toThrow("the disk is full");
  // The previous plan's stop kept the tail first; the candidate's clean-up did not.
  expect(f.stops).toEqual(["search", "web", "search", "web"]);
  expect(f.pathsAtStop.get("search")).toEqual({ "/": "503", "/api": API });
  expect(await f.paths()).toEqual(LIVE);
  expect((await f.stable()).commit).toBe("c1");
  expect(f.overlaps).toEqual([]);
  expect(f.waiting.size).toBe(0);
});

test("rigd killed during the tail's stop leaves the old paths live, for the recovery duty to watch; rig down stops withheld", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  const search = f.holdStop("search", { detach: true });
  const deploying = f.deploy("c2");
  await search.reached;
  search.open();
  await expect(deploying).rejects.toMatchObject({ code: "STOP_DETACHED" });
  expect(await f.paths()).toEqual(LIVE);
  expect((await f.stable()).recovery).toBeDefined();
  expect(f.waiting.size).toBe(0);

  f.reopen();
  await f.reconcile();
  await f.exit("web");
  await f.supervise();
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });

  f.pathsAtStop.clear();
  f.holdStop("search").open();
  await f.down();
  expect((await f.stable()).recovery).toBeUndefined();
  // A recovery stop withholds every path before its first stop.
  expect(f.pathsAtStop.get("search")).toEqual(NONE);
});

test("a routed Service seen stopped during the tail's stop has its paths withheld by the next look, and only those; nothing starts", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["api", "web", "search"]);
  const search = f.holdStop("search");
  const deploying = f.deploy("c2");
  await search.reached;
  await f.exit("web");
  await f.look();
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });
  expect(f.applied).toEqual([{ "/": "503", "/api": API }]);
  expect(f.said).toEqual([
    {
      outcome: "routes-withheld",
      evidence: expect.stringContaining("web stopped"),
    },
  ]);
  expect(f.starts).toEqual([]);

  // Seen once: the path is gone, so the next look asks only about what is still live.
  f.observed.length = 0;
  await f.look();
  expect(f.observed).toEqual(["api"]);

  search.open();
  await deploying;
  expect(await f.paths()).toEqual(LIVE);
  expect(f.overlaps).toEqual([]);
});

test("the guard reads a path by the plan it was published under: a port the new plan gives another Service still goes for the one behind it now", async () => {
  const f = await fixture();
  await f.deploy("c1");
  // The new plan swaps the two ports, so `web`'s port is the running `api`'s under it.
  f.config.services!.web!.ports = { http: API };
  f.config.services!.api!.ports = { http: WEB };
  f.config.services!.search!.command = "search2";
  f.listening.web = [API];
  f.listening.api = [WEB];
  f.reset();
  const search = f.holdStop("search");
  const deploying = f.deploy("c2");
  await search.reached;
  await f.exit("web");
  await f.look();
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });
  search.open();
  await deploying;
  expect(await f.paths()).toEqual({ "/": API, "/api": WEB });
});

test("once the new plan is published the guard reads a path by it: a Service that exits on its new port is withheld, and the deploy still commits", async () => {
  const f = await fixture();
  await f.deploy("c1");
  f.config.services!.web!.ports = { http: MOVED };
  f.config.services!.search!.command = "search2";
  f.listening.web = [MOVED];
  f.reset();
  const write = gate();
  f.failNextWrite.afterPublish = true;
  f.failNextWrite.hold = write;
  const deploying = f.deploy("c2");
  await write.reached;
  expect(await f.paths()).toEqual({ "/": MOVED, "/api": API });

  await f.exit("web");
  await f.look();
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });

  // Before the commit is decided this only withholds: failing the start for it comes with publishing before the tail.
  write.open();
  await deploying;
  expect((await f.stable()).commit).toBe("c2");
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });
  expect(f.overlaps).toEqual([]);
});

test.each(["unknown", "rejected"] as const)(
  "a Service whose observation is %s keeps its path, and the next look that sees it stopped withholds it",
  async (kind) => {
    const f = await fixture();
    await f.deployedThenChanged(["api", "web", "search"]);
    const search = f.holdStop("search");
    const deploying = f.deploy("c2");
    await search.reached;
    await f.exit("web");
    f.answer.set("web", { kind });
    await f.look();
    expect(await f.paths()).toEqual(LIVE);
    expect(f.applied).toEqual([]);

    f.answer.delete("web");
    await f.look();
    expect(await f.paths()).toEqual({ "/": "503", "/api": API });
    search.open();
    await deploying;
  },
);

test("a look held in flight is joined before the stop's withhold, without waiting for the provider, and its late answer changes nothing", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["api", "web", "search"]);
  const search = f.holdStop("search");
  const deploying = f.deploy("c2");
  await search.reached;
  const web = f.holdObservation("web");
  // Fired by hand: it stays in flight, and no later one is scheduled meanwhile.
  const [fire] = f.waiting;
  f.waiting.delete(fire!);
  fire!();
  await web.reached;
  expect(f.waiting.size).toBe(0);

  // No budget ever ends here: only the stop's section can end the look.
  search.open();
  await deploying;
  expect(web.held.signal?.aborted).toBe(true);
  expect(f.applied).toEqual([NONE, NONE, LIVE]);

  // The new plan is published by now. The stale answer that says web stopped must not take its path.
  web.answerLate({ state: "stopped" });
  await settled();
  expect(await f.paths()).toEqual(LIVE);
  expect(f.applied).toEqual([NONE, NONE, LIVE]);
});

test("a withhold the guard has begun finishes through its journal capture before the stop's own route change starts", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["api", "web", "search"]);
  const search = f.holdStop("search");
  const deploying = f.deploy("c2");
  await search.reached;
  await f.exit("web");
  const apply = gate();
  f.proxy.hold = apply;
  const looking = f.look();
  await apply.reached;
  expect(f.applied).toEqual([{ "/": "503", "/api": API }]);

  search.open();
  await settled();
  // The stop has reached its withhold, and waits behind the guard's.
  expect(f.stops).toEqual(["search"]);
  expect(f.applied).toEqual([{ "/": "503", "/api": API }]);

  f.proxy.hold = undefined;
  apply.open();
  await looking;
  await deploying;
  expect(f.overlaps).toEqual([]);
  expect(f.applied).toEqual([{ "/": "503", "/api": API }, NONE, NONE, LIVE]);
  expect(await f.paths()).toEqual(LIVE);
});

test("a proxy that refuses the guard's withhold is tried again by the next look, and said once", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["api", "web", "search"]);
  const search = f.holdStop("search");
  const deploying = f.deploy("c2");
  await search.reached;
  await f.exit("web");
  f.proxy.refuses = true;
  await f.look();
  await f.look();
  expect(await f.paths()).toEqual(LIVE);
  expect(f.said).toEqual([
    expect.objectContaining({
      outcome: "routes-withhold-failed",
      errorCode: "ROUTE_WITHHOLD",
    }),
  ]);

  f.proxy.refuses = false;
  await f.look();
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });
  search.open();
  await deploying;
});

test("one guard holds across a deploy's stop and start: a kept routed Service that exits during the start is withheld, and looks end with the Operation", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  const search = f.holdStop("search");
  const start = f.holdStart("web");
  const deploying = f.deploy("c2");
  await search.reached;
  expect(f.waiting.size).toBe(1);
  search.open();
  await start.reached;
  // The stop withheld only what it stops: `api` is kept, and keeps its path.
  expect(f.pathsAtStop.get("web")).toEqual({ "/": "503", "/api": API });
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });
  expect(f.waiting.size).toBe(1);

  await f.exit("api");
  await f.look();
  expect(await f.paths()).toEqual(NONE);

  start.open();
  await deploying;
  // Restart policy takes over once the Target is released: the deploy carried on, and nothing published its dead path.
  expect(await f.paths()).toEqual({ "/": WEB, "/api": "503" });
  expect((await f.stable()).commit).toBe("c2");
  expect(f.looks.mostWaiting).toBe(1);
  expect(f.waiting.size).toBe(0);
  expect(f.overlaps).toEqual([]);
});

test("one guard holds across rig restart's stop and start, with nothing to observe once the paths are withheld, and ends with it", async () => {
  const f = await fixture();
  await f.deployedThenChanged([]);
  const search = f.holdStop("search");
  const start = f.holdStart("web");
  const restarting = f.restart();
  await search.reached;
  await f.exit("web");
  await f.look();
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });

  search.open();
  await start.reached;
  expect(f.waiting.size).toBe(1);
  f.observed.length = 0;
  await f.look();
  expect(f.observed).toEqual([]);

  start.open();
  await restarting;
  expect(await f.paths()).toEqual(LIVE);
  expect(f.looks.mostWaiting).toBe(1);
  expect(f.waiting.size).toBe(0);
});

test("the guard's withhold is journalled as the transaction's own: the rollback that follows does not take it for an outside change", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  const start = f.holdStart("web");
  f.failNextWrite.afterPublish = true;
  const deploying = f.deploy("c2");
  await start.reached;
  await f.exit("api");
  await f.look();
  expect(await f.paths()).toEqual(NONE);
  start.open();
  await expect(deploying).rejects.toThrow("the disk is full");
  // Not DEPLOY_ROLLBACK_BLOCKED: the previous plan is back, api started again by its own start.
  expect((await f.stable()).commit).toBe("c1");
  expect((await f.stable()).recovery).toBeUndefined();
  expect(f.starts).toContain("api");
  expect(await f.paths()).toEqual(LIVE);
  expect(f.overlaps).toEqual([]);
});

test("a deploy that restarts only the tail changes no path while it stops, as a kept routed Service keeps its own", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["search"]);
  await f.deploy("c2");
  expect(f.stops).toEqual(["search"]);
  expect(f.pathsAtStop.get("search")).toEqual(LIVE);
  for (const paths of f.applied) expect(paths).toEqual(LIVE);
});

test("a plan with no tail makes the same route calls in the same order, withheld before the first stop", async () => {
  const f = await fixture(noTail());
  await f.deployedThenChanged(["api", "web"]);
  await f.deploy("c2");
  expect(f.stops).toEqual(["web", "api"]);
  expect(f.pathsAtStop.get("web")).toEqual(NONE);
  expect(f.applied).toEqual([NONE, NONE, LIVE]);
  expect(f.overlaps).toEqual([]);
});

test("a withhold that fails after the tail stopped says no Service with a path stopped, and web keeps running", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  const search = f.holdStop("search");
  const deploying = f.deploy("c2");
  await search.reached;
  f.proxy.refuses = true;
  search.open();
  const failure = (await deploying.catch(
    (error: unknown) => error,
  )) as RigError;
  expect(failure.code).toBe("DEPLOY_ROLLBACK_BLOCKED");
  expect(f.stops).toEqual(["search"]);
  expect(await f.paths()).toEqual(LIVE);
  expect(f.waiting.size).toBe(0);
});

test("a Target no Operation holds is never looked at: a status and a supervision pass schedule no look", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web"]);
  await f.command({ action: "status", project: "shop" });
  await f.supervise();
  expect(f.looks.scheduled).toBe(0);
  expect(f.waiting.size).toBe(0);
});
