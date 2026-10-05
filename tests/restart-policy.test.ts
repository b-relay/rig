import { localActivation } from "./support/activation-doubles";
import { runtimeWorld } from "./support/runtime-world";
import { afterEach, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCommand } from "../src/providers/command-runner";
import { createChildSupervisor } from "../src/providers/child-supervisor";
import {
  createProcessInspection,
  platformKill,
} from "../src/providers/process-inspection";
import { createProcessTiming } from "../src/providers/process-timing";
import type { FileStateStore } from "../src/runtime/state-store";
import {
  intendRunning,
  restartBudget,
  UNKNOWN_EXIT_RESTART_BACKOFF_MS,
  UNKNOWN_EXIT_RESTART_LIMIT,
  UNKNOWN_EXIT_RESTART_WINDOW_MS,
} from "../src/runtime/supervision";
import type { TargetRecord } from "../src/domain/runtime";
import type {
  ManagedProcess,
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import { parseProjectConfig } from "../src/config";

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
      ready?: string;
      depends_on?: string[];
      ports: { http: number };
    }
  > = SERVICES,
  real?: (root: string) => Supervisor,
) {
  const config = parseProjectConfig({ name: "demo", services });
  const processes = new Map<string, ProcessObservation>();
  const starts: string[] = [];
  const refusal: {
    /** The supervisor fails the start; with an exit, the process had run and left this evidence first. */
    start?: (request: ManagedProcess) => boolean | { exitCode: number };
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
      const refused = refusal.start?.(request);
      if (typeof refused === "object")
        processes.set(request.key, {
          state: "stopped",
          incarnation: request.incarnation,
          ...refused,
        });
      if (refused) throw new Error("spawn refused");
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
  /** Ports something outside Rig listens on. */
  const occupied = new Set<number>();
  const storeFailure: { update?: boolean } = {};
  const world = await runtimeWorld({
    name: "restart-policy",
    config,
    supervisor: (root) => real?.(root) ?? supervisor,
    startsAt: "2026-09-17T00:00:00.000Z",
    // A readiness deadline is long enough for a real health command to answer.
    readinessDeadlineMs: 250,
    activation: {
      ...localActivation(
        Object.values(services).map((service) => service.ports.http),
      ),
      // A port answers while the fake process of the Service that declares it runs, or while something else holds it; a
      // real supervisor's process answers throughout.
      connect: async (port) =>
        real ||
        occupied.has(port) ||
        [...processes].some(
          ([key, observation]) =>
            observation.state === "running" &&
            services[key.slice(key.indexOf(":") + 1)]?.ports.http === port,
        )
          ? { ready: true }
          : { ready: false, reason: `port ${port}: ECONNREFUSED` },
    },
    dependencies: ({ store }) => ({
      store: {
        read: () => store.read(),
        async update(change: Parameters<FileStateStore["update"]>[0]) {
          if (storeFailure.update) throw new Error("state is not writable");
          await store.update(change);
        },
      },
    }),
  });
  roots.push(world.root);
  const { clock, timing, store } = world;
  let runtime = world.open();
  await runtime.command({ action: "init", repoPath: world.repo });
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
    occupied,
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
      runtime = world.open();
    },
    /** The process ends with durable evidence of how. */
    async exit(
      service: string,
      exit: Pick<ProcessObservation, "exitCode" | "signal" | "recordedBy">,
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

test("after a daemon restart an eligible known exit retries at once, a no-policy exit stays stopped, an unrecorded exit under always waits for the slower unknown-exit retry, and the surviving sibling is adopted", async () => {
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

  // The always Service disappears without an exit record: not a stop, not a failure, and not revived by the fast budget.
  await f.vanish("api");
  f.reopen();
  expect(await f.reconcile()).toEqual({
    nextRetryAt: f.clock.ms + UNKNOWN_EXIT_RESTART_BACKOFF_MS[0],
  });
  expect(f.starts).toEqual(["api", "worker", "job", "worker"]);
  const after = await f.status();
  expect(after.api).toMatchObject({ state: "starting", exit: "unknown" });
  expect(String(after.api!.reason)).toContain(
    "nothing recorded how it ended; under restart: always",
  );
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

test("an exit record that names an earlier start proves nothing about this one: it is an unknown exit, never retried under on-failure and retried under always only on the slower budget", async () => {
  const f = await fixture();
  await f.command("up");
  await f.exit("worker", { exitCode: 3 }, "an-earlier-incarnation");
  await f.exit("api", { exitCode: 3 }, "an-earlier-incarnation");
  expect(await f.supervise()).toEqual({
    nextRetryAt: f.clock.ms + UNKNOWN_EXIT_RESTART_BACKOFF_MS[0],
  });
  f.clock.ms += UNKNOWN_EXIT_RESTART_BACKOFF_MS[0];
  await f.supervise();
  expect(f.starts).toEqual(["api", "worker", "job", "api"]);
  expect((await f.status()).worker).toMatchObject({
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

test("an automatic start that never becomes ready is stopped by Rig and spends budget like any other, so it ends exhausted, not retried forever", async () => {
  const unready = join(tmpdir(), `rig-restart-policy-unready-${process.pid}`);
  roots.push(unready);
  const f = await fixture({
    api: { ...SERVICES.api, ready: `test ! -e '${unready}'` },
  });
  await f.command("up");
  await f.exit("api", { exitCode: 1 });
  await writeFile(unready, "");
  for (let pass = 0; pass < 12; pass++) {
    const { nextRetryAt } = await f.supervise();
    if (nextRetryAt === undefined) break;
    f.clock.ms = nextRetryAt;
  }
  expect(f.starts).toHaveLength(6);
  expect(await f.running("api")).toBe(false);
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

for (const [policy, after] of [
  ["on-failure", ["api"]],
  ["always", ["api", "api"]],
] as const)
  test(`an automatic start the supervisor fails leaves an unknown outcome, because nobody saw how that start ended; under ${policy} that is ${policy === "always" ? "retried on the unknown-exit budget" : "never retried"}`, async () => {
    const f = await fixture({ api: { ...SERVICES.api, restart: policy } });
    await f.command("up");
    await f.exit("api", { exitCode: 1 });
    f.refusal.start = () => true;
    await settle(f);
    expect((await f.target()).services!.api!.outcome).toMatchObject({
      kind: "unknown",
    });
    f.refusal.start = undefined;
    f.clock.ms += 60_000;
    f.reopen();
    await f.reconcile();
    await settle(f);
    expect(f.starts).toEqual([...after]);
    if (policy === "always")
      expect((await f.target()).services!.api).toMatchObject({
        unknownAttempts: [f.clock.ms],
        restartedAfterUnknown: true,
      });
    else expect((await f.status()).api).toMatchObject({ exit: "unknown" });
  });

test("an automatic start the supervisor fails after its process already left exit evidence is that known exit, and is tried again", async () => {
  const f = await fixture({ api: SERVICES.api });
  await f.command("up");
  await f.exit("api", { exitCode: 1 });
  f.refusal.start = () => ({ exitCode: 7 });
  await settle(f);
  expect((await f.target()).services!.api).toMatchObject({
    outcome: { kind: "exited", exitCode: 7 },
    attempts: [expect.any(Number)],
  });
  f.refusal.start = undefined;
  await settle(f);
  expect(f.starts).toEqual(["api", "api"]);
  expect(await f.running("api")).toBe(true);
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

test("a Service is not started again while a Service it depends on is down: it waits, visibly and without spending budget, however many passes run", async () => {
  const f = await fixture({
    db: { run: "db", restart: "no", ports: { http: 46021 } },
    api: { run: "api", depends_on: ["db"], ports: { http: 46022 } },
  });
  await f.command("up");
  expect(f.starts).toEqual(["db", "api"]);
  await f.exit("db", { exitCode: 1 });
  await f.exit("api", { exitCode: 1 });
  await settle(f);
  // The daemon's passes run every second; a minute of them changes nothing.
  for (let pass = 0; pass < 60; pass++) {
    f.clock.ms += 1000;
    await f.supervise();
  }
  expect(f.starts).toEqual(["db", "api"]);
  const api = (await f.target()).services!.api!;
  expect(api).toMatchObject({
    outcome: { kind: "exited", exitCode: 1 },
    attempts: [],
    waitingFor: { service: "db" },
  });
  expect(api.exhausted).toBeUndefined();
  const status = (await f.status()).api!;
  expect(status).toMatchObject({ state: "starting", exit: "failed" });
  expect(String(status.reason)).toContain(
    "waiting for db, which it depends on, to be running",
  );
  // One Activity entry says it waits; the passes add none.
  expect(
    (await f.store.read()).activity
      .filter((entry) => entry.action === "restart")
      .map((entry) => `${entry.outcome}: ${entry.message}`),
  ).toEqual([
    "unchanged: api is not started again yet: waiting for db, which it depends on, to be running. Waiting spends none of its automatic restarts.",
  ]);
});

test("a dependent Service killed together with its dependency waits for it instead of exhausting its budget, and starts in the pass that brings the dependency back", async () => {
  const f = await fixture({
    convex: { run: "convex", ports: { http: 46071 } },
    web: { run: "web", depends_on: ["convex"], ports: { http: 46072 } },
  });
  await f.command("up");
  // The incident: one SIGTERM ends both. The dependency's end went unrecorded; the dependent's was recorded.
  await f.vanish("convex");
  await f.exit("web", { signal: "SIGTERM" });
  const ended = f.clock.ms;
  expect(await f.supervise()).toEqual({ nextRetryAt: ended + 100 });
  // Passes every 100 ms until the dependency's unknown-exit retry is due: none spends web's budget.
  while (f.clock.ms < ended + UNKNOWN_EXIT_RESTART_BACKOFF_MS[0] - 100) {
    f.clock.ms += 100;
    await f.supervise();
  }
  expect(f.starts).toEqual(["convex", "web"]);
  expect((await f.target()).services!.web).toMatchObject({
    attempts: [],
    waitingFor: { service: "convex" },
  });
  f.clock.ms = ended + UNKNOWN_EXIT_RESTART_BACKOFF_MS[0];
  await f.supervise();
  expect(f.starts).toEqual(["convex", "web", "convex", "web"]);
  const services = (await f.target()).services!;
  expect(services.web).toMatchObject({ attempts: [f.clock.ms] });
  expect(services.web!.waitingFor).toBeUndefined();
  expect(services.web!.exhausted).toBeUndefined();
  expect(services.convex).toMatchObject({
    unknownAttempts: [f.clock.ms],
    restartedAfterUnknown: true,
  });
  const status = await f.status();
  expect(status.convex).toMatchObject({ state: "running" });
  expect(status.web).toMatchObject({ state: "running" });
  expect(
    (await f.store.read()).activity
      .filter((entry) => entry.action === "restart")
      .map((entry) => entry.outcome),
  ).toEqual(["unchanged", "started", "started"]);
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

test("an automatic start whose rollback cannot be verified leaves an unknown outcome: under on-failure nothing starts it again", async () => {
  const f = await fixture({
    api: { run: "api", restart: "on-failure", ports: { http: 46041 } },
  });
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

test("an automatic start that ends on its own before it is ready is judged by its evidence: under on-failure a recorded failure is tried again, an unrecorded end never is", async () => {
  const f = await fixture({
    api: { run: "api", restart: "on-failure", ports: { http: 46061 } },
  });
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

test("a Service under always whose process and wrapper vanished with no record anywhere is started again after the unknown-exit backoff, and Activity and status say it was an unknown exit that was restarted", async () => {
  const f = await fixture({ api: SERVICES.api });
  await f.command("up");
  await f.vanish("api");
  const ended = f.clock.ms;
  expect(await f.supervise()).toEqual({
    nextRetryAt: ended + UNKNOWN_EXIT_RESTART_BACKOFF_MS[0],
  });
  // Not on the 100 ms budget for known exits.
  f.clock.ms = ended + UNKNOWN_EXIT_RESTART_BACKOFF_MS[0] - 1;
  await f.supervise();
  expect(f.starts).toEqual(["api"]);
  f.clock.ms = ended + UNKNOWN_EXIT_RESTART_BACKOFF_MS[0];
  await f.supervise();
  expect(f.starts).toEqual(["api", "api"]);
  const run = (await f.target()).services!.api!;
  expect(run).toMatchObject({
    attempts: [],
    unknownAttempts: [f.clock.ms],
    restartedAfterUnknown: true,
  });
  expect(
    (await f.store.read()).activity
      .filter((entry) => ["exit", "restart"].includes(entry.action))
      .map((entry) => `${entry.action}/${entry.outcome}: ${entry.message}`),
  ).toEqual([
    "exit/failed: api is not running and nothing recorded how it ended; under restart: always it is started again once it is verified gone and its ports are free.",
    `restart/started: api ended with nothing recorded about how and was started again automatically (unknown exit, restarted: attempt 1 of ${UNKNOWN_EXIT_RESTART_LIMIT} within 10 min).`,
  ]);
  const status = (await f.status()).api!;
  expect(status).toMatchObject({ state: "running" });
  expect(String(status.reason)).toContain("(unknown exit, restarted)");
});

for (const policy of ["on-failure", "no"] as const)
  test(`an unknown exit is never started again under ${policy}`, async () => {
    const f = await fixture({ api: { ...SERVICES.api, restart: policy } });
    await f.command("up");
    await f.vanish("api");
    expect(await f.supervise()).toEqual({});
    for (let minute = 0; minute < 15; minute++) {
      f.clock.ms += 60_000;
      await f.supervise();
    }
    expect(f.starts).toEqual(["api"]);
    expect((await f.status()).api).toMatchObject({
      state: "failed",
      exit: "unknown",
    });
  });

test("unknown exits have their own budget: 3 attempts at 5 s, 1 min and 5 min, then the Service stays stopped, across a daemon restart too, until an explicit restart resets it", async () => {
  const f = await fixture({ api: SERVICES.api });
  await f.command("up");
  const delays: number[] = [];
  for (let attempt = 0; attempt < UNKNOWN_EXIT_RESTART_LIMIT; attempt++) {
    await f.vanish("api");
    const { nextRetryAt } = await f.supervise();
    delays.push(nextRetryAt! - f.clock.ms);
    f.clock.ms = nextRetryAt!;
    await f.supervise();
    expect(f.starts).toHaveLength(2 + attempt);
  }
  expect(delays).toEqual([...UNKNOWN_EXIT_RESTART_BACKOFF_MS]);
  await f.vanish("api");
  expect(await f.supervise()).toEqual({});
  expect((await f.target()).services!.api).toMatchObject({
    exhausted: true,
    outcome: { kind: "unknown" },
    attempts: [],
  });
  const status = (await f.status()).api!;
  expect(status).toMatchObject({ state: "failed", exit: "unknown" });
  expect(String(status.reason)).toContain(
    `after its ${UNKNOWN_EXIT_RESTART_LIMIT} automatic restarts for unknown exits within 10 min`,
  );
  f.reopen();
  f.clock.ms += 60 * 60_000;
  expect(await f.reconcile()).toEqual({});
  expect(f.starts).toHaveLength(4);
  await f.command("restart");
  expect(f.starts).toHaveLength(5);
  const reset = (await f.target()).services!.api!;
  expect(reset.exhausted).toBeUndefined();
  expect(reset.unknownAttempts).toBeUndefined();
  expect(reset.restartedAfterUnknown).toBeUndefined();
});

test("an unknown exit whose port still accepts connections is held back without spending budget, and started once the port is free", async () => {
  const f = await fixture({ api: SERVICES.api });
  await f.command("up");
  await f.vanish("api");
  f.occupied.add(SERVICES.api.ports.http);
  await settle(f);
  for (let pass = 0; pass < 30; pass++) {
    f.clock.ms += 1000;
    await f.supervise();
  }
  expect(f.starts).toEqual(["api"]);
  expect((await f.target()).services!.api).toMatchObject({
    waitingFor: { ports: [SERVICES.api.ports.http] },
    unknownAttempts: [],
  });
  expect(String((await f.status()).api!.reason)).toContain(
    `waiting for port ${SERVICES.api.ports.http}, which still accepts connections, to be free`,
  );
  f.occupied.clear();
  f.clock.ms += 1000;
  await f.supervise();
  expect(f.starts).toEqual(["api", "api"]);
  expect((await f.target()).services!.api!.waitingFor).toBeUndefined();
});

test("an exit only rigd's record of the capture wrapper holds is a known exit: it follows the normal policy and budget, and Activity names the witness", async () => {
  const f = await fixture();
  await f.command("up");
  for (const service of ["api", "worker", "job"])
    await f.exit(service, { signal: "SIGTERM", recordedBy: "rigd" });
  expect(await f.supervise()).toEqual({ nextRetryAt: f.clock.ms + 100 });
  f.clock.ms += 100;
  await f.supervise();
  expect(f.starts).toEqual(["api", "worker", "job", "api", "worker"]);
  expect(
    (await f.store.read()).activity.find(
      (entry) => entry.action === "crash" && entry.message?.startsWith("job"),
    )?.message,
  ).toBe(
    "job was ended by SIGTERM (from rigd's record of its capture wrapper).",
  );
  expect((await f.target()).services!.api).toMatchObject({
    attempts: [f.clock.ms],
  });
  expect((await f.status()).job).toMatchObject({
    state: "failed",
    exit: "failed",
    signal: "SIGTERM",
  });
});

test("stopped intent overrides a scheduled unknown-exit retry, in this daemon and the next", async () => {
  const f = await fixture({ api: SERVICES.api });
  await f.command("up");
  await f.vanish("api");
  const { nextRetryAt } = await f.supervise();
  expect(nextRetryAt).toBeDefined();
  await f.command("down");
  f.clock.ms = nextRetryAt!;
  expect(await f.supervise()).toEqual({});
  f.reopen();
  f.clock.ms += UNKNOWN_EXIT_RESTART_WINDOW_MS;
  expect(await f.reconcile()).toEqual({});
  expect(f.starts).toEqual(["api"]);
  expect((await f.status()).api).toMatchObject({
    state: "stopped",
    exit: "requested",
  });
});

test("a due unknown-exit retry starts nothing while the supervisor cannot show the old process is gone", async () => {
  const f = await fixture({ api: SERVICES.api });
  await f.command("up");
  await f.vanish("api");
  const { nextRetryAt } = await f.supervise();
  // The application turns out to outlive its wrapper, or its identity cannot be read: the observation is unknown.
  await f.uncertain("api");
  f.clock.ms = nextRetryAt!;
  expect(await f.supervise()).toEqual({});
  expect(f.starts).toEqual(["api"]);
  expect((await f.target()).services!.api!.unknownAttempts).toEqual([]);
});

test("a supervision scope that does not retry unknown exits leaves them stopped whatever the policy, and known exits keep their policy", () => {
  const unknown = { kind: "unknown", at: "" } as const;
  const failed = { kind: "exited", exitCode: 1, at: "" } as const;
  expect(restartBudget("always", unknown)).toBe("unknown-exit");
  expect(
    restartBudget("always", unknown, { retryUnknownExits: false }),
  ).toBeUndefined();
  expect(restartBudget("on-failure", unknown)).toBeUndefined();
  expect(restartBudget("always", failed, { retryUnknownExits: false })).toBe(
    "known-exit",
  );
});
