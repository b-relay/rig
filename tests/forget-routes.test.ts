import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loopbackListeners } from "./support/activation-doubles";
import { managedCaddyWorld } from "./support/managed-caddy-double";
import { controlledDeadline } from "./controlled-observation-deadline";
import { createRuntime } from "../src/runtime/application";
import { createTargetLifecycle } from "../src/runtime/lifecycle";
import { createTargetEffects } from "../src/adapters/target-effects";
import { createArtifactInstaller } from "../src/providers/artifact-installer";
import { runCommand } from "../src/providers/command-runner";
import { createCaddyRouter, type Router } from "../src/providers/caddy-router";
import {
  inspectProxyPublication,
  ownedRouteBlocks,
} from "../src/domain/proxy-publication";
import type { Supervisor } from "../src/providers/contracts";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import type { RuntimeState } from "../src/domain/runtime";
import { STATE_VERSION } from "../src/runtime/state-schema";
import {
  parseHostConfig,
  parseProjectConfig,
  resolveTargetPlan,
} from "../src/config";

// Issue #336: `rig forget` dropped the registration but left the Project's route blocks, keyed by Target ids nothing in
// state names any more, so the same hostname could never be published again.

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

type Mode = "managed" | "external";
const modes: Mode[] = ["managed", "external"];

/** The proxy a Rig root publishes through: Rig's own Caddy (scripted job and socket), or the external router writing the
 * route file of a Caddy Rig does not run (every reload succeeds unless `failReloads` says otherwise). */
async function proxyWorld(mode: Mode) {
  if (mode === "managed") {
    const world = await managedCaddyWorld({ tls: { ca: "internal" } });
    roots.push(world.root);
    return {
      root: world.root,
      router: world.caddy.router,
      routeFile: join(world.root, "proxy", "Caddyfile"),
      publication: "managed" as const,
      /** Makes Rig's Caddy run but stop answering on its socket, so no change can be confirmed. */
      breakProxy() {
        world.control.reachable = false;
        world.control.state = "running";
      },
      served: () => world.servedRoutes(),
    };
  }
  const root = await mkdtemp(join(tmpdir(), "rig-external-"));
  roots.push(root);
  const routeFile = join(root, "proxy", "Caddyfile");
  let failReloads = false;
  const router = createCaddyRouter({
    caddyfile: routeFile,
    run: async ({ command }) =>
      failReloads && command.includes("reload")
        ? { exitCode: 1, stdout: "", stderr: "connection refused" }
        : { exitCode: 0, stdout: "", stderr: "" },
  });
  return {
    root,
    router,
    routeFile,
    publication: "unpublished" as const,
    /** Makes the external Caddy refuse every reload. */
    breakProxy() {
      failReloads = true;
    },
    served: () => readFile(routeFile, "utf8").catch(() => ""),
  };
}

/** A runtime over an in-memory state whose Targets publish their routes through `router` with the real lifecycle and
 * effects; Services run under an in-memory supervisor and are ready at once. */
async function rigWorld(mode: Mode) {
  const proxy = await proxyWorld(mode);
  const state: RuntimeState = {
    version: STATE_VERSION,
    projects: [],
    targets: [],
    activity: [],
  };
  const config = parseProjectConfig({
    name: "ledger",
    domain: "ledger.test",
    services: {
      web: { command: "serve --host 127.0.0.1", ports: { http: 4567 } },
    },
    targets: { working: { domain: "dev.ledger.test" }, stable: true },
  });
  const running = new Set<string>();
  const supervisor: Supervisor = {
    async observe(key) {
      return running.has(key)
        ? { state: "running", pid: 1 }
        : { state: "stopped" };
    },
    async ensureRunning(request) {
      const existed = running.has(request.key);
      running.add(request.key);
      return { outcome: existed ? "unchanged" : "started" };
    },
    async stop(key) {
      return { outcome: running.delete(key) ? "stopped" : "unchanged" };
    },
    async shutdown() {},
    async detach() {},
  };
  const effects = createTargetEffects({
    root: proxy.root,
    recordingTime: () => new Date().toISOString(),
    supervisors: new Map([
      ["rigd", supervisor],
      ["child", supervisor],
    ]),
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    installer: createArtifactInstaller({
      run: runCommand,
      bunExecutable: process.execPath,
    }),
    router: proxy.router,
    connect: async () => ({ ready: true }),
    listeners: { inspect: async (pid) => loopbackListeners(pid, [4567]) },
    environment: {},
  });
  // Nothing is built or installed: the workspace a fake source prepares is never on disk.
  effects.prepare = async () => {};
  effects.build = async () => {};
  effects.environment = async () => ({});
  delete effects.digestEnvironment;
  let id = 0;
  const deps: RuntimeDependencies = {
    reconcileGate: "open",
    root: proxy.root,
    async readAdminActivity() {
      return [];
    },
    async inspectHost() {
      return [];
    },
    async inspectProxy() {
      return await inspectProxyPublication({
        proxyFile: proxy.routeFile,
        hostCaddyfiles: [],
        environment: {},
        read: (file) => readFile(file, "utf8").catch(() => undefined),
      }).then((publication) =>
        proxy.publication === "managed"
          ? { ...publication, state: "managed" as const }
          : publication,
      );
    },
    store: {
      async read() {
        return structuredClone(state);
      },
      async update(change) {
        const next = structuredClone(state);
        await change(next);
        Object.assign(state, next);
      },
    },
    documents: {
      async initializationInfo() {
        return {
          name: "ledger",
          productionBranch: "main",
          gitRequired: false,
          existing: true,
        };
      },
      async identifyInitialization(path) {
        return {
          repoPath: path,
          name: config.name,
          configPath: `${path}/rig.yaml`,
        };
      },
      async discover(path) {
        return {
          repoPath: path,
          document: await this.read(path),
          gitRequired: false,
        };
      },
      async read(path) {
        return { path: `${path}/rig.yaml`, revision: "abc", config };
      },
      async initialize(path) {
        return await this.read(path);
      },
      async rename() {
        throw new Error("unused");
      },
      resolve: (input) =>
        resolveTargetPlan(input, {
          operatorHome: "/home/operator",
          envRoot: join(proxy.root, "env"),
        }),
      async host() {
        return parseHostConfig({});
      },
    },
    sources: {
      async preflight() {
        return { commit: "abc", warnings: [] };
      },
      async prepare(request) {
        return { workspacePath: request.destination, commit: "abc" };
      },
      async resolve() {
        return "abc";
      },
      async currentBranch() {
        return "main";
      },
      async release() {},
      async changed() {
        return true;
      },
      async unmatched() {
        return [];
      },
    },
    lifecycle: createTargetLifecycle(effects),
    observations: effects.observations,
    files: {
      async destroyPreview() {},
      async inspectPreviewDeletion() {},
      async selectPorts({ requests }) {
        return Object.fromEntries(requests.map((r) => [r.name, 4567]));
      },
      async logs() {
        return { entries: [], cursor: "0" };
      },
    },
    observationBudgetMs: 2000,
    observationDeadline: controlledDeadline(),
    now: () => new Date().toISOString(),
    id: () => `id${++id}`,
    async diagnostic() {},
  };
  const runtime = createRuntime(deps);
  return {
    ...proxy,
    runtime,
    state,
    deps,
    routes: () => readFile(proxy.routeFile, "utf8").catch(() => ""),
    /** Registers the repository, deploys stable and runs the Working copy, then stops both. */
    async deployedThenStopped() {
      await runtime.command({ action: "init", repoPath: "/tmp/ledger" });
      await runtime.command({
        action: "deploy",
        project: "ledger",
        target: "stable",
      });
      await runtime.command({ action: "up", project: "ledger" });
      await runtime.command({
        action: "down",
        project: "ledger",
        target: "stable",
      });
      await runtime.command({ action: "down", project: "ledger" });
    },
    /** What forget did before #336: the registration and its records go, its route blocks stay. */
    forgetLeavingRoutes() {
      state.projects = [];
      state.targets = [];
    },
    async reRegisterAndDeploy() {
      await runtime.command({ action: "init", repoPath: "/tmp/ledger" });
      return await runtime.command({
        action: "deploy",
        project: "ledger",
        target: "stable",
      });
    },
  };
}

for (const mode of modes) {
  test(`${mode}: forget withdraws every route its Targets own, so the same repository registers again and its stable deploy publishes the hostname`, async () => {
    const w = await rigWorld(mode);
    await w.deployedThenStopped();
    expect(await w.routes()).toContain("ledger.test {");
    expect(await w.routes()).toContain("dev.ledger.test {");
    await w.runtime.command({ action: "forget", project: "ledger" });
    expect(w.state.projects).toEqual([]);
    // Nothing of the forgotten Project is published or served.
    expect(await w.routes()).not.toContain("# rig begin");
    expect(await w.served()).not.toContain("ledger.test");
    expect(await w.reRegisterAndDeploy()).toMatchObject({
      outcome: "deployed",
    });
    const routes = await w.routes();
    expect(routes.match(/^ledger\.test \{$/gm)).toHaveLength(1);
    expect(await w.served()).toContain("ledger.test {");
  });

  test(`${mode}: forget is refused, changing nothing, when a route cannot be withdrawn, and names how to retry`, async () => {
    const w = await rigWorld(mode);
    await w.deployedThenStopped();
    const before = await w.routes();
    w.breakProxy();
    const refused = await w.runtime
      .command({ action: "forget", project: "ledger" })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({
      code: mode === "managed" ? "PROXY_UNREACHABLE" : "ROUTE_RELOAD",
      message: expect.stringContaining(
        "Project 'ledger' was not forgotten: its routes could not be withdrawn",
      ),
      hint: expect.stringContaining("then run rig forget ledger again"),
    });
    // Still registered, with both Targets, and every route block as it was.
    expect(w.state.projects.map((p) => p.name)).toEqual(["ledger"]);
    expect(w.state.targets.map((t) => t.kind).sort()).toEqual([
      "stable",
      "working",
    ]);
    expect(await w.routes()).toBe(before);
  });

  test(`${mode}: when forget cannot write its state, the routes it withdrew are published again and the Project stays registered`, async () => {
    const w = await rigWorld(mode);
    await w.deployedThenStopped();
    const before = await w.routes();
    const update = w.deps.store.update.bind(w.deps.store);
    let failed = false;
    w.deps.store.update = async (change) => {
      // The forget's own write: the one that drops the registration.
      const probe = structuredClone(w.state);
      await change(probe);
      if (!failed && probe.projects.length === 0) {
        failed = true;
        throw new Error("state write failed");
      }
      await update(change);
    };
    await expect(
      w.runtime.command({ action: "forget", project: "ledger" }),
    ).rejects.toThrow();
    expect(failed).toBe(true);
    expect(w.state.projects.map((p) => p.name)).toEqual(["ledger"]);
    expect(await w.routes()).toBe(before);
    // Retrying once the store works forgets it, routes and all.
    await w.runtime.command({ action: "forget", project: "ledger" });
    expect(await w.routes()).not.toContain("# rig begin");
  });

  test(`${mode}: a route block whose Target is gone (left by an earlier forget) is reported by doctor and withdrawn when rigd starts, and the hostname is published again`, async () => {
    const w = await rigWorld(mode);
    await w.deployedThenStopped();
    w.forgetLeavingRoutes();
    const report = (await w.runtime.command({ action: "doctor" })) as {
      checks: { name: string; ok: boolean; message: string; hint?: string }[];
    };
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "route-owners",
        ok: false,
        message: expect.stringContaining("for ledger.test, dev.ledger.test."),
        hint: expect.stringContaining(
          mode === "managed" ? "rig proxy reload" : "rigd withdraws them",
        ),
      }),
    );
    // What rigd runs once it has started: only what no recorded Target owns goes.
    const withdrawn = await w.runtime.withdrawOrphanedRoutes();
    expect(withdrawn.sort()).toEqual(["dev.ledger.test", "ledger.test"]);
    expect(await w.routes()).not.toContain("ledger.test");
    expect(await w.served()).not.toContain("ledger.test");
    const doctor = (await w.runtime.command({ action: "doctor" })) as {
      checks: { name: string }[];
    };
    expect(doctor.checks.map((check) => check.name)).not.toContain(
      "route-owners",
    );
    expect(await w.reRegisterAndDeploy()).toMatchObject({
      outcome: "deployed",
    });
    expect(await w.served()).toContain("ledger.test {");
  });

  test(`${mode}: a deploy withdraws a route block whose Target is gone before it checks its own route, so an orphan never refuses it`, async () => {
    const w = await rigWorld(mode);
    await w.deployedThenStopped();
    // Before #336 was fixed, this deploy failed with ROUTE_CONFLICT for as long as the Rig root existed.
    w.forgetLeavingRoutes();
    expect(await w.reRegisterAndDeploy()).toMatchObject({
      outcome: "deployed",
    });
    const routes = await w.routes();
    expect(routes.match(/^ledger\.test \{$/gm)).toHaveLength(1);
    // The Working copy's orphan went too: no recorded Target owned it.
    expect(routes).not.toContain("dev.ledger.test");
    expect(await w.served()).toContain("ledger.test {");
    // So does the Working copy's up, which publishes dev.ledger.test under its new Target.
    await w.runtime.command({ action: "up", project: "ledger" });
    expect(await w.routes()).toContain("dev.ledger.test {");
  });

  test(`${mode}: rig proxy reload withdraws orphans (Rig's own Caddy only)`, async () => {
    const w = await rigWorld(mode);
    await w.deployedThenStopped();
    w.forgetLeavingRoutes();
    if (mode === "external") {
      await expect(
        w.runtime.command({ action: "proxy-apply" }),
      ).rejects.toMatchObject({ code: "PROXY_UNMANAGED" });
      return;
    }
    let applied = 0;
    w.deps.proxy = {
      async apply() {
        applied++;
      },
      async report() {
        throw new Error("unused");
      },
    };
    expect(await w.runtime.command({ action: "proxy-apply" })).toMatchObject({
      outcome: "applied",
      withdrawn: ["ledger.test", "dev.ledger.test"],
    });
    expect(applied).toBe(1);
    expect(await w.routes()).not.toContain("# rig begin");
  });

  test(`${mode}: withdrawing orphans never touches a route whose Target is recorded, and reads the owners after every change queued before it`, async () => {
    const w = await rigWorld(mode);
    const site = (key: string, hostname: string) => ({
      key,
      sites: [
        {
          hostname,
          routes: [{ prefix: "/", upstream: "127.0.0.1:4000" }],
        },
      ],
    });
    await w.router.apply(site("gone", "gone.test"));
    // Queued before the sweep: its owner is recorded only once it is published, as a deploy records its candidate first.
    const owners = new Set<string>(["live"]);
    const applying = w.router
      .apply(site("late", "late.test"))
      .then(() => owners.add("late"));
    const withdrawn = await w.router.withdrawUnowned(async () => {
      await applying;
      return owners;
    });
    expect(withdrawn).toEqual(["gone.test"]);
    const routes = await w.routes();
    expect(routes).toContain("late.test {");
    expect(routes).not.toContain("gone.test");
    // Nothing unowned: nothing is published, so a Caddy that cannot be reached is never asked.
    w.breakProxy();
    expect(
      await w.router.withdrawUnowned(async () => new Set(["late"])),
    ).toEqual([]);
  });
}

test("forget of a Project whose Targets have no route never asks the proxy", async () => {
  const w = await rigWorld("managed");
  w.deps.documents.read = async (path) => ({
    path: `${path}/rig.yaml`,
    revision: "abc",
    config: parseProjectConfig({
      name: "ledger",
      services: { web: { command: "serve", ports: { http: 4567 } } },
      targets: { working: true, stable: true },
    }),
  });
  await w.deployedThenStopped();
  expect(await w.routes()).not.toContain("# rig begin");
  w.breakProxy();
  expect(
    await w.runtime.command({ action: "forget", project: "ledger" }),
  ).toMatchObject({ outcome: "forgotten" });
});

test("when one Target's route cannot be withdrawn, those already withdrawn are published again before the refusal", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-withdraw-"));
  roots.push(root);
  const routeFile = join(root, "Caddyfile");
  /** Counted once armed: the second reload then (the second Target's withdrawal) fails, every other succeeds. */
  let reloads: number | undefined;
  const router: Router = createCaddyRouter({
    caddyfile: routeFile,
    run: async ({ command }) =>
      command.includes("reload") && reloads !== undefined && ++reloads === 2
        ? { exitCode: 1, stdout: "", stderr: "connection refused" }
        : { exitCode: 0, stdout: "", stderr: "" },
  });
  const site = (key: string, hostname: string) => ({
    key,
    sites: [
      { hostname, routes: [{ prefix: "/", upstream: "127.0.0.1:4000" }] },
    ],
  });
  await router.apply(site("one", "one.test"));
  await router.apply(site("two", "two.test"));
  reloads = 0;
  // Once the failing reload has happened, every later one succeeds again. Blocks are compared regardless of their order.
  const blocks = async () =>
    ownedRouteBlocks(await readFile(routeFile, "utf8")).sort((a, b) =>
      a.token.localeCompare(b.token),
    );
  const before = await blocks();
  const effects = createTargetEffects({
    root,
    recordingTime: () => new Date().toISOString(),
    supervisors: new Map(),
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    installer: createArtifactInstaller({
      run: runCommand,
      bunExecutable: process.execPath,
    }),
    router,
    connect: async () => ({ ready: true }),
    listeners: { inspect: async (pid) => loopbackListeners(pid, []) },
    environment: {},
  });
  const lifecycle = createTargetLifecycle(effects);
  const target = (id: string) =>
    ({ id, name: id, kind: "stable" }) as Parameters<
      typeof lifecycle.withdrawRoutes
    >[0][number];
  await expect(
    lifecycle.withdrawRoutes([target("one"), target("two")]),
  ).rejects.toMatchObject({ code: "ROUTE_RELOAD" });
  // one.test was withdrawn and then published again; two.test never left.
  expect(await blocks()).toEqual(before);
  // Withdrawn together, they come back together.
  const withdrawal = await lifecycle.withdrawRoutes([
    target("one"),
    target("two"),
  ]);
  expect(withdrawal.hostnames).toEqual(["one.test", "two.test"]);
  expect(await readFile(routeFile, "utf8")).not.toContain("# rig begin");
  await withdrawal.restore();
  expect(await blocks()).toEqual(before);
});

test("an orphaned route in a route file written by hand is named by its hostnames", async () => {
  const w = await rigWorld("external");
  await w.router.apply({
    key: "someone",
    sites: [
      {
        hostname: "orphan.test",
        routes: [{ prefix: "/", upstream: "127.0.0.1:4000" }],
      },
    ],
  });
  await writeFile(
    w.routeFile,
    `${await w.routes()}# a comment Rig did not write\n`,
  );
  const report = (await w.runtime.command({ action: "doctor" })) as {
    checks: { name: string; message: string }[];
  };
  expect(
    report.checks.find((check) => check.name === "route-owners")?.message,
  ).toContain("orphan.test");
});
