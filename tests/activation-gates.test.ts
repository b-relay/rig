import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { RouteRequest, Router } from "../src/providers/caddy-router";
import { parseOwnedSites, renderOwnedBlock } from "../src/providers/route-file";
import type { ListenerEvidence } from "../src/providers/listener-inspection";
import type {
  HealthCheck,
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import { parseProjectConfig } from "../src/config";
import {
  FAILURE_MONITOR,
  createNoticeBoard,
  workReport,
} from "../src/daemon/notices";
import { runtimeWorld } from "./support/runtime-world";

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
    web: { command: "web", ports: { http: WEB } },
    api: { command: "api", ports: { http: API, admin: ADMIN } },
  },
};
type Listening = Record<string, ListenerEvidence | string[]>;

/** The real runtime, lifecycle and effects over a scripted supervisor, a recording router, and controlled port and listener
 * evidence. `listening[service]` is what that Service's process tree listens on, as `address:port` or a whole answer. */
async function fixture(project: Record<string, unknown> = PROJECT) {
  const config = parseProjectConfig(withWorkingDomain(project));
  const processes = new Map<string, ProcessObservation>();
  const pids = new Map<number, string>();
  const starts: string[] = [];
  const stops: string[] = [];
  const unstoppable = new Set<string>();
  /** Every upstream the Target's route named as each running Service was stopped. */
  const routeAtStop: (string | null)[][] = [];
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
      if (running)
        routeAtStop.push(
          (published.get(key.split(":")[0]!)?.sites ?? []).flatMap((site) =>
            site.routes.map((route) => route.upstream),
          ),
        );
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
  /** The runtime's reads of state fail with this while set. */
  const stateFailure: { read?: Error } = {};
  /** The notices doctor reports, with supervision reporting to the monitor's channel as rigd wires it. */
  const board = createNoticeBoard(() => "2026-09-17T00:00:00.000Z");
  const router: Router = {
    async apply(route) {
      if (routerFailure.apply?.(route)) throw new Error("caddy is down");
      published.set(route.key, route);
    },
    async remove(key) {
      published.delete(key);
    },
    async withheld(key) {
      return (published.get(key)?.sites ?? []).flatMap((site) =>
        site.routes
          .filter((route) => route.upstream === null)
          .map((route) => ({ hostname: site.hostname, prefix: route.prefix })),
      );
    },
    // A checkpoint is the block as the route file holds it, as both real routers keep it.
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
    async withdrawUnowned(owners) {
      const owned = await owners();
      const withdrawn = [...published].filter(([key]) => !owned.has(key));
      for (const [key] of withdrawn) published.delete(key);
      return withdrawn.flatMap(([, route]) =>
        route.sites.map((site) => site.hostname),
      );
    },
  };
  const world = await runtimeWorld({
    name: "activation",
    config,
    supervisor: () => supervisor,
    startsAt: "2026-09-17T00:00:00.000Z",
    // A readiness deadline is long enough for the test to act while a check is held.
    readinessDeadlineMs: 400,
    activation: {
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
    },
    router,
    dependencies: ({ store }) => ({
      supervision: workReport(board, FAILURE_MONITOR),
      store: {
        read: () =>
          stateFailure.read ? Promise.reject(stateFailure.read) : store.read(),
        update: (change) => store.update(change),
      },
    }),
  });
  roots.push(world.root);
  const { clock, store } = world;
  const runtime = world.open();
  await runtime.command({ action: "init", repoPath: world.repo });
  const target = async () => (await store.read()).targets[0]!;
  return {
    clock,
    starts,
    stops,
    routeAtStop,
    unstoppable,
    listening,
    hold,
    routerFailure,
    stateFailure,
    notices: () => board.list(),
    target,
    up: () => runtime.command({ action: "up", project: "demo" }),
    down: () => runtime.command({ action: "down", project: "demo" }),
    command: runtime.command.bind(runtime),
    /** Every hostname the Target's route publishes, in order. */
    async hostnames() {
      return (published.get((await target()).id)?.sites ?? []).map(
        (site) => site.hostname,
      );
    },
    /** The upstream a request for `path` on `hostname` reaches, as `reach` does for the first site. */
    async reachAt(
      hostname: string,
      path: string,
    ): Promise<string | null | undefined> {
      const route = published.get((await target()).id);
      return route?.sites
        .find((site) => site.hostname === hostname)
        ?.routes.find(
          ({ prefix }) =>
            prefix === "/" || path === prefix || path.startsWith(`${prefix}/`),
        )?.upstream;
    },
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
      return route?.sites[0]?.routes.find(
        ({ prefix }) =>
          prefix === "/" || path === prefix || path.startsWith(`${prefix}/`),
      )?.upstream;
    },
  };
}
/** The working Target is the one these tests start, so rig.yaml turns it on; it is routed only when its role patch names
 * a hostname, here the Project's domain. A Project that writes its own targets keeps them. */
function withWorkingDomain<T extends { domain?: string; targets?: unknown }>(
  config: T,
): T {
  if (config.targets) return config;
  return {
    ...config,
    targets: { working: config.domain ? { domain: config.domain } : true },
  } as T;
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

test("when the route cannot be withheld from a Service that exited, nothing is recorded or started for it until it can", async () => {
  const f = await fixture();
  await f.up();
  await f.exit("api", 3);
  f.routerFailure.apply = () => true;
  expect(await f.supervise()).toEqual({});
  expect(f.starts).toEqual(["web", "api"]);
  expect(await f.running("api")).toBe(false);
  expect(await f.running("web")).toBe(true);
  expect(await f.reach("/")).toBe(`127.0.0.1:${WEB}`);
  expect((await f.target()).services!.api!.outcome).toBeUndefined();
  // Once the proxy answers, the next pass withholds its paths, records the exit and starts it again.
  f.routerFailure.apply = undefined;
  await retry(f);
  expect(f.starts).toEqual(["web", "api", "api"]);
  expect(await f.reach("/api/users")).toBe(`127.0.0.1:${API}`);
  expect(await f.reach("/")).toBe(`127.0.0.1:${WEB}`);
});

test("a routed Service that exits on its own and is not restarted has its paths withheld, and they reach it again once it is verified", async () => {
  const f = await fixture({
    ...PROJECT,
    services: {
      ...PROJECT.services,
      api: { ...PROJECT.services.api, restart: "no" },
    },
  });
  await f.up();
  await f.exit("api", 3);
  expect(await f.supervise()).toEqual({});
  expect((await f.target()).services!.api!.outcome).toMatchObject({
    kind: "exited",
    exitCode: 3,
  });
  // A program that takes its port now receives nothing for its paths; its sibling's stay.
  expect(await f.reach("/api/users")).toBeNull();
  expect(await f.reach("/")).toBe(`127.0.0.1:${WEB}`);
  await f.up();
  expect(await f.reach("/api/users")).toBe(`127.0.0.1:${API}`);
});

test("a start fails, publishing nothing, when a Service it verified exits while a later Service is still starting", async () => {
  const f = await fixture();
  f.hold.add(API);
  const starting = f.up();
  expect(await f.held(API)).toBe(true);
  // web passed its start gate; it exits while api's start waits.
  await f.exit("web", 23);
  f.release(API);
  await expect(starting).rejects.toMatchObject({
    code: "PROCESS_EXITED",
    message:
      "web was ready, then exited with code 23 before working finished starting.",
  });
  // Nothing was published.
  expect(await f.routed()).toBe(false);
  // What it started is stopped again.
  expect(await f.running("api")).toBe(false);
  expect(f.stops).toContain("api");
});

test("a Service already running that a start relies on is verified again once the start is done", async () => {
  const f = await fixture({
    ...PROJECT,
    services: {
      ...PROJECT.services,
      api: { ...PROJECT.services.api, depends_on: ["web"], restart: "no" },
    },
  });
  await f.up();
  await f.exit("api", 0);
  f.hold.add(API);
  const starting = f.up();
  expect(await f.held(API)).toBe(true);
  await f.exit("web", 9);
  f.release(API);
  await expect(starting).rejects.toMatchObject({ code: "PROCESS_EXITED" });
  expect(await f.reach("/api/users")).toBeNull();
  expect(await f.running("api")).toBe(false);
  // web's own exit is supervision's: its next pass withholds web's path.
  await f.supervise();
  expect(await f.reach("/")).toBeNull();
});

test("a supervision pass that cannot read the state raises the monitor notice, and the next pass that reads it clears it", async () => {
  const f = await fixture();
  await f.up();
  f.stateFailure.read = new Error("state.json: Unexpected token");
  expect(await f.supervise()).toEqual({});
  expect(f.notices()).toEqual([
    expect.objectContaining({
      channel: "monitor",
      message: "Reading the runtime state failed: state.json: Unexpected token",
    }),
  ]);
  f.stateFailure.read = undefined;
  await f.supervise();
  expect(f.notices()).toEqual([]);
});

test("a Service whose supervision fails raises the monitor notice while its siblings are still supervised; a pass that skips the Target leaves it, and only supervising it again clears it", async () => {
  const f = await fixture();
  await f.up();
  await f.exit("web", 1);
  await f.exit("api", 3);
  // The proxy refuses to withhold api's paths, and only those.
  f.routerFailure.apply = (route) =>
    route.sites.some((site) =>
      site.routes.some(
        (path) => path.prefix === "/api" && path.upstream === null,
      ),
    );
  await f.supervise();
  expect((await f.target()).services!.web!.outcome).toMatchObject({
    kind: "exited",
    exitCode: 1,
  });
  expect((await f.target()).services!.api!.outcome).toBeUndefined();
  expect(f.notices()).toEqual([
    expect.objectContaining({
      channel: "monitor",
      message: expect.stringMatching(
        /^Supervising working of demo failed: ROUTE_WITHHOLD: /,
      ),
    }),
  ]);
  // An up holds the Target while its readiness waits: the pass skips it, which is no recovery.
  f.routerFailure.apply = undefined;
  f.hold.add(API);
  const starting = f.up();
  expect(await f.held(API)).toBe(true);
  await f.supervise();
  expect(f.notices()).toHaveLength(1);
  f.release(API);
  await starting;
  await f.supervise();
  expect(f.notices()).toEqual([]);
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

test("rig down withholds every path before any Service stops, so a program that binds a freed port receives nothing; rig up opens them only once their Services are verified again", async () => {
  const f = await fixture();
  await f.up();
  await f.down();
  expect(f.stops.sort()).toEqual(["api", "web"]);
  // Neither stop left a path that reaches its port.
  expect(f.routeAtStop).toEqual([
    [null, null],
    [null, null],
  ]);
  expect(await f.reach("/")).toBeNull();
  expect(await f.reach("/api/users")).toBeNull();

  f.hold.add(API);
  const starting = f.up();
  expect(await f.held(API)).toBe(true);
  // Running again, but not verified: nothing reaches the ports yet.
  expect(await f.reach("/")).toBeNull();
  expect(await f.reach("/api/users")).toBeNull();
  f.release(API);
  await starting;
  expect(await f.reach("/")).toBe(`127.0.0.1:${WEB}`);
  expect(await f.reach("/api/users")).toBe(`127.0.0.1:${API}`);
});

test("a failed start leaves the path of a Service that is not running withheld, even where the route before it still named that Service's port", async () => {
  const f = await fixture();
  await f.up();
  // It ended on its own and no pass has seen it yet: its path still names its port.
  await f.exit("api", 3);
  expect(await f.reach("/api")).toBe(`127.0.0.1:${API}`);
  f.listening.api = [`127.0.0.1:${API}`, `*:${ADMIN}`];
  await expect(f.up()).rejects.toMatchObject({ code: "LISTENER_NONLOCAL" });
  expect(await f.running("api")).toBe(false);
  expect(await f.reach("/api/users")).toBeNull();
  expect(await f.reach("/")).toBe(`127.0.0.1:${WEB}`);
});

test("a routed Service that listens only on ::1 is refused at activation, since Rig's proxy connects to 127.0.0.1 where any program may listen", async () => {
  const f = await fixture();
  // Something answers on the port (a program on 127.0.0.1, say), but the Service's own socket is on ::1.
  f.listening.web = [`::1:${WEB}`];
  await expect(f.up()).rejects.toMatchObject({
    code: "HEALTH_FAILED",
    details: {
      component: "web",
      lastCheck: `web listens on port ${WEB} only at ::1, but Rig's proxy connects to 127.0.0.1:${WEB}; bind it to 127.0.0.1`,
    },
  });
  expect(await f.routed()).toBe(false);
  expect(await f.running("web")).toBe(false);
});

test("a routed Service on 127.0.0.1, also as an IPv4-mapped address, is published; a port nothing routes may stay on ::1", async () => {
  const f = await fixture();
  f.listening.web = [`::ffff:127.0.0.1:${WEB}`, `::1:${WEB}`];
  // api's admin port is declared but not routed.
  f.listening.api = [`127.0.0.1:${API}`, `::1:${ADMIN}`];
  await f.up();
  expect(await f.reach("/")).toBe(`127.0.0.1:${WEB}`);
  expect(await f.reach("/api")).toBe(`127.0.0.1:${API}`);
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
    db: { command: "db", restart: "no", ports: { tcp: API } },
    web: { command: "web", depends_on: ["db"], ports: { http: WEB } },
    worker: { command: "worker", depends_on: ["db"] },
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
  // The refusal spawned nothing: web waits for db without spending its budget.
  expect((await f.target()).services!.web).toMatchObject({
    outcome: { kind: "exited", exitCode: 1 },
    attempts: [],
    waitingFor: { service: "db" },
  });
});

test("when the verified replacement's route cannot be published it is stopped, its path stays withheld, and the failure is kept", async () => {
  const f = await fixture();
  await f.up();
  await f.exit("api", 3);
  f.routerFailure.apply = (route) =>
    route.sites.every((site) =>
      site.routes.every(({ upstream }) => upstream !== null),
    );
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

/** web serves the Project domain; api serves a hostname of its own, on the one of its two ports the domain names. */
const OWN_DOMAIN = {
  name: "demo",
  proxy: { "/": "web" },
  services: {
    web: { command: "web", ports: { http: WEB } },
    api: { command: "api", ports: { http: API, admin: ADMIN } },
  },
  targets: {
    working: {
      domain: "app.test",
      services: { api: { domain: { host: "api.app.test", port: "http" } } },
    },
  },
};

test("a Service domain is published with the Target's domain as one route, and withheld alone while its Service is unverified", async () => {
  const f = await fixture(OWN_DOMAIN);
  await f.up();
  expect(await f.hostnames()).toEqual(["app.test", "api.app.test"]);
  expect(await f.reachAt("app.test", "/")).toBe(`127.0.0.1:${WEB}`);
  expect(await f.reachAt("api.app.test", "/users")).toBe(`127.0.0.1:${API}`);

  await f.exit("api", 3);
  f.hold.add(ADMIN);
  const recovering = retry(f);
  expect(await f.held(ADMIN)).toBe(true);
  // The replacement is not verified: every path of its hostname answers 503, and the other hostname keeps its upstream.
  expect(await f.reachAt("api.app.test", "/users")).toBeNull();
  expect(await f.reachAt("app.test", "/")).toBe(`127.0.0.1:${WEB}`);
  f.release(ADMIN);
  await recovering;
  expect(await f.reachAt("api.app.test", "/users")).toBe(`127.0.0.1:${API}`);
});

test("status and doctor list every hostname a Target serves", async () => {
  const f = await fixture(OWN_DOMAIN);
  await f.up();
  const status = (await f.command({ action: "status", project: "demo" })) as {
    targets: {
      route?: string;
      hostnames?: string[];
      components: { name: string; route?: string; hostnames?: string[] }[];
    }[];
  };
  const [working] = status.targets;
  expect(working!.route).toBe("app.test");
  expect(working!.hostnames).toEqual(["app.test", "api.app.test"]);
  expect(
    working!.components.map(({ name, route, hostnames }) => ({
      name,
      route,
      hostnames,
    })),
  ).toEqual([
    { name: "web", route: "app.test", hostnames: ["app.test"] },
    { name: "api", route: "api.app.test", hostnames: ["api.app.test"] },
  ]);
  const doctor = (await f.command({ action: "doctor", project: "demo" })) as {
    checks: { name: string; ok: boolean; message: string }[];
  };
  expect(doctor.checks).toContainEqual({
    name: "working/hostnames",
    ok: true,
    message: "Recorded hostnames: app.test (web), api.app.test (api).",
  });
});
