import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { FileStateStore } from "../src/runtime/state-store";
import { createRuntime } from "../src/runtime/application";
import { plannedRoutes } from "../src/runtime/ports";
import { controlledDeadline } from "./controlled-observation-deadline";
import { waitNotice } from "../src/cli/wait-notice";
import { engagedTargets } from "../src/runtime/alert-policy";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import type { ProcessObservation } from "../src/providers/contracts";
import type { TargetRecord } from "../src/domain/runtime";
import type { RuntimeCommand } from "../src/daemon/protocol";
import {
  parseHostConfig,
  parseProjectConfig,
  resolveTargetPlan as resolvePlanWithHost,
} from "../src/config";

// Every Project here lives under an isolated RIG_ROOT: a real state file, fake processes, no launchd, no Caddy.
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** A promise the test settles, for a step that must stay in progress (a Service ignoring SIGTERM) until released. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}
/** Resolves once `condition` holds; each check yields to pending work first. */
async function until(condition: () => boolean): Promise<void> {
  for (const deadline = Date.now() + 4000; Date.now() < deadline;) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition never held");
}
/** Resolves once rigd holds the Operation behind another one. */
async function waiting(
  runtime: { command(command: RuntimeCommand): Promise<unknown> },
  operation: string,
): Promise<void> {
  for (const deadline = Date.now() + 4000; Date.now() < deadline;) {
    const queue = (await runtime.command({ action: "queue", operation })) as {
      operation?: { state: string };
    };
    if (queue.operation?.state === "waiting") return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`${operation} never waited`);
}
/** Whether `promise` has settled by the time pending work has run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  return done;
}

async function fixture(host: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "rig-queue-"));
  roots.push(root);
  const store = new FileStateStore(root);
  let clock = Date.parse("2026-09-27T04:00:00.000Z");
  let ids = 0;
  const processes = new Map<string, ProcessObservation>();
  /** Stops that stay in progress until released, by Project name. */
  const heldStops = new Map<string, Promise<void>>();
  /** Automatic restarts that stay in progress until released, by Project name. */
  const heldRecoveries = new Map<string, Promise<void>>();
  /** Source checkouts that stay in progress until released, by Branch. */
  const heldCheckouts = new Map<string, Promise<void>>();
  const events: string[] = [];
  /** Each Project's rig.yaml revision; an edit bumps it and changes the Service command. */
  const revisions = new Map<string, number>();
  const config = (name: string) =>
    parseProjectConfig({
      name,
      services: {
        web: {
          run: `serve r${revisions.get(name) ?? 1}`,
          ports: { http: "auto" },
        },
      },
      proxy: { "/": "${services.web.ports.http}" },
      targets: { working: { domain: `${name}.test` } },
    });
  // A Project's repository is <root>/<name>; a deployed revision lives below it.
  const projectAt = (path: string) =>
    basename(path.slice(root.length + 1).split("/")[0]!);
  const key = (target: TargetRecord, service: string) =>
    `${target.id}:${service}`;
  const startAll = async (
    target: TargetRecord,
    journal?: { starting(service: string): Promise<string> },
  ) => {
    for (const component of target.plan.components)
      if (component.kind === "managed") {
        const incarnation = await journal?.starting(component.name);
        processes.set(key(target, component.name), {
          state: "running",
          ...(incarnation ? { incarnation } : {}),
        });
      }
  };
  const deps: RuntimeDependencies = {
    root,
    async readAdminActivity() {
      return [];
    },
    async inspectHost() {
      return [];
    },
    async inspectProxy() {
      return {
        proxyFile: join(root, "proxy", "Caddyfile"),
        routes: 0,
        state: "direct" as const,
      };
    },
    store,
    documents: {
      async initializationInfo(path) {
        return {
          name: basename(path),
          productionBranch: "main",
          gitRequired: false,
          existing: true,
        };
      },
      async identifyInitialization(path) {
        return { repoPath: path, name: basename(path) };
      },
      async discover(path) {
        return {
          repoPath: path,
          document: await this.read(path),
          gitRequired: false,
        };
      },
      async read(path) {
        return {
          path: `${path}/rig.yaml`,
          revision: `r${revisions.get(projectAt(path)) ?? 1}`,
          config: config(projectAt(path)),
        };
      },
      async initialize(path) {
        return await this.read(path);
      },
      async rename() {
        throw new Error("unused");
      },
      resolve: (input) =>
        resolvePlanWithHost(input, {
          operatorHome: "/home/operator",
          envRoot: join(root, "env"),
        }),
      async host() {
        return parseHostConfig(host);
      },
      async upgrade(): Promise<never> {
        throw new Error("rig config upgrade is not part of these tests");
      },
    },
    sources: {
      // The Commit is named after its Branch, so a test can hold one Branch's checkout.
      async preflight(input) {
        return { commit: input.branch, warnings: [] };
      },
      async prepare(request) {
        events.push(`checking out ${request.ref}`);
        await heldCheckouts.get(request.ref);
        events.push(`checkout ${request.ref}`);
        return {
          workspacePath: join(request.repository, "revisions", `${++ids}`),
          commit: "c1",
        };
      },
      async resolve() {
        return "c1";
      },
      async currentBranch() {
        return "main";
      },
      async release() {},
    },
    lifecycle: {
      async pruneCheckpoints() {
        return [];
      },
      async checkpoint(target) {
        return { targetId: target.id, async commit() {}, async rollback() {} };
      },
      async restoreEffects() {},
      async commitEffects() {},
      async retireSuperseded() {},
      async retire(target, publishRemoval) {
        await deps.lifecycle.down(target);
        await publishRemoval?.();
      },
      async prepare() {
        return { built: [] };
      },
      async up(target, _checkpoint, journal) {
        events.push(`up ${target.plan.project} ${target.name}`);
        await startAll(target, journal);
        return { outcome: "started" };
      },
      async recover(target, service, journal) {
        events.push(`recover ${target.plan.project} ${service}`);
        await heldRecoveries.get(target.plan.project);
        const incarnation = await journal.starting(service);
        processes.set(key(target, service), { state: "running", incarnation });
        return { outcome: "started" };
      },
      async stop() {
        return { outcome: "stopped" as const };
      },
      async down(target) {
        events.push(`stop ${target.plan.project} ${target.name}`);
        await heldStops.get(target.plan.project);
        for (const component of target.plan.components)
          processes.delete(key(target, component.name));
        events.push(`stopped ${target.plan.project} ${target.name}`);
        return { outcome: "stopped" };
      },
    },
    observations: {
      async process(target, component) {
        return (
          processes.get(key(target, component.name)) ?? { state: "stopped" }
        );
      },
      async health() {
        return { ready: true };
      },
      async artifact() {
        return "missing";
      },
      async listening() {
        return [];
      },
      async persistent() {
        return true;
      },
    },
    files: {
      async destroyPreview() {},
      async inspectPreviewDeletion() {},
      // Probing takes time, as binding a socket does; the lowest free port wins.
      async selectPorts({ requests, occupied }) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        const used = new Set(occupied.keys());
        const selected: Record<string, number> = {};
        for (const request of requests) {
          let port = request.preferred ?? 5000;
          while (used.has(port)) port++;
          used.add(port);
          selected[request.name] = port;
        }
        return selected;
      },
      async logs() {
        return { entries: [], cursor: "0" };
      },
    },
    observationBudgetMs: 2000,
    observationDeadline: controlledDeadline(),
    now: () => new Date(clock).toISOString(),
    id: () => `id${++ids}`,
    async diagnostic() {},
  };
  const hold = (map: Map<string, Promise<void>>, name: string) => {
    const held = gate();
    map.set(name, held.opened);
    return () => {
      map.delete(name);
      held.open();
    };
  };
  const register = async (...names: string[]) => {
    for (const name of names)
      await runtime.command({ action: "init", repoPath: join(root, name) });
  };
  const runtime = createRuntime(deps);
  return {
    root,
    deps,
    runtime,
    events,
    register,
    holdStop: (project: string) => hold(heldStops, project),
    /** Edits `project`'s rig.yaml. */
    edit(project: string) {
      revisions.set(project, (revisions.get(project) ?? 1) + 1);
    },
    holdRecovery: (project: string) => hold(heldRecoveries, project),
    holdCheckout: (branch: string) => hold(heldCheckouts, branch),
    /** The Service of `project`'s Working copy exits with code 1, as a crash does. */
    async crash(project: string) {
      const target = await working(project);
      const current = processes.get(key(target, "web"))!;
      processes.set(key(target, "web"), {
        state: "stopped",
        exitCode: 1,
        ...(current.incarnation ? { incarnation: current.incarnation } : {}),
      });
    },
    advance(ms: number) {
      clock += ms;
    },
    async targets() {
      return (await store.read()).targets;
    },
  };
  async function working(project: string): Promise<TargetRecord> {
    const state = await store.read();
    const id = state.projects.find((p) => p.name === project)!.id;
    return state.targets.find((t) => t.projectId === id && t.kind === "local")!;
  }
}

test("while one Project's down waits for its Service to exit, other Projects start, restart and restart automatically", async () => {
  const f = await fixture();
  await f.register("alpha", "beta", "gamma");
  for (const project of ["alpha", "beta", "gamma"])
    await f.runtime.command({ action: "up", project });
  const release = f.holdStop("alpha");
  const down = f.runtime.command({
    action: "down",
    project: "alpha",
    operationId: "alpha-down",
  });
  await until(() => f.events.includes("stop alpha local"));

  // Another Project's explicit lifecycle does not queue behind the stop.
  expect(
    await f.runtime.command({ action: "down", project: "beta" }),
  ).toMatchObject({ outcome: "stopped" });
  expect(
    await f.runtime.command({ action: "up", project: "beta" }),
  ).toMatchObject({ outcome: "started" });
  expect(
    await f.runtime.command({ action: "restart", project: "beta" }),
  ).toMatchObject({ outcome: "started" });

  // Nor does a third Project's automatic restart: the crash is recorded, then retried once its backoff passes.
  await f.crash("gamma");
  const { nextRetryAt } = await f.runtime.supervise();
  expect(nextRetryAt).toBeNumber();
  f.advance(1000);
  expect(await f.runtime.supervise()).toEqual({});
  expect(f.events).toContain("recover gamma web");

  // The stopping Target says so, and the stop is still in progress.
  const status = await f.runtime.status({ project: "alpha" });
  expect(status.targets[0]).toMatchObject({ name: "local", state: "stopping" });
  expect(
    await f.runtime.command({ action: "queue", operation: "alpha-down" }),
  ).toMatchObject({ operation: { state: "running", phase: "stopping" } });
  expect(await settled(down)).toBe(false);

  release();
  expect(await down).toMatchObject({ outcome: "stopped" });
  expect((await f.runtime.status({ project: "alpha" })).targets[0]!.state).toBe(
    "stopped",
  );
});

test("a second operation on a stopping Target waits for it, says what it waits for, and runs after it", async () => {
  const f = await fixture();
  await f.register("alpha");
  await f.runtime.command({ action: "up", project: "alpha" });
  const release = f.holdStop("alpha");
  const down = f.runtime.command({
    action: "down",
    project: "alpha",
    operationId: "alpha-down",
  });
  await until(() => f.events.includes("stop alpha local"));
  const up = f.runtime.command({
    action: "up",
    project: "alpha",
    operationId: "alpha-up",
  });
  await waiting(f.runtime, "alpha-up");
  const queue = await f.runtime.command({
    action: "queue",
    operation: "alpha-up",
  });
  expect(queue).toMatchObject({
    waiting: 1,
    operation: {
      state: "waiting",
      waitingOn: [
        {
          operationId: "alpha-down",
          action: "down",
          project: "alpha",
          target: "local",
          phase: "stopping",
        },
      ],
      ahead: 0,
    },
  });
  // What rig prints for it.
  expect(waitNotice(queue, new Date())).toStartWith(
    "Waiting: alpha local is stopping (operation alpha-down, started ",
  );
  release();
  await down;
  expect(await up).toMatchObject({ outcome: "started" });
  expect(f.events.slice(-3)).toEqual([
    "stop alpha local",
    "stopped alpha local",
    "up alpha local",
  ]);
});

test("Previews of one Project deploy side by side, and a Target of it that is stopping holds up only itself", async () => {
  const f = await fixture();
  await f.register("alpha");
  await f.runtime.command({ action: "up", project: "alpha" });
  const release = f.holdStop("alpha");
  const down = f.runtime.command({ action: "down", project: "alpha" });
  await until(() => f.events.includes("stop alpha local"));
  const releaseCheckout = f.holdCheckout("feature-a");
  const first = f.runtime.command({
    action: "deploy",
    project: "alpha",
    target: "preview",
    branch: "feature-a",
  });
  expect(
    await f.runtime.command({
      action: "deploy",
      project: "alpha",
      target: "preview",
      branch: "feature-b",
    }),
  ).toMatchObject({ outcome: "deployed" });
  expect(await settled(first)).toBe(false);
  releaseCheckout();
  expect(await first).toMatchObject({ outcome: "deployed" });
  expect(await settled(down)).toBe(false);
  release();
  await down;
});

test("the operator alert monitor sees every operation in flight: a Working copy's stop beside another Project's Stable deploy holds back only that Stable Target", async () => {
  const f = await fixture();
  await f.register("alpha", "beta");
  for (const project of ["alpha", "beta"]) {
    await f.runtime.command({ action: "up", project });
    await f.runtime.command({ action: "deploy", project, target: "live" });
  }
  const state = await f.deps.store.read();
  const stable = (project: string) =>
    state.targets.find(
      (t) =>
        t.kind === "live" &&
        state.projects.find((p) => p.id === t.projectId)?.name === project,
    )!.id;
  const releaseStop = f.holdStop("alpha");
  const down = f.runtime.command({
    action: "down",
    project: "alpha",
    operationId: "alpha-down",
  });
  await until(() => f.events.includes("stop alpha local"));
  const releaseCheckout = f.holdCheckout("main");
  const deploy = f.runtime.command({
    action: "deploy",
    project: "beta",
    target: "live",
    operationId: "beta-deploy",
  });
  await until(() => f.events.at(-1) === "checking out main");

  // Both run at once, and both are listed.
  expect(f.runtime.mutations()).toEqual([
    {
      operationId: "alpha-down",
      action: "down",
      project: "alpha",
      kind: "local",
    },
    {
      operationId: "beta-deploy",
      action: "deploy",
      project: "beta",
      target: "live",
      kind: "live",
    },
  ]);
  // The deploy holds back beta's Stable Target; the Working copy's stop leaves alpha's to be judged.
  expect(engagedTargets(f.runtime.mutations(), state)).toEqual(
    new Set([stable("beta")]),
  );

  releaseCheckout();
  expect(await deploy).toMatchObject({ outcome: "deployed" });
  expect(f.runtime.mutations().map((m) => m.operationId)).toEqual([
    "alpha-down",
  ]);
  expect(engagedTargets(f.runtime.mutations(), state)).toEqual(new Set());
  releaseStop();
  await down;
  expect(f.runtime.mutations()).toEqual([]);
});

test("two Projects started at once on auto ports get distinct ports and routes", async () => {
  const f = await fixture();
  await f.register("alpha", "beta", "gamma");
  const started = await Promise.all(
    ["alpha", "beta", "gamma"].map((project) =>
      f.runtime.command({ action: "up", project }),
    ),
  );
  expect(started).toMatchObject([
    { outcome: "started" },
    { outcome: "started" },
    { outcome: "started" },
  ]);
  const targets = await f.targets();
  const routes = targets.map((target) => ({
    domain: target.plan.domain,
    ports: plannedRoutes(target.plan).map((route) => route.port),
  }));
  expect(new Set(routes.map((route) => route.domain)).size).toBe(3);
  const ports = routes.flatMap((route) => route.ports);
  expect(ports).toHaveLength(3);
  expect(new Set(ports).size).toBe(3);
});

test("two new Previews deployed at once count against the Preview limit together; the oldest makes room", async () => {
  const f = await fixture({ deploy: { previews: { max: 2 } } });
  await f.register("alpha");
  await f.runtime.command({
    action: "deploy",
    project: "alpha",
    target: "preview",
    branch: "oldest",
  });
  f.advance(1000);
  const release = f.holdCheckout("feature-a");
  const first = f.runtime.command({
    action: "deploy",
    project: "alpha",
    target: "preview",
    branch: "feature-a",
  });
  await until(() => f.events.includes("checking out feature-a"));
  const second = f.runtime.command({
    action: "deploy",
    project: "alpha",
    target: "preview",
    branch: "feature-b",
  });
  release();
  const results = await Promise.all([first, second]);
  const previews = (await f.targets()).filter((t) => t.kind === "preview");
  expect(previews.map((t) => t.branch).sort()).toEqual([
    "feature-a",
    "feature-b",
  ]);
  expect(
    results.flatMap((result) => (result as { retired: unknown[] }).retired),
  ).toMatchObject([{ branch: "oldest", reason: "Preview limit" }]);
});

test("a new Preview deployed and finished while another deploy reads the state still counts against the Preview limit", async () => {
  const f = await fixture({ deploy: { previews: { max: 2 } } });
  await f.register("alpha");
  await f.runtime.command({
    action: "deploy",
    project: "alpha",
    target: "preview",
    branch: "oldest",
  });
  f.advance(1000);
  // feature-a's count reads the state as it is before feature-b is recorded, and gets the answer only after
  // feature-b has been deployed and its claim has ended.
  const store = f.deps.store;
  const read = store.read.bind(store);
  const preflight = f.deps.sources.preflight.bind(f.deps.sources);
  let armed = false;
  const paused = gate();
  const resume = gate();
  f.deps.sources.preflight = async (input) => {
    const result = await preflight(input);
    if (input.branch === "feature-a") armed = true;
    return result;
  };
  store.read = async () => {
    const state = await read();
    if (!armed) return state;
    armed = false;
    paused.open();
    await resume.opened;
    return state;
  };
  const first = f.runtime.command({
    action: "deploy",
    project: "alpha",
    target: "preview",
    branch: "feature-a",
  });
  await paused.opened;
  expect(
    await f.runtime.command({
      action: "deploy",
      project: "alpha",
      target: "preview",
      branch: "feature-b",
    }),
  ).toMatchObject({ outcome: "deployed", retired: [] });
  resume.open();
  expect(await first).toMatchObject({
    outcome: "deployed",
    retired: [{ branch: "oldest", reason: "Preview limit" }],
  });
  const previews = (await f.targets()).filter((t) => t.kind === "preview");
  expect(previews.map((t) => t.branch).sort()).toEqual([
    "feature-a",
    "feature-b",
  ]);
});

test("a slow automatic restart hands its Target over to its lease; the pass returns and other Targets are still supervised", async () => {
  const f = await fixture();
  const budget = controlledDeadline();
  f.deps.supervisionPassBudget = { ms: 2000, deadline: budget };
  await f.register("alpha", "beta");
  for (const project of ["alpha", "beta"])
    await f.runtime.command({ action: "up", project });
  await f.crash("alpha");
  await f.crash("beta");
  // The first pass records both exits and schedules their restarts.
  const first = f.runtime.supervise();
  await until(() => budget.pending);
  await first;
  f.advance(1000);
  const release = f.holdRecovery("alpha");
  const second = f.runtime.supervise();
  await until(() => f.events.includes("recover beta web"));
  await until(() => f.events.includes("recover alpha web"));
  expect(await settled(second)).toBe(false);
  budget.expire();
  expect(await second).toEqual({});
  // alpha's restart still holds alpha: an operator's down waits behind it and says so.
  const down = f.runtime.command({
    action: "down",
    project: "alpha",
    operationId: "alpha-down",
  });
  await waiting(f.runtime, "alpha-down");
  expect(
    await f.runtime.command({ action: "queue", operation: "alpha-down" }),
  ).toMatchObject({
    operation: {
      state: "waiting",
      waitingOn: [{ action: "supervise", project: "alpha", target: "local" }],
    },
  });
  // A later pass skips alpha while its restart runs and is not held up by it.
  expect(await f.runtime.supervise()).toEqual({});
  release();
  expect(await down).toMatchObject({ outcome: "stopped" });
});

test("reconcile at daemon start stops Targets side by side, ahead of commands for them, without holding up other Projects", async () => {
  const f = await fixture();
  await f.register("alpha", "beta");
  for (const project of ["alpha", "beta"])
    await f.runtime.command({ action: "up", project });
  await f.runtime.command({ action: "down", project: "alpha" });
  await f.runtime.command({ action: "down", project: "beta" });
  // A new daemon over the same RIG_ROOT: alpha's Service ignores SIGTERM this time.
  const budget = controlledDeadline();
  const restarted = createRuntime({
    ...f.deps,
    supervisionPassBudget: { ms: 2000, deadline: budget },
  });
  const release = f.holdStop("alpha");
  const reconcile = restarted.reconcile();
  const upAlpha = restarted.command({
    action: "up",
    project: "alpha",
    operationId: "alpha-up",
  });
  await until(() => f.events.includes("stopped beta local"));
  await waiting(restarted, "alpha-up");
  // beta's reconcile is done, so beta is free while alpha is still stopping.
  expect(
    await restarted.command({ action: "up", project: "beta" }),
  ).toMatchObject({ outcome: "started" });
  budget.expire();
  expect(await reconcile).toEqual({});
  expect(
    await restarted.command({ action: "queue", operation: "alpha-up" }),
  ).toMatchObject({
    operation: {
      state: "waiting",
      waitingOn: [{ action: "reconcile", target: "local", phase: "stopping" }],
    },
  });
  release();
  expect(await upAlpha).toMatchObject({ outcome: "started" });
});

test("a drain waits for the running stop and refuses the command queued behind it", async () => {
  const f = await fixture();
  await f.register("alpha");
  await f.runtime.command({ action: "up", project: "alpha" });
  const release = f.holdStop("alpha");
  const down = f.runtime.command({ action: "down", project: "alpha" });
  await until(() => f.events.includes("stop alpha local"));
  const up = f.runtime.command({ action: "up", project: "alpha" });
  const drained = f.runtime.drain();
  expect(await settled(drained)).toBe(false);
  release();
  await drained;
  expect(await down).toMatchObject({ outcome: "stopped" });
  await expect(up).rejects.toMatchObject({ code: "DAEMON_DRAINING" });
});

test("a config edit never waits for a Target's stop, only for another edit of the same Project", async () => {
  const f = await fixture();
  await f.register("alpha", "beta");
  await f.runtime.command({ action: "up", project: "alpha" });
  const release = f.holdStop("alpha");
  const down = f.runtime.command({ action: "down", project: "alpha" });
  await until(() => f.events.includes("stop alpha local"));
  expect(await f.runtime.exclusive("alpha", async () => "edited")).toBe(
    "edited",
  );
  const writing = gate();
  let editing = false;
  const first = f.runtime.exclusive("alpha", async () => {
    editing = true;
    await writing.opened;
  });
  await until(() => editing);
  const second = f.runtime.exclusive("alpha", async () => "second");
  expect(await f.runtime.exclusive("beta", async () => "beta")).toBe("beta");
  expect(await settled(second)).toBe(false);
  writing.open();
  await first;
  expect(await second).toBe("second");
  release();
  await down;
});

test("init of a registered Project never waits for a Target's stop, nor holds the Project's other Targets behind it", async () => {
  const f = await fixture();
  await f.register("alpha");
  await f.runtime.command({ action: "up", project: "alpha" });
  const release = f.holdStop("alpha");
  const down = f.runtime.command({ action: "down", project: "alpha" });
  await until(() => f.events.includes("stop alpha local"));
  const init = f.runtime.command({
    action: "init",
    repoPath: join(f.root, "alpha"),
  });
  const preview = f.runtime.command({
    action: "deploy",
    project: "alpha",
    target: "preview",
    branch: "feature-a",
  });
  expect(await init).toMatchObject({ outcome: "registered" });
  expect(await preview).toMatchObject({ outcome: "deployed" });
  expect(await settled(down)).toBe(false);
  release();
  expect(await down).toMatchObject({ outcome: "stopped" });
});

test("an up that waited behind a stop plans from rig.yaml as it is once admitted", async () => {
  const f = await fixture();
  await f.register("alpha");
  await f.runtime.command({ action: "up", project: "alpha" });
  const release = f.holdStop("alpha");
  const down = f.runtime.command({ action: "down", project: "alpha" });
  await until(() => f.events.includes("stop alpha local"));
  const up = f.runtime.command({
    action: "up",
    project: "alpha",
    operationId: "alpha-up",
  });
  await waiting(f.runtime, "alpha-up");
  f.edit("alpha");
  release();
  await down;
  expect(await up).toMatchObject({ outcome: "started" });
  const [target] = await f.targets();
  expect(target!.configRevision).toBe("r2");
  expect(target!.plan.components[0]).toMatchObject({ command: "serve r2" });
});

test("a registration change refuses at once while a Target of its Project is mid-transition, rather than queueing", async () => {
  const f = await fixture();
  await f.register("alpha");
  await f.runtime.command({
    action: "deploy",
    project: "alpha",
    target: "preview",
    branch: "feature-a",
  });
  const release = f.holdStop("alpha");
  const destroy = f.runtime.command({
    action: "destroy",
    project: "alpha",
    target: "preview",
    branch: "feature-a",
  });
  await until(() => f.events.some((e) => e.startsWith("stop alpha feature-a")));
  await expect(
    f.runtime.command({ action: "forget", project: "alpha" }),
  ).rejects.toMatchObject({ code: "PROJECT_ACTIVE" });
  release();
  expect(await destroy).toMatchObject({ outcome: "stopped" });
});

test("a registration change or uninstall refuses at once while a plain down is waiting for its Service to exit", async () => {
  const f = await fixture();
  await f.register("alpha", "beta");
  await f.runtime.command({ action: "up", project: "alpha" });
  const release = f.holdStop("alpha");
  // down records the Target stopped before it waits, so only the running operation shows it is busy.
  const down = f.runtime.command({ action: "down", project: "alpha" });
  await until(() => f.events.includes("stop alpha local"));
  for (const command of [
    { action: "forget", project: "alpha" },
    { action: "repoint", project: "alpha", newPath: join(f.root, "alpha") },
  ] as const)
    await expect(f.runtime.command(command)).rejects.toMatchObject({
      code: "PROJECT_ACTIVE",
    });
  await expect(
    f.runtime.command({ action: "prepare-uninstall" }),
  ).rejects.toMatchObject({ code: "TARGETS_RUNNING" });
  // Nothing was left queued: beta and alpha's other Targets are free.
  expect(await f.runtime.command({ action: "queue" })).toMatchObject({
    waiting: 0,
  });
  expect(
    await f.runtime.command({ action: "up", project: "beta" }),
  ).toMatchObject({ outcome: "started" });
  release();
  await down;
});

test("a command that arrives while the daemon's first pass holds the Host says it waits for that pass", async () => {
  const f = await fixture();
  await f.register("alpha");
  const pruning = gate();
  f.deps.lifecycle.pruneCheckpoints = async () => {
    await pruning.opened;
    return [];
  };
  const reconcile = f.runtime.reconcile();
  const up = f.runtime.command({
    action: "up",
    project: "alpha",
    operationId: "alpha-up",
  });
  await waiting(f.runtime, "alpha-up");
  const queue = await f.runtime.command({
    action: "queue",
    operation: "alpha-up",
  });
  expect(waitNotice(queue, new Date())).toStartWith(
    "Waiting: rigd is checking every Target after it started (operation reconcile:",
  );
  pruning.open();
  await reconcile;
  expect(await up).toMatchObject({ outcome: "started" });
});
