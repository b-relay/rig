import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { routeFileInRoot } from "../src/adapters/proxy-publication";
import type { RigError } from "../src/domain/errors";
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
import { FileStateStore } from "../src/runtime/state-store";
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
async function proxyWorld(
  mode: Mode,
  /** The external route file, when not `<root>/proxy/Caddyfile`. */
  externalRouteFile?: string,
) {
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
      managed: world,
      failNextReloads(_count: number) {
        throw new Error("only the external router counts reloads");
      },
    };
  }
  const root = await mkdtemp(join(tmpdir(), "rig-external-"));
  roots.push(root);
  const routeFile = externalRouteFile ?? join(root, "proxy", "Caddyfile");
  let failReloads = false;
  let failing = 0;
  const router = createCaddyRouter({
    caddyfile: routeFile,
    run: async ({ command }) => {
      if (!command.includes("reload"))
        return { exitCode: 0, stdout: "", stderr: "" };
      // A failed reload is followed by the rollback's own reload, which succeeds.
      if (failReloads || failing-- > 0)
        return { exitCode: 1, stdout: "", stderr: "connection refused" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
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
    managed: undefined,
    /** Makes the external Caddy refuse the next `count` reloads. */
    failNextReloads(count: number) {
      failing = count;
    },
  };
}

/** A runtime over an in-memory state whose Targets publish their routes through `router` with the real lifecycle and
 * effects; Services run under an in-memory supervisor and are ready at once. */
async function rigWorld(
  mode: Mode,
  options: {
    externalRouteFile?: string;
    /** Stands between the effects and the router, to fail or observe its calls. */
    router?: (router: Router) => Router;
  } = {},
) {
  const proxy = await proxyWorld(mode, options.externalRouteFile);
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
    router: options.router ? options.router(proxy.router) : proxy.router,
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
    // rig proxy reload publishes Host config's proxy section through Rig's own Caddy.
    ...(proxy.managed
      ? {
          proxy: {
            apply: async () => {
              await proxy.managed!.caddy.republish();
            },
            report: async () => {
              throw new Error("unused");
            },
          },
        }
      : {}),
    async readAdminActivity() {
      return [];
    },
    async inspectHost() {
      return [];
    },
    routeFileInRoot: () =>
      routeFileInRoot(proxy.root, {
        proxyMode: proxy.managed ? "managed" : "external",
        providers: { caddy: { caddyfile: proxy.routeFile } },
      } as Parameters<typeof routeFileInRoot>[1]),
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
          "Run rig proxy reload to withdraw them now",
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

  test(`${mode}: rig proxy reload withdraws orphans first, so proxy.routes may name an orphan's hostname`, async () => {
    const w = await rigWorld(mode);
    await w.deployedThenStopped();
    w.forgetLeavingRoutes();
    if (!w.managed) {
      // Without Rig's own Caddy there is no proxy section to apply: the reload only withdraws.
      expect(await w.runtime.command({ action: "proxy-apply" })).toMatchObject({
        outcome: "withdrawn",
        withdrawn: ["ledger.test", "dev.ledger.test"],
      });
      expect(await w.routes()).not.toContain("# rig begin");
      return;
    }
    // The owner now routes the orphan's hostname to a service of their own. Published before the sweep, this Host
    // config would be refused as a second owner of ledger.test.
    w.managed.setSettings({
      tls: { ca: "internal" },
      routes: { "ledger.test": 3005 },
    });
    expect(await w.runtime.command({ action: "proxy-apply" })).toMatchObject({
      outcome: "applied",
      withdrawn: ["ledger.test", "dev.ledger.test"],
    });
    expect(await w.routes()).not.toContain("# rig begin");
    expect(JSON.stringify(w.managed.control.loaded)).toContain(
      "127.0.0.1:3005",
    );
  });

  test(`${mode}: when the sweep before a deploy fails, the deploy's ROUTE_CONFLICT names the gone Target's route, why it is still there, and the way out`, async () => {
    const w = await rigWorld(mode);
    await w.deployedThenStopped();
    w.forgetLeavingRoutes();
    // Caddy refuses the reload that would withdraw the orphans (it still answers, so the deploy's rollback is confirmed).
    if (w.managed) w.managed.failures.reload = "reload refused";
    else w.breakProxy();
    const refused = (await w
      .reRegisterAndDeploy()
      .catch((error: unknown) => error)) as RigError;
    expect(refused).toMatchObject({
      code: "ROUTE_CONFLICT",
      message: expect.stringContaining(
        "ledger.test is held by a route whose Target no longer exists, and Rig could not withdraw it: Caddy could not reload",
      ),
      hint: "No Target serves it any more: run rig doctor (route-owners) and rig proxy reload, then retry.",
      details: expect.objectContaining({ withdrawal: "ROUTE_RELOAD" }),
    });
    expect(refused.causes.recoveryCause).toBeDefined();
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

test("a route file outside the Rig root, which another root may share, is never swept on rigd's own: doctor says so and only rig proxy reload withdraws", async () => {
  // A providers.caddy.caddyfile outside RIG_ROOT, such as a sandbox naming the real root's.
  const shared = await mkdtemp(join(tmpdir(), "rig-shared-"));
  roots.push(shared);
  const w = await rigWorld("external", {
    externalRouteFile: join(shared, "Caddyfile"),
  });
  await w.deployedThenStopped();
  w.forgetLeavingRoutes();
  const before = await w.routes();
  expect(await w.runtime.withdrawOrphanedRoutes()).toEqual([]);
  expect(await w.routes()).toBe(before);
  // A deploy sweeps nothing either: it is refused, naming the way out.
  await expect(w.reRegisterAndDeploy()).rejects.toMatchObject({
    code: "ROUTE_CONFLICT",
    message: "ledger.test is held by a route whose Target no longer exists.",
    hint: expect.stringContaining("rig proxy reload"),
  });
  expect(await w.routes()).toBe(before);
  const report = (await w.runtime.command({ action: "doctor" })) as {
    checks: { name: string; message: string; hint?: string }[];
  };
  expect(
    report.checks.find((check) => check.name === "route-owners"),
  ).toMatchObject({
    message: expect.stringContaining("another Rig root may own them"),
    hint: `If no other Rig root writes routes to ${w.routeFile}, run rig proxy reload to withdraw them.`,
  });
  // The explicit reload withdraws them, and the deploy then publishes.
  expect(await w.runtime.command({ action: "proxy-apply" })).toMatchObject({
    outcome: "withdrawn",
    withdrawn: ["ledger.test", "dev.ledger.test"],
  });
  expect(
    await w.runtime.command({
      action: "deploy",
      project: "ledger",
      target: "stable",
    }),
  ).toMatchObject({ outcome: "deployed" });
});

test("whether the route file lies inside the Rig root is decided by its real path", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-root-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "rig-elsewhere-"));
  roots.push(root, elsewhere);
  const host = (
    caddyfile?: string,
    proxyMode: "managed" | "external" = "external",
  ) =>
    ({
      proxyMode,
      providers: { caddy: caddyfile ? { caddyfile } : {} },
    }) as Parameters<typeof routeFileInRoot>[1];
  expect(await routeFileInRoot(root, host())).toBe(true);
  expect(
    await routeFileInRoot(root, host(join(root, "routes", "Caddyfile"))),
  ).toBe(true);
  expect(await routeFileInRoot(root, host(join(elsewhere, "Caddyfile")))).toBe(
    false,
  );
  // A route file under the root that is a link to another root's file is that other file.
  await mkdir(join(root, "proxy"), { recursive: true });
  await writeFile(join(elsewhere, "Caddyfile"), "");
  await symlink(join(elsewhere, "Caddyfile"), join(root, "proxy", "Caddyfile"));
  expect(await routeFileInRoot(root, host())).toBe(false);
  // Rig's own Caddy's route file is always its own.
  expect(await routeFileInRoot(root, host(undefined, "managed"))).toBe(true);
});

test("when forget cannot write its state and only some routes come back, FORGET_ROLLBACK names only those that did not", async () => {
  const w = await rigWorld("external");
  await w.deployedThenStopped();
  const update = w.deps.store.update.bind(w.deps.store);
  w.deps.store.update = async (change) => {
    const probe = structuredClone(w.state);
    await change(probe);
    if (probe.projects.length === 0) {
      // The first route published again fails; the second comes back.
      w.failNextReloads(1);
      throw new Error("state write failed");
    }
    await update(change);
  };
  const refused = (await w.runtime
    .command({ action: "forget", project: "ledger" })
    .catch((error: unknown) => error)) as RigError;
  expect(refused).toMatchObject({ code: "FORGET_ROLLBACK" });
  const routes = await w.routes();
  const both = ["ledger.test", "dev.ledger.test"];
  const back = both.filter((hostname) =>
    routes.split("\n").includes(`${hostname} {`),
  );
  expect(back).toHaveLength(1);
  const missing = both.filter((hostname) => !back.includes(hostname));
  expect(refused.details.hostnames).toEqual(missing);
  expect(refused.message).toBe(
    `Project 'ledger' is still registered, but the routes for ${missing[0]} were withdrawn and could not be published again.`,
  );
  expect(w.state.projects.map((p) => p.name)).toEqual(["ledger"]);
});

test("a withdrawal that fails with no RigError still refuses the forget as one that changed nothing", async () => {
  const w = await rigWorld("external");
  await w.deployedThenStopped();
  w.deps.lifecycle.withdrawRoutes = async () => {
    throw new TypeError("unexpected");
  };
  await expect(
    w.runtime.command({ action: "forget", project: "ledger" }),
  ).rejects.toMatchObject({
    code: "ROUTE_WITHDRAW",
    message:
      "Project 'ledger' was not forgotten: its routes could not be withdrawn.",
    hint: expect.stringContaining("then run rig forget ledger again"),
  });
  expect(w.state.projects.map((p) => p.name)).toEqual(["ledger"]);
});

/** The route file's blocks, in any order. */
async function blocksOf(file: string) {
  return ownedRouteBlocks(await readFile(file, "utf8").catch(() => "")).sort(
    (a, b) => a.token.localeCompare(b.token),
  );
}

for (const mode of modes) {
  test(`${mode}: a sweep never writes into a file the route file was swapped for after the sweep resolved it`, async () => {
    const w = await rigWorld(mode);
    await w.router.apply({
      key: "gone",
      sites: [
        {
          hostname: "gone.test",
          routes: [{ prefix: "/", upstream: "127.0.0.1:4000" }],
        },
      ],
    });
    // Another root's route file, with a block its own state records.
    const other = await mkdtemp(join(tmpdir(), "rig-other-root-"));
    roots.push(other);
    const otherFile = join(other, "Caddyfile");
    const otherRoutes =
      "# rig begin " +
      "a".repeat(64) +
      "\nother.test {\n  reverse_proxy 127.0.0.1:5000\n}\n# rig end " +
      "a".repeat(64) +
      "\n";
    await writeFile(otherFile, otherRoutes);
    const before = await w.routes();
    // While the sweep waits for the owners it read, the in-root route file becomes a link to the other root's.
    const refused = await w.router
      .withdrawUnowned(
        async () => {
          await rm(w.routeFile);
          await symlink(otherFile, w.routeFile);
          return new Set<string>();
        },
        { within: w.root },
      )
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "ROUTE_CHANGED" });
    expect(await readFile(otherFile, "utf8")).toBe(otherRoutes);
    // The link is undone: the root's own file was never touched either.
    await rm(w.routeFile);
    await writeFile(w.routeFile, before);
    // A route file that already resolves outside the root is not swept at all.
    await rm(w.routeFile);
    await symlink(otherFile, w.routeFile);
    expect(
      await w.router.withdrawUnowned(async () => new Set<string>(), {
        within: w.root,
      }),
    ).toEqual([]);
    expect(await readFile(otherFile, "utf8")).toBe(otherRoutes);
  });

  test(`${mode}: a withdrawal whose route cannot be read back after its removal is still compensated, and never needs reading back`, async () => {
    // Every read of a route after its removal fails; the second removal is refused.
    const failing = (router: Router): Router => {
      const removed = new Set<string>();
      let removals = 0;
      return {
        ...router,
        async remove(key) {
          if (refuseSecond && ++removals === 2)
            throw Object.assign(new Error("reload refused"), {
              code: "ROUTE_RELOAD",
            });
          await router.remove(key);
          removed.add(key);
        },
        async checkpoint(key) {
          if (removed.has(key)) throw new Error("route file unreadable");
          return await router.checkpoint(key);
        },
        async restore(saved, expected) {
          await router.restore(saved, expected);
          removed.delete(saved.key);
        },
      };
    };
    let refuseSecond = true;
    const w = await rigWorld(mode, { router: failing });
    await w.deployedThenStopped();
    const before = await blocksOf(w.routeFile);
    await expect(
      w.runtime.command({ action: "forget", project: "ledger" }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("was not forgotten"),
    });
    // The first Target's withdrawn route was published again: nothing changed.
    expect(await blocksOf(w.routeFile)).toEqual(before);
    expect(w.state.projects.map((p) => p.name)).toEqual(["ledger"]);
    // With every removal confirmed, no read after one is needed: the forget completes.
    refuseSecond = false;
    expect(
      await w.runtime.command({ action: "forget", project: "ledger" }),
    ).toMatchObject({ outcome: "forgotten" });
    expect(await blocksOf(w.routeFile)).toEqual([]);
  });

  test(`${mode}: a state write that fails after it committed leaves the routes withdrawn and reports the Project forgotten`, async () => {
    const w = await rigWorld(mode);
    // The real store: a write is renamed into place, then its directory synced; the sync is what fails here.
    const store = new FileStateStore(w.root);
    let failed = false;
    w.deps.store = {
      read: () => store.read(),
      async update(change) {
        await store.update(change);
        if (!failed && (await store.read()).projects.length === 0) {
          failed = true;
          throw new Error("fsync of the runtime directory failed");
        }
      },
    };
    await w.deployedThenStopped();
    const forgotten = (await w.runtime.command({
      action: "forget",
      project: "ledger",
    })) as { outcome: string; warnings: string[] };
    expect(failed).toBe(true);
    expect(forgotten.outcome).toBe("forgotten");
    expect(forgotten.warnings).toContainEqual(
      expect.stringContaining(
        "The forget was saved, but confirming it on disk failed",
      ),
    );
    expect((await store.read()).projects).toEqual([]);
    // No orphan was published again.
    expect(await blocksOf(w.routeFile)).toEqual([]);
  });
}

test("managed: an ordinary route change never writes into a file the route file was swapped for after the change read it", async () => {
  const w = await rigWorld("managed");
  await w.deployedThenStopped();
  const before = await w.routes();
  const other = await mkdtemp(join(tmpdir(), "rig-other-root-"));
  roots.push(other);
  const otherFile = join(other, "Caddyfile");
  const otherRoutes = `# rig begin ${"b".repeat(64)}\nother.test {\n  reverse_proxy 127.0.0.1:5000\n}\n# rig end ${"b".repeat(64)}\n`;
  await writeFile(otherFile, otherRoutes);
  // The settings Caddy accepted are read from Host config once the current generation records none, which a change does
  // after it read the route file: that is when the link is swapped in.
  const current = await w.managed!.current();
  const metadata = join(
    w.root,
    "caddy",
    "generations",
    current!,
    "generation.json",
  );
  const recorded = JSON.parse(await readFile(metadata, "utf8"));
  delete recorded.proxy;
  await writeFile(metadata, JSON.stringify(recorded));
  let reads = 0;
  w.managed!.control.beforeSettings = async () => {
    // The first read is reconcile's, before the change reads the route file; the second follows that read.
    if (++reads === 2) {
      await rm(w.routeFile);
      await symlink(otherFile, w.routeFile);
    }
  };
  await expect(
    w.runtime.command({ action: "forget", project: "ledger" }),
  ).rejects.toMatchObject({
    code: "ROUTE_CHANGED",
    message: expect.stringContaining("was not forgotten"),
  });
  expect(reads).toBeGreaterThanOrEqual(2);
  // The other root's routes are untouched, and the Project is still registered with its routes in its own file.
  expect(await readFile(otherFile, "utf8")).toBe(otherRoutes);
  expect(w.state.projects.map((p) => p.name)).toEqual(["ledger"]);
  w.managed!.control.beforeSettings = undefined;
  await rm(w.routeFile);
  await writeFile(w.routeFile, before);
  expect(await blocksOf(w.routeFile)).toHaveLength(2);
});

test("external: a withdrawal that took effect, then failed, and could not be put back is reported as a failed rollback naming the missing hostname", async () => {
  let afterRemoval = false;
  const w = await rigWorld("external", {
    router: (router) => ({
      ...router,
      async remove(key) {
        await router.remove(key);
        if (!afterRemoval) {
          afterRemoval = true;
          // The removal took effect; what follows it fails, and so does the reload that would put it back.
          w.failNextReloads(1);
          throw new Error("recording the removal failed");
        }
      },
    }),
  });
  await w.deployedThenStopped();
  const refused = (await w.runtime
    .command({ action: "forget", project: "ledger" })
    .catch((error: unknown) => error)) as RigError;
  // Read before toMatchObject, which leaves a matched message replaced by its matcher.
  expect(refused.message).toContain("recording the removal failed");
  expect(refused).toMatchObject({
    code: "FORGET_ROLLBACK",
    message: expect.stringContaining(
      "Project 'ledger' was not forgotten, and its routes could not all be put back.",
    ),
    hint: expect.stringContaining("rig up or rig deploy of"),
  });
  const missing = refused.details.hostnames as string[];
  expect(missing).toHaveLength(1);
  const routes = (await w.routes()).split("\n");
  expect(routes).not.toContain(`${missing[0]} {`);
  expect(w.state.projects.map((p) => p.name)).toEqual(["ledger"]);
});

test("a state write that fails and cannot be read back leaves the routes withdrawn and says the outcome is uncertain", async () => {
  const w = await rigWorld("external");
  await w.deployedThenStopped();
  const update = w.deps.store.update.bind(w.deps.store);
  const read = w.deps.store.read.bind(w.deps.store);
  let broken = false;
  w.deps.store.update = async (change) => {
    const probe = structuredClone(w.state);
    await change(probe);
    if (probe.projects.length === 0) {
      broken = true;
      throw new Error("state write failed");
    }
    await update(change);
  };
  w.deps.store.read = async () => {
    if (broken) throw new Error("state unreadable");
    return await read();
  };
  await expect(
    w.runtime.command({ action: "forget", project: "ledger" }),
  ).rejects.toMatchObject({ code: "FORGET_UNCERTAIN" });
  expect(await blocksOf(w.routeFile)).toEqual([]);
});
