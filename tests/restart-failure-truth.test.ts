import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseProjectConfig, readProjectConfig } from "../src/config";
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
    /** The preparation at the head of a start throws this. */
    prepare?: () => unknown;
  } = {};
  /** How many withholds have reached the effects. */
  const withholds = { count: 0 };
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
      async prepare(target, composed) {
        if (fail.prepare) throw fail.prepare();
        await effects.prepare(target, composed);
      },
      async withhold(target, ports) {
        withholds.count++;
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
    withholds,
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

test("a deploy whose env file holds a value Rig refuses is refused before anything stops, since its rollback could not start either", async () => {
  const f = await fixture();
  const file = join(f.world.root, "web.env");
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
  await f.command({ action: "deploy", project: "shop", target: "stable" });
  const pids = await f.pids("stable");
  await writeFile(file, "A=1\0\n");
  f.events.length = 0;
  await expect(
    f.command({
      action: "deploy",
      project: "shop",
      target: "stable",
      force: true,
    }),
  ).rejects.toMatchObject({ code: "ENV_VALUE" });
  expect(f.events).toEqual([]);
  expect(await f.pids("stable")).toEqual(pids);
  expect(await f.livePorts("stable")).toEqual([WEB]);
});

/** A fixture whose Project reads `config` from now on. */
async function fixtureReading(make: (root: string) => ProjectConfig) {
  const f = await fixture();
  const config = make(f.world.root);
  const read = f.deps.documents.read;
  f.deps.documents.read = async (path) => ({
    ...(await read.call(f.deps.documents, path)),
    config,
  });
  return f;
}

test.each([
  [
    "cannot be parsed",
    "ENV_FILE",
    (file: string) => writeFile(file, "not an assignment\n"),
  ],
  ["is missing", "ENV_FILE_MISSING", (file: string) => rm(file)],
  [
    "contradicts a command",
    "ENV_CONFLICT",
    (file: string) => writeFile(file, "MODE=other\n"),
  ],
] as const)(
  "a deploy whose env file %s is refused as that before anything stops, with the previous Deployment still running",
  async (_why, code, refuse) => {
    const f = await fixtureReading((root) =>
      shop({
        environment: { MODE: "live" },
        services: {
          web: {
            command: "web ${environment.MODE}",
            restart: "always",
            ports: { http: WEB },
            env_file: join(root, "web.env"),
          },
          api: { command: "api", restart: "no", ports: { http: API } },
        },
      }),
    );
    const file = join(f.world.root, "web.env");
    await writeFile(file, "A=1\n");
    await f.command({ action: "deploy", project: "shop", target: "stable" });
    const pids = await f.pids("stable");
    const before = await f.target("stable");
    await refuse(file);
    f.events.length = 0;
    await expect(
      f.command({
        action: "deploy",
        project: "shop",
        target: "stable",
        force: true,
      }),
    ).rejects.toMatchObject({ code });
    expect(f.events).toEqual([]);
    expect(await f.pids("stable")).toEqual(pids);
    expect(await f.livePorts("stable")).toEqual([WEB]);
    const after = await f.target("stable");
    expect(after.desired).toBe("running");
    expect(after.recovery).toBeUndefined();
    expect(after.services).toEqual(before.services);
  },
);

test("a deploy goes on when its own build writes the env file a Service reads, since every build has run by the check", async () => {
  const f = await fixtureReading((root) =>
    shop({
      build: `echo A=1 > ${join(root, "generated.env")}`,
      services: {
        web: {
          command: "web",
          restart: "always",
          ports: { http: WEB },
          env_file: join(root, "generated.env"),
        },
        api: { command: "api", restart: "no", ports: { http: API } },
      },
    }),
  );
  await f.command({ action: "deploy", project: "shop", target: "stable" });
  await rm(join(f.world.root, "generated.env"));
  f.events.length = 0;
  await f.command({
    action: "deploy",
    project: "shop",
    target: "stable",
    force: true,
  });
  expect(f.events).toEqual(["stop api", "stop web", "start web", "start api"]);
});

// A rig.yaml refused for its bytes (#754)

test("a rig.yaml that starts being refused for its bytes stops nothing: the working Target's restart and a deploy are refused, status and doctor say why, and recorded plans go on", async () => {
  const f = await fixture();
  const path = join(f.world.repo, "rig.yaml");
  const valid = [
    "name: shop",
    "domain: shop.test",
    'proxy: { "/": "${services.web.ports.http}" }',
    "services:",
    `  web: { command: web, restart: always, ports: { http: ${WEB} } }`,
    `  api: { command: api, restart: "no", ports: { http: ${API} } }`,
    "targets:",
    "  working: { domain: dev.shop.test }",
    "  stable: true",
    "",
  ].join("\n");
  const refused = Buffer.concat([
    Buffer.from(valid),
    Buffer.from("environment: { LABEL: caf\xe9 }\n", "latin1"),
  ]);
  await writeFile(path, valid);
  f.deps.documents.read = readProjectConfig;
  let committed: string | Buffer = valid;
  const prepare = f.deps.sources.prepare;
  f.deps.sources.prepare = async (request) => {
    const prepared = await prepare.call(f.deps.sources, request);
    await writeFile(join(request.destination, "rig.yaml"), committed);
    return prepared;
  };
  await f.command({ action: "up", project: "shop", target: "working" });
  await f.command({ action: "deploy", project: "shop", target: "stable" });
  const stable = await f.pids("stable");

  await refusedWithEverythingRunning(
    f,
    "working",
    () => writeFile(path, refused),
    "invalid_yaml",
  );
  const { warnings } = await f.status("working");
  expect(warnings.join()).toContain("not valid UTF-8 on line 10");
  const report = (await f.command({
    action: "doctor",
    project: "shop",
  })) as { checks: { name: string; reason?: string; message: string }[] };
  expect(
    report.checks.find((check) => check.name === "project-config"),
  ).toMatchObject({
    reason: "config-invalid",
    message: expect.stringContaining("not valid UTF-8 on line 10"),
  });

  // A Commit whose own rig.yaml is refused never gets to stop what runs.
  committed = refused;
  f.events.length = 0;
  await expect(
    f.command({
      action: "deploy",
      project: "shop",
      target: "stable",
      force: true,
    }),
  ).rejects.toMatchObject({ code: "invalid_yaml" });
  expect(f.events).toEqual([]);
  expect(await f.pids("stable")).toEqual(stable);

  // The stable Target restarts from its recorded plan, and the working Target can still be stopped.
  await f.command({ action: "restart", project: "shop", target: "stable" });
  expect(await f.pids("stable")).toHaveLength(2);
  await f.command({ action: "down", project: "shop", target: "working" });
  expect((await f.target("working")).desired).toBe("stopped");
});

test.each([
  ["a NUL", Buffer.from("TOKEN=v\0\n")],
  ["invalid UTF-8", Buffer.from([0x54, 0x3d, 0xff, 0x0a])],
  ["__proto__", Buffer.from("__proto__=v\n")],
])(
  "a working Target's restart with a build is refused before anything stops when a Service's env file holds %s, in whichever file",
  async (_kind, content) => {
    const f = await fixtureReading((root) =>
      shop({
        build: "true",
        services: {
          web: {
            command: "web",
            restart: "always",
            ports: { http: WEB },
            // The build may still write the first; that it is missing must not hide the second.
            env_file: [join(root, "generated.env"), join(root, "web.env")],
          },
          api: { command: "api", restart: "no", ports: { http: API } },
        },
      }),
    );
    const generated = join(f.world.root, "generated.env");
    const file = join(f.world.root, "web.env");
    await writeFile(generated, "A=1\n");
    await writeFile(file, "B=2\n");
    await f.command({ action: "up", project: "shop", target: "working" });
    await refusedWithEverythingRunning(
      f,
      "working",
      () => writeFile(file, content),
      "ENV_VALUE",
    );
    await rm(generated);
    await refusedWithEverythingRunning(f, "working", () => {}, "ENV_VALUE");
  },
);

test.each([
  ["on its own line", "crash", "# caf\xe9\nTOKEN=exact\n"],
  ["on its own line", "Host restart", "# caf\xe9\nTOKEN=exact\n"],
  ["after a value", "crash", "TOKEN=exact # caf\xe9\n"],
  ["after a value", "Host restart", "TOKEN=exact # caf\xe9\n"],
] as const)(
  "a stable Target whose env file has invalid bytes only in a comment %s starts again after a %s, and a restart goes on",
  async (_where, cause, comment) => {
    const f = await fixtureReading((root) =>
      shop({
        services: {
          web: {
            command: "web",
            restart: "always",
            ports: { http: WEB },
            env_file: join(root, "web.env"),
          },
          api: { command: "api", restart: "no", ports: { http: API } },
        },
      }),
    );
    const file = join(f.world.root, "web.env");
    await writeFile(file, "# cafe\nTOKEN=exact\n");
    await f.command({ action: "deploy", project: "shop", target: "stable" });
    const content = Buffer.from(comment, "latin1");
    await writeFile(file, content);
    const key = `${(await f.target("stable")).id}:web`;
    f.events.length = 0;
    if (cause === "crash") {
      f.processes.set(key, {
        state: "stopped",
        incarnation: f.processes.get(key)!.incarnation!,
        exitCode: 1,
      });
      await f.supervise();
      f.world.clock.ms += 1000;
      await f.supervise();
    } else {
      f.processes.clear();
      f.host.session = REBOOTED;
      f.reopen();
      await f.reconcile();
    }
    expect(f.events).toContain("start web");
    expect(f.processes.get(key)?.state).toBe("running");

    await f.command({ action: "restart", project: "shop", target: "stable" });
    expect(f.processes.get(key)?.state).toBe("running");
    expect(await readFile(file)).toEqual(content);
  },
);

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

test("a restart is refused before anything stops when the first build's working_dir is missing, since nothing could make it first", async () => {
  const f = await fixture(
    shop({
      services: {
        web: {
          command: "web",
          restart: "always",
          ports: { http: WEB },
          working_dir: "app",
          build: "true",
        },
        api: { command: "api", restart: "no", ports: { http: API } },
      },
    }),
  );
  const directory = join(f.world.repo, "app");
  await mkdir(directory);
  await f.command({ action: "up", project: "shop", target: "working" });
  await refusedWithEverythingRunning(
    f,
    "working",
    () => rm(directory, { recursive: true }),
    "WORKING_DIR_MISSING",
  );
});

test("a restart goes on when an earlier build can make a later build's missing working_dir", async () => {
  const f = await fixture(
    shop({
      build: "mkdir -p app",
      services: {
        web: {
          command: "web",
          restart: "always",
          ports: { http: WEB },
          working_dir: "app",
          build: "true",
        },
        api: { command: "api", restart: "no", ports: { http: API } },
      },
    }),
  );
  await f.command({ action: "up", project: "shop", target: "working" });
  await rm(join(f.world.repo, "app"), { recursive: true });
  f.events.length = 0;
  await f.command({ action: "restart", project: "shop", target: "working" });
  expect(f.events).toEqual(["stop api", "stop web", "start web", "start api"]);
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

test("a stable Target whose start after a Host restart fails keeps no path to a port nothing owns, however early it failed", async () => {
  const refused = () =>
    new RigError("PREPARE_FAILED", "The disk said no.", "Check it.");
  for (const failing of ["prepare", "start"] as const) {
    const f = await fixture();
    await f.command({ action: "deploy", project: "shop", target: "stable" });
    expect(await f.livePorts("stable")).toEqual([WEB]);
    f.processes.clear();
    f.host.session = REBOOTED;
    f.fail[failing] = refused;
    f.reopen();
    await f.reconcile();

    expect(f.processes.size).toBe(0);
    expect(await f.livePorts("stable")).toEqual([]);
    expect((await f.target("stable")).services?.web?.outcome).toMatchObject({
      kind: "start-failed",
    });

    // Its next start publishes them again.
    delete f.fail[failing];
    await f.command({ action: "up", project: "shop", target: "stable" });
    expect(await f.livePorts("stable")).toEqual([WEB]);
  }
});

/** A stable Service left running through a new login, whose start then fails while its state is `first`; `settle` makes its
 * state known again. */
async function failedStartWhileUncertain(first: "unknown" | "unanswered") {
  const f = await fixture();
  await f.command({ action: "deploy", project: "shop", target: "stable" });
  const pids = await f.pids("stable");
  f.withholds.count = 0;
  f.host.session = { ...f.host.session, login: "100099" };
  f.fail.prepare = () =>
    new RigError("PREPARE_FAILED", "The disk said no.", "Check it.");
  const observe = f.deps.observations.process;
  const deadline = f.deps.observationDeadline;
  f.deps.observations.process = async () =>
    first === "unknown" ? { state: "unknown" } : new Promise(() => {});
  if (first === "unanswered")
    f.deps.observationDeadline = {
      schedule(_ms, expiry) {
        setTimeout(expiry, 0);
        return () => {};
      },
    };
  f.reopen();
  await f.reconcile();
  expect(await f.pids("stable")).toEqual(pids);
  expect(f.withholds.count).toBe(0);
  expect(await f.livePorts("stable")).toEqual([WEB]);
  return {
    f,
    pids,
    settle() {
      f.deps.observations.process = observe;
      f.deps.observationDeadline = deadline;
      delete f.fail.prepare;
    },
  };
}

test.each(["unknown", "unanswered"] as const)(
  "a stable Service %s when its start fails after a new login keeps its paths until a pass sees it stopped",
  async (first) => {
    const { f, settle } = await failedStartWhileUncertain(first);
    // Still uncertain: the next pass looks again and leaves the paths as they are.
    await f.supervise();
    expect(await f.livePorts("stable")).toEqual([WEB]);

    settle();
    f.processes.delete(`${(await f.target("stable")).id}:web`);
    await f.supervise();
    expect(await f.livePorts("stable")).toEqual([]);
  },
);

test.each(["unknown", "unanswered"] as const)(
  "a stable Service %s when its start fails after a new login, then seen running, has a later exit handled as any crash",
  async (first) => {
    const { f, settle } = await failedStartWhileUncertain(first);
    settle();
    await f.supervise();
    const target = await f.target("stable");
    const key = `${target.id}:web`;
    const run = target.services!.web!;
    expect(run.outcome).toBeUndefined();

    f.processes.set(key, {
      state: "stopped",
      incarnation: run.incarnation!,
      exitCode: 1,
    });
    await f.supervise();
    expect(await f.livePorts("stable")).toEqual([]);
    expect((await f.target("stable")).services?.web?.outcome).toMatchObject({
      kind: "exited",
    });
    // restart: always takes it from here, and its verified start publishes its paths again.
    f.world.clock.ms += 1000;
    await f.supervise();
    expect(f.processes.get(key)?.state).toBe("running");
    expect(await f.livePorts("stable")).toEqual([WEB]);
  },
);

test("a Service whose record keeps it stopped has its paths withheld once when it stops, however long it ran with that record", async () => {
  const f = await fixture();
  await f.command({ action: "deploy", project: "shop", target: "stable" });
  const { id } = await f.target("stable");
  await f.store.update((state) => {
    const stable = state.targets.find((target) => target.id === id)!;
    stable.services!.web = {
      ...stable.services!.web!,
      outcome: {
        kind: "activation-failed",
        errorCode: "HEALTH_FAILED",
        at: "2026-11-03T08:00:00.000Z",
      },
    };
  });
  f.withholds.count = 0;
  f.reopen();
  await f.reconcile();
  await f.supervise();
  expect(await f.livePorts("stable")).toEqual([WEB]);
  expect(f.withholds.count).toBe(0);

  f.processes.delete(`${id}:web`);
  await f.supervise();
  await f.supervise();
  expect(await f.livePorts("stable")).toEqual([]);
  expect(f.withholds.count).toBe(1);
});

test.each(["unknown", "unanswered"] as const)(
  "a stable Service %s when its start fails after a new login, then seen running, keeps its paths",
  async (first) => {
    const { f, pids, settle } = await failedStartWhileUncertain(first);
    settle();
    await f.supervise();
    await f.supervise();
    expect(await f.pids("stable")).toEqual(pids);
    expect(f.withholds.count).toBe(0);
    expect(await f.livePorts("stable")).toEqual([WEB]);
  },
);

describe.each(["working", "preview"] as const)(
  "a %s Service whose state is uncertain after a new login",
  (kind) => {
    test.each([
      ["unknown", "running"],
      ["unknown", "stopped"],
      ["unanswered", "running"],
      ["unanswered", "stopped"],
    ] as const)(
      "%s, later seen %s, keeps its paths until a pass sees it stopped",
      async (uncertain, later) => {
        const f = await fixture();
        if (kind === "working")
          await f.command({ action: "up", project: "shop", target: kind });
        else await f.preview();
        const pids = await f.pids(kind);
        f.host.session = { ...f.host.session, login: "100099" };
        const observe = f.deps.observations.process;
        const deadline = f.deps.observationDeadline;
        f.deps.observations.process = async () =>
          uncertain === "unknown"
            ? { state: "unknown" }
            : new Promise(() => {});
        if (uncertain === "unanswered")
          f.deps.observationDeadline = {
            schedule(_ms, expiry) {
              setTimeout(expiry, 0);
              return () => {};
            },
          };
        f.reopen();
        await f.reconcile();
        expect(await f.pids(kind)).toEqual(pids);
        expect(await f.livePorts(kind)).toEqual([WEB]);

        f.deps.observations.process = observe;
        f.deps.observationDeadline = deadline;
        if (later === "stopped")
          f.processes.delete(`${(await f.target(kind)).id}:web`);
        await f.supervise();
        await f.supervise();
        expect(await f.livePorts(kind)).toEqual(
          later === "running" ? [WEB] : [],
        );
      },
    );
  },
);

test("while a stable Target's route cannot be withheld its failed start after a Host restart is not recorded, each pass tries again, and nothing starts", async () => {
  const f = await fixture();
  await f.command({ action: "deploy", project: "shop", target: "stable" });
  f.processes.clear();
  f.host.session = REBOOTED;
  f.fail.prepare = () =>
    new RigError("PREPARE_FAILED", "The disk said no.", "Check it.");
  f.fail.withhold = () =>
    new RigError("ROUTE_RELOAD", "The proxy did not answer.", "Check it.");
  f.reopen();
  await f.reconcile();
  const outcome = async () => (await f.target("stable")).services?.web?.outcome;
  expect(await outcome()).toBeUndefined();
  await f.supervise();
  expect(await outcome()).toBeUndefined();
  expect(await f.livePorts("stable")).toEqual([WEB]);

  delete f.fail.withhold;
  await f.supervise();
  expect(await outcome()).toMatchObject({ kind: "start-failed" });
  expect(await f.livePorts("stable")).toEqual([]);
  expect(f.processes.size).toBe(0);
});

/** A stable Target an earlier rigd settled for the reboot: its start recorded as failed, its paths still published. */
async function settledByAnEarlierRigd() {
  const f = await fixture();
  await f.command({ action: "deploy", project: "shop", target: "stable" });
  f.processes.clear();
  f.host.session = REBOOTED;
  const id = (await f.target("stable")).id;
  await f.store.update((state) => {
    const stable = state.targets.find((target) => target.id === id)!;
    stable.services = Object.fromEntries(
      Object.entries(stable.services ?? {}).map(([service, run]) => [
        service,
        {
          ...run,
          outcome: {
            kind: "start-failed" as const,
            errorCode: "HEALTH_FAILED",
            at: "2026-11-03T08:00:00.000Z",
          },
        },
      ]),
    );
    state.host!.restart = {
      kind: "reboot",
      boot: REBOOTED.boot,
      login: REBOOTED.login,
      seq: state.startSeq ?? 0,
      settled: [id],
    };
  });
  return f;
}

test("paths an earlier rigd left published to a stable Target's stopped Services go with the next daemon's first pass, not its next rig up", async () => {
  const f = await settledByAnEarlierRigd();
  expect(await f.livePorts("stable")).toEqual([WEB]);
  f.reopen();
  await f.reconcile();
  expect(await f.livePorts("stable")).toEqual([]);
  expect(f.processes.size).toBe(0);
  await f.command({ action: "up", project: "shop", target: "stable" });
  expect(await f.livePorts("stable")).toEqual([WEB]);
});

test("paths the first pass could not withhold from stopped Services are withheld by a later pass once the proxy answers", async () => {
  const f = await settledByAnEarlierRigd();
  f.fail.withhold = () =>
    new RigError("ROUTE_RELOAD", "The proxy did not answer.", "Check it.");
  f.reopen();
  await f.reconcile();
  expect(await f.livePorts("stable")).toEqual([WEB]);
  delete f.fail.withhold;
  await f.supervise();
  expect(await f.livePorts("stable")).toEqual([]);
});

test.each(["unknown", "unanswered"] as const)(
  "a Service %s on the first pass has its paths withheld by the pass that sees it stopped, and is not asked about again",
  async (first) => {
    const f = await settledByAnEarlierRigd();
    const observe = f.deps.observations.process;
    const deadline = f.deps.observationDeadline;
    f.deps.observations.process = async () =>
      first === "unknown" ? { state: "unknown" } : new Promise(() => {});
    if (first === "unanswered")
      f.deps.observationDeadline = {
        schedule(_ms, expiry) {
          setTimeout(expiry, 0);
          return () => {};
        },
      };
    f.reopen();
    await f.reconcile();
    expect(await f.livePorts("stable")).toEqual([WEB]);
    expect(f.withholds.count).toBe(0);

    f.deps.observations.process = observe;
    f.deps.observationDeadline = deadline;
    await f.supervise();
    expect(await f.livePorts("stable")).toEqual([]);
    expect(f.withholds.count).toBe(1);
    await f.supervise();
    expect(f.withholds.count).toBe(1);
  },
);

test("the diagnostic log says when a Service's state cannot be established, naming it, and when it can, not at every pass", async () => {
  const f = await settledByAnEarlierRigd();
  const observe = f.deps.observations.process;
  const said: { outcome: string; evidence?: string }[] = [];
  f.deps.diagnostic = async ({ outcome, evidence }) => {
    if (outcome.startsWith("routes-")) said.push({ outcome, evidence });
  };
  f.deps.observations.process = async () => ({ state: "unknown" });
  f.reopen();
  await f.reconcile();
  for (let pass = 0; pass < 5; pass++) await f.supervise();
  expect(said).toEqual([
    {
      outcome: "routes-unchecked",
      evidence: expect.stringContaining("Whether web still run"),
    },
  ]);

  f.deps.observations.process = observe;
  for (let pass = 0; pass < 3; pass++) await f.supervise();
  expect(said.at(-1)).toEqual({ outcome: "routes-checked" });
  expect(said).toHaveLength(2);
  expect(await f.livePorts("stable")).toEqual([]);
});

test("a daemon's first pass leaves the paths of a running Service published", async () => {
  const f = await fixture();
  await f.command({ action: "deploy", project: "shop", target: "stable" });
  f.withholds.count = 0;
  f.reopen();
  await f.reconcile();
  expect(f.withholds.count).toBe(0);
  expect(await f.livePorts("stable")).toEqual([WEB]);
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

// rigd uninstall (#678)

test("rigd uninstall is refused for a Service whose process cannot be ruled out, naming it and how to stop it", async () => {
  const f = await fixture();
  await f.command({ action: "up", project: "shop", target: "working" });
  await f.command({ action: "down", project: "shop", target: "working" });
  const stopped = await f.target("working");
  f.processes.set(`${stopped.id}:api`, { state: "unknown" });
  await expect(
    f.command({ action: "prepare-uninstall" }),
  ).rejects.toMatchObject({
    code: "TARGETS_RUNNING",
    message: expect.stringContaining("shop working (api is unknown)"),
    hint: expect.stringContaining("rig down working --project shop"),
  });
  await f.command({ action: "cancel-uninstall" });
  f.processes.clear();
  expect(await f.command({ action: "prepare-uninstall" })).toEqual({
    ready: true,
  });
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
