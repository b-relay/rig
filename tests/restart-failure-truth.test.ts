import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseProjectConfig } from "../src/config";
import type { ProjectConfig } from "../src/config/types";
import { RigError } from "../src/domain/errors";
import type { HostSession } from "../src/domain/host-session";
import { upstreamPort } from "../src/domain/route-upstream";
import { stopDetached } from "../src/domain/stop-budget";
import type {
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import { liveUpstreams, ownedBlock } from "../src/providers/route-file";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import { checkIdentity } from "../src/runtime/health-monitor";
import { preparationProcessKey } from "../src/runtime/lifecycle";
import { runtimeWorld } from "./support/runtime-world";

/** What Rig reports and does after a restart or a failure, through the real runtime, lifecycle, effects, route file and
 * state file over a scripted supervisor and Host session. */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const WEB = 47301;
const API = 47302;

type Kind = "working" | "stable" | "preview";

function shop(extra: Record<string, unknown> = {}): ProjectConfig {
  return parseProjectConfig({
    name: "shop",
    domain: "shop.test",
    proxy: { "/": "${services.web.ports.http}" },
    services: {
      web: { command: "web", restart: "always", ports: { http: WEB } },
      api: { command: "api", restart: "no", ports: { http: API } },
    },
    targets: {
      working: { domain: "dev.shop.test" },
      stable: true,
      preview: { domain: "${rig.target}.preview.shop.test" },
    },
    ...extra,
  });
}

async function fixture(config: ProjectConfig = shop()) {
  const processes = new Map<string, ProcessObservation>();
  /** Process stops and starts, in order, as `stop <service>` and `start <service>`. */
  const events: string[] = [];
  const fail: {
    /** Stops of keys ending so throw this. */
    stop?: { suffix: string; error: () => unknown };
    /** Starts throw this. */
    start?: () => unknown;
    /** The route check of a start throws this. */
    routeCheck?: () => unknown;
    /** Each withhold throws this. */
    withhold?: () => unknown;
  } = {};
  /** Held open while a Target's build runs, and said running under its recorded key, as a live daemon's own build is. */
  const build: { hold?: Promise<void>; running?: () => void } = {};
  let pid = 7000;
  const name = (key: string) => key.split(":").at(-1)!;
  const supervisor: Supervisor = {
    async observe(key) {
      return processes.get(key) ?? { state: "stopped" };
    },
    async ensureRunning(request) {
      if (processes.get(request.key)?.state === "running")
        return { outcome: "unchanged" };
      if (fail.start) throw fail.start();
      events.push(`start ${request.componentName}`);
      processes.set(request.key, {
        state: "running",
        pid: ++pid,
        incarnation: request.incarnation,
      });
      return { outcome: "started" };
    },
    async stop(key) {
      if (fail.stop && key.endsWith(fail.stop.suffix)) throw fail.stop.error();
      const running = processes.get(key)?.state === "running";
      if (running) events.push(`stop ${name(key)}`);
      processes.delete(key);
      return { outcome: running ? "stopped" : "unchanged" };
    },
    async shutdown() {},
    async detach() {},
  };
  const host: { session: HostSession } = {
    session: {
      boot: "BOOT-1",
      bootedAt: "2026-11-03T07:00:00.000Z",
      login: "100002",
    },
  };
  const world = await runtimeWorld({
    name: "restart-truth",
    config,
    supervisor: () => supervisor,
    startsAt: "2026-11-03T08:00:00.000Z",
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
          const key = [...processes].find(
            ([, seen]) => seen.state === "running" && seen.pid === owned,
          )?.[0];
          return {
            state: "observed",
            listeners: [
              {
                pid: owned,
                address: "127.0.0.1",
                port: key && name(key) === "api" ? API : WEB,
              },
            ],
          };
        },
      },
    },
    wrapEffects: (effects) => ({
      ...effects,
      async withhold(target, ports) {
        if (fail.withhold) throw fail.withhold();
        await effects.withhold(target, ports);
      },
      async checkRoute(target) {
        if (fail.routeCheck) throw fail.routeCheck();
        await effects.checkRoute?.(target);
      },
      async build(unit, target, environment) {
        const key = preparationProcessKey(target);
        if (build.hold) {
          processes.set(key, { state: "running", pid: ++pid });
          build.running?.();
          await build.hold;
          processes.delete(key);
          return;
        }
        await effects.build(unit, target, environment);
      },
    }),
    dependencies: () => ({
      // No observation is taken for unanswered because the machine is loaded.
      observationBudgetMs: 600_000,
      sources: {
        async preflight() {
          return { commit: "c1", warnings: [] };
        },
        async resolve() {
          return "c1";
        },
        async currentBranch() {
          return "feature";
        },
        async prepare(request: { destination: string }) {
          await mkdir(request.destination, { recursive: true });
          return { workspacePath: request.destination, commit: "c1" };
        },
        async release() {},
        async changed() {
          return true;
        },
        async unmatched() {
          return [];
        },
      } as unknown as RuntimeDependencies["sources"],
      hostSession: {
        async current() {
          return { ...host.session };
        },
      },
    }),
  });
  roots.push(world.root);
  let runtime = world.open();
  await runtime.command({ action: "init", repoPath: world.repo });
  await runtime.reconcile();
  const target = async (kind: Kind) =>
    (await world.store.read()).targets.find((t) => t.kind === kind)!;
  /** The ports a live path of `kind`'s route block reaches. */
  const livePorts = async (kind: Kind) => {
    const file = await readFile(join(world.root, "Caddyfile"), "utf8").catch(
      () => "",
    );
    return [
      ...liveUpstreams(ownedBlock(file, (await target(kind)).id) ?? ""),
    ].map(upstreamPort);
  };
  return {
    world,
    deps: world.deps,
    processes,
    events,
    fail,
    build,
    host,
    store: world.store,
    target,
    livePorts,
    preview: () =>
      runtime.command({
        action: "deploy",
        project: "shop",
        target: "preview",
        branch: "feature",
      }),
    command: (command: Parameters<typeof runtime.command>[0]) =>
      runtime.command(command),
    restartUnhealthy: (
      request: Parameters<typeof runtime.restartUnhealthy>[0],
    ) => runtime.restartUnhealthy(request),
    /** A new daemon over the same state file and whatever processes survive. */
    reopen() {
      runtime = world.open();
    },
    reconcile: () => runtime.reconcile(),
    supervise: () => runtime.supervise(),
    drain: () => runtime.drain(),
    /** Whether every Service of `kind` is still running, as the same processes it started with. */
    async pids(kind: Kind) {
      const prefix = `${(await target(kind)).id}:`;
      return [...processes]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, seen]) => `${name(key)}=${seen.pid}`)
        .sort();
    },
    async status(kind: Kind) {
      const report = (await runtime.command({
        action: "status",
        project: "shop",
      })) as {
        warnings?: string[];
        targets: (Record<string, unknown> & { kind: string })[];
      };
      return {
        warnings: report.warnings ?? [],
        report: report.targets.find((t) => t.kind === kind)!,
      };
    },
    async activity(action: string) {
      return (await world.store.read()).activity
        .filter((entry) => entry.action === action)
        .map((entry) => `${entry.outcome}: ${entry.message ?? ""}`);
    },
  };
}
type World = Awaited<ReturnType<typeof fixture>>;

const REBOOTED: HostSession = {
  boot: "BOOT-2",
  bootedAt: "2026-11-03T07:59:00.000Z",
  login: "100002",
};

// A refused restart (#708)

/** `refuse` makes a restart refuse; the restart is refused with `code`, every process running and its record unchanged. */
async function refusedWithEverythingRunning(
  f: World,
  kind: "working" | "stable",
  refuse: () => void | Promise<void>,
  code: string,
) {
  const pids = await f.pids(kind);
  const events = f.events.length;
  await refuse();
  const before = await f.target(kind);
  await expect(
    f.command({ action: "restart", project: "shop", target: kind }),
  ).rejects.toMatchObject({ code });
  expect(f.events.slice(events)).toEqual([]);
  expect(await f.pids(kind)).toEqual(pids);
  const after = await f.target(kind);
  expect(after.desired).toBe("running");
  expect(after.services).toEqual(before.services);
  expect(after.plan).toEqual(before.plan);
  expect(await f.livePorts(kind)).toEqual([WEB]);
  // It is recorded as a failed restart, not as a stop.
  expect((await f.activity("restart")).at(-1)).toStartWith(`failed: `);
}

test("a working Target's restart with an unreadable rig.yaml is refused before anything stops", async () => {
  const f = await fixture();
  await f.command({ action: "up", project: "shop", target: "working" });
  const read = f.deps.documents.read;
  await refusedWithEverythingRunning(
    f,
    "working",
    () => {
      f.deps.documents.read = async () => {
        throw new RigError(
          "CONFIG_INVALID",
          "Invalid Project configuration.",
          "Fix config.",
        );
      };
    },
    "CONFIG_INVALID",
  );
  // Once it can be read, the same restart stops and starts it from that config.
  f.deps.documents.read = read;
  f.events.length = 0;
  await f.command({ action: "restart", project: "shop", target: "working" });
  expect(f.events).toEqual(["stop api", "stop web", "start web", "start api"]);
  expect((await f.target("working")).desired).toBe("running");
});

test("a working Target's restart whose new plan is refused, such as a pinned port another Target holds, stops nothing", async () => {
  const f = await fixture();
  await f.command({ action: "up", project: "shop", target: "working" });
  await refusedWithEverythingRunning(
    f,
    "working",
    () => {
      f.deps.files.selectPorts = async () => {
        throw new RigError("PORT_RESERVED", "Port is held.", "Pin another.");
      };
    },
    "PORT_RESERVED",
  );
});

test("a restart whose route could not be published is refused before anything stops, on a working and a stable Target", async () => {
  const f = await fixture();
  await f.command({ action: "up", project: "shop", target: "working" });
  await f.command({ action: "deploy", project: "shop", target: "stable" });
  const conflict = () =>
    new RigError("ROUTE_CONFLICT", "Hostname has another owner.", "Free it.");
  for (const kind of ["working", "stable"] as const) {
    await refusedWithEverythingRunning(
      f,
      kind,
      () => {
        f.fail.routeCheck = conflict;
      },
      "ROUTE_CONFLICT",
    );
    delete f.fail.routeCheck;
  }
});

test("a stable Target whose recorded preparation is not complete refuses a restart before anything stops", async () => {
  const f = await fixture();
  await f.command({ action: "deploy", project: "shop", target: "stable" });
  await refusedWithEverythingRunning(
    f,
    "stable",
    () =>
      f.store.update((state) => {
        const stable = state.targets.find((t) => t.kind === "stable")!;
        stable.plan.builds = [{ id: "shared", command: "true", timeout: 60 }];
      }),
    "PREPARATION_INCOMPLETE",
  );
});

test("a restart that cannot read a Service's env file is refused before anything stops; a Working copy's build may still write one", async () => {
  const f = await fixture();
  const file = join(f.world.root, "generated.env");
  await writeFile(file, "A=1\n");
  const config = shop({
    services: {
      web: {
        command: "web",
        restart: "always",
        ports: { http: WEB },
        env_file: file,
      },
      api: { command: "api", restart: "no", ports: { http: API } },
    },
  });
  const read = f.deps.documents.read;
  f.deps.documents.read = async (path) => ({
    ...(await read.call(f.deps.documents, path)),
    config,
  });
  await f.command({ action: "up", project: "shop", target: "working" });
  await refusedWithEverythingRunning(
    f,
    "working",
    () => rm(file),
    "ENV_FILE_MISSING",
  );

  // A build runs between this check and the start, and may write the file: such a restart goes on.
  const built = shop({
    build: `echo A=1 > ${file}`,
    services: {
      web: {
        command: "web",
        restart: "always",
        ports: { http: WEB },
        env_file: file,
      },
      api: { command: "api", restart: "no", ports: { http: API } },
    },
  });
  f.deps.documents.read = async (path) => ({
    ...(await read.call(f.deps.documents, path)),
    config: built,
  });
  f.events.length = 0;
  await f.command({ action: "restart", project: "shop", target: "working" });
  expect(f.events).toEqual(["stop api", "stop web", "start web", "start api"]);
});

test("a restart is refused before anything stops when the first build's own env file is missing, shared or a Service's, since nothing could write it first", async () => {
  const web = (extra: Record<string, unknown>) => ({
    command: "web",
    restart: "always",
    ports: { http: WEB },
    ...extra,
  });
  const api = { command: "api", restart: "no", ports: { http: API } };
  for (const build of ["shared", "service"] as const) {
    const f = await fixture();
    const file = join(f.world.root, "build-input.env");
    await writeFile(file, "A=1\n");
    const config =
      build === "shared"
        ? shop({
            env_file: file,
            build: "true",
            services: { web: web({}), api },
          })
        : shop({
            services: { web: web({ env_file: file, build: "true" }), api },
          });
    const read = f.deps.documents.read;
    f.deps.documents.read = async (path) => ({
      ...(await read.call(f.deps.documents, path)),
      config,
    });
    await f.command({ action: "up", project: "shop", target: "working" });
    await refusedWithEverythingRunning(
      f,
      "working",
      () => rm(file),
      "ENV_FILE_MISSING",
    );
  }
});

// After a Host restart (#702)

test("after a Host restart no route of a working Target or Preview reaches its port until a verified start; a stable Target's comes back with its start", async () => {
  const f = await fixture();
  await f.command({ action: "up", project: "shop", target: "working" });
  await f.command({ action: "deploy", project: "shop", target: "stable" });
  await f.preview();
  expect(await f.livePorts("working")).toEqual([WEB]);
  expect(await f.livePorts("preview")).toEqual([WEB]);

  f.processes.clear();
  f.host.session = REBOOTED;
  f.reopen();
  await f.reconcile();

  expect(await f.livePorts("working")).toEqual([]);
  expect(await f.livePorts("preview")).toEqual([]);
  expect(await f.livePorts("stable")).toEqual([WEB]);
  expect((await f.target("working")).services?.web?.outcome).toMatchObject({
    kind: "unknown",
    hostRestart: "reboot",
  });

  await f.command({ action: "up", project: "shop", target: "working" });
  expect(await f.livePorts("working")).toEqual([WEB]);
  expect(await f.livePorts("preview")).toEqual([]);
});

test("while a Host restart's route cannot be withheld its stop is not recorded, each pass tries again, and nothing starts", async () => {
  const f = await fixture();
  await f.command({ action: "up", project: "shop", target: "working" });
  f.processes.clear();
  f.host.session = REBOOTED;
  f.reopen();
  f.fail.withhold = () =>
    new RigError("ROUTE_RELOAD", "The proxy did not answer.", "Check it.");
  await f.reconcile();
  const unrecorded = async () =>
    (await f.target("working")).services?.web?.outcome;
  expect(await unrecorded()).toBeUndefined();
  await f.supervise();
  expect(await unrecorded()).toBeUndefined();
  expect(f.processes.size).toBe(0);
  await expect(
    f.command({ action: "up", project: "shop", target: "working" }),
  ).rejects.toMatchObject({
    code: "STATE_WRITE",
    hint: expect.stringContaining("a route could not be withheld"),
  });

  delete f.fail.withhold;
  await f.supervise();
  expect(await unrecorded()).toMatchObject({ hostRestart: "reboot" });
  expect(await f.livePorts("working")).toEqual([]);
  expect(f.processes.size).toBe(0);
});

test("a Service that survived a new login keeps its route after the Host restart", async () => {
  const f = await fixture();
  await f.command({ action: "up", project: "shop", target: "working" });
  f.host.session = { ...f.host.session, login: "100099" };
  f.reopen();
  await f.reconcile();
  expect((await f.target("working")).services?.web?.outcome).toBeUndefined();
  expect(await f.livePorts("working")).toEqual([WEB]);
});

// Builds left running (#705)

const leftover = async (f: World, kind: Kind) => {
  const key = preparationProcessKey(await f.target(kind));
  f.processes.set(key, { state: "running", pid: 9001 });
  return key;
};

test("the first pass stops a build a dead rigd left running for every Target: meant to run, stopped, or mid-transition", async () => {
  const f = await fixture();
  await f.command({ action: "up", project: "shop", target: "working" });
  await f.command({ action: "deploy", project: "shop", target: "stable" });
  await f.preview();
  await f.command({
    action: "down",
    project: "shop",
    target: "preview",
    branch: "feature",
  });
  await f.store.update((state) => {
    const stable = state.targets.find((t) => t.kind === "stable")!;
    stable.recovery = {
      plan: stable.plan,
      desired: "running",
      stage: "pending",
    };
  });
  const keys = await Promise.all(
    (["working", "stable", "preview"] as const).map((kind) =>
      leftover(f, kind),
    ),
  );
  f.reopen();
  await f.reconcile();
  for (const key of keys) expect(f.processes.has(key)).toBe(false);
  expect(await f.pids("working")).toHaveLength(2);
  // The transition is still there for rig down to settle.
  expect((await f.target("stable")).recovery).toBeDefined();
});

test("rig status lists a build left running until it is stopped, and a build that cannot be stopped does not hold up the Target's pass", async () => {
  const f = await fixture();
  await f.command({ action: "up", project: "shop", target: "working" });
  const key = await leftover(f, "working");
  f.reopen();
  f.fail.stop = {
    suffix: ":preparation:run",
    error: () => new Error("the group did not end"),
  };
  await f.reconcile();
  expect(f.processes.has(key)).toBe(true);

  const shown = await f.status("working");
  expect(shown.report.leftoverBuild).toBe(true);
  expect(shown.warnings).toContainEqual(
    expect.stringContaining(
      "working: a build an earlier rigd started is still running",
    ),
  );
  expect(shown.warnings).toContainEqual(
    expect.stringContaining("rig down working"),
  );

  // The Target's Services are still supervised: one that ended is recorded.
  f.processes.delete(`${(await f.target("working")).id}:web`);
  await f.supervise();
  expect((await f.target("working")).services?.web?.outcome).toBeDefined();

  delete f.fail.stop;
  await f.command({ action: "down", project: "shop", target: "working" });
  const after = await f.status("working");
  expect(after.report.leftoverBuild).toBeUndefined();
  expect(after.warnings.join()).not.toContain("a build an earlier rigd");
});

test("a build whose observation is uncertain is said to be uncertain, not running", async () => {
  const f = await fixture();
  await f.command({ action: "up", project: "shop", target: "working" });
  f.deps.lifecycle.observePreparation = async () => ({
    state: "unknown",
    reason: "Process ownership could not be verified.",
  });
  const shown = await f.status("working");
  expect(shown.report.leftoverBuild).toBeUndefined();
  expect(shown.warnings.join()).not.toContain("is still running (");
  expect(shown.warnings).toContainEqual(
    expect.stringContaining(
      "working: whether a build an earlier rigd started is still running could not be established (Process ownership could not be verified.).",
    ),
  );
});

test("status observes Services and builds under one deadline, whichever of them stalls", async () => {
  const f = await fixture();
  await f.command({ action: "up", project: "shop", target: "working" });
  let deadlines = 0;
  let expire = () => {};
  const scheduled = new Promise<void>((resolve) => {
    f.deps.observationDeadline = {
      schedule(_ms, expiry) {
        deadlines++;
        expire = expiry;
        resolve();
        return () => {};
      },
    };
  });
  f.deps.observations.process = () => new Promise(() => {});
  f.deps.lifecycle.observePreparation = () => new Promise(() => {});
  const status = f.status("working");
  await scheduled;
  // One expiry ends all of it.
  expire();
  const shown = await status;
  expect(deadlines).toBe(1);
  expect(shown.report.leftoverBuild).toBeUndefined();
  expect(shown.warnings).toContainEqual(
    expect.stringContaining("could not be established"),
  );
});

test("rig status does not call this rigd's own build a leftover", async () => {
  const f = await fixture(
    shop({
      services: {
        web: {
          command: "web",
          restart: "always",
          ports: { http: WEB },
          build: "true",
        },
        api: { command: "api", restart: "no", ports: { http: API } },
      },
    }),
  );
  let release = () => {};
  const running = new Promise<void>((resolve) => {
    f.build.running = resolve;
  });
  f.build.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const up = f.command({ action: "up", project: "shop", target: "working" });
  await running;
  const during = await f.status("working");
  expect(during.report.leftoverBuild).toBeUndefined();
  release();
  await up;
});

// A restart attempt rigd's shutdown cut short (#314)

test("an automatic restart attempt rigd's shutdown interrupted is not recorded as a failed attempt; the next daemon decides from how the process ended", async () => {
  const f = await fixture();
  await f.command({ action: "up", project: "shop", target: "working" });
  const id = (await f.target("working")).id;
  // web exits with code 1 and its attempt is due.
  const before = (await f.target("working")).services!.web!;
  f.processes.set(`${id}:web`, {
    state: "stopped",
    incarnation: before.incarnation!,
    exitCode: 1,
  });
  await f.supervise();
  f.world.clock.ms += 1000;
  f.fail.start = () => stopDetached({ key: `${id}:web` });
  await f.supervise();

  const run = (await f.target("working")).services!.web!;
  // Nothing settles the attempt: it was journalled, and spent as a crash would leave it.
  expect(run.incarnation).not.toBe(before.incarnation);
  expect(run.attempts).toHaveLength(1);
  expect(run.outcome).toBeUndefined();
  expect((await f.activity("restart")).join()).not.toContain("STOP_DETACHED");

  // The next daemon observes how it ended, and goes on as after any exit.
  delete f.fail.start;
  f.reopen();
  await f.reconcile();
  expect((await f.target("working")).services!.web!.outcome).toMatchObject({
    kind: "unknown",
  });
});

test("a health restart rigd's shutdown interrupted records no failure, and stays owned by the health back-off", async () => {
  const f = await fixture(
    shop({
      services: {
        web: {
          command: "web",
          restart: "no",
          ports: { http: WEB },
          healthcheck: { test: "true", on_failure: "restart" },
        },
        api: { command: "api", restart: "no", ports: { http: API } },
      },
    }),
  );
  await f.command({ action: "up", project: "shop", target: "working" });
  const target = await f.target("working");
  const web = target.plan.components.find((c) => c.name === "web")!;
  const run = target.services!.web!;
  const request = {
    targetId: target.id,
    service: "web",
    incarnation: run.incarnation!,
    check: checkIdentity(web as Parameters<typeof checkIdentity>[0]),
    attempt: 1,
    failures: 3,
    since: Date.now(),
    restarts: [],
  };
  // In the stop half, then in the start half.
  f.fail.stop = {
    suffix: ":web",
    error: () => stopDetached({ key: `${target.id}:web` }),
  };
  expect(await f.restartUnhealthy(request)).toEqual({ outcome: "deferred" });
  delete f.fail.stop;
  f.fail.start = () => stopDetached({ key: `${target.id}:web` });
  expect(await f.restartUnhealthy(request)).toEqual({ outcome: "deferred" });
  expect(await f.activity("health-restart")).toEqual([]);
  expect(
    (await f.target("working")).services!.web!.healthStretch?.pendingStart,
  ).toEqual(expect.any(Number));
});
