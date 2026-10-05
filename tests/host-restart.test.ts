import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeWorld } from "./support/runtime-world";
import type { FileStateStore } from "../src/runtime/state-store";
import { UNKNOWN_EXIT_RESTART_BACKOFF_MS } from "../src/runtime/supervision";
import { stopDetached } from "../src/domain/stop-budget";
import type { RuntimeState } from "../src/domain/runtime";
import type { HostSession } from "../src/domain/host-session";
import type {
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import { parseProjectConfig } from "../src/config";

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
  const config = parseProjectConfig({
    name: "demo",
    services: SERVICES,
    targets: { working: true, stable: true, preview: true },
  });
  const processes = new Map<string, ProcessObservation>();
  /** Process keys (`<target id>:<service>`) in the order they were started. */
  const starts: string[] = [];
  const refusal: { start?: (key: string) => boolean } = {};
  /** Starts that stay in progress until the promise it returns for their key settles. */
  const delay: { start?: (key: string) => Promise<void> | undefined } = {};
  /** A stop of this key waits until rigd's shutdown detaches it; `hung` says one is waiting. */
  const stall: { key?: string; hung?: boolean } = {};
  const supervisor: Supervisor = {
    async observe(key) {
      return processes.get(key) ?? { state: "stopped" };
    },
    async ensureRunning(request) {
      if (processes.get(request.key)?.state === "running")
        return { outcome: "unchanged" };
      if (refusal.start?.(request.key)) throw new Error("spawn refused");
      await delay.start?.(request.key);
      starts.push(request.key);
      processes.set(request.key, {
        state: "running",
        pid: 1000 + starts.length,
        incarnation: request.incarnation,
      });
      return { outcome: "started" };
    },
    async stop(key, request) {
      if (key === stall.key) {
        stall.hung = true;
        await new Promise<never>((_, reject) =>
          request.detach?.addEventListener("abort", () =>
            reject(stopDetached({ key })),
          ),
        );
      }
      const running = processes.get(key)?.state === "running";
      processes.delete(key);
      return { outcome: running ? "stopped" : "unchanged" };
    },
    async shutdown() {},
    async detach() {},
  };
  /** What the scripted Host reports as its boot and GUI login; a test changes it to restart the Host. */
  const host: { session: HostSession; hold?: Promise<void> } = {
    session: {
      boot: "BOOT-1",
      bootedAt: "2026-09-26T07:00:00.000Z",
      login: "100002",
    },
  };
  const world = await runtimeWorld({
    name: "host-restart",
    config,
    supervisor: () => supervisor,
    startsAt: "2026-09-27T08:00:00.000Z",
    readinessDeadlineMs: 250,
    dependencies: () => ({
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
      hostSession: {
        async current() {
          await host.hold;
          return { ...host.session };
        },
      },
    }),
  });
  roots.push(world.root);
  const { root, clock, store, deps } = world;
  let runtime = world.open();
  await runtime.command({ action: "init", repoPath: world.repo });
  const targetId = async (kind: "working" | "stable" | "preview") =>
    (await store.read()).targets.find((t) => t.kind === kind)!.id;
  const f = {
    root,
    clock,
    host,
    processes,
    refusal,
    lifecycle: deps.lifecycle,
    delay,
    stall,
    store,
    /** A new daemon over the same saved state and whatever processes survived. */
    reopen() {
      runtime = world.open();
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
        target: "stable",
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
    async running(kind: "working" | "stable" | "preview") {
      const prefix = `${await targetId(kind)}:`;
      return [...processes]
        .filter(
          ([key, seen]) => key.startsWith(prefix) && seen.state === "running",
        )
        .map(([key]) => key.slice(prefix.length))
        .sort();
    },
    /** The Services of `kind` started since `from`, in order. */
    async startedSince(kind: "working" | "stable" | "preview", from: number) {
      const prefix = `${await targetId(kind)}:`;
      return starts
        .slice(from)
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length));
    },
    starts,
    async key(kind: "working" | "stable" | "preview", service: string) {
      return `${await targetId(kind)}:${service}`;
    },
    async status(kind: "working" | "stable" | "preview") {
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

test("after an upgrade, a stopped Stable Target whose plan names the removed launchd supervisor starts, restarts and stops under rigd", async () => {
  const f = await fixture();
  await f.command({ action: "deploy", project: "demo", target: "stable" });
  await f.command({ action: "down", project: "demo", target: "stable" });
  // What a Rig that offered launchd supervision left: the same plan, naming launchd. This daemon has only rigd's supervisor.
  const path = join(f.root, "runtime", "state.json");
  const recorded = JSON.parse(await readFile(path, "utf8"));
  recorded.targets.find(
    (target: { kind: string }) => target.kind === "stable",
  ).plan.providers.processSupervisor = "launchd";
  await writeFile(path, JSON.stringify(recorded));
  f.reopen();
  await f.reconcile();
  const plan = async () =>
    (await f.store.read()).targets.find((target) => target.kind === "stable")!
      .plan;
  expect((await plan()).providers.processSupervisor).toBe("rigd");
  // Not config drift: the recorded plan is what rig.yaml plans now.
  const doctor = (await f.command({ action: "doctor", project: "demo" })) as {
    checks: { name: string; ok: boolean }[];
  };
  expect(
    doctor.checks.find((check) => check.name === "stable/config"),
  ).toMatchObject({ ok: true });

  const live = { project: "demo", target: "stable" } as const;
  expect(await f.command({ action: "up", ...live })).toMatchObject({
    outcome: "started",
  });
  expect(await f.running("stable")).toEqual(["api", "db", "worker"]);
  const startsBefore = f.starts.length;
  expect(await f.command({ action: "restart", ...live })).toMatchObject({
    action: "restart",
    outcome: "started",
  });
  expect(await f.startedSince("stable", startsBefore)).toEqual([
    "db",
    "api",
    "worker",
  ]);
  expect(await f.command({ action: "down", ...live })).toMatchObject({
    outcome: "stopped",
  });
  expect(await f.running("stable")).toEqual([]);
  // The state file now says what this rigd read.
  expect(
    JSON.parse(await readFile(path, "utf8")).targets.find(
      (target: { kind: string }) => target.kind === "stable",
    ).plan.providers,
  ).toEqual({ processSupervisor: "rigd" });
});

test("after a reboot every Stable Target meant to run comes back in dependency order, with one Host-restarted event and one start per Target, while the Working copy and Previews stay stopped", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  const startsBefore = f.starts.length;

  f.restartHost(REBOOTED);
  f.reopen();
  expect(await f.reconcile()).toEqual({});

  expect(await f.startedSince("stable", startsBefore)).toEqual([
    "db",
    "api",
    "worker",
  ]);
  expect(await f.running("stable")).toEqual(["api", "db", "worker"]);
  expect(await f.running("working")).toEqual([]);
  expect(await f.running("preview")).toEqual([]);
  const activity = await f.activitySince(before);
  expect(activity).toEqual(["host-restart/stopped -", "up/started stable"]);
  const entries = (await f.store.read()).activity.slice(before);
  expect(entries[0]!.message).toContain("The Mac restarted");
  expect(entries[1]!.message).toContain("restarted after reboot");
  // The session is recorded once rigd has acted on it.
  expect((await f.store.read()).host).toMatchObject({ boot: "BOOT-2" });

  const live = await f.status("stable");
  expect(live.api).toMatchObject({ state: "running" });
  expect(String(live.api!.reason)).toContain("restarted after reboot");
  const local = await f.status("working");
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
  expect(await f.running("working")).toEqual([]);
  expect(await f.running("preview")).toEqual([]);
  expect(await f.activitySince(before)).toEqual([
    "host-restart/stopped -",
    "up/started stable",
  ]);
});

test("the precedence over unknown-exit retries ends with the next explicit start: rig up brings the Working copy back, and a later unknown exit is retried as before", async () => {
  const f = await fixture();
  await f.startAll();
  f.restartHost(REBOOTED);
  f.reopen();
  await f.reconcile();

  await f.command({ action: "up", project: "demo" });
  expect(await f.running("working")).toEqual(["api", "db", "worker"]);
  expect((await f.status("working")).api).toMatchObject({ state: "running" });

  // The Working copy's api vanishes on its own (not a Host restart): #274's slower retry applies again.
  f.processes.delete(await f.key("working", "api"));
  const from = f.starts.length;
  const { nextRetryAt } = await f.supervise();
  expect(nextRetryAt).toBe(f.clock.ms + UNKNOWN_EXIT_RESTART_BACKOFF_MS[0]);
  f.clock.ms = nextRetryAt!;
  await f.supervise();
  expect(await f.startedSince("working", from)).toEqual(["api"]);
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
  for (const kind of ["working", "stable"] as const) {
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
  const survivor = await f.key("working", "worker");
  const kept = f.processes.get(survivor)!;
  f.restartHost({ ...f.host.session, login: "100019" });
  f.processes.set(survivor, kept);
  f.reopen();
  await f.reconcile();

  expect(await f.running("stable")).toEqual(["api", "db", "worker"]);
  expect(await f.running("working")).toEqual(["worker"]);
  expect(await f.activitySince(before)).toEqual([
    "host-restart/stopped -",
    "up/started stable",
  ]);
  const entries = (await f.store.read()).activity.slice(before);
  expect(entries[0]!.message).toContain("You logged out and in again");
  expect(String((await f.status("stable")).api!.reason)).toContain(
    "restarted after login",
  );
  const local = await f.status("working");
  expect(local.worker).toMatchObject({ state: "running" });
  expect(String(local.api!.reason)).toContain(
    "It stopped when you logged out and in again",
  );
  expect((await f.store.read()).host).toMatchObject({ login: "100019" });
});

test("a Stable start after a reboot whose clean-up stop rigd's shutdown detaches records no failed start and leaves the restart pending for the next daemon, which acts on it once", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  f.restartHost(REBOOTED);
  // worker cannot start, and the stop of api that undoes the start waits until rigd shuts down.
  const worker = await f.key("stable", "worker");
  const api = await f.key("stable", "api");
  f.refusal.start = (key) => key === worker;
  f.stall.key = api;
  f.reopen();
  const pass = f.reconcile();
  for (let tries = 0; !f.stall.hung; tries++) {
    if (tries > 2000) throw new Error("the clean-up stop never began");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await f.drain();
  await pass;

  const live = (await f.store.read()).targets.find((t) => t.kind === "stable")!;
  const host = (await f.store.read()).host!;
  expect(host.boot).toBe("BOOT-1");
  expect(host.restart).toMatchObject({ kind: "reboot", boot: "BOOT-2" });
  expect(host.restart!.settled ?? []).not.toContain(live.id);
  expect(await f.activitySince(before)).toEqual(["host-restart/stopped -"]);

  // api finishes stopping on its own. The next daemon acts on the restart for the Stable Target once, as after a crash
  // mid-start (the start's unfinished effect transaction is then its outcome), announces it no second time, and records
  // the session.
  f.processes.delete(api);
  f.stall.key = undefined;
  f.refusal.start = undefined;
  f.reopen();
  await f.reconcile();
  const after = await f.activitySince(before);
  expect(after).toHaveLength(2);
  expect(after[0]).toBe("host-restart/stopped -");
  expect(after[1]).toMatch(/^up\/(started|failed) stable$/);
  expect((await f.store.read()).host).toMatchObject({ boot: "BOOT-2" });
  expect((await f.store.read()).host!.restart).toBeUndefined();
});

test("a Stable Target meant to be stopped stays stopped after a reboot", async () => {
  const f = await fixture();
  await f.startAll();
  await f.command({ action: "down", project: "demo", target: "stable" });
  const before = await f.activityCount();
  f.restartHost(REBOOTED);
  f.reopen();
  await f.reconcile();
  expect(await f.running("stable")).toEqual([]);
  expect(await f.activitySince(before)).toEqual(["host-restart/stopped -"]);
  expect((await f.status("stable")).api).toMatchObject({
    state: "stopped",
    exit: "requested",
  });
});

test("a Stable Target that fails to come back after a reboot keeps a failed status and stays meant to run", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  f.restartHost(REBOOTED);
  const db = await f.key("stable", "db");
  f.refusal.start = (key) => key === db;
  f.reopen();
  await f.reconcile();

  expect(await f.running("stable")).toEqual([]);
  expect(await f.activitySince(before)).toEqual([
    "host-restart/stopped -",
    "up/failed stable",
  ]);
  const live = (await f.store.read()).targets.find((t) => t.kind === "stable")!;
  expect(live.desired).toBe("running");
  // Every Service the failed start left stopped is failed, not retried: not even api under always once db could start.
  f.refusal.start = undefined;
  for (const delay of [...UNKNOWN_EXIT_RESTART_BACKOFF_MS, 600_000]) {
    f.clock.ms += delay;
    await f.supervise();
  }
  expect(await f.running("stable")).toEqual([]);
  const status = await f.status("stable");
  for (const service of ["api", "db", "worker"]) {
    expect(status[service]).toMatchObject({ state: "failed" });
    expect(String(status[service]!.reason)).toContain("The last start failed");
  }
  await f.command({ action: "up", project: "demo", target: "stable" });
  expect(await f.running("stable")).toEqual(["api", "db", "worker"]);
});

test("a Stable Target whose start after a reboot finds an unfinished effect transaction names rig down, then rig up, as its recovery", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  f.restartHost(REBOOTED);
  // An earlier start of api had failed its readiness check; then a crash mid-start left the Stable Target's effect
  // transaction unfinished.
  await f.store.update((state) => {
    const saved = state.targets.find((t) => t.kind === "stable")!;
    saved.services!.api = {
      ...saved.services!.api!,
      outcome: {
        kind: "start-failed",
        errorCode: "HEALTH_FAILED",
        at: "2026-09-27T07:00:00.000Z",
      },
    };
  });
  const live = (await f.store.read()).targets.find((t) => t.kind === "stable")!;
  await f.lifecycle.checkpoint(live);
  f.reopen();
  await f.reconcile();

  expect(await f.running("stable")).toEqual([]);
  const entries = (await f.store.read()).activity.slice(before);
  const failed = entries.find((entry) => entry.action === "up")!;
  expect(failed).toMatchObject({ outcome: "failed", target: "stable" });
  expect(failed.message).toContain("EFFECTS_RECOVERY");
  expect(failed.message).toContain("Run rig down stable, then rig up stable");
  const status = await f.status("stable");
  for (const service of ["api", "db", "worker"])
    expect(String(status[service]!.reason)).toContain(
      "Run rig down, then rig up to start it again.",
    );
  await f.command({ action: "down", project: "demo", target: "stable" });
  await f.command({ action: "up", project: "demo", target: "stable" });
  expect(await f.running("stable")).toEqual(["api", "db", "worker"]);
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
  expect(await f.running("stable")).toEqual([]);
  expect((await f.store.read()).host).toMatchObject({ boot: "BOOT-1" });

  f.host.hold = undefined;
  f.reopen();
  await f.reconcile();
  expect(await f.running("stable")).toEqual(["api", "db", "worker"]);
  expect(await f.activitySince(before)).toEqual([
    "host-restart/stopped -",
    "up/started stable",
  ]);
  const host = (await f.store.read()).host!;
  expect(host).toMatchObject({ boot: "BOOT-2" });
  expect(host.restart).toBeUndefined();
});

test("a daemon that finishes a restart an earlier one left pending does not mark again a Working copy the operator started since: its unknown exit is retried", async () => {
  const f = await fixture();
  await f.startAll();
  f.restartHost(REBOOTED);
  // The Stable Target's start stays in progress, so the first pass never settles the restart.
  const db = await f.key("stable", "db");
  f.delay.start = (key) =>
    key === db ? new Promise<void>(() => {}) : undefined;
  f.reopen();
  void f.reconcile();
  const localApi = await f.key("working", "api");
  for (let i = 0; i < 200; i++) {
    const local = (await f.store.read()).targets.find(
      (t) => t.kind === "working",
    )!;
    const outcome = local.services?.api?.outcome;
    if (outcome?.kind === "unknown" && outcome.hostRestart) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // The operator starts the Working copy again; its api then vanishes with nothing recorded, and rigd is replaced.
  await f.command({ action: "up", project: "demo" });
  expect(await f.running("working")).toEqual(["api", "db", "worker"]);
  f.processes.delete(localApi);
  f.delay.start = undefined;
  f.reopen();
  await f.reconcile();

  f.clock.ms += UNKNOWN_EXIT_RESTART_BACKOFF_MS[0]!;
  await f.supervise();
  expect(await f.running("working")).toEqual(["api", "db", "worker"]);
});

/** Makes the state writes that record the Working copy's Services as stopped by the Host restart fail while `failing.on`,
 * as a full disk would, so the first pass cannot settle that Target and the next daemon finds the restart again. */
function failWorkingCopyMarking(store: FileStateStore) {
  const failing = { on: true };
  const update = store.update.bind(store);
  store.update = (change) =>
    update(async (state) => {
      await change(state);
      if (
        failing.on &&
        state.targets.some(
          (t) =>
            t.kind === "working" &&
            Object.values(t.services ?? {}).some(
              (run) =>
                run.outcome?.kind === "unknown" &&
                run.outcome.hostRestart !== undefined,
            ),
        )
      )
        throw new Error("disk full");
    });
  return failing;
}

test("a daemon that finds a restart an earlier one only partly acted on records it once, even when it reads more of the session, and does not start a Stable Target again", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  // Right after the reboot the GUI login cannot be read yet.
  f.restartHost({ boot: "BOOT-2", bootedAt: REBOOTED.bootedAt });
  const failing = failWorkingCopyMarking(f.store);
  f.reopen();
  await f.reconcile();
  expect(await f.running("stable")).toEqual(["api", "db", "worker"]);
  expect((await f.store.read()).host).toMatchObject({ boot: "BOOT-1" });

  failing.on = false;
  f.host.session = REBOOTED;
  const startsBefore = f.starts.length;
  f.reopen();
  await f.reconcile();
  expect(await f.startedSince("stable", startsBefore)).toEqual([]);
  expect(await f.activitySince(before)).toEqual([
    "host-restart/stopped -",
    "up/started stable",
  ]);
  const host = (await f.store.read()).host!;
  expect(host).toMatchObject({ boot: "BOOT-2", login: "100002" });
  expect(host.restart).toBeUndefined();
  expect(await f.status("working")).toMatchObject({
    api: { state: "stopped", exit: "unknown" },
  });
});

test("a Stable Target whose start failed after a restart is not retried by the daemon that finishes acting on that restart", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  f.restartHost(REBOOTED);
  const db = await f.key("stable", "db");
  f.refusal.start = (key) => key === db;
  const failing = failWorkingCopyMarking(f.store);
  f.reopen();
  await f.reconcile();
  expect(await f.running("stable")).toEqual([]);

  failing.on = false;
  f.refusal.start = undefined;
  f.reopen();
  await f.reconcile();
  expect(await f.running("stable")).toEqual([]);
  expect(await f.activitySince(before)).toEqual([
    "host-restart/stopped -",
    "up/failed stable",
  ]);
  expect((await f.store.read()).host).toMatchObject({ boot: "BOOT-2" });
});

test("a restart whose Activity entry could not be written at first is recorded once the pass has acted on it, and not again by the next start", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  f.restartHost(REBOOTED);
  const update = f.store.update.bind(f.store);
  let refusals = 1;
  f.store.update = (change) =>
    update(async (state) => {
      await change(state);
      if (
        refusals > 0 &&
        state.activity.some((entry) => entry.action === "host-restart")
      ) {
        refusals--;
        throw new Error("disk full");
      }
    });
  f.reopen();
  await f.reconcile();
  expect(await f.running("stable")).toEqual(["api", "db", "worker"]);
  expect((await f.store.read()).host).toMatchObject({ boot: "BOOT-2" });

  f.reopen();
  await f.reconcile();
  expect((await f.activitySince(before)).sort()).toEqual([
    "host-restart/stopped -",
    "up/started stable",
  ]);
});

test("a daemon that never managed to write a restart's entry leaves its Stable starts noted, so the next one announces the restart once and starts nothing again", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  f.restartHost(REBOOTED);
  const update = f.store.update.bind(f.store);
  let refuse = true;
  f.store.update = (change) =>
    update(async (state) => {
      await change(state);
      if (
        refuse &&
        state.activity.some((entry) => entry.action === "host-restart")
      )
        throw new Error("disk full");
    });
  f.reopen();
  await f.reconcile();
  expect(await f.running("stable")).toEqual(["api", "db", "worker"]);
  expect((await f.store.read()).host).toMatchObject({
    boot: "BOOT-1",
    restart: { kind: "reboot", unannounced: true },
  });

  refuse = false;
  const startsBefore = f.starts.length;
  f.reopen();
  await f.reconcile();
  expect(await f.startedSince("stable", startsBefore)).toEqual([]);
  expect(await f.activitySince(before)).toEqual([
    "up/started stable",
    "host-restart/stopped -",
  ]);
  const host = (await f.store.read()).host!;
  expect(host).toMatchObject({ boot: "BOOT-2", login: "100002" });
  expect(host.restart).toBeUndefined();
});

/** Makes the next `times` state writes whose result `matches` fail, as a full disk would; `left` counts those still to fail. */
function failWrites(
  store: FileStateStore,
  matches: (state: RuntimeState) => boolean,
  times = Number.POSITIVE_INFINITY,
) {
  const failing = { left: times };
  const update = store.update.bind(store);
  store.update = (change) =>
    update(async (state) => {
      await change(state);
      if (failing.left > 0 && matches(state)) {
        failing.left--;
        throw new Error("disk full");
      }
    });
  return failing;
}
const HOST_ENTRY = (state: RuntimeState) =>
  state.activity.some((entry) => entry.action === "host-restart");

test("a failed Stable start after a restart whose record could not be written is recorded by a later pass, and no daemon starts it again", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  f.restartHost(REBOOTED);
  const db = await f.key("stable", "db");
  f.refusal.start = (key) => key === db;
  // The write that records the failed start, with its Activity entry, fails twice.
  const failing = failWrites(
    f.store,
    (state) =>
      state.activity
        .slice(before)
        .some((entry) => entry.action === "up" && entry.outcome === "failed"),
    2,
  );
  f.reopen();
  await f.reconcile();
  expect(await f.running("stable")).toEqual([]);

  // Nothing of the Target is started while its failure is unrecorded, nor once a later pass has recorded it.
  f.refusal.start = undefined;
  for (const delay of [...UNKNOWN_EXIT_RESTART_BACKOFF_MS, 600_000]) {
    f.clock.ms += delay;
    await f.supervise();
  }
  expect(failing.left).toBe(0);
  expect(await f.running("stable")).toEqual([]);
  const status = await f.status("stable");
  for (const service of ["api", "db", "worker"])
    expect(status[service]).toMatchObject({ state: "failed" });

  f.reopen();
  await f.reconcile();
  expect(await f.running("stable")).toEqual([]);
  expect(await f.activitySince(before)).toEqual([
    "host-restart/stopped -",
    "up/failed stable",
  ]);
  const host = (await f.store.read()).host!;
  expect(host).toMatchObject({ boot: "BOOT-2" });
  expect(host.restart).toBeUndefined();
  await f.command({ action: "up", project: "demo", target: "stable" });
  expect(await f.running("stable")).toEqual(["api", "db", "worker"]);
});

test("an Operation on a Stable Target whose failed start after a restart is still unrecorded records that failure first, and is refused while it cannot", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  f.restartHost(REBOOTED);
  const db = await f.key("stable", "db");
  f.refusal.start = (key) => key === db;
  const failing = failWrites(f.store, (state) =>
    state.activity
      .slice(before)
      .some((entry) => entry.action === "up" && entry.outcome === "failed"),
  );
  f.reopen();
  await f.reconcile();
  f.refusal.start = undefined;
  await expect(
    f.command({ action: "up", project: "demo", target: "stable" }),
  ).rejects.toMatchObject({ code: "STATE_WRITE" });
  expect(await f.running("stable")).toEqual([]);

  // Even an Operation refused before it acts leaves the failure recorded, in its place ahead of the Operation's own entry.
  failing.left = 0;
  await expect(
    f.command({ action: "destroy", project: "demo", target: "stable" }),
  ).rejects.toMatchObject({ code: "DESTROY_TARGET" });
  const activity = await f.activitySince(before);
  expect(activity.slice(0, 2)).toEqual([
    "host-restart/stopped -",
    "up/failed stable",
  ]);
  f.reopen();
  await f.reconcile();
  expect(await f.running("stable")).toEqual([]);
  expect(await f.activitySince(before)).toEqual(activity);
  expect((await f.store.read()).host!.restart).toBeUndefined();
  await f.command({ action: "up", project: "demo", target: "stable" });
  expect(await f.running("stable")).toEqual(["api", "db", "worker"]);
});

test("a write reported failed after it was saved is not repeated: one Host entry and one failed start", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  f.restartHost(REBOOTED);
  const db = await f.key("stable", "db");
  f.refusal.start = (key) => key === db;
  // The first write carrying each entry is saved, then reported failed, as a failed directory sync would be.
  const reported = new Set<string>();
  const update = f.store.update.bind(f.store);
  f.store.update = async (change) => {
    let saved: RuntimeState | undefined;
    await update(async (state) => {
      await change(state);
      saved = state;
    });
    for (const entry of saved!.activity.slice(before))
      if (!reported.has(entry.action)) {
        reported.add(entry.action);
        throw new Error("fsync failed");
      }
  };
  f.reopen();
  await f.reconcile();
  f.refusal.start = undefined;
  f.clock.ms += UNKNOWN_EXIT_RESTART_BACKOFF_MS[0]!;
  await f.supervise();
  expect(await f.activitySince(before)).toEqual([
    "host-restart/stopped -",
    "up/failed stable",
  ]);
  expect(await f.running("stable")).toEqual([]);
});

test("a login after a reboot whose entry was never written is announced with it by the late write, each in its own words", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  f.restartHost(REBOOTED);
  const failing = failWrites(f.store, HOST_ENTRY);
  f.reopen();
  await f.reconcile();

  // The next daemon's early write fails too; its late write, once the pass has acted, succeeds.
  failing.left = 1;
  f.restartHost({ ...REBOOTED, login: "100019" });
  f.reopen();
  await f.reconcile();
  const entries = (await f.store.read()).activity
    .slice(before)
    .filter((entry) => entry.action === "host-restart");
  expect(entries.map((entry) => entry.message)).toEqual([
    expect.stringMatching(/^The Mac restarted, .* Recorded late: /),
    expect.stringMatching(/^You logged out and in again/),
  ]);
  const host = (await f.store.read()).host!;
  expect(host).toMatchObject({ boot: "BOOT-2", login: "100019" });
  expect(host.restart).toBeUndefined();
});

test("a second reconcile of the same daemon does not start again a Stable Target whose failed start it could not record", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  f.restartHost(REBOOTED);
  const db = await f.key("stable", "db");
  f.refusal.start = (key) => key === db;
  const failing = failWrites(f.store, (state) =>
    state.activity
      .slice(before)
      .some((entry) => entry.action === "up" && entry.outcome === "failed"),
  );
  f.reopen();
  await f.reconcile();
  f.refusal.start = undefined;
  const startsBefore = f.starts.length;
  await f.reconcile();
  expect(await f.startedSince("stable", startsBefore)).toEqual([]);

  failing.left = 0;
  await f.reconcile();
  expect(await f.startedSince("stable", startsBefore)).toEqual([]);
  expect(await f.activitySince(before)).toEqual([
    "host-restart/stopped -",
    "up/failed stable",
  ]);
});

test("a Working copy's Services are recorded as stopped by a restart only in the same write as the restart itself, so no such record outlives a restart nothing remembers", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  f.restartHost(REBOOTED);
  // Every write that would leave the restart in state fails: its entry, and every Target's note in the pending restart.
  const failing = failWrites(
    f.store,
    (state) => state.host?.restart !== undefined,
  );
  f.reopen();
  await f.reconcile();
  const saved = await f.store.read();
  expect(saved.host).toMatchObject({ boot: "BOOT-1" });
  expect(saved.host!.restart).toBeUndefined();
  const local = saved.targets.find((t) => t.kind === "working")!;
  for (const run of Object.values(local.services ?? {}))
    expect(run.outcome).not.toHaveProperty("hostRestart");

  failing.left = 0;
  f.reopen();
  await f.reconcile();
  expect(await f.status("working")).toMatchObject({
    api: { state: "stopped", exit: "unknown" },
  });
  expect(
    (await f.activitySince(before)).filter((entry) =>
      entry.startsWith("host-restart"),
    ),
  ).toEqual(["host-restart/stopped -"]);
  expect((await f.store.read()).host).toMatchObject({ boot: "BOOT-2" });
});

test("a later pass that records a Working copy's Services as stopped by the restart records the restart with them, so it is still announced after another reboot", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  f.restartHost(REBOOTED);
  const failing = failWrites(
    f.store,
    (state) => state.host?.restart !== undefined,
  );
  f.reopen();
  await f.reconcile();
  expect((await f.store.read()).host!.restart).toBeUndefined();

  failing.left = 0;
  await f.supervise();
  const local = (await f.store.read()).targets.find(
    (t) => t.kind === "working",
  )!;
  expect((await f.store.read()).host!.restart).toMatchObject({
    kind: "reboot",
    boot: "BOOT-2",
    unannounced: true,
    settled: expect.arrayContaining([local.id]),
  });

  f.restartHost({ ...REBOOTED, boot: "BOOT-3" });
  f.reopen();
  await f.reconcile();
  const entries = (await f.store.read()).activity
    .slice(before)
    .filter((entry) => entry.action === "host-restart");
  expect(entries.map((entry) => entry.message)).toEqual([
    expect.stringContaining("Recorded late: "),
    expect.not.stringContaining("Recorded late: "),
  ]);
});

test("a restart whose entry was never written is still announced when the Mac restarts again before the next daemon, ahead of the new restart's entry", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  f.restartHost(REBOOTED);
  const failing = failWrites(f.store, HOST_ENTRY);
  f.reopen();
  await f.reconcile();
  expect((await f.store.read()).host).toMatchObject({
    boot: "BOOT-1",
    restart: { kind: "reboot", boot: "BOOT-2", unannounced: true },
  });

  failing.left = 0;
  f.clock.ms += 3_600_000;
  f.restartHost({
    boot: "BOOT-3",
    bootedAt: "2026-09-27T08:59:00.000Z",
    login: "100002",
  });
  f.reopen();
  await f.reconcile();
  expect(await f.running("stable")).toEqual(["api", "db", "worker"]);
  expect(await f.activitySince(before)).toEqual([
    "up/started stable",
    "host-restart/stopped -",
    "host-restart/stopped -",
    "up/started stable",
  ]);
  const [first, second] = (await f.store.read()).activity
    .slice(before)
    .filter((entry) => entry.action === "host-restart");
  expect(first!.message).toStartWith("The Mac restarted, which stops");
  expect(second!.message).toContain("(booted 2026-09-27T08:59:00.000Z)");
  const host = (await f.store.read()).host!;
  expect(host).toMatchObject({ boot: "BOOT-3" });
  expect(host.restart).toBeUndefined();

  // Announced once: the next start finds nothing to say.
  f.reopen();
  await f.reconcile();
  expect(await f.activitySince(before)).toHaveLength(4);
});

test("restarts whose entries no daemon could write are carried from one pending restart to the next and announced once each, oldest first", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  f.restartHost(REBOOTED);
  const failing = failWrites(f.store, HOST_ENTRY);
  f.reopen();
  await f.reconcile();

  f.restartHost({ ...REBOOTED, boot: "BOOT-3" });
  f.reopen();
  await f.reconcile();
  expect((await f.store.read()).host).toMatchObject({
    boot: "BOOT-1",
    restart: {
      kind: "reboot",
      boot: "BOOT-3",
      unannounced: true,
      unannouncedBefore: [{ kind: "reboot", boot: "BOOT-2" }],
    },
  });

  failing.left = 0;
  const startsBefore = f.starts.length;
  f.reopen();
  await f.reconcile();
  expect(await f.startedSince("stable", startsBefore)).toEqual([]);
  expect(await f.activitySince(before)).toEqual([
    "up/started stable",
    "up/started stable",
    "host-restart/stopped -",
    "host-restart/stopped -",
  ]);
  const host = (await f.store.read()).host!;
  expect(host).toMatchObject({ boot: "BOOT-3" });
  expect(host.restart).toBeUndefined();
});

test("a logout and login after a reboot the first pass did not finish is a restart of its own: the Stable Target is started again", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  f.restartHost(REBOOTED);
  const failing = failWorkingCopyMarking(f.store);
  f.reopen();
  await f.reconcile();
  expect(await f.running("stable")).toEqual(["api", "db", "worker"]);

  failing.on = false;
  f.restartHost({ ...REBOOTED, login: "100019" });
  f.reopen();
  await f.reconcile();
  expect(await f.running("stable")).toEqual(["api", "db", "worker"]);
  expect(await f.activitySince(before)).toEqual([
    "host-restart/stopped -",
    "up/started stable",
    "host-restart/stopped -",
    "up/started stable",
  ]);
  const host = (await f.store.read()).host!;
  expect(host).toMatchObject({ boot: "BOOT-2", login: "100019" });
  expect(host.restart).toBeUndefined();
});

test("a daemon that can read nothing of the session still finishes a restart an earlier one found: the Working copy stays stopped under restart: always", async () => {
  const f = await fixture();
  await f.startAll();
  const before = await f.activityCount();
  f.restartHost(REBOOTED);
  const failing = failWorkingCopyMarking(f.store);
  f.reopen();
  await f.reconcile();
  failing.on = false;

  f.host.session = {};
  f.reopen();
  await f.reconcile();
  for (const delay of [...UNKNOWN_EXIT_RESTART_BACKOFF_MS, 600_000]) {
    f.clock.ms += delay;
    await f.supervise();
  }
  expect(await f.running("working")).toEqual([]);
  expect(await f.activitySince(before)).toEqual([
    "host-restart/stopped -",
    "up/started stable",
  ]);
  // Recorded as it was found, so the next restart can be told.
  expect((await f.store.read()).host).toMatchObject({
    boot: "BOOT-2",
    login: "100002",
  });
});

test("a pending restart finished by a daemon that could not read the login keeps the login read when it was found, so a later logout is still a restart", async () => {
  const f = await fixture();
  await f.startAll();
  f.restartHost(REBOOTED);
  const failing = failWorkingCopyMarking(f.store);
  f.reopen();
  await f.reconcile();
  failing.on = false;

  f.host.session = { boot: "BOOT-2" };
  f.reopen();
  await f.reconcile();
  expect((await f.store.read()).host).toMatchObject({
    boot: "BOOT-2",
    login: "100002",
  });

  const before = await f.activityCount();
  f.restartHost({ ...REBOOTED, login: "100019" });
  f.reopen();
  await f.reconcile();
  expect(await f.running("stable")).toEqual(["api", "db", "worker"]);
  expect(await f.activitySince(before)).toEqual([
    "host-restart/stopped -",
    "up/started stable",
  ]);
});

test("after a reboot an outcome that already kept a Working copy Service stopped is kept, and one that would have been retried is replaced", async () => {
  const f = await fixture();
  await f.startAll();
  const incarnation = (key: string) => f.processes.get(key)!.incarnation;
  // Before the reboot worker (on-failure) exited cleanly and stays stopped; api (always) crashed, and its retry is due.
  const worker = await f.key("working", "worker");
  const api = await f.key("working", "api");
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
  expect(await f.running("working")).toEqual([]);
  const local = await f.status("working");
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
  expect(await f.running("stable")).toEqual([]);
  expect((await f.store.read()).host).toMatchObject({ boot: "BOOT-1" });

  f.host.session = REBOOTED;
  f.reopen();
  await f.reconcile();
  expect(await f.running("stable")).toEqual(["api", "db", "worker"]);
  expect(await f.running("working")).toEqual([]);
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
  const api = await f.key("working", "api");
  const run = async () =>
    (await f.store.read()).targets.find((t) => t.kind === "working")!.services!
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
