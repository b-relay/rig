import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTargetEffects } from "../src/adapters/target-effects";
import { createArtifactInstaller } from "../src/providers/artifact-installer";
import { runCommand } from "../src/providers/command-runner";
import type { RouteRequest, Router } from "../src/providers/caddy-router";
import type { ListenerEvidence } from "../src/providers/listener-inspection";
import { createTargetLifecycle } from "../src/runtime/lifecycle";
import { createRuntime } from "../src/runtime/application";
import { FileStateStore } from "../src/runtime/state-store";
import { timerObservationDeadline } from "../src/runtime/bounded-observations";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import type {
  HealthCheck,
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import {
  parseHostConfig,
  parseProjectConfig,
  resolveTargetPlan,
} from "../src/config";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const WEB = 46101,
  API = 46102,
  ADMIN = 46103;
const PROJECT = {
  name: "demo",
  domain: "app.test",
  proxy: {
    "/": "${services.web.ports.http}",
    "/api": "${services.api.ports.http}",
  },
  services: {
    web: { run: "web", ports: { http: WEB } },
    api: { run: "api", ports: { http: API, admin: ADMIN } },
  },
};
type Listening = Record<string, ListenerEvidence | string[]>;

/** The real runtime, lifecycle and effects over a scripted supervisor, a recording router, and controlled port and listener
 * evidence. `listening[service]` is what that Service's process tree listens on, as `address:port` or a whole answer. */
async function fixture(project: Record<string, unknown> = PROJECT) {
  const root = await mkdtemp(join(tmpdir(), "rig-activation-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  const config = parseProjectConfig(project);
  const clock = { ms: Date.parse("2026-09-17T00:00:00.000Z") };
  const processes = new Map<string, ProcessObservation>();
  const pids = new Map<number, string>();
  const starts: string[] = [];
  const stops: string[] = [];
  const unstoppable = new Set<string>();
  const supervisor: Supervisor = {
    async observe(key) {
      return processes.get(key) ?? { state: "stopped" };
    },
    async ensureRunning(request) {
      if (processes.get(request.key)?.state === "running")
        return { outcome: "unchanged" };
      starts.push(request.componentName);
      const pid = 1000 + starts.length;
      pids.set(pid, request.componentName);
      processes.set(request.key, {
        state: "running",
        pid,
        incarnation: request.incarnation,
      });
      return { outcome: "started" };
    },
    async stop(key) {
      if (unstoppable.has(key.split(":").at(-1)!))
        throw new Error("the process ignored the stop");
      const running = processes.get(key)?.state === "running";
      if (running) stops.push(key.split(":").at(-1)!);
      processes.delete(key);
      return { outcome: running ? "stopped" : "unchanged" };
    },
    async shutdown() {},
    async detach() {},
  };
  const listening: Listening = {
    web: [`127.0.0.1:${WEB}`],
    api: [`127.0.0.1:${API}`, `::1:${ADMIN}`],
  };
  /** A held port answers only once released; every other port answers at once. */
  const held = new Map<number, (check: HealthCheck) => void>();
  const hold = new Set<number>();
  const published = new Map<string, RouteRequest>();
  const routerFailure: { apply?: (route: RouteRequest) => boolean } = {};
  const router: Router = {
    async apply(route) {
      if (routerFailure.apply?.(route)) throw new Error("caddy is down");
      published.set(route.key, route);
    },
    async remove(key) {
      published.delete(key);
    },
    async withheld(key) {
      return (published.get(key)?.routes ?? [])
        .filter((route) => route.upstream === null)
        .map((route) => route.prefix);
    },
    async checkpoint(key) {
      return { key, value: JSON.stringify(published.get(key) ?? null) };
    },
    async restore(saved) {
      const value = JSON.parse(saved.value ?? "null") as RouteRequest | null;
      if (value) published.set(saved.key, value);
      else published.delete(saved.key);
    },
  };
  const effects = createTargetEffects({
    recordingTime: () => new Date(clock.ms).toISOString(),
    root,
    environment: {},
    supervisors: new Map([["rigd", supervisor]]),
    installer: createArtifactInstaller({
      run: runCommand,
      bunExecutable: process.execPath,
    }),
    router,
    connect: (port) =>
      hold.has(port)
        ? new Promise((resolve) => held.set(port, resolve))
        : Promise.resolve({ ready: true }),
    listeners: {
      async inspect(pid) {
        const answer = listening[pids.get(pid)!] ?? [];
        return Array.isArray(answer)
          ? {
              state: "observed",
              listeners: answer.map((listener) => ({
                pid,
                address: listener.slice(0, listener.lastIndexOf(":")),
                port: Number(listener.slice(listener.lastIndexOf(":") + 1)),
              })),
            }
          : answer;
      },
    },
    run: runCommand,
  });
  const timing = {
    // Polls fire at once; a readiness deadline is long enough for the test to act while a check is held.
    schedule(delayMs: number, fire: () => void) {
      if (delayMs < 1000) {
        const poll = setTimeout(fire, 0);
        return () => clearTimeout(poll);
      }
      const timer = setTimeout(fire, 400);
      return () => clearTimeout(timer);
    },
    startGraceMs: 0,
  };
  const store = new FileStateStore(root);
  let id = 0;
  const deps = {
    root,
    async assertOwnershipReady() {},
    async readAdminActivity() {
      return [];
    },
    async inspectHost() {
      return [];
    },
    async inspectProxy() {
      return {
        proxyFile: join(root, "Caddyfile"),
        routes: 0,
        state: "unpublished" as const,
      };
    },
    store,
    documents: {
      async read(path: string) {
        return { path: `${path}/rig.yaml`, revision: "abc", config };
      },
      async discover(path: string) {
        return {
          repoPath: path,
          document: await this.read(path),
          gitRequired: false,
        };
      },
      async identifyInitialization(path: string) {
        return { repoPath: path, name: "demo", configPath: `${path}/rig.yaml` };
      },
      async initialize(path: string) {
        return await this.read(path);
      },
      resolve: (input: Parameters<typeof resolveTargetPlan>[0]) =>
        resolveTargetPlan(
          { ...input, config: withWorkingDomain(input.config) },
          { operatorHome: "/home/operator", envRoot: join(root, "env") },
        ),
      async host() {
        return parseHostConfig({});
      },
    },
    lifecycle: createTargetLifecycle(effects, timing),
    observations: effects.observations,
    observationBudgetMs: 2000,
    observationDeadline: timerObservationDeadline,
    files: {
      async selectPorts(input: {
        requests: { name: string; preferred?: number }[];
      }) {
        return Object.fromEntries(
          input.requests.map((request) => [request.name, request.preferred!]),
        );
      },
    },
    now: () => new Date(clock.ms).toISOString(),
    id: () => `id${++id}`,
    async diagnostic() {},
  } as unknown as RuntimeDependencies;
  const runtime = createRuntime(deps);
  await runtime.command({ action: "init", repoPath: repo });
  const target = async () => (await store.read()).targets[0]!;
  return {
    clock,
    starts,
    stops,
    unstoppable,
    listening,
    hold,
    routerFailure,
    target,
    up: () => runtime.command({ action: "up", project: "demo" }),
    supervise: () => runtime.supervise(),
    /** A held readiness connection answers. */
    release(port: number) {
      hold.delete(port);
      held.get(port)?.({ ready: true });
    },
    async held(port: number) {
      for (let turn = 0; turn < 200 && !held.has(port); turn++)
        await new Promise((resolve) => setTimeout(resolve, 1));
      return held.has(port);
    },
    async exit(service: string, exitCode: number) {
      const key = `${(await target()).id}:${service}`;
      processes.set(key, {
        state: "stopped",
        incarnation: processes.get(key)!.incarnation,
        exitCode,
      });
    },
    async running(service: string) {
      return (
        processes.get(`${(await target()).id}:${service}`)?.state === "running"
      );
    },
    /** The upstream a request for `path` reaches through the published route: the first path that matches at a slash boundary. */
    routed: async () => published.has((await target()).id),
    async reach(path: string): Promise<string | null | undefined> {
      const route = published.get((await target()).id);
      return route?.routes.find(
        ({ prefix }) =>
          prefix === "/" || path === prefix || path.startsWith(`${prefix}/`),
      )?.upstream;
    },
  };
}
/** The Working copy is the Target these tests start; it is routed only when its role patch names a hostname. */
function withWorkingDomain<T extends { domain?: string }>(config: T): T {
  return config.domain
    ? ({ ...config, targets: { working: { domain: config.domain } } } as T)
    : config;
}
/** Records what the pass at the current time sees, then runs the pass at the time the scheduled retry is due. */
async function retry(f: Awaited<ReturnType<typeof fixture>>) {
  const { nextRetryAt } = await f.supervise();
  f.clock.ms = nextRetryAt!;
  return f.supervise();
}

test("an automatic replacement is not reachable through the route its predecessor had until it is ready and listens only locally", async () => {
  const f = await fixture();
  await f.up();
  expect(await f.reach("/api/users")).toBe(`127.0.0.1:${API}`);
  expect(await f.reach("/")).toBe(`127.0.0.1:${WEB}`);

  await f.exit("api", 3);
  f.hold.add(ADMIN);
  const recovering = retry(f);
  expect(await f.held(ADMIN)).toBe(true);
  // The replacement runs and its routed port may already answer, but it is not verified: its path reaches no process.
  expect(await f.running("api")).toBe(true);
  expect(await f.reach("/api/users")).toBeNull();
  expect(await f.reach("/api")).toBeNull();
  // A sibling's path is untouched, and '/apix' was never the api's.
  expect(await f.reach("/apix")).toBe(`127.0.0.1:${WEB}`);

  f.release(ADMIN);
  await recovering;
  expect(await f.reach("/api/users")).toBe(`127.0.0.1:${API}`);
  expect((await f.target()).services!.api!.outcome).toBeUndefined();
});

test("a replacement that listens beyond loopback is stopped and stays unreachable; its sibling keeps its route", async () => {
  const f = await fixture();
  await f.up();
  await f.exit("api", 3);
  f.listening.api = [`127.0.0.1:${API}`, `*:${ADMIN}`];
  await retry(f);

  expect(await f.running("api")).toBe(false);
  expect(f.stops).toEqual(["api"]);
  expect(await f.reach("/api/users")).toBeNull();
  expect(await f.reach("/")).toBe(`127.0.0.1:${WEB}`);
  expect((await f.target()).services!.api!.outcome).toMatchObject({
    kind: "activation-failed",
    errorCode: "LISTENER_NONLOCAL",
  });
});

test("when the route cannot be withdrawn the replacement is never started, and the failure is kept as evidence", async () => {
  const f = await fixture();
  await f.up();
  await f.exit("api", 3);
  f.routerFailure.apply = () => true;
  await retry(f);

  expect(f.starts).toEqual(["web", "api"]);
  expect(await f.running("api")).toBe(false);
  expect(await f.running("web")).toBe(true);
  expect(await f.reach("/")).toBe(`127.0.0.1:${WEB}`);
  expect((await f.target()).services!.api!.outcome).toMatchObject({
    kind: "activation-failed",
  });
});

test("an explicit up withholds the path of a stopped Service under the Target's existing route until that Service is verified", async () => {
  const f = await fixture();
  await f.up();
  await f.exit("api", 0);
  f.hold.add(API);
  const starting = f.up();
  expect(await f.held(API)).toBe(true);
  expect(await f.reach("/api/users")).toBeNull();
  expect(await f.reach("/")).toBe(`127.0.0.1:${WEB}`);
  f.release(API);
  await starting;
  expect(await f.reach("/api/users")).toBe(`127.0.0.1:${API}`);
  expect(f.starts).toEqual(["web", "api", "api"]);
});

test.each([
  ["the inspection has no answer", { state: "unknown", reason: "lsof failed" }],
  ["the process tree listens beyond loopback", [`0.0.0.0:${WEB}`]],
] as const)(
  "a first up publishes nothing and stops what it started when %s",
  async (_label, answer) => {
    const f = await fixture();
    f.listening.web = answer as Listening[string];
    await expect(f.up()).rejects.toMatchObject({
      code: Array.isArray(answer) ? "LISTENER_NONLOCAL" : "LISTENER_UNKNOWN",
    });
    expect(await f.routed()).toBe(false);
    expect(await f.running("web")).toBe(false);
    expect(f.starts).toEqual(["web"]);
  },
);

test("a port that answers but that no owned process listens on is someone else's: the Service is not ready, and the failure says it was an unready answer", async () => {
  const f = await fixture();
  f.listening.api = [`127.0.0.1:${API}`];
  await expect(f.up()).rejects.toMatchObject({
    code: "HEALTH_FAILED",
    details: { component: "api", outcome: "unready" },
  });
  expect(await f.routed()).toBe(false);
  expect(f.stops.sort()).toEqual(["api", "web"]);
});

test("readiness that never answers within the budget is reported as unanswered, and its late answer publishes nothing", async () => {
  const f = await fixture();
  f.hold.add(WEB);
  const starting = f.up();
  await expect(starting).rejects.toMatchObject({
    code: "HEALTH_FAILED",
    details: { component: "web", outcome: "unanswered" },
  });
  f.release(WEB);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(await f.routed()).toBe(false);
  expect(await f.running("web")).toBe(false);
});

const DEPENDENT = {
  name: "demo",
  services: {
    db: { run: "db", restart: "no", ports: { tcp: API } },
    web: { run: "web", depends_on: ["db"], ports: { http: WEB } },
    worker: { run: "worker", depends_on: ["db"] },
  },
};

test("a prerequisite that is already running is verified again before its dependent starts", async () => {
  const f = await fixture(DEPENDENT);
  f.listening.db = [`127.0.0.1:${API}`];
  await f.up();
  expect(f.starts).toEqual(["db", "web", "worker"]);
  await f.exit("web", 1);
  f.listening.db = [`*:${API}`];
  await expect(f.up()).rejects.toMatchObject({ code: "LISTENER_NONLOCAL" });
  expect(f.starts).toEqual(["db", "web", "worker"]);
  // The prerequisite was running before this up, so its rollback leaves it alone.
  expect(await f.running("db")).toBe(true);
});

test("a Service without ports or a check is started on liveness alone, in a Project that routes nothing", async () => {
  const f = await fixture(DEPENDENT);
  f.listening.db = [`127.0.0.1:${API}`];
  await f.up();
  expect(await f.running("worker")).toBe(true);
  expect(await f.routed()).toBe(false);
});

test("a no-restart prerequisite that exited successfully does not satisfy the dependency of an automatic start", async () => {
  const f = await fixture(DEPENDENT);
  f.listening.db = [`127.0.0.1:${API}`];
  await f.up();
  await f.exit("db", 0);
  await f.exit("web", 1);
  await retry(f);
  expect(f.starts).toEqual(["db", "web", "worker"]);
  expect((await f.target()).services!.web!.outcome).toMatchObject({
    kind: "activation-failed",
    errorCode: "SERVICE_DEPENDENCY",
  });
});

test("when the verified replacement's route cannot be published it is stopped, its path stays withheld, and the failure is kept", async () => {
  const f = await fixture();
  await f.up();
  await f.exit("api", 3);
  f.routerFailure.apply = (route) =>
    route.routes.every(({ upstream }) => upstream !== null);
  await retry(f);
  expect(await f.running("api")).toBe(false);
  expect(await f.reach("/api")).toBeNull();
  expect(await f.reach("/")).toBe(`127.0.0.1:${WEB}`);
  expect((await f.target()).services!.api!.outcome).toMatchObject({
    kind: "activation-failed",
  });
});

test("a sibling's recovery does not reopen the path of a Service whose unsafe replacement could not be stopped", async () => {
  const f = await fixture();
  await f.up();
  await f.exit("api", 3);
  f.listening.api = [`127.0.0.1:${API}`, `*:${ADMIN}`];
  f.unstoppable.add("api");
  await retry(f);
  expect(await f.running("api")).toBe(true);
  expect(await f.reach("/api")).toBeNull();

  f.unstoppable.delete("api");
  await f.exit("web", 3);
  await retry(f);
  expect(await f.running("web")).toBe(true);
  expect(await f.reach("/")).toBe(`127.0.0.1:${WEB}`);
  expect(await f.reach("/api")).toBeNull();

  // Cleanup that failed is not retried on its own. The path is released by its own Service passing the gate, here on an
  // operator's up, and not by anyone else's publication.
  f.listening.api = [`127.0.0.1:${API}`, `::1:${ADMIN}`];
  await f.exit("api", 3);
  await f.up();
  expect(await f.reach("/api")).toBe(`127.0.0.1:${API}`);
});
