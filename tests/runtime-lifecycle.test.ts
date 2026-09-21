import { loopbackListeners } from "./support/activation-doubles";
import { expect, test } from "bun:test";
import {
  createTargetLifecycle,
  type TargetEffects,
} from "../src/runtime/lifecycle";
import type { TargetRecord } from "../src/domain/runtime";
import type { Supervisor } from "../src/providers/contracts";
const target: TargetRecord = {
  id: "t1",
  projectId: "p1",
  name: "local",
  kind: "local",
  desired: "running",
  createdAt: "now",
  updatedAt: "now",
  logRoot: "/tmp/logs",
  plan: {
    project: "demo",
    target: "local",
    workspacePath: "/tmp/developer",
    dataRoot: "/tmp/data",
    deploymentName: "local",
    branchSlug: "local",
    subdomain: "local",
    providers: { processSupervisor: "child" },
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
};

test("readiness expires even when a health provider ignores cancellation, then rolls back newly started processes", async () => {
  const record = structuredClone(target);
  const component = record.plan.components[0]!;
  if (component.kind !== "managed") throw new Error("Expected managed fixture");
  component.health = "http://127.0.0.1:4000/health";
  component.readyTimeout = 0.01;
  const running = new Set<string>();
  let healthSignal: AbortSignal | undefined;
  let rolledBack = false;
  const effects: TargetEffects = {
    async checkpoint(record) {
      return {
        targetId: record.id,
        async commit() {},
        async rollback() {
          rolledBack = true;
        },
      };
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
        running.add(request.key);
        return { outcome: "started" };
      },
      async stop(key) {
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
    health(_component, _target, signal) {
      healthSignal = signal;
      return new Promise<never>(() => {});
    },
    async build() {},
    async install() {
      return { outcome: "unchanged" };
    },
    async route() {},
    async removeRoute() {},
    listeners: async (pid: number) => loopbackListeners(pid, [4000, 4001]),
  };
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      createTargetLifecycle(effects)
        .up(record)
        .catch((error: unknown) => error),
      new Promise((resolve) => {
        watchdog = setTimeout(() => resolve({ code: "TEST_DEADLINE" }), 200);
      }),
    ]);
    expect(outcome).toMatchObject({ code: "HEALTH_FAILED" });
  } finally {
    clearTimeout(watchdog);
  }
  expect(healthSignal?.aborted).toBe(true);
  expect([...running]).toEqual([]);
  expect(rolledBack).toBe(true);
}, 500);
test("up preserves running components and rollback stops only newly started components", async () => {
  const stopped: string[] = [];
  const started: string[] = [];
  const supervisor: Supervisor = {
    async ensureRunning(request) {
      started.push(request.key);
      if (request.key.endsWith(":web")) throw new Error("start failed");
      return { outcome: "unchanged" };
    },
    async stop(key) {
      stopped.push(key);
      return { outcome: "stopped" };
    },
    async observe(key) {
      return key.endsWith(":api")
        ? { state: "running", pid: 1 }
        : { state: "stopped" };
    },
    async shutdown() {},
    async detach() {},
  };
  const lifecycle = createTargetLifecycle({
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
    supervisor: () => supervisor,
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
  });
  await expect(lifecycle.up(target)).rejects.toThrow("start failed");
  expect(started).toEqual(["t1:web"]);
  expect(stopped).toEqual([]);
});
test("down uses recorded plan and reports no-op only when every process was stopped", async () => {
  const keys: string[] = [];
  const supervisor: Supervisor = {
    async ensureRunning() {
      return { outcome: "unchanged" };
    },
    async stop(key) {
      keys.push(key);
      return { outcome: "stopped" };
    },
    async observe() {
      return { state: "stopped" };
    },
    async shutdown() {},
    async detach() {},
  };
  const lifecycle = createTargetLifecycle({
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
    supervisor: () => supervisor,
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
  });
  expect(await lifecycle.down(target)).toEqual({ outcome: "stopped" });
  expect(keys).toEqual(["t1:web", "t1:api"]);
});

test("down attempts every process even when one process stop fails", async () => {
  const stopped: string[] = [];
  const supervisor: Supervisor = {
    async ensureRunning() {
      return { outcome: "unchanged" };
    },
    async stop(key) {
      stopped.push(key);
      if (key.endsWith(":web")) throw new Error("provider failed");
      return { outcome: "stopped" };
    },
    async observe() {
      return { state: "running", pid: 1 };
    },
    async shutdown() {},
    async detach() {},
  };
  const lifecycle = createTargetLifecycle({
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
    supervisor: () => supervisor,
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
  });
  await expect(lifecycle.down(target)).rejects.toThrow();
  expect(stopped).toEqual(["t1:web", "t1:api"]);
});

import { stopFixture } from "./stop-fixture";

test("down on an already-stopped Target attempts every process and remains unchanged", async () => {
  const f = stopFixture();
  expect(await f.lifecycle.down(structuredClone(target))).toEqual({
    outcome: "unchanged",
  });
  expect(f.stops).toEqual(["t1:web", "t1:api"]);
});

test("a mixed Target stops what still runs, and repeated down is unchanged", async () => {
  const f = stopFixture(["t1:api"]);
  const record = structuredClone(target);
  expect(await f.lifecycle.down(record)).toEqual({ outcome: "stopped" });
  expect(await f.lifecycle.down(record)).toEqual({ outcome: "unchanged" });
  expect(f.stops).toEqual(["t1:web", "t1:api", "t1:web", "t1:api"]);
  expect([...f.running]).toEqual([]);
});

test.each(["unknown", "failed-observation"] as const)(
  "%s is not proof of absence and still ends in verified shutdown",
  async (state) => {
    const f = stopFixture(["t1:web"]);
    f.observations.set(
      "t1:web",
      state === "failed-observation"
        ? new Error("Observation failed")
        : { state: "unknown" },
    );
    expect(await f.lifecycle.down(structuredClone(target))).toEqual({
      outcome: "stopped",
    });
    expect(f.stops).toEqual(["t1:web", "t1:api"]);
    expect([...f.running]).toEqual([]);
  },
);

test("failed process shutdown reports STOP_INCOMPLETE and still stops the other components", async () => {
  const f = stopFixture(["t1:web", "t1:api"]);
  f.stopFailures.add("t1:web");
  await expect(f.lifecycle.down(structuredClone(target))).rejects.toMatchObject(
    {
      code: "STOP_INCOMPLETE",
      details: { processFailures: [expect.any(Error)] },
    },
  );
  expect([...f.running]).toEqual(["t1:web"]);
  expect(f.stops).toEqual(["t1:web", "t1:api"]);
});

test("Targets without managed components have no shutdown work", async () => {
  const f = stopFixture();
  const record = structuredClone(target);
  record.plan.components = [];
  expect(await f.lifecycle.down(record)).toEqual({ outcome: "unchanged" });
  expect(f.stops).toEqual([]);
});

test("port contention after selection fails startup and preserves an already running component", async () => {
  const { createRuntimeFiles } = await import("../src/adapters/runtime-files");
  const { createChildSupervisor } =
    await import("../src/providers/child-supervisor");
  const { runCommand } = await import("../src/providers/command-runner");
  const { createProcessInspection, platformKill } =
    await import("../src/providers/process-inspection");
  const { createProcessTiming } =
    await import("../src/providers/process-timing");
  const { mkdtemp, mkdir, rm, writeFile, readFile } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const base = await mkdtemp(join(tmpdir(), "rig-port-contention-"));
  const root = join(base, ".rig");
  await mkdir(root);
  const supervisor = createChildSupervisor({
    stateRoot: root,
    timing: createProcessTiming(),
    processInspection: createProcessInspection({
      run: runCommand,
      kill: platformKill,
    }),
  });
  const ports = await createRuntimeFiles().selectPorts({
    requests: [{ name: "api" }, { name: "web" }],
    occupied: new Map(),
    policy: "dynamic",
  });
  const record = structuredClone(target);
  record.plan.workspacePath = root;
  record.plan.dataRoot = root;
  record.logRoot = join(root, "logs");
  await writeFile(
    join(root, "server.ts"),
    "Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>new Response('owned')});",
  );
  await writeFile(join(root, "precious"), "prior Target work");
  for (const component of record.plan.components) {
    if (component.kind !== "managed") continue;
    component.port = ports[component.name]!;
    component.command = `'${process.execPath}' server.ts`;
    component.env = { PORT: String(component.port), RIG_ROOT: root };
    component.health = `http://127.0.0.1:${component.port}`;
    component.readyTimeout = 0.5;
  }
  let rollback = false;
  const effects: TargetEffects = {
    async checkpoint(record) {
      return {
        targetId: record.id,
        async commit() {},
        async rollback() {
          rollback = true;
        },
      };
    },
    async restoreEffects() {},
    async commitEffects() {},
    async retireSuperseded() {},
    async retireArtifacts() {},
    async pruneCheckpoints() {
      return [];
    },
    supervisor: () => supervisor,
    async prepare() {},
    async environment(_target, component) {
      return component.env;
    },
    async health(component) {
      try {
        return (await fetch(component.health!)).ok
          ? { ready: true }
          : { ready: false, reason: "not ok" };
      } catch {
        return { ready: false, reason: "unreachable" };
      }
    },
    async build() {},
    async install() {
      return { outcome: "unchanged" };
    },
    async route() {},
    async removeRoute() {},
    listeners: async (pid: number) => loopbackListeners(pid, [4000, 4001]),
  };
  const lifecycle = createTargetLifecycle(effects);
  const prior = structuredClone(record);
  prior.plan.components = prior.plan.components.slice(0, 1);
  let competitor: ReturnType<typeof Bun.serve> | undefined;
  try {
    await lifecycle.up(prior);
    competitor = Bun.serve({
      hostname: "127.0.0.1",
      port: ports.web!,
      fetch: () => new Response("competitor", { status: 503 }),
    });
    // The competitor answers on the port, but rig's own process died on EADDRINUSE: fail fast with its exit code.
    await expect(lifecycle.up(record)).rejects.toMatchObject({
      code: "PROCESS_EXITED",
      hint: expect.any(String),
      details: { component: "web", exitCode: 1 },
    });
    expect(rollback).toBe(true);
    expect(await supervisor.observe("t1:api")).toMatchObject({
      state: "running",
    });
    expect(await supervisor.observe("t1:web")).toMatchObject({
      state: "stopped",
    });
    expect(await (await fetch(`http://127.0.0.1:${ports.api}`)).text()).toBe(
      "owned",
    );
    expect(await readFile(join(root, "precious"), "utf8")).toBe(
      "prior Target work",
    );
    expect(
      await readFile(join(record.logRoot, "target.jsonl"), "utf8"),
    ).toContain("EADDRINUSE");
  } finally {
    competitor?.stop(true);
    await supervisor.shutdown();
    await rm(base, { recursive: true, force: true });
  }
  for (const port of Object.values(ports)) {
    const probe = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { data() {} },
    });
    probe.stop();
  }
}, 15000);

test("up prepares the workspace, publishes Tools in plan order, and starts only what is not running", async () => {
  const record = structuredClone(target);
  record.plan.components = [
    {
      name: "tool",
      kind: "installed",
      entrypoint: "tool",
      env: {},
      dependsOn: [],
    },
    record.plan.components[0]!,
  ];
  const events: string[] = [];
  const running = new Set<string>();
  const effects: TargetEffects = {
    async checkpoint(r) {
      return { targetId: r.id, async commit() {}, async rollback() {} };
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
        events.push(`start:${request.componentName}`);
        running.add(request.key);
        return { outcome: "started" };
      },
      async stop(key) {
        running.delete(key);
        return { outcome: "stopped" };
      },
      async shutdown() {},
      async detach() {},
    }),
    async prepare() {
      events.push("prepare");
    },
    async environment() {
      return {};
    },
    async health() {
      return { ready: true };
    },
    async build() {},
    async install(component) {
      events.push(`install:${component.name}`);
      return { outcome: "installed" };
    },
    async route() {},
    async removeRoute() {},
    listeners: async (pid: number) => loopbackListeners(pid, [4000, 4001]),
  };
  const lifecycle = createTargetLifecycle(effects, {
    schedule(delayMs, fire) {
      const timer = setTimeout(fire, delayMs);
      return () => clearTimeout(timer);
    },
    startGraceMs: 0,
  });
  expect(await lifecycle.up(record)).toEqual({ outcome: "started" });
  expect(events).toEqual(["prepare", "install:tool", "start:api"]);
  events.length = 0;
  expect(await lifecycle.up(record)).toEqual({ outcome: "started" });
  expect(events).toEqual(["prepare", "install:tool"]);
});
