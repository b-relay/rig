import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTargetEffects } from "../src/adapters/target-effects";
import { createArtifactInstaller } from "../src/providers/artifact-installer";
import { runCommand } from "../src/providers/command-runner";
import { createCaddyRouter } from "../src/providers/caddy-router";
import { createChildSupervisor } from "../src/providers/child-supervisor";
import {
  createProcessInspection,
  platformKill,
} from "../src/providers/process-inspection";
import { createProcessTiming } from "../src/providers/process-timing";
import { createTargetLifecycle } from "../src/runtime/lifecycle";
import { createRuntime } from "../src/runtime/application";
import { FileStateStore } from "../src/runtime/state-store";
import { intendRunning } from "../src/runtime/supervision";
import type { TargetRecord } from "../src/domain/runtime";
import { timerObservationDeadline } from "../src/runtime/bounded-observations";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import type {
  ManagedProcess,
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

const SERVICES = {
  api: { run: "api", ports: { http: 46011 } },
  worker: { run: "worker", restart: "on-failure", ports: { http: 46012 } },
  job: { run: "job", restart: "no", ports: { http: 46013 } },
};

/** The real lifecycle, effects and file state store over a scripted supervisor and clock.
 * `reopen()` is a new daemon: a new runtime over the same saved state and the same surviving processes. */
async function fixture(
  services: Record<
    string,
    {
      run: string;
      restart?: string;
      depends_on?: string[];
      ports: { http: number };
    }
  > = SERVICES,
  real?: (root: string) => Supervisor,
) {
  const root = await mkdtemp(join(tmpdir(), "rig-restart-policy-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  const config = parseProjectConfig({ name: "demo", services });
  const clock = { ms: Date.parse("2026-09-17T00:00:00.000Z") };
  const processes = new Map<string, ProcessObservation>();
  const starts: string[] = [];
  const refusal: {
    start?: (request: ManagedProcess) => boolean;
    /** The process is spawned and ends on its own before it is ready, leaving this evidence; `{}` is none. */
    dies?: (request: ManagedProcess) => { exitCode?: number } | undefined;
    stop?: (key: string) => boolean;
  } = {};
  const supervisor: Supervisor = {
    async observe(key) {
      return processes.get(key) ?? { state: "stopped" };
    },
    async ensureRunning(request) {
      if (processes.get(request.key)?.state === "running")
        return { outcome: "unchanged" };
      if (refusal.start?.(request)) throw new Error("spawn refused");
      starts.push(request.componentName);
      const death = refusal.dies?.(request);
      if (death)
        processes.set(request.key, {
          state: "stopped",
          ...("exitCode" in death ? { incarnation: request.incarnation } : {}),
          ...death,
        });
      else
        processes.set(request.key, {
          state: "running",
          pid: 1000 + starts.length,
          incarnation: request.incarnation,
        });
      return { outcome: "started" };
    },
    async stop(key) {
      if (refusal.stop?.(key)) throw new Error("stop could not be verified");
      const running = processes.get(key)?.state === "running";
      processes.delete(key);
      return { outcome: running ? "stopped" : "unchanged" };
    },
    async shutdown() {},
    async detach() {},
  };
  const effects = createTargetEffects({
    recordingTime: () => new Date(clock.ms).toISOString(),
    root,
    environment: {},
    supervisors: new Map([["rigd", real?.(root) ?? supervisor]]),
    installer: createArtifactInstaller({
      run: runCommand,
      bunExecutable: process.execPath,
    }),
    router: createCaddyRouter({
      caddyfile: join(root, "Caddyfile"),
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }),
    run: runCommand,
  });
  /** A grace above zero makes a start observe its process once before it counts as started. */
  const timing = {
    schedule(_delayMs: number, fire: () => void) {
      queueMicrotask(fire);
      return () => {};
    },
    startGraceMs: 0,
  };
  const store = new FileStateStore(root);
  const storeFailure: { update?: boolean } = {};
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
    store: {
      read: () => store.read(),
      async update(change: Parameters<FileStateStore["update"]>[0]) {
        if (storeFailure.update) throw new Error("state is not writable");
        await store.update(change);
      },
    },
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
        resolveTargetPlan(input, {
          operatorHome: "/home/operator",
          envRoot: join(root, "env"),
        }),
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
  let runtime = createRuntime(deps);
  await runtime.command({ action: "init", repoPath: repo });
  const target = async () => (await store.read()).targets[0]!;
  const key = async (service: string) => `${(await target()).id}:${service}`;
  const status = async () => {
    const report = (await runtime.command({
      action: "status",
      project: "demo",
    })) as { targets: { components: Record<string, unknown>[] }[] };
    return Object.fromEntries(
      report.targets[0]!.components.map((component) => [
        component.name as string,
        component,
      ]),
    );
  };
  return {
    clock,
    timing,
    starts,
    refusal,
    storeFailure,
    store,
    status,
    target,
    command: (action: "up" | "down" | "restart") =>
      runtime.command({ action, project: "demo" }),
    reconcile: () => runtime.reconcile(),
    supervise: () => runtime.supervise(),
    reopen() {
      runtime = createRuntime(deps);
    },
    /** The process ends with durable evidence of how. */
    async exit(
      service: string,
      exit: { exitCode?: number; signal?: string },
      incarnation?: string,
    ) {
      const k = await key(service);
      incarnation ??= processes.get(k)!.incarnation;
      processes.set(k, { state: "stopped", incarnation, ...exit });
    },
    /** The supervisor cannot tell whether the process runs. */
    async uncertain(service: string) {
      processes.set(await key(service), { state: "unknown" });
    },
    /** The process is gone and nothing recorded how. */
    async vanish(service: string) {
      processes.delete(await key(service));
    },
    async running(service: string) {
      return processes.get(await key(service))?.state === "running";
    },
  };
}

test("after a daemon restart only an eligible known exit retries: a no-policy exit and an unrecorded exit stay stopped and visible, and the surviving sibling is adopted", async () => {
  const f = await fixture();
  await f.command("up");
  expect(f.starts).toEqual(["api", "worker", "job"]);
  await f.exit("worker", { exitCode: 3 });
  await f.exit("job", { exitCode: 3 });

  f.reopen();
  // The first pass records the exits and schedules the one eligible retry; the pass at that time makes the attempt.
  expect(await f.reconcile()).toEqual({ nextRetryAt: f.clock.ms + 100 });
  expect(f.starts).toEqual(["api", "worker", "job"]);
  expect((await f.status()).worker).toMatchObject({ state: "starting" });
  f.clock.ms += 100;
  expect(await f.supervise()).toEqual({});
  expect(f.starts).toEqual(["api", "worker", "job", "worker"]);
  expect(await f.running("api")).toBe(true);
  expect(await f.running("job")).toBe(false);
  const status = await f.status();
  expect(status.api).toMatchObject({ state: "running" });
  expect(status.worker).toMatchObject({ state: "running" });
  expect(status.job).toMatchObject({
    state: "failed",
    exit: "failed",
    exitCode: 3,
  });
  expect(String(status.job!.reason)).toContain("restart policy is no");

  // The always Service disappears without an exit record: not a stop, not a failure, and never revived.
  await f.vanish("api");
  f.reopen();
  await f.reconcile();
  expect(f.starts).toEqual(["api", "worker", "job", "worker"]);
  const after = await f.status();
  expect(after.api).toMatchObject({ state: "failed", exit: "unknown" });
  expect(String(after.api!.reason)).toContain("rig up");
  expect(after.worker).toMatchObject({ state: "running" });
  const services = (await f.target()).services!;
  expect(services.api!.outcome).toMatchObject({ kind: "unknown" });
  expect(services.worker!.attempts).toHaveLength(1);
  expect(services.job!.outcome).toMatchObject({ kind: "exited", exitCode: 3 });

  // An explicit up starts every stopped Service under every policy.
  await f.command("up");
  expect(f.starts).toEqual(["api", "worker", "job", "worker", "api", "job"]);
});

/** Records what the pass at the current time sees, then runs the pass at the time the scheduled retry is due. */
async function settle(f: Awaited<ReturnType<typeof fixture>>) {
  const { nextRetryAt } = await f.supervise();
  if (nextRetryAt === undefined) return;
  f.clock.ms = nextRetryAt;
  await f.supervise();
}

for (const [name, exit, restarted] of [
  ["a clean exit", { exitCode: 0 }, ["api"]],
  ["a failure", { exitCode: 3 }, ["api", "worker"]],
  ["a signal nobody asked Rig for", { signal: "SIGKILL" }, ["api", "worker"]],
] as const)
  test(`${name} restarts exactly ${restarted.join(" and ")}`, async () => {
    const f = await fixture();
    await f.command("up");
    for (const service of ["api", "worker", "job"]) await f.exit(service, exit);
    await settle(f);
    expect(f.starts.slice(3)).toEqual([...restarted]);
    const status = await f.status();
    expect(status.job).toMatchObject({
      state: "exitCode" in exit && exit.exitCode === 0 ? "stopped" : "failed",
      exit: "exitCode" in exit && exit.exitCode === 0 ? "clean" : "failed",
      ...exit,
    });
    const activity = (await f.store.read()).activity.map(
      (entry) => `${entry.action}/${entry.outcome}`,
    );
    expect(
      activity.filter((entry) => entry === "restart/started"),
    ).toHaveLength(restarted.length);
  });

test("an exit record that names an earlier start proves nothing about this one: no retry, reported unknown", async () => {
  const f = await fixture();
  await f.command("up");
  await f.exit("api", { exitCode: 3 }, "an-earlier-incarnation");
  await settle(f);
  expect(f.starts).toHaveLength(3);
  expect((await f.status()).api).toMatchObject({
    state: "failed",
    exit: "unknown",
  });
});

test("five automatic attempts within 60 s exhaust the budget with doubling backoff; exhaustion survives a new daemon, an unchanged up keeps it, a restart resets it", async () => {
  const f = await fixture({ api: SERVICES.api });
  await f.command("up");
  const delays: number[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    await f.exit("api", { exitCode: 1 });
    const { nextRetryAt } = await f.supervise();
    delays.push(nextRetryAt! - f.clock.ms);
    // A pass before the backoff has passed starts nothing.
    f.clock.ms = nextRetryAt! - 1;
    expect(await f.supervise()).toEqual({ nextRetryAt });
    expect(f.starts).toHaveLength(1 + attempt);
    f.clock.ms = nextRetryAt!;
    await f.supervise();
    expect(f.starts).toHaveLength(2 + attempt);
  }
  expect(delays).toEqual([100, 200, 400, 800, 1600]);
  await f.exit("api", { exitCode: 1 });
  expect(await f.supervise()).toEqual({});
  expect(f.starts).toHaveLength(6);
  expect((await f.status()).api).toMatchObject({
    state: "failed",
    exitCode: 1,
  });
  expect(String((await f.status()).api!.reason)).toContain(
    "5 automatic restarts",
  );

  f.reopen();
  f.clock.ms += 120_000;
  expect(await f.reconcile()).toEqual({});
  expect(f.starts).toHaveLength(6);
  expect((await f.target()).services!.api).toMatchObject({ exhausted: true });

  await f.command("restart");
  expect(f.starts).toHaveLength(7);
  expect((await f.target()).services!.api).toMatchObject({ attempts: [] });
  expect((await f.target()).services!.api!.exhausted).toBeUndefined();
});

test("an up that finds the Service running keeps the attempts it already spent", async () => {
  const f = await fixture({ api: SERVICES.api });
  await f.command("up");
  await f.exit("api", { exitCode: 1 });
  await settle(f);
  expect((await f.target()).services!.api!.attempts).toHaveLength(1);
  await f.command("up");
  expect(f.starts).toHaveLength(2);
  expect((await f.target()).services!.api!.attempts).toHaveLength(1);
});

test("down cancels a scheduled retry: a pass at the old due time revives nothing, a repeated down changes nothing, and status says the stop was requested", async () => {
  const f = await fixture({ api: SERVICES.api });
  await f.command("up");
  await f.exit("api", { exitCode: 1 });
  const { nextRetryAt } = await f.supervise();
  expect(nextRetryAt).toBeDefined();
  await f.command("down");
  f.clock.ms = nextRetryAt!;
  expect(await f.supervise()).toEqual({});
  await f.command("down");
  f.reopen();
  expect(await f.reconcile()).toEqual({});
  expect(f.starts).toHaveLength(1);
  expect((await f.target()).services!.api!.retryAt).toBeUndefined();
  expect((await f.status()).api).toMatchObject({
    state: "stopped",
    exit: "requested",
  });
});

test("an exit whose record cannot be saved is not retried until it can be", async () => {
  const f = await fixture({ api: SERVICES.api });
  await f.command("up");
  await f.exit("api", { exitCode: 1 });
  f.storeFailure.update = true;
  f.clock.ms += 5000;
  expect(await f.supervise()).toEqual({});
  expect(f.starts).toHaveLength(1);
  expect((await f.target()).services!.api!.outcome).toBeUndefined();
  f.storeFailure.update = false;
  await settle(f);
  expect(f.starts).toHaveLength(2);
});

test("an automatic start that fails spends budget like any other, so a Service that cannot start ends exhausted, not retried forever", async () => {
  const f = await fixture({ api: SERVICES.api });
  await f.command("up");
  await f.exit("api", { exitCode: 1 });
  f.refusal.start = () => true;
  for (let pass = 0; pass < 12; pass++) {
    const { nextRetryAt } = await f.supervise();
    if (nextRetryAt === undefined) break;
    f.clock.ms = nextRetryAt;
  }
  expect(f.starts).toHaveLength(1);
  const run = (await f.target()).services!.api!;
  expect(run).toMatchObject({
    exhausted: true,
    outcome: { kind: "activation-failed" },
  });
  expect(run.attempts).toHaveLength(5);
  expect((await f.status()).api).toMatchObject({ state: "failed" });
  expect(
    (await f.store.read()).activity.filter(
      (entry) => entry.action === "restart" && entry.outcome === "failed",
    ),
  ).toHaveLength(6);
});

test("an explicit up that fails is never retried automatically", async () => {
  const f = await fixture({ api: SERVICES.api });
  f.refusal.start = () => true;
  await expect(f.command("up")).rejects.toThrow();
  f.refusal.start = undefined;
  f.clock.ms += 5000;
  await f.supervise();
  expect(f.starts).toEqual([]);
});

test("a Target with a pending deployment transition is left alone, and its transition stays recorded", async () => {
  const f = await fixture({ api: SERVICES.api });
  await f.command("up");
  await f.exit("api", { exitCode: 1 });
  const recovery = {
    plan: (await f.target()).plan,
    desired: "running" as const,
    stage: "pending" as const,
  };
  await f.store.update((state) => {
    state.targets[0]!.recovery = recovery as never;
  });
  f.clock.ms += 5000;
  expect(await f.supervise()).toEqual({});
  expect(await f.reconcile()).toEqual({});
  expect(f.starts).toHaveLength(1);
  expect((await f.target()).recovery).toMatchObject({ stage: "pending" });
  expect((await f.target()).services!.api!.outcome).toBeUndefined();
});

test("a Service is not started again while a Service it depends on is down", async () => {
  const f = await fixture({
    db: { run: "db", restart: "no", ports: { http: 46021 } },
    api: { run: "api", depends_on: ["db"], ports: { http: 46022 } },
  });
  await f.command("up");
  expect(f.starts).toEqual(["db", "api"]);
  await f.exit("db", { exitCode: 1 });
  await f.exit("api", { exitCode: 1 });
  await settle(f);
  expect(f.starts).toEqual(["db", "api"]);
  expect((await f.target()).services!.api!.outcome).toMatchObject({
    kind: "activation-failed",
    errorCode: "SERVICE_DEPENDENCY",
  });
});

test("smoke: a real process that fails under the rigd supervisor is recorded and started again by the next pass, as a new process", async () => {
  let supervisor!: Supervisor;
  const f = await fixture(
    {
      api: {
        run: "sleep 0.2; exit 3",
        restart: "on-failure",
        ports: { http: 46031 },
      },
    },
    (root) =>
      (supervisor = createChildSupervisor({
        stateRoot: root,
        timing: createProcessTiming(),
        processInspection: createProcessInspection({
          run: runCommand,
          kill: platformKill,
        }),
      })),
  );
  try {
    await f.command("up");
    const first = (await f.status()).api!.pid;
    expect(first).toBeGreaterThan(1);
    let due: number | undefined;
    for (let waited = 0; waited < 100 && due === undefined; waited++) {
      await Bun.sleep(50);
      due = (await f.supervise()).nextRetryAt;
    }
    expect((await f.target()).services!.api!.outcome).toMatchObject({
      kind: "exited",
      exitCode: 3,
    });
    f.clock.ms = due!;
    await f.supervise();
    const again = await f.status();
    expect(again.api).toMatchObject({ state: "running" });
    expect(again.api!.pid).not.toBe(first);
    expect((await f.target()).services!.api!.attempts).toHaveLength(1);
  } finally {
    await supervisor.shutdown();
  }
});

test("a Service whose sibling cannot be observed is still started again, and the sibling costs it no budget", async () => {
  const f = await fixture({
    api: { run: "api", ports: { http: 46031 } },
    other: { run: "other", ports: { http: 46032 } },
  });
  await f.command("up");
  await f.exit("api", { exitCode: 1 });
  await f.uncertain("other");
  await settle(f);
  expect(f.starts).toEqual(["api", "other", "api"]);
  expect((await f.target()).services!.api).toMatchObject({
    attempts: [expect.any(Number)],
  });
  expect((await f.target()).services!.api!.outcome).toBeUndefined();
});

test("an automatic start whose rollback cannot be verified leaves an unknown outcome: nothing starts it again", async () => {
  const f = await fixture({ api: { run: "api", ports: { http: 46041 } } });
  await f.command("up");
  await f.exit("api", { exitCode: 1 });
  f.timing.startGraceMs = 1;
  f.refusal.dies = () => ({});
  f.refusal.stop = () => true;
  await settle(f);
  expect(f.starts).toEqual(["api", "api"]);
  expect((await f.target()).services!.api!.outcome).toMatchObject({
    kind: "unknown",
  });
  delete f.refusal.dies;
  delete f.refusal.stop;
  f.clock.ms += 60_000;
  f.reopen();
  await f.reconcile();
  await settle(f);
  expect(f.starts).toEqual(["api", "api"]);
  expect((await f.status()).api).toMatchObject({
    state: "failed",
    exit: "unknown",
  });
});

test("an automatic start that ends on its own before it is ready is judged by its evidence: a recorded failure is tried again, an unrecorded end never is", async () => {
  const f = await fixture({ api: { run: "api", ports: { http: 46061 } } });
  await f.command("up");
  f.timing.startGraceMs = 1;
  await f.exit("api", { exitCode: 1 });
  f.refusal.dies = () => ({ exitCode: 5 });
  await settle(f);
  expect(f.starts).toEqual(["api", "api"]);
  expect((await f.target()).services!.api!.outcome).toMatchObject({
    kind: "exited",
    exitCode: 5,
  });
  f.refusal.dies = () => ({});
  await settle(f);
  expect(f.starts).toEqual(["api", "api", "api"]);
  expect((await f.target()).services!.api!.outcome).toMatchObject({
    kind: "unknown",
  });
  delete f.refusal.dies;
  f.clock.ms += 60_000;
  f.reopen();
  await f.reconcile();
  await settle(f);
  expect(f.starts).toEqual(["api", "api", "api"]);
  expect((await f.status()).api).toMatchObject({
    state: "failed",
    exit: "unknown",
  });
});

test("a Service a failed down left running keeps its record through the next up, so its later failure is still started again", async () => {
  const f = await fixture({ api: { run: "api", ports: { http: 46051 } } });
  await f.command("up");
  f.refusal.stop = () => true;
  await expect(f.command("down")).rejects.toBeDefined();
  delete f.refusal.stop;
  await f.command("up");
  expect(f.starts).toEqual(["api"]);
  expect((await f.target()).services!.api).toMatchObject({ intent: "running" });
  await f.exit("api", { exitCode: 3 });
  await settle(f);
  expect(f.starts).toEqual(["api", "api"]);
});

test("a successful up means every recorded Service to run again, also one a failed down left running and up therefore never started", () => {
  const target = {
    services: {
      api: { deployment: "/d", intent: "stopped", attempts: [1] },
      worker: { deployment: "/d", intent: "running", attempts: [] },
    },
  } as unknown as TargetRecord;
  intendRunning(target);
  expect(target.services).toEqual({
    api: { deployment: "/d", intent: "running", attempts: [1] },
    worker: { deployment: "/d", intent: "running", attempts: [] },
  });
});
