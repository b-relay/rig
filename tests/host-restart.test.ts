import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localActivation } from "./support/activation-doubles";
import { createTargetEffects } from "../src/adapters/target-effects";
import { createArtifactInstaller } from "../src/providers/artifact-installer";
import { runCommand } from "../src/providers/command-runner";
import { createCaddyRouter } from "../src/providers/caddy-router";
import { createTargetLifecycle } from "../src/runtime/lifecycle";
import { createRuntime } from "../src/runtime/application";
import { FileStateStore } from "../src/runtime/state-store";
import { timerObservationDeadline } from "../src/runtime/bounded-observations";
import { UNKNOWN_EXIT_RESTART_BACKOFF_MS } from "../src/runtime/supervision";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import type { HostSession } from "../src/domain/host-session";
import type {
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import {
  parseHostConfig,
  parseProjectConfig,
  resolveTargetPlan,
} from "../src/config";

// Every daemon here runs under an isolated RIG_ROOT: a real state file and lifecycle, scripted processes and Host session,
// no launchd, no sysctl, no Caddy.
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** api depends on db and is listed first, so a start in dependency order is visible; the three policies all appear. */
const SERVICES = {
  api: { run: "api", depends_on: ["db"] },
  db: { run: "db", restart: "no" },
  worker: { run: "worker", restart: "on-failure" },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rig-host-restart-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  const config = parseProjectConfig({ name: "demo", services: SERVICES });
  const clock = { ms: Date.parse("2026-09-27T08:00:00.000Z") };
  const processes = new Map<string, ProcessObservation>();
  /** Process keys (`<target id>:<service>`) in the order they were started. */
  const starts: string[] = [];
  const refusal: { start?: (key: string) => boolean } = {};
  const supervisor: Supervisor = {
    async observe(key) {
      return processes.get(key) ?? { state: "stopped" };
    },
    async ensureRunning(request) {
      if (processes.get(request.key)?.state === "running")
        return { outcome: "unchanged" };
      if (refusal.start?.(request.key)) throw new Error("spawn refused");
      starts.push(request.key);
      processes.set(request.key, {
        state: "running",
        pid: 1000 + starts.length,
        incarnation: request.incarnation,
      });
      return { outcome: "started" };
    },
    async stop(key) {
      const running = processes.get(key)?.state === "running";
      processes.delete(key);
      return { outcome: running ? "stopped" : "unchanged" };
    },
    async shutdown() {},
    async detach() {},
  };
  const effects = createTargetEffects({
    ...localActivation(),
    recordingTime: () => new Date(clock.ms).toISOString(),
    root,
    environment: {},
    supervisors: new Map([["rigd", supervisor]]),
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
  const timing = {
    schedule(delayMs: number, fire: () => void) {
      const timer = setTimeout(fire, delayMs < 1000 ? 0 : 250);
      return () => clearTimeout(timer);
    },
    startGraceMs: 0,
  };
  const store = new FileStateStore(root);
  /** What the scripted Host reports as its boot and GUI login; a test changes it to restart the Host. */
  const host: { session: HostSession; hold?: Promise<void> } = {
    session: {
      boot: "BOOT-1",
      bootedAt: "2026-09-26T07:00:00.000Z",
      login: "100002",
    },
  };
  let id = 0;
  const deps = {
    root,
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
    store,
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
    sources: {
      async preflight(input: { branch: string }) {
        return { commit: `c-${input.branch}`, warnings: [] };
      },
      async prepare(request: { destination: string }) {
        await mkdir(request.destination, { recursive: true });
        return { workspacePath: request.destination, commit: "c1" };
      },
      async resolve() {
        return "c1";
      },
      async currentBranch() {
        return "feature";
      },
      async release() {},
    },
    lifecycle: createTargetLifecycle(effects, timing),
    observations: effects.observations,
    observationBudgetMs: 2000,
    observationDeadline: timerObservationDeadline,
    files: {
      async selectPorts() {
        return {};
      },
    },
    hostSession: {
      async current() {
        await host.hold;
        return { ...host.session };
      },
    },
    now: () => new Date(clock.ms).toISOString(),
    id: () => `id${++id}`,
    async diagnostic() {},
  } as unknown as RuntimeDependencies;
  let runtime = createRuntime(deps);
  await runtime.command({ action: "init", repoPath: repo });
  const targetId = async (kind: "local" | "live" | "preview") =>
    (await store.read()).targets.find((t) => t.kind === kind)!.id;
  const f = {
    clock,
    host,
    processes,
    refusal,
    store,
    /** A new daemon over the same saved state and whatever processes survived. */
    reopen() {
      runtime = createRuntime(deps);
    },
    reconcile: () => runtime.reconcile(),
    drain: () => runtime.drain(),
    supervise: () => runtime.supervise(),
    command: (command: Parameters<typeof runtime.command>[0]) =>
      runtime.command(command),
    /** The Working copy, the Stable Target and a Preview, all running. */
    async startAll() {
      await runtime.command({ action: "up", project: "demo" });
      await runtime.command({
        action: "deploy",
        project: "demo",
        target: "live",
      });
      await runtime.command({
        action: "deploy",
        project: "demo",
        target: "preview",
        branch: "feature",
      });
    },
    /** The Host restarts: every process is gone, and the boot (or only the login) is new. */
    restartHost(session: HostSession) {
      processes.clear();
      host.session = session;
    },
    /** The Services of `kind` that run now. */
    async running(kind: "local" | "live" | "preview") {
      const prefix = `${await targetId(kind)}:`;
      return [...processes]
        .filter(
          ([key, seen]) => key.startsWith(prefix) && seen.state === "running",
        )
        .map(([key]) => key.slice(prefix.length))
        .sort();
    },
    /** The Services of `kind` started since `from`, in order. */
    async startedSince(kind: "local" | "live" | "preview", from: number) {
      const prefix = `${await targetId(kind)}:`;
      return starts
        .slice(from)
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length));
    },
    starts,
    async key(kind: "local" | "live" | "preview", service: string) {
      return `${await targetId(kind)}:${service}`;
    },
    async status(kind: "local" | "live" | "preview") {
      const name = (await store.read()).targets.find(
        (t) => t.kind === kind,
      )!.name;
      const report = (await runtime.command({
        action: "status",
        project: "demo",
      })) as {
        targets: { name: string; components: Record<string, unknown>[] }[];
      };
      return Object.fromEntries(
        report.targets
          .find((t) => t.name === name)!
          .components.map((component) => [component.name as string, component]),
      );
    },
    /** Activity recorded after the first `from` entries, as `action/outcome target`. */
    async activitySince(from: number) {
      return (await store.read()).activity
        .slice(from)
        .map(
          (entry) => `${entry.action}/${entry.outcome} ${entry.target ?? "-"}`,
        );
    },
    async activityCount() {
      return (await store.read()).activity.length;
    },
  };
  // The first daemon records the session it runs in; with nothing recorded before it, it detects nothing.
  await f.reconcile();
  return f;
}

const REBOOTED: HostSession = {
  boot: "BOOT-2",
  bootedAt: "2026-09-27T07:59:00.000Z",
  login: "100002",
};

test("the first daemon to record a Host session detects nothing and records the session", async () => {
  const f = await fixture();
  expect((await f.store.read()).host).toMatchObject({
    boot: "BOOT-1",
    login: "100002",
  });
  expect(await f.activitySince(0)).toEqual(["init/registered -"]);
});

test("after a reboot every Stable Target meant to run comes back in dependency order, with one Host-restarted event and one start per Target, while the Working copy and Previews stay stopped", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  const startsBefore = f.starts.length;

  f.restartHost(REBOOTED);
  f.reopen();
  expect(await f.reconcile()).toEqual({});

  expect(await f.startedSince("live", startsBefore)).toEqual([
    "db",
    "api",
    "worker",
  ]);
  expect(await f.running("live")).toEqual(["api", "db", "worker"]);
  expect(await f.running("local")).toEqual([]);
  expect(await f.running("preview")).toEqual([]);
  const activity = await f.activitySince(before);
  expect(activity).toEqual(["host-restart/stopped -", "up/started live"]);
  const entries = (await f.store.read()).activity.slice(before);
  expect(entries[0]!.message).toContain("The Mac restarted");
  expect(entries[1]!.message).toContain("restarted after reboot");
  // The session is recorded once rigd has acted on it.
  expect((await f.store.read()).host).toMatchObject({ boot: "BOOT-2" });

  const live = await f.status("live");
  expect(live.api).toMatchObject({ state: "running" });
  expect(String(live.api!.reason)).toContain("restarted after reboot");
  const local = await f.status("local");
  for (const service of ["api", "db", "worker"]) {
    expect(local[service]).toMatchObject({ state: "stopped", exit: "unknown" });
    expect(String(local[service]!.reason)).toContain(
      "It stopped when the Mac restarted",
    );
    expect(String(local[service]!.reason)).toContain("Run rig up");
  }
  expect((await f.status("preview")).api).toMatchObject({ state: "stopped" });

  // api is under restart: always, yet no unknown-exit retry brings the Working copy or the Preview back: not in any later
  // pass, and not after a plain daemon restart in the same session.
  for (const delay of [...UNKNOWN_EXIT_RESTART_BACKOFF_MS, 600_000]) {
    f.clock.ms += delay;
    await f.supervise();
  }
  f.reopen();
  await f.reconcile();
  await f.supervise();
  expect(await f.running("local")).toEqual([]);
  expect(await f.running("preview")).toEqual([]);
  expect(await f.activitySince(before)).toEqual([
    "host-restart/stopped -",
    "up/started live",
  ]);
});

test("the precedence over unknown-exit retries ends with the next explicit start: rig up brings the Working copy back, and a later unknown exit is retried as before", async () => {
  const f = await fixture();
  await f.startAll();
  f.restartHost(REBOOTED);
  f.reopen();
  await f.reconcile();

  await f.command({ action: "up", project: "demo" });
  expect(await f.running("local")).toEqual(["api", "db", "worker"]);
  expect((await f.status("local")).api).toMatchObject({ state: "running" });

  // The Working copy's api vanishes on its own (not a Host restart): #274's slower retry applies again.
  f.processes.delete(await f.key("local", "api"));
  const from = f.starts.length;
  const { nextRetryAt } = await f.supervise();
  expect(nextRetryAt).toBe(f.clock.ms + UNKNOWN_EXIT_RESTART_BACKOFF_MS[0]);
  f.clock.ms = nextRetryAt!;
  await f.supervise();
  expect(await f.startedSince("local", from)).toEqual(["api"]);
});

test("a daemon restart without a Host restart keeps today's behavior: nothing is started as after a reboot, and unknown exits follow each Service's policy", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  const startsBefore = f.starts.length;
  // Every process vanishes with the same boot and login: the outside-SIGTERM case of #274, not a Host restart.
  f.processes.clear();
  f.reopen();
  expect(await f.reconcile()).toEqual({
    nextRetryAt: f.clock.ms + UNKNOWN_EXIT_RESTART_BACKOFF_MS[0],
  });
  expect(f.starts.length).toBe(startsBefore);
  const activity = await f.activitySince(before);
  expect(activity.filter((entry) => entry.startsWith("host-restart"))).toEqual(
    [],
  );
  expect(activity.filter((entry) => entry.startsWith("up/"))).toEqual([]);
  for (const kind of ["local", "live"] as const) {
    const status = await f.status(kind);
    // Under always the unknown exit is scheduled for the slower retry; under no and on-failure it stays failed.
    expect(status.api).toMatchObject({ state: "starting", exit: "unknown" });
    expect(status.db).toMatchObject({ state: "failed", exit: "unknown" });
    expect(status.worker).toMatchObject({ state: "failed", exit: "unknown" });
  }
});

test("a new login in the same boot is a Host restart too: Stable Targets come back and the Working copy's survivor is left alone", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  // A process of the Working copy survived the logout; everything else ended with the login session.
  const survivor = await f.key("local", "worker");
  const kept = f.processes.get(survivor)!;
  f.restartHost({ ...f.host.session, login: "100019" });
  f.processes.set(survivor, kept);
  f.reopen();
  await f.reconcile();

  expect(await f.running("live")).toEqual(["api", "db", "worker"]);
  expect(await f.running("local")).toEqual(["worker"]);
  expect(await f.activitySince(before)).toEqual([
    "host-restart/stopped -",
    "up/started live",
  ]);
  const entries = (await f.store.read()).activity.slice(before);
  expect(entries[0]!.message).toContain("You logged out and in again");
  expect(String((await f.status("live")).api!.reason)).toContain(
    "restarted after login",
  );
  const local = await f.status("local");
  expect(local.worker).toMatchObject({ state: "running" });
  expect(String(local.api!.reason)).toContain(
    "It stopped when you logged out and in again",
  );
  expect((await f.store.read()).host).toMatchObject({ login: "100019" });
});

test("a Stable Target meant to be stopped stays stopped after a reboot", async () => {
  const f = await fixture();
  await f.startAll();
  await f.command({ action: "down", project: "demo", target: "live" });
  const before = await f.activityCount();
  f.restartHost(REBOOTED);
  f.reopen();
  await f.reconcile();
  expect(await f.running("live")).toEqual([]);
  expect(await f.activitySince(before)).toEqual(["host-restart/stopped -"]);
  expect((await f.status("live")).api).toMatchObject({
    state: "stopped",
    exit: "requested",
  });
});

test("a Stable Target that fails to come back after a reboot keeps a failed status and stays meant to run", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  f.restartHost(REBOOTED);
  const db = await f.key("live", "db");
  f.refusal.start = (key) => key === db;
  f.reopen();
  await f.reconcile();

  expect(await f.running("live")).toEqual([]);
  expect(await f.activitySince(before)).toEqual([
    "host-restart/stopped -",
    "up/failed live",
  ]);
  const live = (await f.store.read()).targets.find((t) => t.kind === "live")!;
  expect(live.desired).toBe("running");
  // Every Service the failed start left stopped is failed, not retried: not even api under always once db could start.
  f.refusal.start = undefined;
  for (const delay of [...UNKNOWN_EXIT_RESTART_BACKOFF_MS, 600_000]) {
    f.clock.ms += delay;
    await f.supervise();
  }
  expect(await f.running("live")).toEqual([]);
  const status = await f.status("live");
  for (const service of ["api", "db", "worker"]) {
    expect(status[service]).toMatchObject({ state: "failed" });
    expect(String(status[service]!.reason)).toContain("The last start failed");
  }
  await f.command({ action: "up", project: "demo", target: "live" });
  expect(await f.running("live")).toEqual(["api", "db", "worker"]);
});

test("a first pass that could not act on the restart for every Target leaves it to the next daemon, which acts on it without recording it twice", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  f.restartHost(REBOOTED);
  f.reopen();
  // rigd is asked to stop while its first pass is still reading the Host session.
  let release!: () => void;
  f.host.hold = new Promise<void>((resolve) => (release = resolve));
  const reconciling = f.reconcile();
  const draining = f.drain();
  release();
  await reconciling;
  await draining;
  expect(await f.running("live")).toEqual([]);
  expect((await f.store.read()).host).toMatchObject({ boot: "BOOT-1" });

  f.host.hold = undefined;
  f.reopen();
  await f.reconcile();
  expect(await f.running("live")).toEqual(["api", "db", "worker"]);
  expect(await f.activitySince(before)).toEqual([
    "host-restart/stopped -",
    "up/started live",
  ]);
  const host = (await f.store.read()).host!;
  expect(host).toMatchObject({ boot: "BOOT-2" });
  expect(host.restart).toBeUndefined();
});

test("after a reboot an outcome that already kept a Working copy Service stopped is kept, and one that would have been retried is replaced", async () => {
  const f = await fixture();
  await f.startAll();
  const incarnation = (key: string) => f.processes.get(key)!.incarnation;
  // Before the reboot worker (on-failure) exited cleanly and stays stopped; api (always) crashed, and its retry is due.
  const worker = await f.key("local", "worker");
  const api = await f.key("local", "api");
  f.processes.set(worker, {
    state: "stopped",
    exitCode: 0,
    incarnation: incarnation(worker),
  });
  f.processes.set(api, {
    state: "stopped",
    exitCode: 1,
    incarnation: incarnation(api),
  });
  await f.supervise();
  f.restartHost(REBOOTED);
  f.reopen();
  await f.reconcile();
  f.clock.ms += 1000;
  await f.supervise();
  expect(await f.running("local")).toEqual([]);
  const local = await f.status("local");
  expect(local.worker).toMatchObject({ state: "stopped", exit: "clean" });
  expect(local.api).toMatchObject({ state: "stopped", exit: "unknown" });
  expect(String(local.api!.reason)).toContain(
    "It stopped when the Mac restarted",
  );
});

test("a boot that could not be read right after a reboot detects nothing yet and keeps the recorded boot, so the next start finds the reboot", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  // The audit session number repeats in the new boot, and the boot itself cannot be read this time.
  f.restartHost({ login: "100002" });
  f.reopen();
  await f.reconcile();
  expect(await f.running("live")).toEqual([]);
  expect((await f.store.read()).host).toMatchObject({ boot: "BOOT-1" });

  f.host.session = REBOOTED;
  f.reopen();
  await f.reconcile();
  expect(await f.running("live")).toEqual(["api", "db", "worker"]);
  expect(await f.running("local")).toEqual([]);
  expect(
    (await f.activitySince(before)).filter((entry) =>
      entry.startsWith("host-restart"),
    ),
  ).toEqual(["host-restart/stopped -"]);
});

test("a Service recorded as stopped by the restart but later seen running loses that record, so its own later exit is judged on its own", async () => {
  const f = await fixture();
  await f.startAll();
  f.restartHost(REBOOTED);
  f.reopen();
  await f.reconcile();
  const api = await f.key("local", "api");
  const run = async () =>
    (await f.store.read()).targets.find((t) => t.kind === "local")!.services!
      .api!;
  expect((await run()).outcome).toMatchObject({ hostRestart: "reboot" });
  f.processes.set(api, { state: "running", pid: 4242 });
  await f.supervise();
  expect((await run()).outcome).toBeUndefined();
  f.processes.delete(api);
  await f.supervise();
  expect((await run()).outcome).toMatchObject({ kind: "unknown" });
  expect((await run()).outcome).not.toHaveProperty("hostRestart");
});
