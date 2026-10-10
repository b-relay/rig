import { expect, test } from "bun:test";
import type { RuntimeState, TargetRecord } from "../src/domain/runtime";
import { reportingTransitions } from "../src/runtime/health-transitions";
import {
  createTargetLifecycle,
  type TargetEffects,
} from "../src/runtime/lifecycle";
import { loopbackListeners } from "./support/activation-doubles";

/** The runtime's side of the health monitor's epoch rule: every lifecycle transition is reported as it happens. */

const target = (): TargetRecord => ({
  id: "t1",
  projectId: "p1",
  name: "stable",
  kind: "stable",
  desired: "running",
  createdAt: "now",
  updatedAt: "now",
  logRoot: "/tmp/logs",
  plan: {
    project: "demo",
    target: "stable",
    workspacePath: "/tmp/work",
    dataRoot: "/tmp/data",
    deploymentName: "stable",
    branchSlug: "stable",
    subdomain: "stable",
    providers: { processSupervisor: "rigd" },
    preparedComponents: [],
    components: [
      {
        name: "api",
        kind: "managed",
        command: "serve",
        port: 4000,
        readyTimeout: 1,
        env: {},
        dependsOn: [],
      },
      {
        name: "web",
        kind: "managed",
        command: "serve",
        port: 4001,
        readyTimeout: 1,
        env: {},
        dependsOn: ["api"],
      },
    ],
  },
  services: {
    api: {
      deployment: "/tmp/work",
      intent: "running",
      incarnation: "api-1",
      attempts: [],
    },
  },
});

test("every state write that is a lifecycle transition is reported as it is applied, and no other write is", async () => {
  let state = {
    version: 6,
    projects: [],
    targets: [target(), { ...target(), id: "t2", name: "feature" }],
    activity: [],
  } as unknown as RuntimeState;
  const reported: string[] = [];
  const store = reportingTransitions(
    {
      read: async () => structuredClone(state),
      async update(change) {
        const next = structuredClone(state);
        await change(next);
        state = next;
      },
    },
    {
      invalidate: (targetId, service) =>
        reported.push(service ? `${targetId}:${service}` : targetId),
    },
  );
  const writes: [string, (state: RuntimeState) => void][] = [
    [
      "an Activity entry",
      (s) => {
        s.activity.push({ id: "a" } as RuntimeState["activity"][number]);
      },
    ],
    [
      "a plan",
      (s) => {
        s.targets[0]!.plan.components[0]!.env = { A: "1" };
      },
    ],
    [
      "the desired state",
      (s) => {
        s.targets[0]!.desired = "stopped";
      },
    ],
    [
      "a pending destruction",
      (s) => {
        s.targets[1]!.destructionPending = true;
      },
    ],
    [
      "a new process",
      (s) => {
        s.targets[0]!.services!.api!.incarnation = "api-2";
        s.targets[0]!.services!.web = {
          deployment: "/tmp/work",
          intent: "running",
          incarnation: "web-1",
          attempts: [],
        };
      },
    ],
    [
      "a run's unhealthy stretch",
      (s) => {
        s.targets[0]!.services!.api!.healthStretch = {
          since: 1,
          restarts: [1],
        };
      },
    ],
    [
      "a removed Target",
      (s) => {
        s.targets = s.targets.filter((t) => t.id !== "t2");
      },
    ],
  ];
  const seen: Record<string, string[]> = {};
  for (const [name, change] of writes) {
    reported.length = 0;
    await store.update(change);
    seen[name] = [...reported];
  }
  expect(seen).toEqual({
    "an Activity entry": [],
    "a plan": ["t1"],
    "the desired state": ["t1"],
    "a pending destruction": ["t2"],
    "a new process": ["t1:api", "t1:web"],
    "a run's unhealthy stretch": [],
    "a removed Target": ["t2"],
  });
});

test("the lifecycle reports every start and stop of a Service as it begins, and a start that passed its start check", async () => {
  const events: string[] = [];
  const running = new Set<string>();
  const effects: TargetEffects = {
    async checkpoint(record) {
      return { targetId: record.id, async commit() {}, async rollback() {} };
    },
    async restoreEffects() {},
    async commitEffects() {},
    async retireSuperseded() {},
    async pruneCheckpoints() {
      return [];
    },
    async retireArtifacts() {},
    supervisor: () => ({
      async observe(key) {
        return running.has(key)
          ? { state: "running", pid: 1 }
          : { state: "stopped" };
      },
      async ensureRunning(request) {
        events.push(`spawn ${request.componentName}`);
        running.add(request.key);
        return { outcome: "started" };
      },
      async stop(key) {
        events.push(`stop ${key.split(":").at(-1)}`);
        running.delete(key);
        return { outcome: "stopped" };
      },
      async shutdown() {},
      async detach() {},
    }),
    async prepare() {},
    async environment() {
      return {};
    },
    async health() {
      return { ready: true };
    },
    async build() {},
    async install() {
      return { outcome: "unchanged" };
    },
    async route() {},
    async removeRoute() {},
    listeners: async (pid: number) => loopbackListeners(pid, [4000, 4001]),
  };
  const lifecycle = createTargetLifecycle(
    effects,
    {
      schedule(delayMs, fire) {
        const timer = setTimeout(fire, delayMs < 1000 ? 0 : delayMs);
        return () => clearTimeout(timer);
      },
      startGraceMs: 0,
    },
    {
      changing: (t, service) => events.push(`changing ${t.id}:${service}`),
      activated: (t, service, incarnation) =>
        events.push(`activated ${t.id}:${service} ${typeof incarnation}`),
    },
  );
  const record = target();
  await lifecycle.up(record);
  await lifecycle.stop(record, "web");
  await lifecycle.down(record);
  expect(events).toEqual([
    "changing t1:api",
    "spawn api",
    "activated t1:api string",
    "changing t1:web",
    "spawn web",
    "activated t1:web string",
    "changing t1:web",
    "stop web",
    // down stops every Service, dependents first, each reported as its stop begins.
    "changing t1:web",
    "stop web",
    "changing t1:api",
    "stop api",
  ]);
});
