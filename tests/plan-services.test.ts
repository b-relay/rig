import { expect, test } from "bun:test";
import type { TargetRecord } from "../src/domain/runtime";
import type {
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import {
  componentOf,
  hasDependents,
  managedComponent,
  managedServices,
  observeManaged,
  routedPorts,
  routedServices,
} from "../src/runtime/plan-services";

/** `db` has no port, `api` and `web` are routed, `worker` declares a port no path reaches, and `cli` is a Tool. */
const target: TargetRecord = {
  id: "t1",
  projectId: "p1",
  name: "stable",
  kind: "stable",
  desired: "running",
  createdAt: "now",
  updatedAt: "now",
  logRoot: "/logs",
  plan: {
    project: "shop",
    target: "stable",
    workspacePath: "/ws",
    dataRoot: "/data",
    deploymentName: "stable",
    branchSlug: "stable",
    subdomain: "stable",
    providers: { processSupervisor: "child" },
    preparedComponents: [],
    domain: "shop.test",
    proxy: {
      upstream: "web",
      routes: [
        { prefix: "/api", service: "api", port: 4001 },
        { prefix: "/", service: "web", port: 4002 },
      ],
    },
    serviceDomains: [
      { hostname: "admin.shop.test", service: "api", port: 4003 },
    ],
    components: [
      {
        name: "db",
        kind: "managed",
        command: "db",
        readyTimeout: 1,
        env: {},
        dependsOn: [],
      },
      {
        name: "api",
        kind: "managed",
        command: "api",
        port: 4001,
        ports: { http: 4001, admin: 4003 },
        readyTimeout: 1,
        env: {},
        dependsOn: ["db"],
      },
      {
        name: "web",
        kind: "managed",
        command: "web",
        port: 4002,
        readyTimeout: 1,
        env: {},
        dependsOn: ["api"],
      },
      // A Tool that names a dependency: only a Service depending on one counts.
      {
        name: "cli",
        kind: "installed",
        entrypoint: "bin/cli",
        env: {},
        dependsOn: ["web"],
      },
      {
        name: "worker",
        kind: "managed",
        command: "work",
        port: 4004,
        readyTimeout: 1,
        env: {},
        dependsOn: [],
      },
    ],
  },
};

test("managedServices names the plan's Services in plan order, and no Tool", () => {
  expect(managedServices(target)).toEqual(["db", "api", "web", "worker"]);
  expect(
    managedServices({ ...target, plan: { ...target.plan, components: [] } }),
  ).toEqual([]);
});

test("routedPorts gives every port a path or Service domain of the plan reaches for the named Services, and nothing else", () => {
  expect(routedPorts(target, ["api"])).toEqual(new Set([4001, 4003]));
  expect(routedPorts(target, ["api", "web"])).toEqual(
    new Set([4001, 4002, 4003]),
  );
  // A declared port no path reaches, and a Service without one, give nothing.
  expect(routedPorts(target, ["worker", "db"])).toEqual(new Set());
  expect(routedPorts(target, [])).toEqual(new Set());
  expect(routedPorts(target, ["nobody"])).toEqual(new Set());
});

test("routedServices picks among the routed Services only", () => {
  expect(routedServices(target, () => true)).toEqual(new Set(["api", "web"]));
  expect(routedServices(target, (service) => service !== "web")).toEqual(
    new Set(["api"]),
  );
  expect(routedServices(target, () => false)).toEqual(new Set());
  const unrouted = {
    ...target,
    plan: {
      ...target.plan,
      domain: undefined,
      proxy: undefined,
      serviceDomains: undefined,
    },
  };
  expect(routedServices(unrouted, () => true)).toEqual(new Set());
});

test("managedComponent finds a Service by name, and refuses a Tool or a missing name with SERVICE_UNKNOWN", () => {
  expect(managedComponent(target, "web")).toMatchObject({
    name: "web",
    kind: "managed",
  });
  for (const name of ["cli", "search"])
    expect(() => managedComponent(target, name)).toThrow(
      expect.objectContaining({
        code: "SERVICE_UNKNOWN",
        message: `stable has no Service named '${name}'.`,
        hint: "Select a Service of the recorded plan.",
        details: { service: name },
      }),
    );
});

test("componentOf names the Service of a process key of this Target, and none for another Target's key or a job's", () => {
  expect(componentOf(target, "t1:api")).toMatchObject({ name: "api" });
  expect(componentOf(target, "t2:api")).toBeUndefined();
  expect(componentOf(target, "t1:job:api")).toBeUndefined();
  expect(componentOf(target, "t1:cli")).toBeUndefined();
});

test("hasDependents says whether any Service depends on the one named, and a Tool never counts", () => {
  expect(hasDependents(target, "db")).toBe(true);
  expect(hasDependents(target, "api")).toBe(true);
  expect(hasDependents(target, "web")).toBe(false);
  expect(hasDependents(target, "worker")).toBe(false);
});

function supervisorSeeing(
  states: Record<string, ProcessObservation>,
  asked: string[],
): Supervisor {
  return {
    async observe(key) {
      asked.push(key);
      return states[key] ?? { state: "stopped" };
    },
    async ensureRunning() {
      return { outcome: "started" };
    },
    async stop() {
      return { outcome: "unchanged" };
    },
    async shutdown() {},
    async detach() {},
  };
}

test("observeManaged observes each Service in plan order, or only those named, keyed by process key", async () => {
  const asked: string[] = [];
  const supervisor = supervisorSeeing(
    { "t1:api": { state: "running", pid: 7 } },
    asked,
  );
  const all = await observeManaged(target, supervisor);
  expect(asked).toEqual(["t1:db", "t1:api", "t1:web", "t1:worker"]);
  expect([...all]).toEqual([
    ["t1:db", { state: "stopped" }],
    ["t1:api", { state: "running", pid: 7 }],
    ["t1:web", { state: "stopped" }],
    ["t1:worker", { state: "stopped" }],
  ]);
  asked.length = 0;
  const some = await observeManaged(target, supervisor, ["web", "db", "cli"]);
  expect(asked).toEqual(["t1:db", "t1:web"]);
  expect([...some.keys()]).toEqual(["t1:db", "t1:web"]);
});

test("observeManaged stops at the first Service whose owner is unknown, with PROCESS_UNKNOWN", async () => {
  const asked: string[] = [];
  const supervisor = supervisorSeeing(
    { "t1:api": { state: "unknown", reason: "lease unreadable" } },
    asked,
  );
  await expect(observeManaged(target, supervisor)).rejects.toMatchObject({
    code: "PROCESS_UNKNOWN",
    message: "Cannot safely start api.",
    hint: "Run rig doctor to inspect process ownership.",
  });
  expect(asked).toEqual(["t1:db", "t1:api"]);
});
