import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { releaseUnreferencedRevisions } from "../src/runtime/revisions";
import { parseProjectConfig } from "../src/config";
import type { ProjectConfig } from "../src/config/types";
import type {
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import type { ServiceRun, TargetRecord } from "../src/domain/runtime";
import {
  preparedBuild,
  serviceDefinition,
} from "../src/domain/service-definition";
import { runtimeWorld } from "./support/runtime-world";
import { localActivation } from "./support/activation-doubles";

/** ADR 0016 through the real runtime, lifecycle and state file, over a scripted supervisor and scripted deployment sources:
 * what a start records, which Services a deploy keeps running, and when a checkout a kept process runs in is given back. */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** Melody's shape: db (Postgres via a script in the repository), search (Typesense, an absolute binary), api on both, and
 * web on api. */
function melody(services: Record<string, Record<string, unknown>> = {}) {
  return parseProjectConfig({
    name: "melody",
    environment: { PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
    services: {
      db: { command: "sh scripts/rig-postgres.sh", ...services.db },
      search: {
        command: "/opt/typesense/bin/typesense-server",
        ...services.search,
      },
      api: {
        command: "node api.js",
        depends_on: ["db", "search"],
        // Its own hostname (ADR 0015), routed to its one port.
        ports: { http: 4000 },
        domain: "api.melody.test",
        ...services.api,
      },
      web: { command: "node web.js", depends_on: ["api"], ...services.web },
    },
    targets: { working: true, stable: true },
  });
}

async function fixture(
  config: ProjectConfig = melody(),
  wrapEffects?: Parameters<typeof runtimeWorld>[0]["wrapEffects"],
) {
  const processes = new Map<string, ProcessObservation>();
  /** Process keys whose observation cannot be made. */
  const unobservable = new Set<string>();
  /** Services the health monitor reports unhealthy. */
  const unhealthy = new Set<string>();
  /** Called before a running process is stopped. */
  const hooks: {
    beforeStop?: (key: string) => Promise<void>;
    /** Awaited before each observation of a process. */
    beforeObserve?: (key: string) => Promise<void>;
  } = {};
  /** Services whose next spawn fails, once. */
  const failStarts = new Set<string>();
  let pid = 5000;
  /** Every spawn and stop, by Service name, in order. */
  const events: string[] = [];
  const supervisor: Supervisor = {
    async observe(key) {
      await hooks.beforeObserve?.(key);
      if (unobservable.has(key))
        return { state: "unknown", reason: "lease unreadable" };
      return processes.get(key) ?? { state: "stopped" };
    },
    async ensureRunning(request) {
      if (processes.get(request.key)?.state === "running")
        return { outcome: "unchanged" };
      if (failStarts.delete(request.componentName))
        throw new Error(`${request.componentName} could not be spawned`);
      events.push(`start ${request.componentName}`);
      processes.set(request.key, {
        state: "running",
        pid: ++pid,
        incarnation: request.incarnation,
      });
      return { outcome: "started" };
    },
    async stop(key) {
      const running = processes.get(key)?.state === "running";
      if (running) await hooks.beforeStop?.(key);
      if (running) events.push(`stop ${key.split(":").at(-1)}`);
      processes.set(key, { state: "stopped" });
      return { outcome: running ? "stopped" : "unchanged" };
    },
    async shutdown() {},
    async detach() {},
  };
  /** The Commit the Production branch points at; a test moves it. */
  const git = {
    head: "c1",
    /** Whether `paths` (undefined: the whole tree) changed between two Commits. */
    changed: (_from: string, _to: string, _paths?: readonly string[]) => true,
    /** The tracked files a `watch` entry may name. */
    tracked: ["scripts/rig-postgres.sh"],
  };
  const released: string[] = [];
  const world = await runtimeWorld({
    name: "keep",
    ...(wrapEffects ? { wrapEffects } : {}),
    // api listens on its port at loopback, so its route can be published.
    activation: localActivation([4000]),
    config,
    supervisor: () => supervisor,
    startsAt: "2026-10-11T09:00:00.000Z",
    readinessDeadlineMs: 2000,
    dependencies: () => ({
      // The health monitor's cached results: the Services named here are unhealthy.
      healthResults: (_target: unknown, service: string) =>
        unhealthy.has(service)
          ? { status: "unhealthy", failures: 3, retries: 3, restarts: 0 }
          : undefined,
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
        async release({ workspacePath }: { workspacePath: string }) {
          released.push(workspacePath);
          await rm(workspacePath, { recursive: true, force: true });
        },
        async changed(request: {
          from: string;
          to: string;
          paths?: readonly string[];
        }) {
          if (request.paths?.length === 0) return false;
          return git.changed(request.from, request.to, request.paths);
        },
        async unmatched(request: { paths: readonly string[] }) {
          return request.paths.filter((path) => !git.tracked.includes(path));
        },
      } as unknown as RuntimeDependencies["sources"],
    }),
  });
  roots.push(world.root);
  const runtime = world.open();
  await runtime.command({ action: "init", repoPath: world.repo });
  const stable = async (): Promise<TargetRecord> =>
    (await world.store.read()).targets.find((t) => t.kind === "stable")!;
  const pids = async () => {
    const target = await stable();
    return Object.fromEntries(
      ["db", "search", "api", "web"].map((name) => [
        name,
        processes.get(`${target.id}:${name}`)?.pid,
      ]),
    );
  };
  const deploy = (extra: Record<string, unknown> = {}) =>
    runtime.command({
      action: "deploy",
      repoPath: world.repo,
      target: "stable",
      branch: "main",
      ...extra,
    }) as Promise<Record<string, unknown>>;
  return {
    world,
    runtime,
    processes,
    unobservable,
    unhealthy,
    hooks,
    failStarts,
    events,
    git,
    released,
    stable,
    pids,
    deploy,
    config,
  };
}

test("every start records where its process runs: the checkout, its Commit, the definition and a keyed environment digest", async () => {
  const f = await fixture();
  await f.deploy();
  const target = await f.stable();
  const run = target.services!.db as ServiceRun;
  const db = target.plan.components.find((c) => c.name === "db")!;
  expect(run.source).toEqual({
    checkout: target.plan.workspacePath,
    commit: "c1",
    definition: serviceDefinition(
      target.plan,
      db as Parameters<typeof serviceDefinition>[1],
    ),
    environment: expect.stringMatching(/^[0-9a-f]{64}$/),
    build: preparedBuild(target, "db"),
  });
  expect(run.source!.build).toMatch(/^[0-9a-f]{64}$/);
  // The digest is what a start would record now, so an unchanged environment compares equal.
  expect(await f.world.deps.lifecycle.environmentDigest(target, "db")).toBe(
    run.source!.environment!,
  );
  // The working Target's starts record its checkout, the repository itself, without a Commit.
  await f.runtime.command({ action: "up", repoPath: f.world.repo });
  const working = (await f.world.store.read()).targets.find(
    (t) => t.kind === "working",
  )!;
  expect(working.services!.web!.source).toMatchObject({
    checkout: f.world.repo,
  });
  expect(working.services!.web!.source).not.toHaveProperty("commit");
});

/** Makes db's run say its process runs in `old`, an earlier checkout of the stable Target, as a kept Service's run does. */
async function runIn(f: Awaited<ReturnType<typeof fixture>>, old: string) {
  const target = await f.stable();
  await f.world.store.update((state) => {
    const saved = state.targets.find((t) => t.id === target.id)!;
    saved.services!.db!.source = {
      ...saved.services!.db!.source!,
      checkout: old,
    };
  });
  return { ...target, plan: { ...target.plan, workspacePath: old } };
}

test("a superseded checkout a Service process still runs in is held, not removed, and given back once the process is gone", async () => {
  const f = await fixture();
  await f.deploy();
  const target = await f.stable();
  const old = join(target.sourceRoot!, "earlier");
  await mkdir(old, { recursive: true });
  const earlier = await runIn(f, old);
  expect(await releaseUnreferencedRevisions([earlier], f.world.deps)).toEqual(
    [],
  );
  expect(f.released).toEqual([]);
  expect((await f.world.store.read()).heldCheckouts).toEqual([
    { target: target.id, project: target.projectId, workspace: old },
  ]);
  // The sweep offers it back while db runs: it stays held, and recorded.
  await f.runtime.releaseHeldCheckouts(target.id);
  expect(f.released).toEqual([]);
  // A process that cannot be observed may still run there: still held.
  f.unobservable.add(`${target.id}:db`);
  await f.runtime.releaseHeldCheckouts(target.id);
  expect(f.released).toEqual([]);
  expect((await f.world.store.read()).heldCheckouts).toHaveLength(1);
  // Once db's process is gone (a crash, a stop, or a restart from the current checkout), the sweep gives it back.
  f.unobservable.clear();
  f.processes.set(`${target.id}:db`, { state: "stopped" });
  await f.runtime.releaseHeldCheckouts(target.id);
  expect(f.released).toEqual([old]);
  expect((await f.world.store.read()).heldCheckouts).toEqual([]);
});

test("a process under the Service's key with another incarnation does not hold the checkout its old run named", async () => {
  const f = await fixture();
  await f.deploy();
  const target = await f.stable();
  const old = join(target.sourceRoot!, "earlier");
  const earlier = await runIn(f, old);
  f.processes.set(`${target.id}:db`, {
    state: "running",
    pid: 1,
    incarnation: "a later start",
  });
  expect(await releaseUnreferencedRevisions([earlier], f.world.deps)).toEqual(
    [],
  );
  expect(f.released).toEqual([old]);
  expect((await f.world.store.read()).heldCheckouts ?? []).toEqual([]);
});

/** A config edit committed with the next Commit: the Project's rig.yaml is read live, so the next deploy plans from it. */
function edit(
  config: ProjectConfig,
  service: string,
  settings: Record<string, unknown>,
) {
  Object.assign(config.services![service]!, settings);
}

test("a deploy whose Commit changed nothing a Service uses keeps every Service running in its checkout; the new Deployment adopts them", async () => {
  const f = await fixture();
  await f.deploy();
  const first = await f.stable();
  const before = await f.pids();
  f.events.length = 0;
  f.git.head = "c2";
  f.git.changed = () => false;
  const result = await f.deploy();
  expect(result).toMatchObject({
    outcome: "deployed",
    commit: "c2",
    previousCommit: "c1",
    kept: ["db", "search", "api", "web"],
    restarted: [],
  });
  expect(f.events).toEqual([]);
  expect(await f.pids()).toEqual(before);
  // A kept Service keeps its own hostname: the route map is republished from the new plan.
  const status = await f.runtime.status({ repoPath: f.world.repo });
  expect(
    status.targets
      .find((t) => t.name === "stable")!
      .components.find((c) => c.name === "api"),
  ).toMatchObject({
    hostnames: ["api.melody.test"],
    commit: "c1",
  });
  const second = await f.stable();
  expect(second.plan.workspacePath).not.toBe(first.plan.workspacePath);
  // Each run now belongs to the new Deployment, and still says where its process runs.
  for (const service of ["db", "search", "api", "web"])
    expect(second.services![service]).toEqual({
      ...first.services![service]!,
      deployment: second.plan.workspacePath,
    });
  // The earlier checkout stays on disk while they run in it, recorded for the sweep.
  expect(f.released).toEqual([]);
  expect((await f.world.store.read()).heldCheckouts).toEqual([
    {
      target: first.id,
      project: first.projectId,
      workspace: first.plan.workspacePath,
    },
  ]);
  expect((await f.world.store.read()).deployments?.at(-1)).toMatchObject({
    outcome: "deployed",
    commit: "c2",
    kept: ["db", "search", "api", "web"],
  });
});

test("a changed definition restarts that Service and every dependent, in dependency order, and leaves the rest running", async () => {
  const f = await fixture();
  await f.deploy();
  const before = await f.pids();
  f.events.length = 0;
  f.git.head = "c2";
  f.git.changed = () => false;
  edit(f.config, "db", { stop_timeout: "60s" });
  // Before the first stop, the pending candidate already owns the kept run, so a rigd that stops here knows its plans.
  let atFirstStop: TargetRecord | undefined;
  f.hooks.beforeStop = async () => {
    atFirstStop ??= await f.stable();
  };
  const result = await f.deploy();
  expect(atFirstStop!.recovery).toMatchObject({ stage: "pending" });
  expect(atFirstStop!.commit).toBe("c2");
  expect(atFirstStop!.services!.search).toMatchObject({
    deployment: atFirstStop!.plan.workspacePath,
    source: { commit: "c1" },
  });
  expect(result).toMatchObject({
    kept: ["search"],
    restarted: [
      { service: "db", reason: "definition" },
      { service: "api", reason: "dependency", dependency: "db" },
      { service: "web", reason: "dependency", dependency: "api" },
    ],
  });
  // Stopped in reverse dependency order, started in order; search was never touched.
  expect(f.events).toEqual([
    "stop web",
    "stop api",
    "stop db",
    "start db",
    "start api",
    "start web",
  ]);
  const after = await f.pids();
  expect(after.search).toBe(before.search);
  for (const service of ["db", "api", "web"])
    expect(after[service]).not.toBe(before[service]);
  const target = await f.stable();
  expect(target.services!.db!.source!.checkout).toBe(target.plan.workspacePath);
  expect(target.services!.search!.source!.checkout).not.toBe(
    target.plan.workspacePath,
  );
});

test("rig restart does not hide a changed build environment: a start carries the digest its checkout was prepared with", async () => {
  const config = parseProjectConfig({
    name: "melody",
    build: 'printf %s "$FLAVOR" > built.txt',
    services: { app: { command: "node app.js", watch: [] } },
    targets: { stable: true },
  });
  const f = await fixture(config);
  // A Project env file supplies FLAVOR to the shared build; app's own env file masks it for the process.
  const projectFile = join(f.world.root, "env", "melody", "all.env");
  const appFile = join(f.world.root, "env", "melody", "app", "all.env");
  await mkdir(join(appFile, ".."), { recursive: true });
  await writeFile(projectFile, "FLAVOR=v1\n");
  await writeFile(appFile, "FLAVOR=runtime\n");
  await f.deploy();
  const first = await f.stable();
  const built = first.services!.app!.source!.build;
  expect(built).toBeDefined();
  // The env file changes, and a restart starts app again from the same checkout, which still holds v1's output.
  await writeFile(projectFile, "FLAVOR=v2\n");
  await f.runtime.command({
    action: "restart",
    repoPath: f.world.repo,
    target: "stable",
  });
  const restarted = await f.stable();
  expect(
    await readFile(join(restarted.plan.workspacePath, "built.txt"), "utf8"),
  ).toBe("v1");
  expect(restarted.services!.app!.incarnation).not.toBe(
    first.services!.app!.incarnation,
  );
  expect(restarted.services!.app!.source!.build).toBe(built);
  // The next deploy builds v2 in its new checkout, so app restarts from it.
  f.git.head = "c2";
  f.git.changed = () => false;
  expect(await f.deploy()).toMatchObject({
    kept: [],
    restarted: [{ service: "app", reason: "definition" }],
  });
  const second = await f.stable();
  expect(
    await readFile(join(second.plan.workspacePath, "built.txt"), "utf8"),
  ).toBe("v2");
});

test("a build runs in the very environment its digest was taken of, even when an env file changes in between", async () => {
  const config = parseProjectConfig({
    name: "melody",
    build: 'printf %s "$FLAVOR" > built.txt',
    services: { app: { command: "node app.js", watch: [] } },
    targets: { stable: true },
  });
  let projectFile = "";
  let changeBetween = false;
  // Right after the shared build's environment is composed (and before it runs), the env file says v2.
  const f = await fixture(config, (effects) => ({
    ...effects,
    async buildEnvironment(unit, target) {
      const env = await effects.buildEnvironment!(unit, target);
      if (changeBetween && unit.id === "shared")
        await writeFile(projectFile, "FLAVOR=v2\n");
      return env;
    },
  }));
  projectFile = join(f.world.root, "env", "melody", "all.env");
  await mkdir(join(projectFile, ".."), { recursive: true });
  await writeFile(projectFile, "FLAVOR=v1\n");
  changeBetween = true;
  await f.deploy();
  const target = await f.stable();
  // The build ran in the environment that was composed (v1), not in one read again after the edit.
  expect(
    await readFile(join(target.plan.workspacePath, "built.txt"), "utf8"),
  ).toBe("v1");
  // And what was recorded describes v1: composing v1 again gives the same digest, v2 another.
  const recorded = target.preparation!.units.shared!.environment!;
  expect(await f.world.deps.lifecycle.environmentDigest(target)).not.toBe(
    recorded,
  );
  await writeFile(projectFile, "FLAVOR=v1\n");
  expect(await f.world.deps.lifecycle.environmentDigest(target)).toBe(recorded);
  expect(target.preparation!.environment).toBe(recorded);
});

test("a change to the Project environment the shared build runs in restarts a Service whose own environment masks it", async () => {
  const config = parseProjectConfig({
    name: "melody",
    environment: { FLAVOR: "v1" },
    build: 'printf %s "$FLAVOR" > built.txt',
    services: {
      app: {
        command: "node app.js",
        environment: { FLAVOR: "runtime" },
        watch: ["src"],
      },
    },
    targets: { stable: true },
  });
  const f = await fixture(config);
  f.git.tracked = ["src"];
  await f.deploy();
  const first = await f.stable();
  expect(
    await readFile(join(first.plan.workspacePath, "built.txt"), "utf8"),
  ).toBe("v1");
  f.git.head = "c2";
  f.git.changed = () => false;
  config.environment = { FLAVOR: "v2" };
  // app's own environment and the shared build's command are unchanged, but what the build wrote is not.
  expect(await f.deploy()).toMatchObject({
    kept: [],
    restarted: [{ service: "app", reason: "definition" }],
  });
  const second = await f.stable();
  expect(
    await readFile(join(second.plan.workspacePath, "built.txt"), "utf8"),
  ).toBe("v2");
  expect(second.services!.app!.source!.checkout).toBe(
    second.plan.workspacePath,
  );
  // An unchanged Project environment keeps it.
  f.git.head = "c3";
  expect(await f.deploy()).toMatchObject({ kept: ["app"] });
});

test("an env file whose contents changed restarts the Service that loads it, though nothing else changed", async () => {
  const f = await fixture();
  const file = join(f.world.root, "env", "melody", "search", "all.env");
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, "TYPESENSE_API_KEY=first\n");
  await f.deploy();
  f.git.head = "c2";
  f.git.changed = () => false;
  await writeFile(file, "TYPESENSE_API_KEY=rotated\n");
  expect(await f.deploy()).toMatchObject({
    kept: ["db"],
    restarted: [
      { service: "search", reason: "environment" },
      { service: "api", reason: "dependency", dependency: "search" },
      { service: "web", reason: "dependency", dependency: "api" },
    ],
  });
  // No value reaches the state file.
  expect(
    await readFile(join(f.world.root, "runtime", "state.json"), "utf8"),
  ).not.toContain("rotated");
});

test("a running but unhealthy Service is restarted by a deploy that changed nothing it uses", async () => {
  const f = await fixture();
  await f.deploy();
  f.git.head = "c2";
  f.git.changed = () => false;
  f.unhealthy.add("web");
  expect(await f.deploy()).toMatchObject({
    kept: ["db", "search", "api"],
    restarted: [{ service: "web", reason: "unhealthy" }],
  });
});

test("--force and --no-up keep nothing, and a deploy whose files changed restarts every Service that watches the whole checkout", async () => {
  const f = await fixture();
  await f.deploy();
  f.git.head = "c2";
  f.git.changed = () => false;
  expect(await f.deploy({ force: true })).toMatchObject({ kept: [] });
  f.git.head = "c3";
  expect(await f.deploy({ noUp: true })).toMatchObject({ kept: [] });
  expect((await f.stable()).desired).toBe("stopped");
  await f.runtime.command({
    action: "up",
    repoPath: f.world.repo,
    target: "stable",
  });
  f.git.head = "c4";
  f.git.changed = () => true;
  expect(await f.deploy()).toMatchObject({
    kept: [],
    restarted: [
      { service: "db", reason: "files" },
      { service: "search", reason: "files" },
      { service: "api", reason: "files" },
      { service: "web", reason: "files" },
    ],
  });
  // Nothing was kept, so no earlier checkout is held.
  expect((await f.world.store.read()).heldCheckouts ?? []).toEqual([]);
});

test("a failed deploy stops only what it started and restores the previous plan; a kept Service is never stopped", async () => {
  const f = await fixture();
  await f.deploy();
  const first = await f.stable();
  const before = await f.pids();
  f.git.head = "c2";
  f.git.changed = () => false;
  edit(f.config, "web", { command: "node web2.js" });
  f.failStarts.add("web");
  f.events.length = 0;
  await expect(f.deploy()).rejects.toThrow("web could not be spawned");
  // Only web was stopped, and the previous plan started it again; the rest kept running throughout.
  expect(f.events).toEqual(["stop web", "start web"]);
  const after = await f.pids();
  for (const service of ["db", "search", "api"])
    expect(after[service]).toBe(before[service]);
  const restored = await f.stable();
  expect(restored.commit).toBe("c1");
  expect(restored.plan.workspacePath).toBe(first.plan.workspacePath);
  for (const service of ["db", "search", "api"])
    expect(restored.services![service]).toEqual(first.services![service]);
  // The rejected candidate's checkout went; the previous one is the plan's again.
  expect((await f.world.store.read()).heldCheckouts ?? []).toEqual([]);
});

test("a kept Service that crashes later starts from the current checkout, and the earlier one is given back", async () => {
  const f = await fixture();
  await f.deploy();
  const first = await f.stable();
  f.git.head = "c2";
  f.git.changed = () => false;
  edit(f.config, "web", { command: "node web2.js" });
  expect(await f.deploy()).toMatchObject({
    kept: ["db", "search", "api"],
  });
  const target = await f.stable();
  // db exits; the next supervision pass starts it again, from the current plan.
  f.processes.set(`${target.id}:db`, {
    state: "stopped",
    exitCode: 1,
    incarnation: target.services!.db!.incarnation!,
  });
  await f.runtime.supervise();
  f.world.clock.ms += 60_000;
  await f.runtime.supervise();
  const restarted = (await f.stable()).services!.db!;
  expect(restarted.source!.checkout).toBe(target.plan.workspacePath);
  // search and api still run in the earlier checkout, so it stays.
  await f.runtime.releaseHeldCheckouts(target.id);
  expect(f.released).toEqual([]);
  // rig restart starts every Service from the current checkout and gives the earlier one back at once.
  await f.runtime.command({
    action: "restart",
    repoPath: f.world.repo,
    target: "stable",
  });
  expect(f.released).toEqual([first.plan.workspacePath]);
  expect((await f.world.store.read()).heldCheckouts).toEqual([]);
  for (const run of Object.values((await f.stable()).services!))
    expect(run.source!.checkout).toBe(target.plan.workspacePath);
});

test("Melody's watch settings: a web-only change keeps db and search; a change to db's script restarts db and its dependents", async () => {
  const f = await fixture(
    melody({
      db: { watch: ["scripts/rig-postgres.sh"] },
      search: { watch: [] },
    }),
  );
  /** The files each Commit changed since the one before. */
  const touched: Record<string, string[]> = {
    c2: ["apps/web/page.tsx"],
    c3: ["scripts/rig-postgres.sh"],
  };
  const asked: { to: string; paths?: readonly string[] }[] = [];
  f.git.changed = (_from, to, paths) => {
    asked.push({ to, ...(paths ? { paths } : {}) });
    return touched[to]!.some(
      (file) => paths === undefined || paths.includes(file),
    );
  };
  await f.deploy();
  const first = await f.pids();
  f.git.head = "c2";
  expect(await f.deploy()).toMatchObject({
    kept: ["db", "search"],
    restarted: [
      { service: "api", reason: "files" },
      { service: "web", reason: "files" },
    ],
  });
  const second = await f.pids();
  expect(second.db).toBe(first.db);
  expect(second.search).toBe(first.search);
  expect(second.api).not.toBe(first.api);
  // search watches nothing, so only db's script and the whole tree for api and web were compared.
  expect(asked).toEqual([
    { to: "c2", paths: ["scripts/rig-postgres.sh"] },
    { to: "c2" },
    { to: "c2" },
  ]);
  f.git.head = "c3";
  // api and web watch the whole checkout, which changed too; their own reason is the one reported.
  expect(await f.deploy()).toMatchObject({
    kept: ["search"],
    restarted: [
      { service: "db", reason: "files" },
      { service: "api", reason: "files" },
      { service: "web", reason: "files" },
    ],
  });
  const third = await f.pids();
  expect(third.search).toBe(first.search);
  expect(third.db).not.toBe(first.db);
  // search still runs in the first checkout, so that one stays held; the second, which nothing runs in, went.
  const target = await f.stable();
  expect(target.services!.search!.source).toMatchObject({ commit: "c1" });
  expect(target.services!.db!.source).toMatchObject({ commit: "c3" });
  expect(f.released).toHaveLength(1);
  expect((await f.world.store.read()).heldCheckouts).toHaveLength(1);
  // Status says which Commit each Service runs from.
  const status = await f.runtime.status({ repoPath: f.world.repo });
  const stable = status.targets.find((t) => t.name === "stable")!;
  expect(
    Object.fromEntries(stable.components.map((c) => [c.name, c.commit])),
  ).toEqual({ db: "c3", search: "c1", api: "c3", web: "c3" });
});

/** Deploys c1, then c2 with db's settings changed, so search is kept running in c1's checkout, which is held. */
async function keptInFirst(f: Awaited<ReturnType<typeof fixture>>) {
  await f.deploy();
  const first = await f.stable();
  f.git.head = "c2";
  f.git.changed = () => false;
  edit(f.config, "db", { stop_timeout: "60s" });
  expect(await f.deploy()).toMatchObject({ kept: ["search"] });
  return first.plan.workspacePath;
}

for (const [change, apply] of [
  [
    "drops it",
    (config: ProjectConfig) => {
      delete config.services!.search;
    },
  ],
  [
    "turns it into a job",
    (config: ProjectConfig) => {
      delete config.services!.search;
      (config as { jobs?: Record<string, unknown> }).jobs = {
        search: { command: "reindex", schedule: "0 3 * * *" },
      };
    },
  ],
] as const)
  test(`while a deploy whose plan ${change} builds, the checkout the kept Service still runs in stays held, even for another rigd's sweep`, async () => {
    const f = await fixture();
    const held = await keptInFirst(f);
    const target = await f.stable();
    f.git.head = "c3";
    edit(f.config, "api", { depends_on: ["db"] });
    apply(f.config);
    const lifecycle = f.world.deps.lifecycle;
    const prepare = lifecycle.prepare.bind(lifecycle);
    lifecycle.prepare = async (candidate, request) => {
      // The candidate has no Service named search, yet search's process still runs in the first checkout.
      await f.world.open().releaseHeldCheckouts(candidate.id);
      expect(f.released).not.toContain(held);
      return await prepare(candidate, request);
    };
    await f.deploy();
    lifecycle.prepare = prepare;
    // The deploy stopped search, so the next sweep gives its checkout back.
    expect(f.processes.get(`${target.id}:search`)?.state).toBe("stopped");
    await f.runtime.releaseHeldCheckouts(target.id);
    expect(f.released).toContain(held);
    expect((await f.world.store.read()).heldCheckouts).not.toContainEqual(
      expect.objectContaining({ workspace: held }),
    );
  });

test("while a later deploy builds, the checkout a kept Service runs in stays held, even for the sweep of a rigd that restarted meanwhile", async () => {
  const f = await fixture();
  const held = await keptInFirst(f);
  f.git.head = "c3";
  edit(f.config, "db", { stop_timeout: "30s" });
  const lifecycle = f.world.deps.lifecycle;
  const prepare = lifecycle.prepare.bind(lifecycle);
  let swept = false;
  lifecycle.prepare = async (target, request) => {
    // Another rigd over the same state sweeps while this candidate builds, as one started after a crash would.
    await f.world.open().releaseHeldCheckouts(target.id);
    swept = true;
    return await prepare(target, request);
  };
  expect(await f.deploy()).toMatchObject({ kept: ["search"] });
  expect(swept).toBe(true);
  expect(f.released).not.toContain(held);
  expect((await f.world.store.read()).heldCheckouts).toEqual([
    expect.objectContaining({ workspace: held }),
  ]);
  // The carried runs of the previous Deployment are gone from the completed record: only current runs remain.
  const target = await f.stable();
  for (const run of Object.values(target.services!))
    expect(run.deployment).toBe(target.plan.workspacePath);
});

test("the checkout a kept Service runs in is recorded as held in the same write that completes the deploy", async () => {
  const f = await fixture();
  await f.deploy();
  const first = await f.stable();
  const store = f.world.deps.store;
  const update = store.update.bind(store);
  const writes: Awaited<ReturnType<typeof store.read>>[] = [];
  store.update = async (change) => {
    await update(change);
    writes.push(await store.read());
  };
  f.git.head = "c2";
  f.git.changed = () => false;
  edit(f.config, "web", { command: "node web2.js" });
  await f.deploy();
  const completing = writes.find((state) => {
    const target = state.targets.find((t) => t.id === first.id);
    return target?.commit === "c2" && !target.recovery;
  })!;
  expect(completing.heldCheckouts).toEqual([
    {
      target: first.id,
      project: first.projectId,
      workspace: first.plan.workspacePath,
    },
  ]);
});

test("the sweep observes a held checkout without its Target's lease, and takes it only when something can be given back", async () => {
  const f = await fixture();
  const held = await keptInFirst(f);
  const target = await f.stable();
  const views: unknown[] = [];
  f.hooks.beforeObserve = async () => {
    views.push(
      ...(
        (await f.runtime.command({ action: "queue" })) as {
          operations: unknown[];
        }
      ).operations,
    );
  };
  await f.runtime.releaseHeldCheckouts(target.id);
  f.hooks.beforeObserve = undefined;
  // While search runs there, the sweep only looked: no Operation held the Target, so status never showed it stopping.
  expect(views).toEqual([]);
  expect(f.runtime.targetBusy(target)).toBe(false);
  expect(f.released).not.toContain(held);
  f.processes.set(`${target.id}:search`, { state: "stopped" });
  await f.runtime.releaseHeldCheckouts(target.id);
  expect(f.released).toContain(held);
});

test("a kept Service that ended between the decision and the start is started from the new checkout and not reported as kept", async () => {
  const f = await fixture();
  await f.deploy();
  const target = await f.stable();
  f.git.head = "c2";
  f.git.changed = () => false;
  edit(f.config, "db", { stop_timeout: "60s" });
  f.hooks.beforeStop = async () => {
    f.processes.set(`${target.id}:search`, { state: "stopped" });
  };
  expect(await f.deploy()).toMatchObject({
    kept: [],
    restarted: expect.arrayContaining([
      { service: "search", reason: "not-running" },
    ]),
  });
  const after = await f.stable();
  expect(after.services!.search!.source!.checkout).toBe(
    after.plan.workspacePath,
  );
  expect((await f.world.store.read()).heldCheckouts ?? []).toEqual([]);
});

test("a kept Service whose start check fails during the deploy is restarted, with its dependents, by the rollback", async () => {
  const flag = join(
    tmpdir(),
    `rig-keep-unhealthy-${process.pid}-${Date.now()}`,
  );
  const f = await fixture(
    melody({
      db: { healthcheck: { test: `test ! -e '${flag}'`, start_period: "1s" } },
    }),
  );
  await f.deploy();
  const before = await f.pids();
  f.git.head = "c2";
  f.git.changed = () => false;
  edit(f.config, "web", { command: "node web2.js" });
  await writeFile(flag, "");
  f.hooks.beforeStop = async (key) => {
    if (key.endsWith(":db")) await rm(flag, { force: true });
  };
  try {
    await expect(f.deploy()).rejects.toMatchObject({ code: "HEALTH_FAILED" });
  } finally {
    await rm(flag, { force: true });
  }
  const after = await f.pids();
  expect(after.search).toBe(before.search);
  for (const service of ["db", "api", "web"])
    expect(after[service]).not.toBe(before[service]);
  expect((await f.stable()).commit).toBe("c1");
});

test("a deploy warns about a watch entry that matches no tracked file at its Commit", async () => {
  const f = await fixture(
    melody({ db: { watch: ["scripts/rig-postgress.sh"] } }),
  );
  expect(await f.deploy()).toMatchObject({
    warnings: [
      "services.db.watch entry 'scripts/rig-postgress.sh' matches no tracked file at c1, so a change there would never restart db. Check its spelling and case in rig.yaml.",
    ],
  });
});
