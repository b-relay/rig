import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { releaseUnreferencedRevisions } from "../src/runtime/revisions";
import { parseProjectConfig } from "../src/config";
import type { ProjectConfig } from "../src/config/types";
import type {
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import type { ServiceRun, TargetRecord } from "../src/domain/runtime";
import { serviceDefinition } from "../src/domain/service-definition";
import { runtimeWorld } from "./support/runtime-world";

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
        ...services.api,
      },
      web: { command: "node web.js", depends_on: ["api"], ...services.web },
    },
    targets: { working: true, stable: true },
  });
}

async function fixture(config: ProjectConfig = melody()) {
  const processes = new Map<string, ProcessObservation>();
  /** Process keys whose observation cannot be made. */
  const unobservable = new Set<string>();
  /** Services whose next spawn fails, once. */
  const failStarts = new Set<string>();
  let pid = 5000;
  /** Every spawn and stop, by Service name, in order. */
  const events: string[] = [];
  const supervisor: Supervisor = {
    async observe(key) {
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
  };
  const released: string[] = [];
  const world = await runtimeWorld({
    name: "keep",
    config,
    supervisor: () => supervisor,
    startsAt: "2026-10-11T09:00:00.000Z",
    readinessDeadlineMs: 2000,
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
  });
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
  const result = await f.deploy();
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
