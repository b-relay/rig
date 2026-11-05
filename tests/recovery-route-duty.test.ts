import { afterEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { parseProjectConfig } from "../src/config";
import type { ProjectConfig } from "../src/config/types";
import {
  FAILURE_MONITOR,
  createNoticeBoard,
  workReport,
} from "../src/daemon/notices";
import type { RouteRequest, Router } from "../src/providers/caddy-router";
import { parseOwnedSites, renderOwnedBlock } from "../src/providers/route-file";
import type {
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import type { HostSession } from "../src/domain/host-session";
import { stopDetached } from "../src/domain/stop-budget";
import type { TargetRecord } from "../src/domain/runtime";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import { runtimeWorld } from "./support/runtime-world";

/** A pass's one duty for a Target whose recovery is unresolved (ADR 0020), through the real runtime, lifecycle and effects
 * over a scripted supervisor and a recording router. rigd "dies" in a deploy by a stop detached at its route check, before
 * anything stops, or at its commit, after it published. */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const WEB = 47401,
  API = 47402,
  MOVED = 47403;

function shop(): ProjectConfig {
  return parseProjectConfig({
    name: "shop",
    domain: "shop.test",
    proxy: {
      "/": "${services.web.ports.http}",
      "/api": "${services.api.ports.http}",
    },
    services: {
      web: { command: "web", ports: { http: WEB } },
      api: { command: "api", ports: { http: API } },
      worker: { command: "worker" },
    },
    targets: { stable: { domain: "shop.test" } },
  });
}

const REBOOTED: HostSession = {
  boot: "BOOT-2",
  bootedAt: "2026-11-05T09:00:00.000Z",
  login: "100003",
};

async function fixture() {
  const config = shop();
  const processes = new Map<string, ProcessObservation>();
  const starts: string[] = [];
  const stops: string[] = [];
  /** How many times each Service was observed through the status budget. */
  const observed = new Map<string, number>();
  /** Services whose observation answers so: `unknown`, never, or by failing. */
  const answer = new Map<string, "unknown" | "unanswered" | "rejected">();
  /** Stops held until released, by Service; each says when the stop reached it. */
  const heldStops = new Map<
    string,
    { reached: () => void; released: Promise<void> }
  >();
  const name = (key: string) => key.split(":").at(-1)!;
  let pid = 8000;
  const pids = new Map<number, string>();
  const supervisor: Supervisor = {
    async observe(key) {
      return processes.get(key) ?? { state: "stopped" };
    },
    async ensureRunning(request) {
      if (processes.get(request.key)?.state === "running")
        return { outcome: "unchanged" };
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
      const held = heldStops.get(name(key));
      held?.reached();
      await held?.released;
      const running = processes.get(key)?.state === "running";
      if (running) stops.push(name(key));
      processes.delete(key);
      return { outcome: running ? "stopped" : "unchanged" };
    },
    async shutdown() {},
    async detach() {},
  };
  const published = new Map<string, RouteRequest>();
  const calls = { checkpoint: 0, apply: 0 };
  const proxy: { refuses?: boolean } = {};
  const router: Router = {
    async apply(route) {
      calls.apply++;
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
      calls.checkpoint++;
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
    worker: [],
  };
  const board = createNoticeBoard(() => "2026-11-05T09:00:00.000Z");
  const said: { outcome: string; evidence?: string }[] = [];
  const crash: {
    atRouteCheck?: boolean;
    atCommit?: boolean;
    holdRouteCheck?: Promise<void>;
    routeCheckHeld?: () => void;
  } = {};
  const git = { head: "c1" };
  const host: { session: HostSession } = {
    session: {
      boot: "BOOT-1",
      bootedAt: "2026-11-05T07:00:00.000Z",
      login: "100002",
    },
  };
  const world = await runtimeWorld({
    name: "recovery-duty",
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
          observed.set(component.name, (observed.get(component.name) ?? 0) + 1);
          const answers = answer.get(component.name);
          if (answers === "unknown")
            return Promise.resolve<ProcessObservation>({ state: "unknown" });
          if (answers === "unanswered") return new Promise(() => {});
          if (answers === "rejected")
            return Promise.reject(new Error("the supervisor did not answer"));
          return effects.observations.process(target, component, signal);
        },
      },
      async checkRoute(target) {
        if (crash.holdRouteCheck) {
          crash.routeCheckHeld?.();
          await crash.holdRouteCheck;
        }
        if (crash.atRouteCheck) {
          crash.atRouteCheck = false;
          throw stopDetached();
        }
        await effects.checkRoute?.(target);
      },
      async checkpoint(target, previous) {
        const checkpoint = await effects.checkpoint(target, previous);
        return {
          ...checkpoint,
          async commit() {
            if (crash.atCommit) {
              crash.atCommit = false;
              throw stopDetached();
            }
            await checkpoint.commit();
          },
        };
      },
    }),
    dependencies: () => ({
      supervision: workReport(board, FAILURE_MONITOR),
      // No observation is taken for unanswered because the machine is loaded.
      observationBudgetMs: 600_000,
      async diagnostic({ outcome, evidence }) {
        if (outcome.startsWith("routes-")) said.push({ outcome, evidence });
      },
      hostSession: {
        async current() {
          return { ...host.session };
        },
      },
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
  const deploy = (commit: string) => {
    git.head = commit;
    return runtime.command({
      action: "deploy",
      repoPath: world.repo,
      target: "stable",
      branch: "main",
    });
  };
  return {
    config,
    processes,
    starts,
    stops,
    observed,
    answer,
    heldStops,
    calls,
    proxy,
    listening,
    said,
    crash,
    host,
    deps: world.deps,
    store: world.store,
    stable,
    deploy,
    notices: () => board.list(),
    down: () =>
      runtime.command({ action: "down", project: "shop", target: "stable" }),
    up: () =>
      runtime.command({ action: "up", project: "shop", target: "stable" }),
    /** A new daemon over the same state file and whatever processes survive. */
    reopen() {
      runtime = world.open();
    },
    reconcile: () => runtime.reconcile(),
    supervise: () => runtime.supervise(),
    /** Each path of shop.test with the port it reaches, or `503`. */
    async paths(): Promise<Record<string, number | "503">> {
      const route = published.get((await stable()).id);
      return Object.fromEntries(
        (route?.sites ?? []).flatMap((site) =>
          site.routes.map((path) => [
            path.prefix,
            path.upstream === null
              ? ("503" as const)
              : Number(path.upstream.split(":").at(-1)),
          ]),
        ),
      );
    },
    async exit(service: string, exitCode = 1) {
      const key = `${(await stable()).id}:${service}`;
      processes.set(key, {
        state: "stopped",
        incarnation: processes.get(key)?.incarnation,
        exitCode,
      });
    },
    /** The deploy of a changed `web` and `api`, cut short by rigd dying at its route check: the previous plan still runs and
     * serves, and its recovery is pending. */
    async crashedDeploy() {
      await deploy("c1");
      config.services!.web!.command = "web2";
      config.services!.api!.command = "api2";
      crash.atRouteCheck = true;
      await expect(deploy("c2")).rejects.toMatchObject({
        code: "STOP_DETACHED",
      });
      expect((await stable()).recovery).toBeDefined();
      starts.length = 0;
      stops.length = 0;
      calls.apply = 0;
    },
  };
}

test("a Service that survives the first pass and exits later has its paths withheld by a later pass, and only its paths; nothing starts", async () => {
  const f = await fixture();
  await f.crashedDeploy();
  f.reopen();
  await f.reconcile();
  expect(await f.paths()).toEqual({ "/": WEB, "/api": API });
  expect(f.calls.apply).toBe(0);

  await f.exit("web");
  const before = await f.stable();
  await f.supervise();
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });
  expect(f.starts).toEqual([]);
  expect(f.stops).toEqual([]);
  const after = await f.stable();
  expect(after.recovery).toEqual(before.recovery);
  expect(after.services).toEqual(before.services);
  expect(f.notices()).toEqual([]);
});

test("a path to a Service seen stopped goes under the previous plan's port, while rigd died before the new plan published", async () => {
  const f = await fixture();
  await f.deploy("c1");
  f.config.services!.web!.ports = { http: MOVED };
  f.crash.atRouteCheck = true;
  await expect(f.deploy("c2")).rejects.toMatchObject({ code: "STOP_DETACHED" });
  // The Target's plan names MOVED; the route still reaches the previous plan's port.
  expect(await f.paths()).toEqual({ "/": WEB, "/api": API });

  await f.exit("web");
  await f.supervise();
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });
});

test("a path to a Service seen stopped goes under the new plan's port, while rigd died after the new plan published", async () => {
  const f = await fixture();
  await f.deploy("c1");
  f.config.services!.web!.ports = { http: MOVED };
  f.listening.web = [MOVED];
  f.crash.atCommit = true;
  await expect(f.deploy("c2")).rejects.toMatchObject({
    code: "DEPLOY_COMMIT_PENDING",
  });
  expect((await f.stable()).recovery?.stage).toBe("committing");
  expect(await f.paths()).toEqual({ "/": MOVED, "/api": API });
  f.starts.length = 0;

  await f.exit("web");
  await f.supervise();
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });
  expect(f.starts).toEqual([]);
});

test("a port the two plans give to different Services goes only once both are seen stopped: a path is never taken from a Service that may serve it", async () => {
  const f = await fixture();
  await f.deploy("c1");
  // The new plan moves web away and gives its old port to api.
  f.config.services!.web!.ports = { http: MOVED };
  f.config.services!.api!.ports = { http: WEB };
  f.crash.atRouteCheck = true;
  await expect(f.deploy("c2")).rejects.toMatchObject({ code: "STOP_DETACHED" });

  await f.exit("web");
  await f.supervise();
  expect(await f.paths()).toEqual({ "/": WEB, "/api": API });

  f.answer.set("api", "unknown");
  await f.supervise();
  expect(await f.paths()).toEqual({ "/": WEB, "/api": API });
  expect(f.said).toEqual([
    {
      outcome: "routes-unchecked",
      evidence: expect.stringContaining("Whether api still run"),
    },
  ]);

  f.answer.delete("api");
  await f.exit("api");
  await f.supervise();
  expect(await f.paths()).toEqual({ "/": "503", "/api": "503" });
});

test("a Mac restart with a pending recovery has the paths to its dead ports withheld by the first pass, starts nothing, and rig down still settles it", async () => {
  const f = await fixture();
  await f.crashedDeploy();
  f.processes.clear();
  f.host.session = REBOOTED;
  f.reopen();
  await f.reconcile();
  expect(await f.paths()).toEqual({ "/": "503", "/api": "503" });
  expect(f.starts).toEqual([]);
  expect((await f.stable()).recovery).toBeDefined();

  await f.down();
  const settled = await f.stable();
  expect(settled.recovery).toBeUndefined();
  expect(settled.desired).toBe("stopped");
});

test.each(["unknown", "unanswered", "rejected"] as const)(
  "an observation %s withholds nothing, says so once, and the next pass that sees it stopped withholds it",
  async (how) => {
    const f = await fixture();
    await f.crashedDeploy();
    await f.exit("web");
    await f.exit("api");
    const deadline = f.deps.observationDeadline;
    f.answer.set("web", how);
    if (how === "unanswered")
      f.deps.observationDeadline = {
        schedule(_ms, expire) {
          const timer = setTimeout(expire, 0);
          return () => clearTimeout(timer);
        },
      };
    f.reopen();
    await f.reconcile();
    await f.supervise();
    // api is seen stopped and goes; web decides nothing.
    expect(await f.paths()).toEqual({ "/": WEB, "/api": "503" });
    expect(f.notices()).toEqual([]);
    expect(f.said).toEqual([
      {
        outcome: "routes-unchecked",
        evidence: expect.stringContaining("Whether web still run"),
      },
    ]);

    f.answer.delete("web");
    f.deps.observationDeadline = deadline;
    await f.supervise();
    expect(await f.paths()).toEqual({ "/": "503", "/api": "503" });
    expect(f.said.at(-1)).toEqual({
      outcome: "routes-checked",
      evidence: undefined,
    });
    expect(f.said).toHaveLength(2);
    expect(f.starts).toEqual([]);
  },
);

test("a proxy that refuses is reported as a supervision failure and retried, and the pass that withholds clears the report", async () => {
  const f = await fixture();
  await f.crashedDeploy();
  await f.exit("web");
  f.proxy.refuses = true;
  await f.supervise();
  expect(await f.paths()).toEqual({ "/": WEB, "/api": API });
  const failure = expect.objectContaining({
    channel: "monitor",
    message: expect.stringMatching(
      /^Supervising stable of shop failed: ROUTE_WITHHOLD: /,
    ),
  });
  expect(f.notices()).toEqual([failure]);

  // Still refused: still reported, and still nothing started.
  await f.supervise();
  expect(f.notices()).toEqual([failure]);
  expect(f.starts).toEqual([]);

  // The next pass that finds it answering withholds the path and clears the failure.
  f.proxy.refuses = false;
  await f.supervise();
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });
  expect(f.notices()).toEqual([]);
});

test("a route failure stands through a pass that skips the Target for an Operation holding it", async () => {
  const f = await fixture();
  await f.crashedDeploy();
  await f.exit("web");
  f.proxy.refuses = true;
  await f.supervise();
  expect(f.notices()).toHaveLength(1);

  // rig down holds the Target while api's stop waits.
  f.proxy.refuses = false;
  let releaseStop = () => {};
  const released = new Promise<void>((resolve) => (releaseStop = resolve));
  const reached = new Promise<void>((resolve) =>
    f.heldStops.set("api", { reached: resolve, released }),
  );
  const down = f.down();
  await reached;
  await f.supervise();
  expect(f.notices()).toHaveLength(1);
  releaseStop();
  await down;
  await f.supervise();
  expect(f.notices()).toEqual([]);
});

test("it applies with desired stopped too, and stops nothing", async () => {
  const f = await fixture();
  await f.crashedDeploy();
  const id = (await f.stable()).id;
  await f.store.update((state) => {
    state.targets.find((target) => target.id === id)!.desired = "stopped";
  });
  f.reopen();
  await f.reconcile();
  expect(await f.paths()).toEqual({ "/": WEB, "/api": API });
  expect(f.stops).toEqual([]);

  await f.exit("web");
  await f.supervise();
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });
  expect(f.stops).toEqual([]);
  expect(f.starts).toEqual([]);
  expect((await f.stable()).desired).toBe("stopped");
});

test("a Target an Operation holds is skipped: a deploy still running keeps its paths and its own say", async () => {
  const f = await fixture();
  await f.deploy("c1");
  f.config.services!.web!.command = "web2";
  let releaseCheck = () => {};
  f.crash.holdRouteCheck = new Promise((resolve) => (releaseCheck = resolve));
  const held = new Promise<void>((resolve) => {
    f.crash.routeCheckHeld = resolve;
  });
  const deploying = f.deploy("c2");
  await held;
  expect((await f.stable()).recovery).toBeDefined();

  await f.exit("web");
  f.observed.clear();
  f.calls.checkpoint = 0;
  await f.supervise();
  expect(f.observed.size).toBe(0);
  expect(f.calls.checkpoint).toBe(0);
  expect(await f.paths()).toEqual({ "/": WEB, "/api": API });

  delete f.crash.holdRouteCheck;
  releaseCheck();
  await deploying;
  expect((await f.stable()).recovery).toBeUndefined();
  expect(await f.paths()).toEqual({ "/": WEB, "/api": API });
});

test("rig down settles a recovery whose paths were withheld, and the next rig up publishes them again", async () => {
  const f = await fixture();
  await f.crashedDeploy();
  await f.exit("web");
  await f.supervise();
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });

  await f.down();
  const settled = await f.stable();
  expect(settled.recovery).toBeUndefined();
  expect(settled.desired).toBe("stopped");
  expect(f.stops).toContain("api");
  expect(await f.paths()).toEqual({ "/": "503", "/api": "503" });
  expect(f.notices()).toEqual([]);

  await f.up();
  expect(await f.paths()).toEqual({ "/": WEB, "/api": API });
});

test("idle cost: an unresolved recovery costs one route read and an observation for each Service behind a live path; no paths, no observation", async () => {
  const f = await fixture();
  await f.crashedDeploy();
  f.observed.clear();
  f.calls.checkpoint = 0;
  await f.supervise();
  // worker has no path, so it is not observed.
  expect(Object.fromEntries(f.observed)).toEqual({ web: 1, api: 1 });
  expect(f.calls).toEqual({ checkpoint: 1, apply: 0 });

  // Nothing live: the route read alone.
  await f.exit("web");
  await f.exit("api");
  await f.supervise();
  expect(await f.paths()).toEqual({ "/": "503", "/api": "503" });
  f.observed.clear();
  f.calls.checkpoint = 0;
  f.calls.apply = 0;
  await f.supervise();
  expect(f.observed.size).toBe(0);
  expect(f.calls).toEqual({ checkpoint: 1, apply: 0 });
});

test("idle cost: a settled Target pays nothing for the duty: no route read, and no more than supervision's own observations", async () => {
  const f = await fixture();
  await f.deploy("c1");
  f.observed.clear();
  f.calls.checkpoint = 0;
  f.calls.apply = 0;
  await f.supervise();
  expect(Object.fromEntries(f.observed)).toEqual({
    web: 1,
    api: 1,
    worker: 1,
  });
  expect(f.calls).toEqual({ checkpoint: 0, apply: 0 });

  await f.down();
  f.observed.clear();
  f.calls.checkpoint = 0;
  f.calls.apply = 0;
  await f.supervise();
  expect(f.observed.size).toBe(0);
  expect(f.calls).toEqual({ checkpoint: 0, apply: 0 });
});
