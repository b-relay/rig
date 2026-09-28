import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ManagedComponent, TargetPlan } from "../src/config/types";
import { RigError } from "../src/domain/errors";
import type {
  OperatorAlert,
  OperatorAlerts,
} from "../src/domain/operator-alerts";
import type { ServiceRun, TargetRecord } from "../src/domain/runtime";
import type { ProcessObservation } from "../src/providers/contracts";
import {
  ALERT_GRACE_MS,
  ALERT_REMINDER_MS,
  ALERT_RETRY_MS,
} from "../src/runtime/alert-policy";
import {
  evaluateOperatorAlerts,
  type AlertMonitorDependencies,
} from "../src/runtime/alert-monitor";
import { timerObservationDeadline } from "../src/runtime/bounded-observations";
import { FileStateStore } from "../src/runtime/state-store";
import { hostDoctor } from "../src/runtime/doctor";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import {
  DaemonAdmin,
  recordedDowntime,
  withDowntime,
} from "../src/daemon/admin";
import { renderResult } from "../src/cli/output";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const T0 = Date.parse("2026-09-25T13:58:58.000Z");
const MINUTE = 60_000;

/** A fake channel: records every alert it is given, and fails while `failing` is set. */
function fakeChannel(): OperatorAlerts & {
  sent: OperatorAlert[];
  failing: boolean;
} {
  const channel = {
    channel: "test notification",
    sent: [] as OperatorAlert[],
    failing: false,
    async send(alert: OperatorAlert) {
      if (channel.failing)
        throw new RigError(
          "ALERT_DELIVERY",
          "The test channel refused the alert.",
          "Nothing to do in a test.",
        );
      channel.sent.push(alert);
    },
  };
  return channel;
}

function plan(
  project: string,
  kind: TargetRecord["kind"],
  name: string,
  services: Record<string, Partial<ManagedComponent>>,
  domain?: string,
): TargetPlan {
  return {
    project,
    target: kind,
    workspacePath: `/deployments/${project}/${name}`,
    dataRoot: `/data/${project}/${name}`,
    deploymentName: name,
    branchSlug: name,
    subdomain: name,
    providers: { processSupervisor: "rigd" },
    components: Object.entries(services).map(([service, settings]) => ({
      kind: "managed",
      name: service,
      env: {},
      dependsOn: [],
      command: service,
      readyTimeout: 30,
      restart: "on-failure",
      ...settings,
    })),
    preparedComponents: [],
    ...(domain ? { domain } : {}),
  } as TargetPlan;
}

/** Real file state under a private RIG_ROOT, observed through scripted processes, on a clock the test moves. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rig-operator-alerts-"));
  roots.push(root);
  const clock = { ms: T0 };
  const processes = new Map<string, ProcessObservation>();
  const unhealthy = new Set<string>();
  const hung = new Set<string>();
  const diagnostics: Parameters<AlertMonitorDependencies["diagnostic"]>[0][] =
    [];
  const channel = fakeChannel();
  let store = new FileStateStore(root);
  let id = 0;
  const targets: TargetRecord[] = [];

  async function addTarget(
    project: string,
    kind: TargetRecord["kind"],
    name: string,
    services: Record<string, Partial<ManagedComponent>> = { web: {} },
    domain?: string,
  ): Promise<TargetRecord> {
    const target: TargetRecord = {
      id: `${project}-${name}`,
      projectId: project,
      name,
      kind,
      plan: plan(project, kind, name, services, domain),
      desired: "running",
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
      logRoot: `/logs/${project}/${name}`,
      services: Object.fromEntries(
        Object.keys(services).map((service) => [
          service,
          {
            deployment: `/deployments/${project}/${name}`,
            intent: "running",
            incarnation: `${service}-1`,
            attempts: [],
          } satisfies ServiceRun,
        ]),
      ),
    };
    await store.update((state) => {
      if (!state.projects.some((p) => p.id === project))
        state.projects.push({
          id: project,
          name: project,
          repoPath: `/repos/${project}`,
          configPath: `/repos/${project}/rig.yaml`,
          createdAt: new Date(T0).toISOString(),
        });
      state.targets.push(target);
    });
    targets.push(target);
    for (const service of Object.keys(services))
      processes.set(`${target.id}:${service}`, {
        state: "running",
        pid: 100,
        incarnation: `${service}-1`,
      });
    return target;
  }

  /** The Service's process is gone and nothing recorded how, as supervision leaves it; under on-failure it stays down. */
  async function crash(target: TargetRecord, service: string, at = clock.ms) {
    processes.set(`${target.id}:${service}`, { state: "stopped" });
    await store.update((state) => {
      const saved = state.targets.find((t) => t.id === target.id)!;
      saved.services![service] = {
        ...saved.services![service]!,
        outcome: { kind: "unknown", at: new Date(at).toISOString() },
      };
    });
  }

  /** The Service runs again, as an operator's rig up leaves it. */
  async function restore(target: TargetRecord, service: string) {
    processes.set(`${target.id}:${service}`, {
      state: "running",
      pid: 200,
      incarnation: `${service}-2`,
    });
    await store.update((state) => {
      const saved = state.targets.find((t) => t.id === target.id)!;
      saved.services![service] = {
        deployment: saved.plan.workspacePath,
        intent: "running",
        incarnation: `${service}-2`,
        attempts: [],
      };
    });
  }

  const deps = (): AlertMonitorDependencies => ({
    store,
    observations: {
      async process(target, component) {
        return (
          processes.get(`${target.id}:${component.name}`) ?? {
            state: "stopped",
          }
        );
      },
      async health(target, component) {
        const key = `${target.id}:${component.name}`;
        // A hung endpoint: accepts the probe and never answers, whatever the signal says.
        if (hung.has(key)) return await new Promise<never>(() => {});
        return unhealthy.has(key)
          ? { ready: false, reason: "HTTP 503" }
          : { ready: true };
      },
      async artifact() {
        return "installed";
      },
      async persistent() {
        return true;
      },
      async listening() {
        return [];
      },
    },
    observationBudgetMs: 2000,
    observationDeadline: timerObservationDeadline,
    async inspectProxy() {
      return {
        proxyFile: join(root, "Caddyfile"),
        routes: 1,
        state: "imported",
      };
    },
    channels: [channel],
    now: () => new Date(clock.ms).toISOString(),
    id: () => `op-${++id}`,
    async diagnostic(event) {
      diagnostics.push(event);
    },
  });

  return {
    root,
    clock,
    channel,
    diagnostics,
    processes,
    unhealthy,
    hung,
    addTarget,
    /** Changes the saved record of `target` as another writer (an operator's command, a supervision pass) would. */
    async change(target: TargetRecord, edit: (saved: TargetRecord) => void) {
      await new FileStateStore(root).update((state) =>
        edit(state.targets.find((t) => t.id === target.id)!),
      );
    },
    crash,
    restore,
    /** One alert evaluation at `clock.ms`, as rigd's alert monitor runs it. */
    evaluate: (overrides: Partial<AlertMonitorDependencies> = {}) =>
      evaluateOperatorAlerts({ ...deps(), ...overrides }),
    /** A new daemon over the same RIG_ROOT: nothing is carried over in memory. */
    restartDaemon() {
      store = new FileStateStore(root);
    },
    state: () => new FileStateStore(root).read(),
    at(offsetMs: number) {
      clock.ms = T0 + offsetMs;
    },
  };
}

test("a Stable Target down past the grace period produces one alert naming the Project, Target, Services, reason and recovery command", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live", {
    convex: {},
    web: {},
  });
  await rig.crash(pantry, "convex");
  await rig.crash(pantry, "web");
  await rig.evaluate();
  rig.at(ALERT_GRACE_MS - MINUTE);
  await rig.evaluate();
  expect(rig.channel.sent).toEqual([]);

  rig.at(ALERT_GRACE_MS);
  await rig.evaluate();
  rig.at(ALERT_GRACE_MS + MINUTE);
  await rig.evaluate();

  expect(rig.channel.sent).toHaveLength(1);
  const [alert] = rig.channel.sent;
  expect(alert).toMatchObject({
    kind: "down",
    title: "pantry live went down at 13:58:58 UTC",
    targets: [
      {
        project: "pantry",
        target: "live",
        since: "2026-09-25T13:58:58.000Z",
        recover: "rig up live --project pantry",
        services: [
          { name: "convex", brief: "unknown exit, not restarted" },
          { name: "web", brief: "unknown exit, not restarted" },
        ],
      },
    ],
  });
  expect(alert!.targets[0]!.services[0]!.reason).toContain(
    "nothing recorded how it ended",
  );
  // The short text a notification shows leads with the command, then names the Services and their reason.
  expect(alert!.summary).toBe(
    "Run rig up live --project pantry. convex: unknown exit, not restarted; web: unknown exit, not restarted.",
  );
  const activity = (await rig.state()).activity.filter(
    (entry) => entry.action === "outage",
  );
  expect(activity).toEqual([
    expect.objectContaining({
      projectId: "pantry",
      project: "pantry",
      target: "live",
      outcome: "failed",
      occurredAt: new Date(T0 + ALERT_GRACE_MS).toISOString(),
    }),
  ]);
  expect(activity[0]!.message).toContain("nothing recorded how it ended");
  expect(activity[0]!.message).toContain("Run rig up live --project pantry.");
  expect(activity[0]!.message).toContain("Sent as a test notification.");
});

test("a Stable Target down for less than the grace period alerts nobody and leaves nothing to recover from", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  await rig.crash(pantry, "web");
  await rig.evaluate();
  rig.at(ALERT_GRACE_MS - MINUTE);
  await rig.evaluate();
  await rig.restore(pantry, "web");
  rig.at(ALERT_GRACE_MS);
  await rig.evaluate();
  rig.at(ALERT_REMINDER_MS);
  await rig.evaluate();

  expect(rig.channel.sent).toEqual([]);
  const state = await rig.state();
  expect(state.activity).toEqual([]);
  expect(state.alerts).toEqual({ targets: [] });
});

test("Stable Targets across Projects that go down together produce one grouped alert and one Activity entry", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live", {
    convex: {},
    web: {},
  });
  const design = await rig.addTarget("design", "live", "live", {
    convex: {},
    web: {},
  });
  const share = await rig.addTarget("share", "live", "live", {
    server: {},
    explorer: {},
  });
  // The 2026-09-25 event: every Service ended within about nine seconds.
  await rig.crash(pantry, "convex", T0 + 2_000);
  await rig.crash(design, "convex", T0 + 1_000);
  await rig.crash(pantry, "web", T0 + 2_500);
  await rig.crash(share, "explorer", T0 + 2_800);
  await rig.crash(design, "web", T0 + 3_000);
  await rig.crash(share, "server", T0);
  rig.at(10_000);
  await rig.evaluate();
  rig.at(ALERT_GRACE_MS + 30_000);
  await rig.evaluate();
  rig.at(ALERT_GRACE_MS + 60_000);
  await rig.evaluate();

  expect(rig.channel.sent).toHaveLength(1);
  const [alert] = rig.channel.sent;
  expect(alert!.title).toBe(
    "3 Stable Targets across 3 Projects went down at 13:58:58 UTC",
  );
  expect(alert!.targets.map((t) => `${t.project} ${t.target}`)).toEqual([
    "share live",
    "design live",
    "pantry live",
  ]);
  expect(alert!.summary).toBe(
    "share live, design live, pantry live. Run rig activity for the reasons and commands.",
  );
  for (const command of [
    "rig up live --project pantry",
    "rig up live --project design",
    "rig up live --project share",
  ])
    expect(alert!.detail).toContain(command);
  const outages = (await rig.state()).activity.filter(
    (entry) => entry.action === "outage",
  );
  expect(outages).toHaveLength(1);
  // A Host-wide event is filed under no single Project.
  expect(outages[0]).not.toHaveProperty("project");
  expect(outages[0]!.message).toStartWith(
    "3 Stable Targets across 3 Projects went down at 13:58:58 UTC.",
  );
});

test("a grouped alert waits until the last Target of the group has been down for the grace period, and names none that came back before", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  const design = await rig.addTarget("design", "live", "live");
  const share = await rig.addTarget("share", "live", "live");
  await rig.crash(pantry, "web", T0);
  await rig.crash(design, "web", T0 + 59_000);
  await rig.crash(share, "web", T0 + 30_000);
  rig.at(60_000);
  await rig.evaluate();
  rig.at(ALERT_GRACE_MS);
  await rig.evaluate();
  // design has been down only 4 minutes 1 second.
  expect(rig.channel.sent).toEqual([]);
  // share comes back before its own grace has passed; it is never named.
  await rig.restore(share, "web");
  rig.at(ALERT_GRACE_MS + 30_000);
  await rig.evaluate();
  expect(rig.channel.sent).toEqual([]);
  rig.at(ALERT_GRACE_MS + 59_000);
  await rig.evaluate();
  expect(rig.channel.sent).toHaveLength(1);
  expect(
    rig.channel.sent[0]!.targets.map((t) => `${t.project} ${t.target}`),
  ).toEqual(["pantry live", "design live"]);
});

test("Stable Targets that go down apart are alerted apart", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  const design = await rig.addTarget("design", "live", "live");
  await rig.crash(pantry, "web");
  await rig.evaluate();
  rig.at(3 * MINUTE);
  await rig.crash(design, "web");
  await rig.evaluate();
  rig.at(ALERT_GRACE_MS);
  await rig.evaluate();
  expect(rig.channel.sent.map((alert) => alert.title)).toEqual([
    "pantry live went down at 13:58:58 UTC",
  ]);
  rig.at(3 * MINUTE + ALERT_GRACE_MS);
  await rig.evaluate();
  expect(rig.channel.sent.map((alert) => alert.title)).toEqual([
    "pantry live went down at 13:58:58 UTC",
    "design live went down at 14:01:58 UTC",
  ]);
});

test("a reminder follows every 6 hours while an alerted Stable Target stays down", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  await rig.crash(pantry, "web");
  rig.at(ALERT_GRACE_MS);
  await rig.evaluate();
  rig.at(ALERT_GRACE_MS + ALERT_REMINDER_MS - MINUTE);
  await rig.evaluate();
  expect(rig.channel.sent.map((alert) => alert.kind)).toEqual(["down"]);

  rig.at(ALERT_GRACE_MS + ALERT_REMINDER_MS);
  await rig.evaluate();
  rig.at(ALERT_GRACE_MS + ALERT_REMINDER_MS + MINUTE);
  await rig.evaluate();
  expect(rig.channel.sent.map((alert) => alert.kind)).toEqual([
    "down",
    "reminder",
  ]);
  expect(rig.channel.sent[1]).toMatchObject({
    title: "pantry live is still down (6 h)",
    summary:
      "Run rig up live --project pantry. Down since 13:58:58 UTC: web: unknown exit, not restarted.",
  });

  rig.at(ALERT_GRACE_MS + 2 * ALERT_REMINDER_MS);
  await rig.evaluate();
  expect(rig.channel.sent.map((alert) => alert.kind)).toEqual([
    "down",
    "reminder",
    "reminder",
  ]);
  const outages = (await rig.state()).activity.filter(
    (entry) => entry.action === "outage",
  );
  expect(outages.map((entry) => entry.outcome)).toEqual([
    "failed",
    "unchanged",
    "unchanged",
  ]);
});

test("a Stable Target that comes back after its alert gets one recovered message and no stale reminder", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  await rig.crash(pantry, "web");
  rig.at(ALERT_GRACE_MS);
  await rig.evaluate();
  rig.at(42 * 60 * MINUTE);
  await rig.restore(pantry, "web");
  await rig.evaluate();
  rig.at(42 * 60 * MINUTE + 30_000);
  await rig.evaluate();
  rig.at(42 * 60 * MINUTE + ALERT_REMINDER_MS * 2);
  await rig.evaluate();

  expect(rig.channel.sent.map((alert) => alert.kind)).toEqual([
    "down",
    "recovered",
  ]);
  expect(rig.channel.sent.at(-1)).toMatchObject({
    title: "pantry live is back up",
    summary: "It was down 42 h.",
    targets: [{ resolved: { how: "running" } }],
  });
  expect((await rig.state()).alerts).toEqual({
    targets: [],
    notifiedAt: expect.any(String),
  });
  const last = (await rig.state()).activity.at(-1)!;
  expect(last).toMatchObject({ action: "outage", outcome: "started" });
});

test("an operator's rig down ends a down period with a message saying so", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  await rig.crash(pantry, "web");
  rig.at(ALERT_GRACE_MS);
  await rig.evaluate();
  rig.at(ALERT_GRACE_MS + 10 * MINUTE);
  await new FileStateStore(rig.root).update((state) => {
    state.targets.find((t) => t.id === pantry.id)!.desired = "stopped";
  });
  await rig.evaluate();
  expect(rig.channel.sent.at(-1)).toMatchObject({
    kind: "recovered",
    title: "pantry live was stopped",
  });
  expect((await rig.state()).activity.at(-1)).toMatchObject({
    action: "outage",
    outcome: "stopped",
  });
});

test("an operator's rig down that begins and ends while the monitor observes the Target sends no down alert for it", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  await rig.crash(pantry, "web");
  rig.at(ALERT_GRACE_MS);
  let downDone = false;
  await rig.evaluate({
    observations: {
      async health() {
        return { ready: true };
      },
      async artifact() {
        return "installed";
      },
      async persistent() {
        return true;
      },
      async listening() {
        return [];
      },
      async process() {
        // rig down runs to its end between the monitor's read of state and the end of its observation.
        if (!downDone) {
          downDone = true;
          await rig.change(pantry, (saved) => {
            saved.desired = "stopped";
          });
        }
        return { state: "stopped" };
      },
    },
  });
  expect(rig.channel.sent).toEqual([]);
  await rig.evaluate();
  expect(rig.channel.sent).toEqual([]);
});

test("a delivery failure is recorded in Activity and diagnostics, retried later, and changes no Target", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  await rig.crash(pantry, "web");
  const targetsBefore = (await rig.state()).targets;
  rig.channel.failing = true;
  rig.at(ALERT_GRACE_MS);
  await rig.evaluate();
  rig.at(ALERT_GRACE_MS + ALERT_RETRY_MS - MINUTE);
  await rig.evaluate();

  let state = await rig.state();
  expect(state.targets).toEqual(targetsBefore);
  expect(state.activity).toEqual([
    expect.objectContaining({
      action: "alert",
      outcome: "failed",
      project: "pantry",
      target: "live",
    }),
  ]);
  expect(state.activity[0]!.message).toBe(
    'The test notification "pantry live went down at 13:58:58 UTC" could not be delivered: The test channel refused the alert. Nothing to do in a test. Rig tries again at 14:08:58 UTC.',
  );
  expect(rig.diagnostics).toEqual([
    expect.objectContaining({
      action: "alert",
      outcome: "delivery-failed",
      errorCode: "ALERT_DELIVERY",
      reason: "test notification",
    }),
  ]);

  rig.channel.failing = false;
  rig.at(ALERT_GRACE_MS + ALERT_RETRY_MS);
  await rig.evaluate();
  state = await rig.state();
  expect(rig.channel.sent.map((alert) => alert.kind)).toEqual(["down"]);
  expect(state.activity.map((entry) => entry.action)).toEqual([
    "alert",
    "outage",
  ]);
  expect(state.alerts?.retry).toBeUndefined();
  expect(state.targets).toEqual(targetsBefore);
});

test("an evaluation whose channel throws unexpectedly still resolves: alerting never fails the caller", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  await rig.crash(pantry, "web");
  rig.at(ALERT_GRACE_MS);
  await expect(
    rig.evaluate({
      channels: [
        {
          channel: "broken channel",
          send: () => Promise.reject(new TypeError("boom")),
        },
      ],
    }),
  ).resolves.toBeUndefined();
  expect((await rig.state()).activity[0]).toMatchObject({
    action: "alert",
    outcome: "failed",
  });
});

test("the Working copy and Previews stay quiet however long they are down", async () => {
  const rig = await fixture();
  const local = await rig.addTarget("pantry", "local", "local");
  const preview = await rig.addTarget("pantry", "preview", "feature-x");
  await rig.crash(local, "web");
  await rig.crash(preview, "web");
  for (const offset of [0, ALERT_GRACE_MS, ALERT_REMINDER_MS * 2]) {
    rig.at(offset);
    await rig.evaluate();
  }
  expect(rig.channel.sent).toEqual([]);
  const state = await rig.state();
  expect(state.activity).toEqual([]);
  expect(state.alerts).toBeUndefined();
});

test("a daemon restart neither repeats an alert nor forgets one", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  const design = await rig.addTarget("design", "live", "live");
  await rig.crash(pantry, "web");
  rig.at(ALERT_GRACE_MS);
  await rig.evaluate();
  expect(rig.channel.sent).toHaveLength(1);

  // design goes down while rigd restarts; its grace counts from its recorded end, not from the new daemon's start.
  await rig.crash(design, "web", T0 + ALERT_GRACE_MS + MINUTE);
  rig.restartDaemon();
  rig.at(ALERT_GRACE_MS + 2 * MINUTE);
  await rig.evaluate();
  expect(rig.channel.sent).toHaveLength(1);

  rig.restartDaemon();
  rig.at(2 * ALERT_GRACE_MS + MINUTE);
  await rig.evaluate();
  expect(rig.channel.sent.map((alert) => alert.title)).toEqual([
    "pantry live went down at 13:58:58 UTC",
    "design live went down at 14:04:58 UTC",
  ]);

  // pantry came back while rigd was stopped: the next daemon still says so.
  await rig.restore(pantry, "web");
  rig.restartDaemon();
  rig.at(3 * ALERT_GRACE_MS);
  await rig.evaluate();
  expect(rig.channel.sent.at(-1)).toMatchObject({
    kind: "recovered",
    title: "pantry live is back up",
  });
  expect(rig.channel.sent).toHaveLength(3);
});

test("a Service stuck waiting for a dependency that never returns keeps its Stable Target down", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live", {
    convex: { restart: "no" },
    web: { restart: "always", dependsOn: ["convex"] },
  });
  await rig.crash(pantry, "convex");
  // web is due for a restart and holds, waiting for convex: status shows it starting.
  rig.processes.set(`${pantry.id}:web`, { state: "stopped" });
  await new FileStateStore(rig.root).update((state) => {
    state.targets[0]!.services!.web = {
      ...state.targets[0]!.services!.web!,
      outcome: {
        kind: "exited",
        signal: "SIGTERM",
        at: new Date(T0).toISOString(),
      },
      retryAt: T0 + 100,
      waitingFor: { service: "convex" },
    };
  });
  rig.at(ALERT_GRACE_MS);
  await rig.evaluate();
  expect(rig.channel.sent[0]!.targets[0]!.services).toEqual([
    expect.objectContaining({
      name: "convex",
      brief: "unknown exit, not restarted",
    }),
    expect.objectContaining({ name: "web", brief: "waiting for convex" }),
  ]);
});

test("a failing readiness check and an unpublished route each count as down", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget(
    "pantry",
    "live",
    "live",
    { web: { health: "http://127.0.0.1:3000/health" } },
    "pantry.example.com",
  );
  rig.unhealthy.add(`${pantry.id}:web`);
  await rig.evaluate();
  rig.at(ALERT_GRACE_MS);
  await rig.evaluate();
  expect(rig.channel.sent[0]!.summary).toBe(
    "Run rig up live --project pantry. web: failing its readiness check.",
  );

  const unpublished = await fixture();
  await unpublished.addTarget(
    "pantry",
    "live",
    "live",
    { web: {} },
    "pantry.example.com",
  );
  const deps = {
    async inspectProxy() {
      return {
        proxyFile: "/rig/proxy/Caddyfile",
        routes: 1,
        state: "unpublished" as const,
      };
    },
  };
  await unpublished.evaluate(deps);
  unpublished.at(ALERT_GRACE_MS);
  await unpublished.evaluate(deps);
  expect(unpublished.channel.sent[0]!.targets[0]).toMatchObject({
    services: [],
    unpublishedRoute: "pantry.example.com",
  });
});

test("with no alert channel enabled, downtime is still counted and the event still recorded once in Activity", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  await rig.crash(pantry, "web");
  rig.at(ALERT_GRACE_MS);
  await rig.evaluate({ channels: [] });
  rig.at(ALERT_GRACE_MS + MINUTE);
  await rig.evaluate({ channels: [] });
  const outages = (await rig.state()).activity;
  expect(outages).toHaveLength(1);
  expect(outages[0]!.message).toEndWith(
    "No alert channel is enabled in the Host config, so nothing was sent.",
  );
});

test("used-up automatic restarts keep a Stable Target down even after clean exits; a clean exit its policy keeps stopped does not", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live", {
    web: { restart: "always" },
    migrate: { restart: "on-failure" },
  });
  const exited = (service: string) => ({
    state: "stopped" as const,
    incarnation: `${service}-1`,
    exitCode: 0,
  });
  rig.processes.set(`${pantry.id}:web`, exited("web"));
  rig.processes.set(`${pantry.id}:migrate`, exited("migrate"));
  await rig.change(pantry, (saved) => {
    const at = new Date(T0).toISOString();
    saved.services!.web = {
      ...saved.services!.web!,
      outcome: { kind: "exited", exitCode: 0, at },
      exhausted: true,
    };
    saved.services!.migrate = {
      ...saved.services!.migrate!,
      outcome: { kind: "exited", exitCode: 0, at },
    };
  });
  rig.at(ALERT_GRACE_MS);
  await rig.evaluate();
  expect(rig.channel.sent[0]!.targets[0]!.services).toEqual([
    {
      name: "web",
      brief: "automatic restarts used up",
      reason: expect.stringContaining("after 5 automatic restarts"),
    },
  ]);
});

test("a readiness check that never answers counts as failing, not as an observation that decides nothing", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live", {
    web: { health: "http://127.0.0.1:3000/health" },
  });
  rig.hung.add(`${pantry.id}:web`);
  await rig.evaluate({ observationBudgetMs: 200 });
  rig.at(ALERT_GRACE_MS);
  await rig.evaluate({ observationBudgetMs: 200 });
  expect(rig.channel.sent[0]!.targets[0]!.services[0]).toMatchObject({
    name: "web",
    brief: "failing its readiness check",
  });
});

test("new outages never silence the reminder about an older one", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  const design = await rig.addTarget("design", "live", "live");
  await rig.crash(pantry, "web");
  rig.at(ALERT_GRACE_MS);
  await rig.evaluate();
  // design goes down, is alerted and comes back, over and over; pantry stays down throughout.
  for (let hour = 1; hour < 6; hour++) {
    rig.at(hour * 60 * MINUTE);
    await rig.crash(design, "web");
    await rig.evaluate();
    rig.at(hour * 60 * MINUTE + ALERT_GRACE_MS);
    await rig.evaluate();
    await rig.restore(design, "web");
    rig.at(hour * 60 * MINUTE + ALERT_GRACE_MS + MINUTE);
    await rig.evaluate();
  }
  rig.at(ALERT_GRACE_MS + ALERT_REMINDER_MS);
  await rig.evaluate();
  expect(rig.channel.sent.at(-1)).toMatchObject({
    kind: "reminder",
    title: "pantry live is still down (6 h)",
  });
});

test("a route check that fails decides nothing: no false recovery, no second alert", async () => {
  const rig = await fixture();
  await rig.addTarget(
    "pantry",
    "live",
    "live",
    { web: {} },
    "pantry.example.com",
  );
  const publication = { state: "unpublished" as "unpublished" | "imported" };
  const failing = { inspection: false };
  const inspectProxy = async () => {
    if (failing.inspection) throw new Error("Caddyfile unreadable");
    return { proxyFile: "/rig/Caddyfile", routes: 1, state: publication.state };
  };
  await rig.evaluate({ inspectProxy });
  rig.at(ALERT_GRACE_MS);
  await rig.evaluate({ inspectProxy });
  failing.inspection = true;
  rig.at(ALERT_GRACE_MS + MINUTE);
  await rig.evaluate({ inspectProxy });
  failing.inspection = false;
  rig.at(ALERT_GRACE_MS + 2 * MINUTE);
  await rig.evaluate({ inspectProxy });
  expect(rig.channel.sent.map((alert) => alert.kind)).toEqual(["down"]);
  publication.state = "imported";
  rig.at(ALERT_GRACE_MS + 3 * MINUTE);
  await rig.evaluate({ inspectProxy });
  expect(rig.channel.sent.map((alert) => alert.kind)).toEqual([
    "down",
    "recovered",
  ]);
});

test("failed deliveries back off, doubling, and a later outage starts with a clean slate", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  await rig.crash(pantry, "web");
  rig.channel.failing = true;
  rig.at(ALERT_GRACE_MS);
  await rig.evaluate();
  expect((await rig.state()).alerts?.retry).toEqual({
    failures: 1,
    at: new Date(T0 + ALERT_GRACE_MS + ALERT_RETRY_MS).toISOString(),
  });
  rig.at(ALERT_GRACE_MS + ALERT_RETRY_MS);
  await rig.evaluate();
  expect((await rig.state()).alerts?.retry).toEqual({
    failures: 2,
    at: new Date(T0 + ALERT_GRACE_MS + 3 * ALERT_RETRY_MS).toISOString(),
  });
  // It recovers before any alert got through: nothing is left to tell, and nothing of the failures is kept.
  await rig.restore(pantry, "web");
  rig.at(ALERT_GRACE_MS + 2 * ALERT_RETRY_MS);
  await rig.evaluate();
  expect((await rig.state()).alerts).toEqual({ targets: [] });
  expect((await rig.state()).activity.map((entry) => entry.action)).toEqual([
    "alert",
    "alert",
  ]);
});

test("a channel that throws synchronously is a failed delivery like any other", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  await rig.crash(pantry, "web");
  rig.at(ALERT_GRACE_MS);
  await expect(
    rig.evaluate({
      channels: [
        {
          channel: "broken channel",
          send() {
            throw new TypeError("not a function");
          },
        },
      ],
    }),
  ).resolves.toBeUndefined();
  expect((await rig.state()).activity).toEqual([
    expect.objectContaining({ action: "alert", outcome: "failed" }),
  ]);
});

test("when one channel delivers and another fails, the alert counts as sent and the failure is still recorded", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  await rig.crash(pantry, "web");
  const broken = fakeChannel();
  broken.failing = true;
  rig.at(ALERT_GRACE_MS);
  await rig.evaluate({ channels: [rig.channel, broken] });
  const state = await rig.state();
  expect(rig.channel.sent).toHaveLength(1);
  expect(state.alerts?.retry).toBeUndefined();
  expect(state.activity.map((entry) => entry.action)).toEqual([
    "outage",
    "alert",
  ]);
  expect(state.activity[1]!.message).toEndWith("Another channel delivered it.");
});

test("going down again before the recovery was told sends neither a recovery nor a second down alert", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  await rig.crash(pantry, "web");
  rig.at(ALERT_GRACE_MS);
  await rig.evaluate();
  rig.channel.failing = true;
  await rig.restore(pantry, "web");
  rig.at(ALERT_GRACE_MS + MINUTE);
  await rig.evaluate();
  await rig.crash(pantry, "web");
  rig.channel.failing = false;
  rig.at(ALERT_GRACE_MS + MINUTE + ALERT_RETRY_MS);
  await rig.evaluate();
  rig.at(3 * ALERT_GRACE_MS + ALERT_RETRY_MS);
  await rig.evaluate();
  expect(rig.channel.sent.map((alert) => alert.kind)).toEqual(["down"]);
  expect((await rig.state()).alerts?.targets).toEqual([
    expect.objectContaining({
      since: new Date(T0 + ALERT_GRACE_MS + MINUTE).toISOString(),
      alertedAt: new Date(T0 + ALERT_GRACE_MS).toISOString(),
    }),
  ]);
});

test("a down Stable Target that is no longer recorded is told as such", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  await rig.crash(pantry, "web");
  rig.at(ALERT_GRACE_MS);
  await rig.evaluate();
  await new FileStateStore(rig.root).update((state) => {
    state.targets = [];
    state.projects = [];
  });
  rig.at(ALERT_GRACE_MS + MINUTE);
  await rig.evaluate();
  expect(rig.channel.sent.at(-1)).toMatchObject({
    kind: "recovered",
    title: "pantry live is no longer recorded",
  });
});

test("a deploy still moving a Stable Target decides nothing; one whose rollback could not finish keeps it down", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  await rig.crash(pantry, "web");
  await rig.change(pantry, (saved) => {
    saved.recovery = {
      plan: saved.plan,
      desired: "running",
      stage: "pending",
      operationId: "deploy-1",
    };
  });
  const deploying = () => ({
    operationId: "deploy-1",
    project: "pantry",
    target: "live",
  });
  for (const offset of [0, ALERT_GRACE_MS, 2 * ALERT_GRACE_MS]) {
    rig.at(offset);
    await rig.evaluate({ mutations: () => [deploying()] });
  }
  expect(rig.channel.sent).toEqual([]);

  await rig.change(pantry, (saved) => {
    saved.recovery!.stage = "blocked";
    saved.desired = "stopped";
  });
  rig.at(3 * ALERT_GRACE_MS);
  await rig.evaluate();
  rig.at(4 * ALERT_GRACE_MS);
  await rig.evaluate();
  // One command, and the same one everywhere: the reason, the summary and the recovery all say down first, then up.
  const recover =
    "rig down live --project pantry, then rig up live --project pantry";
  expect(rig.channel.sent[0]!.summary).toBe(
    `Run ${recover}. deployment: deploy rollback incomplete.`,
  );
  expect(rig.channel.sent[0]!.targets[0]!.recover).toBe(recover);
  expect(rig.channel.sent[0]!.detail).not.toContain("before rig up");
  const report = await hostDoctor({
    store: new FileStateStore(rig.root),
    async inspectHost() {
      return [];
    },
    now: () => new Date(T0 + 4 * ALERT_GRACE_MS).toISOString(),
  } as unknown as RuntimeDependencies);
  expect(
    report.checks.find((check) => check.name === "stable-targets")?.hint,
  ).toBe(
    `Once the cause is fixed, run ${recover}. rig activity shows the reasons Rig recorded.`,
  );
});

test("a deploy that no operation is running any more, left by a daemon that stopped mid-deploy, keeps its Stable Target down", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  await rig.crash(pantry, "web");
  await rig.change(pantry, (saved) => {
    saved.recovery = {
      plan: saved.plan,
      desired: "running",
      stage: "pending",
      operationId: "deploy-1",
    };
  });
  rig.restartDaemon();
  await rig.evaluate();
  rig.at(ALERT_GRACE_MS);
  await rig.evaluate();
  expect(rig.channel.sent).toHaveLength(1);
  expect(rig.channel.sent[0]).toMatchObject({
    kind: "down",
    summary:
      "Run rig down live --project pantry, then rig up live --project pantry. deployment: deploy interrupted, transition unresolved.",
  });
});

test("an operation working on a Stable Target decides nothing: a restart is neither a stop nor a recovery until it ends", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  await rig.crash(pantry, "web");
  rig.at(ALERT_GRACE_MS);
  await rig.evaluate();
  expect(rig.channel.sent.map((alert) => alert.kind)).toEqual(["down"]);

  // rig restart records the Target as stopped before it starts it again.
  await rig.change(pantry, (saved) => {
    saved.desired = "stopped";
  });
  const restarting = () => ({
    operationId: "restart-1",
    project: "pantry",
    target: "live",
  });
  rig.at(ALERT_GRACE_MS + MINUTE);
  await rig.evaluate({ mutations: () => [restarting()] });
  // Selected by the Project's directory rather than its name, the same restart holds the Target just the same.
  await rig.evaluate({
    mutations: () => [{ operationId: "restart-1", repoPath: "/repos/pantry" }],
  });
  expect(rig.channel.sent.map((alert) => alert.kind)).toEqual(["down"]);

  await rig.change(pantry, (saved) => {
    saved.desired = "running";
  });
  await rig.restore(pantry, "web");
  rig.at(ALERT_GRACE_MS + 2 * MINUTE);
  await rig.evaluate();
  expect(rig.channel.sent.at(-1)).toMatchObject({
    kind: "recovered",
    title: "pantry live is back up",
  });
});

test("an operation on another Project or on a Preview does not hold back a Stable Target's alert", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  await rig.crash(pantry, "web");
  for (const mutation of [
    { operationId: "deploy-2", project: "design", target: "live" },
    { operationId: "deploy-3", project: "pantry", target: "preview" },
  ]) {
    rig.at(ALERT_GRACE_MS);
    await rig.evaluate({ mutations: () => [mutation] });
  }
  expect(rig.channel.sent.map((alert) => alert.kind)).toEqual(["down"]);
});

test("a Target command that names no Target works on the Working copy and does not hold back the Stable Target's alert; a Project-wide one does", async () => {
  for (const [mutation, alerted] of [
    [{ operationId: "up-1", action: "up", project: "pantry" }, true],
    [{ operationId: "up-2", action: "up", repoPath: "/repos/pantry" }, true],
    [{ operationId: "restart-3", action: "restart", project: "pantry" }, true],
    [{ operationId: "forget-4", action: "forget", project: "pantry" }, false],
    // A push names no Target: it selects the Stable Target by its Branch later, so it may be working on it.
    [{ operationId: "push-6", action: "git-push", project: "pantry" }, false],
    // Once rigd has selected the kind, it decides, whatever name the command used (a configured name mid-rename).
    [
      {
        operationId: "push-7",
        action: "git-push",
        project: "pantry",
        target: "production",
        kind: "live",
      },
      false,
    ],
    [
      {
        operationId: "push-8",
        action: "git-push",
        project: "pantry",
        target: "preview",
        kind: "preview",
      },
      true,
    ],
    [
      {
        operationId: "up-9",
        action: "up",
        project: "pantry",
        target: "dev",
        kind: "local",
      },
      true,
    ],
    [{ operationId: "old-5", project: "pantry" }, false],
  ] as const) {
    const rig = await fixture();
    const pantry = await rig.addTarget("pantry", "live", "live");
    await rig.crash(pantry, "web");
    await rig.evaluate();
    // The Working copy's build outlasts the grace period.
    rig.at(ALERT_GRACE_MS);
    await rig.evaluate({ mutations: () => [mutation] });
    expect(rig.channel.sent.map((alert) => alert.kind)).toEqual(
      alerted ? ["down"] : [],
    );
  }
});

test("operations running at once each hold back what they may change: a Working copy's up leaves one Project's Stable Target judged while another Project's restart holds its own back", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  const design = await rig.addTarget("design", "live", "live");
  await rig.crash(pantry, "web");
  await rig.crash(design, "web");
  const inFlight = () => [
    {
      operationId: "up-1",
      action: "up",
      project: "pantry",
      target: "dev",
      kind: "local" as const,
    },
    {
      operationId: "restart-2",
      action: "restart",
      project: "design",
      target: "live",
      kind: "live" as const,
    },
  ];
  await rig.evaluate({ mutations: inFlight });
  rig.at(ALERT_GRACE_MS);
  await rig.evaluate({ mutations: inFlight });
  expect(rig.channel.sent).toHaveLength(1);
  expect(rig.channel.sent[0]!.kind).toBe("down");
  expect(rig.channel.sent[0]!.targets.map((target) => target.project)).toEqual([
    "pantry",
  ]);
});

test("a down period an operation is working on sends no first alert, even past the grace period", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  await rig.crash(pantry, "web");
  await rig.evaluate();
  // The operator deploys the fix a minute in; the build outlasts the grace period.
  await rig.change(pantry, (saved) => {
    saved.recovery = {
      plan: saved.plan,
      desired: "running",
      stage: "pending",
      operationId: "deploy-1",
    };
  });
  const deploying = () => ({
    operationId: "deploy-1",
    project: "pantry",
    target: "live",
  });
  for (const offset of [MINUTE, ALERT_GRACE_MS, ALERT_GRACE_MS + MINUTE]) {
    rig.at(offset);
    await rig.evaluate({ mutations: () => [deploying()] });
  }
  expect(rig.channel.sent).toEqual([]);
  await rig.change(pantry, (saved) => {
    delete saved.recovery;
  });
  await rig.restore(pantry, "web");
  rig.at(ALERT_GRACE_MS + 2 * MINUTE);
  await rig.evaluate();
  expect(rig.channel.sent).toEqual([]);
  expect((await rig.state()).alerts).toEqual({ targets: [] });
});

test("doctor shows how long each down Stable Target has been down, as one Host-wide finding", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  const design = await rig.addTarget("design", "live", "live");
  await rig.crash(pantry, "web");
  await rig.crash(design, "web", T0 + 1_000);
  rig.at(10_000);
  await rig.evaluate();
  rig.at(42 * 60 * MINUTE);
  await rig.evaluate();
  const report = await hostDoctor({
    store: new FileStateStore(rig.root),
    async inspectHost() {
      return [];
    },
    now: () => new Date(T0 + 42 * 60 * MINUTE + 30_000).toISOString(),
  } as unknown as RuntimeDependencies);
  expect(report.ok).toBe(false);
  expect(
    report.checks.filter((check) => check.name === "stable-targets"),
  ).toEqual([
    {
      name: "stable-targets",
      ok: false,
      message:
        "2 Stable Targets are down: pantry live for 42 h (since 2026-09-25T13:58:58.000Z), design live for 42 h (since 2026-09-25T13:58:59.000Z).",
      reason: "stable-target-down",
      hint: "Once the cause is fixed, run rig up live --project pantry; rig up live --project design. rig activity shows the reasons Rig recorded.",
    },
  ]);
});

test("rigd status shows how long each down Stable Target has been down, only while rigd is reachable", async () => {
  const rig = await fixture();
  const pantry = await rig.addTarget("pantry", "live", "live");
  await rig.crash(pantry, "web");
  await rig.evaluate();
  // Not reachable: what the state file last recorded would read as downtime still growing, so none is shown.
  const status = await new DaemonAdmin({
    root: rig.root,
    command: [],
    mode: "process",
    userHome: rig.root,
  }).status();
  expect(status.reachable).toBe(false);
  expect(status.down).toBeUndefined();
  const reachable = {
    installed: true,
    running: true,
    reachable: true,
  } as const;
  const recorded = () =>
    recordedDowntime(rig.root, () =>
      new Date(T0 + 42 * 60 * MINUTE).toISOString(),
    );
  expect(await withDowntime(reachable, recorded)).toEqual({
    ...reachable,
    down: [
      {
        project: "pantry",
        target: "live",
        since: "2026-09-25T13:58:58.000Z",
        down: "42 h",
        alerted: false,
        recover: "rig up live --project pantry",
      },
    ],
  });
  expect(
    await withDowntime({ ...reachable, reachable: false }, recorded),
  ).toEqual({ ...reachable, reachable: false });
  expect(
    await withDowntime(reachable, async () => {
      throw new Error("unreadable");
    }),
  ).toEqual(reachable);
  expect(
    renderResult("daemon-status", {
      installed: true,
      running: true,
      reachable: true,
      down: [
        {
          project: "pantry",
          target: "live",
          since: "2026-09-25T13:58:58.000Z",
          down: "42 h",
          alerted: true,
          recover: "rig up live --project pantry",
        },
      ],
    }),
  ).toBe(
    "Installed  yes\nRunning    yes\nReachable  yes\nDown       pantry live for 42 h (since 2026-09-25T13:58:58.000Z); run rig up live --project pantry\n",
  );
});
