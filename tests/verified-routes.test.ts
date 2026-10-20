import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseProjectConfig } from "../src/config";
import type { ProjectConfig } from "../src/config/types";
import type {
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import type { TargetRecord } from "../src/domain/runtime";
import { stopDetached } from "../src/domain/stop-budget";
import { runtimeWorld } from "./support/runtime-world";
import { managedCaddyWorld } from "./support/managed-caddy-double";
import { localActivation } from "./support/activation-doubles";
import { createTargetEffects } from "../src/adapters/target-effects";
import { createArtifactInstaller } from "../src/providers/artifact-installer";
import { runCommand } from "../src/providers/command-runner";
import { createTargetLifecycle } from "../src/runtime/lifecycle";

/** The rule every route change keeps, checked through the real runtime, lifecycle, effects and route file over a scripted
 * supervisor: a path reaches a port only while the Service process that owns the port runs and listens there on
 * 127.0.0.1. It is checked at every route change and checkpoint rollback, and as each process stops. */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const WEB = 47101,
  ADMIN = 47102,
  API = 47103,
  MOVED = 47104;

function shop(): ProjectConfig {
  return parseProjectConfig({
    name: "shop",
    domain: "shop.test",
    proxy: {
      "/": "${services.web.ports.http}",
      "/api": "${services.api.ports.http}",
    },
    services: {
      web: { command: "node web.js", ports: { http: WEB, admin: ADMIN } },
      api: { command: "node api.js", ports: { http: API } },
    },
    targets: { stable: { domain: "shop.test" } },
  });
}

async function fixture(config: ProjectConfig = shop()) {
  const processes = new Map<string, ProcessObservation>();
  /** What each Service's process listens on, as `address:port`. */
  const listening: Record<string, string[]> = {
    web: [`127.0.0.1:${WEB}`, `127.0.0.1:${ADMIN}`],
    api: [`127.0.0.1:${API}`],
  };
  /** Services whose every start fails, and those whose next start fails. */
  const failAlways = new Set<string>();
  const failOnce = new Set<string>();
  /** Runs once a Service of this name has started, as another process's doing meanwhile. */
  const afterStart = new Map<string, () => void>();
  /** Every breach of the rule, described. */
  const breaches: string[] = [];
  const events: string[] = [];
  let pid = 6000;
  let root = "";
  const service = (key: string) => key.split(":").at(-1)!;
  /** The ports a live path of the route file reaches. */
  const livePorts = async () =>
    [
      ...(
        await readFile(join(root, "Caddyfile"), "utf8").catch(() => "")
      ).matchAll(/reverse_proxy 127\.0\.0\.1:(\d+)/g),
    ].map((match) => Number(match[1]));
  const owner = (port: number) =>
    Object.entries(listening).find(([, sockets]) =>
      sockets.some((socket) => socket.endsWith(`:${port}`)),
    )?.[0];
  const check = async (moment: string) => {
    for (const port of await livePorts()) {
      const name = owner(port);
      const running = [...processes].some(
        ([key, observation]) =>
          service(key) === name && observation.state === "running",
      );
      if (!name || !running || !listening[name]!.includes(`127.0.0.1:${port}`))
        breaches.push(`${moment}: port ${port} is live`);
    }
  };
  const supervisor: Supervisor = {
    async observe(key) {
      return processes.get(key) ?? { state: "stopped" };
    },
    async ensureRunning(request) {
      if (processes.get(request.key)?.state === "running")
        return { outcome: "unchanged" };
      if (
        failAlways.has(request.componentName) ||
        failOnce.delete(request.componentName)
      )
        throw new Error(`${request.componentName} could not be spawned`);
      events.push(`start ${request.componentName}`);
      processes.set(request.key, {
        state: "running",
        pid: ++pid,
        incarnation: request.incarnation,
      });
      afterStart.get(request.componentName)?.();
      return { outcome: "started" };
    },
    async stop(key) {
      const running = processes.get(key)?.state === "running";
      if (running) {
        // Before the process ends: none of its ports may still be reached.
        const own = (listening[service(key)] ?? []).map((socket) =>
          Number(socket.split(":").at(-1)),
        );
        const live = await livePorts();
        for (const port of own)
          if (live.includes(port))
            breaches.push(`stop ${service(key)}: port ${port} is live`);
        events.push(`stop ${service(key)}`);
      }
      processes.set(key, { state: "stopped" });
      return { outcome: running ? "stopped" : "unchanged" };
    },
    async shutdown() {},
    async detach() {},
  };
  const git = { head: "c1" };
  /** Thrown, once, by the next route check a deploy asks: rigd dies before the deploy is decided. */
  const crash: { atRouteCheck?: boolean; atCommit?: boolean } = {};
  const world = await runtimeWorld({
    name: "verified",
    config,
    supervisor: () => supervisor,
    startsAt: "2026-10-19T09:00:00.000Z",
    readinessDeadlineMs: 400,
    activation: {
      connect: async () => ({ ready: true }),
      listeners: {
        async inspect(owned) {
          const key = [...processes].find(
            ([, observation]) =>
              observation.state === "running" && observation.pid === owned,
          )?.[0];
          return {
            state: "observed",
            listeners: (key ? (listening[service(key)] ?? []) : []).map(
              (socket) => ({
                pid: owned,
                address: socket.slice(0, socket.lastIndexOf(":")),
                port: Number(socket.slice(socket.lastIndexOf(":") + 1)),
              }),
            ),
          };
        },
      },
    },
    wrapEffects: (effects) => ({
      ...effects,
      async route(target, change) {
        await effects.route(target, change);
        await check("route");
      },
      async withhold(target, ports) {
        await effects.withhold(target, ports);
        await check("withhold");
      },
      async checkRoute(target) {
        if (crash.atRouteCheck) {
          crash.atRouteCheck = false;
          throw stopDetached();
        }
        await effects.checkRoute?.(target);
      },
      async restoreEffects(target) {
        await effects.restoreEffects(target);
        await check("restore");
      },
      async checkpoint(target, previous) {
        const checkpoint = await effects.checkpoint(target, previous);
        return {
          ...checkpoint,
          // Its commit fails once when asked to: after the route was published, as a failed journal write would.
          async commit() {
            if (crash.atCommit) {
              crash.atCommit = false;
              throw new Error("the checkpoint could not be committed");
            }
            await checkpoint.commit();
          },
          async rollback() {
            await checkpoint.rollback();
            await check("rollback");
          },
        };
      },
    }),
    dependencies: () => ({
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
        // Nothing a Service watches changed, so a Service whose definition is the same is kept.
        async changed() {
          return false;
        },
        async unmatched() {
          return [];
        },
      } as unknown as RuntimeDependencies["sources"],
    }),
  });
  root = world.root;
  roots.push(root);
  const runtime = world.open();
  await runtime.command({ action: "init", repoPath: world.repo });
  const stable = async (): Promise<TargetRecord> =>
    (await world.store.read()).targets.find((t) => t.kind === "stable")!;
  return {
    config,
    listening,
    failAlways,
    failOnce,
    afterStart,
    processes,
    breaches,
    events,
    git,
    crash,
    stable,
    command: runtime.command.bind(runtime),
    deploy: (commit: string) => {
      git.head = commit;
      return runtime.command({
        action: "deploy",
        repoPath: world.repo,
        target: "stable",
        branch: "main",
      }) as Promise<Record<string, unknown>>;
    },
    /** Each path of shop.test with what it reaches: an upstream, or `503`. */
    async paths(): Promise<Record<string, string>> {
      const text = await readFile(join(root, "Caddyfile"), "utf8");
      const site = /^shop\.test \{\n([\s\S]*?)^\}/m.exec(text)?.[1] ?? "";
      const paths: Record<string, string> = {};
      for (const handle of site.matchAll(
        /(?:@rig\d+ path (\S+) [^\n]*\n\s*)?handle(?: @rig\d+)? \{\n\s*(reverse_proxy (\S+)|respond 503)/g,
      ))
        paths[handle[1] ?? "/"] = handle[3] ?? "503";
      return paths;
    },
  };
}

test("a deploy that gives a kept Service a new routed port publishes it only once that Service is found listening there on 127.0.0.1", async () => {
  const f = await fixture();
  f.listening.web = [`127.0.0.1:${WEB}`, `::1:${ADMIN}`];
  await f.deploy("c1");
  f.config.proxy = {
    ...f.config.proxy,
    "/admin": "${services.web.ports.admin}",
  };
  expect(await f.deploy("c2")).toMatchObject({ kept: ["web", "api"] });
  expect(await f.paths()).toEqual({
    "/admin": "503",
    "/api": `127.0.0.1:${API}`,
    "/": `127.0.0.1:${WEB}`,
  });
  // On 127.0.0.1 as well, it is published at the next start.
  f.listening.web = [`127.0.0.1:${WEB}`, `127.0.0.1:${ADMIN}`];
  await f.command({ action: "up", project: "shop", target: "stable" });
  expect((await f.paths())["/admin"]).toBe(`127.0.0.1:${ADMIN}`);
  expect(f.breaches).toEqual([]);
});

test("a path moved to a kept Service follows that Service's port, and the kept Service's own paths stay published", async () => {
  const f = await fixture();
  await f.deploy("c1");
  f.config.services!.api!.command = "node api2.js";
  f.config.proxy = { ...f.config.proxy, "/api": "${services.web.ports.http}" };
  expect(await f.deploy("c2")).toMatchObject({ kept: ["web"] });
  expect(await f.paths()).toEqual({
    "/api": `127.0.0.1:${WEB}`,
    "/": `127.0.0.1:${WEB}`,
  });
  expect(f.breaches).toEqual([]);
});

test("a failed deploy's rollback never publishes a path to a Service that is not running: the previous route comes back withheld until it is verified", async () => {
  const f = await fixture();
  await f.deploy("c1");
  // api changed and its new start fails; the previous api starts again.
  f.config.services!.api!.command = "node api2.js";
  f.failOnce.add("api");
  await expect(f.deploy("c2")).rejects.toThrow("api could not be spawned");
  expect(await f.paths()).toEqual({
    "/api": `127.0.0.1:${API}`,
    "/": `127.0.0.1:${WEB}`,
  });
  // Neither start works now: the previous api cannot run, and its path stays withheld.
  f.config.services!.api!.command = "node api3.js";
  f.failAlways.add("api");
  await expect(f.deploy("c3")).rejects.toMatchObject({
    code: "DEPLOY_RESTORE_FAILED",
  });
  expect(await f.paths()).toEqual({
    "/api": "503",
    "/": `127.0.0.1:${WEB}`,
  });
  expect(f.breaches).toEqual([]);
});

test("a deploy whose new web exits while its api starts is not committed: the previous revision serves again and the deploy is recorded failed", async () => {
  const f = await fixture();
  await f.deploy("c1");
  f.config.services!.web!.command = "node web2.js";
  f.config.services!.api!.command = "node api2.js";
  // The new web passed its start gate; it exits as api starts.
  f.afterStart.set("api", () => {
    f.afterStart.delete("api");
    for (const [key, observation] of f.processes)
      if (key.endsWith(":web") && observation.state === "running")
        f.processes.set(key, {
          state: "stopped",
          incarnation: observation.incarnation,
          exitCode: 23,
        });
  });
  await expect(f.deploy("c2")).rejects.toMatchObject({
    code: "PROCESS_EXITED",
  });
  expect((await f.stable()).commit).toBe("c1");
  expect(await f.paths()).toEqual({
    "/api": `127.0.0.1:${API}`,
    "/": `127.0.0.1:${WEB}`,
  });
  const activity = (await f.command({
    action: "activity",
    project: "shop",
  })) as { operations: { action: string; outcome: string }[] };
  expect(
    activity.operations.filter((operation) => operation.action === "deploy"),
  ).toEqual([
    expect.objectContaining({ outcome: "deployed" }),
    expect.objectContaining({ outcome: "failed" }),
  ]);
  expect(f.breaches).toEqual([]);
});

test("a start that fails after its route was published withholds it again before its processes stop", async () => {
  const f = await fixture();
  await f.deploy("c1");
  await f.command({ action: "down", project: "shop", target: "stable" });
  f.crash.atCommit = true;
  await expect(
    f.command({ action: "up", project: "shop", target: "stable" }),
  ).rejects.toThrow("the checkpoint could not be committed");
  expect(f.events.slice(-4)).toEqual([
    "start web",
    "start api",
    "stop api",
    "stop web",
  ]);
  expect(await f.paths()).toEqual({ "/api": "503", "/": "503" });
  expect(f.breaches).toEqual([]);
});

test("rig down of a deploy rigd died in, whose new plan moved a Service's port, withholds the old port before it stops the old process", async () => {
  const f = await fixture();
  await f.deploy("c1");
  f.config.services!.web!.ports = { http: MOVED, admin: ADMIN };
  f.listening.web = [`127.0.0.1:${WEB}`, `127.0.0.1:${ADMIN}`];
  f.crash.atRouteCheck = true;
  await expect(f.deploy("c2")).rejects.toMatchObject({ code: "STOP_DETACHED" });
  expect((await f.stable()).recovery).toBeDefined();
  expect((await f.paths())["/"]).toBe(`127.0.0.1:${WEB}`);
  await f.command({ action: "down", project: "shop", target: "stable" });
  expect(f.events.slice(-2).sort()).toEqual(["stop api", "stop web"]);
  expect(f.breaches).toEqual([]);
});

test("a route file that already withholds a path is no proof Caddy does: rig down confirms what Caddy serves, and stops nothing until it can", async () => {
  const caddy = await managedCaddyWorld({ tls: { ca: "internal" } });
  roots.push(caddy.root);
  let running = true;
  /** Whether Caddy's loaded configuration reached the Service's port as its process stopped. */
  const liveAtStop: boolean[] = [];
  const supervisor: Supervisor = {
    observe: async () =>
      running ? { state: "running", pid: 1 } : { state: "stopped" },
    ensureRunning: async () => ({ outcome: "unchanged" }),
    async stop() {
      liveAtStop.push(caddy.servedRoutes().includes(`127.0.0.1:${WEB}`));
      running = false;
      return { outcome: "stopped" };
    },
    shutdown: async () => {},
    detach: async () => {},
  };
  const effects = createTargetEffects({
    ...localActivation([WEB]),
    root: caddy.root,
    recordingTime: () => "2026-10-20T00:00:00.000Z",
    environment: {},
    supervisors: new Map([["child", supervisor]]),
    installer: createArtifactInstaller({
      run: runCommand,
      bunExecutable: process.execPath,
    }),
    router: caddy.caddy.router,
    run: runCommand,
  });
  const target = {
    id: "target",
    projectId: "project",
    name: "stable",
    kind: "stable",
    desired: "running",
    createdAt: "now",
    updatedAt: "now",
    logRoot: join(caddy.root, "logs"),
    plan: {
      project: "shop",
      target: "stable",
      workspacePath: caddy.root,
      dataRoot: join(caddy.root, "data"),
      deploymentName: "stable",
      branchSlug: "main",
      subdomain: "stable",
      providers: { processSupervisor: "child" },
      preparedComponents: [],
      domain: "shop.test",
      proxy: { upstream: "web" },
      components: [
        {
          name: "web",
          kind: "managed",
          command: "serve",
          port: WEB,
          readyTimeout: 1,
          env: {},
          dependsOn: [],
        },
      ],
    },
  } as TargetRecord;
  await effects.route(target, { verified: new Set([WEB]) });
  expect(caddy.servedRoutes()).toContain(`reverse_proxy 127.0.0.1:${WEB}`);
  // rigd died after writing a withholding route file and before Caddy took it; Caddy still serves the live route.
  const file = join(caddy.root, "proxy", "Caddyfile");
  await writeFile(
    file,
    (await readFile(file, "utf8")).replace(
      `reverse_proxy 127.0.0.1:${WEB}`,
      "respond 503",
    ),
  );
  caddy.control.reachable = false;
  const lifecycle = createTargetLifecycle(effects);
  await expect(lifecycle.down(target)).rejects.toMatchObject({
    code: "ROUTE_WITHHOLD",
  });
  expect(liveAtStop).toEqual([]);
  expect(running).toBe(true);
  caddy.control.reachable = true;
  await lifecycle.down(target);
  expect(liveAtStop).toEqual([false]);
});
