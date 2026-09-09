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
    providerProfile: "default",
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
  if (component.kind !== "managed")
    throw new Error("Expected managed fixture");
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
    async retireArtifacts() {},
    supervisor: () => ({
      async observe(key) {
        return { state: running.has(key) ? "running" : "stopped" };
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
    }),
    async prepare() {},
    async environment() {
      return {};
    },
    async hook() {},
    health(_component, _target, signal) {
      healthSignal = signal;
      return new Promise<boolean>(() => {});
    },
    async install() {
      return { outcome: "unchanged" };
    },
    async route() {},
    async removeRoute() {},
  };
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      createTargetLifecycle(effects).up(record).catch((error: unknown) => error),
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
      return { state: key.endsWith(":api") ? "running" : "stopped" };
    },
    async shutdown() {},
  };
  const lifecycle = createTargetLifecycle({
    async checkpoint(record) {
      return { targetId: record.id, async commit() {}, async rollback() {} };
    },
    async restoreEffects() {},
    async commitEffects() {},
    async retireSuperseded() {},
    async retireArtifacts() {},
    supervisor: () => supervisor,
    async prepare() {},
    async environment() {
      return {};
    },
    async hook() {},
    async health() {
      return true;
    },
    async install() {
      return { outcome: "unchanged" };
    },
    async route() {},
    async removeRoute() {},
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
  };
  const lifecycle = createTargetLifecycle({
    async checkpoint(record) {
      return { targetId: record.id, async commit() {}, async rollback() {} };
    },
    async restoreEffects() {},
    async commitEffects() {},
    async retireSuperseded() {},
    async retireArtifacts() {},
    supervisor: () => supervisor,
    async prepare() {},
    async environment() {
      return {};
    },
    async hook() {},
    async health() {
      return true;
    },
    async install() {
      return { outcome: "unchanged" };
    },
    async route() {},
    async removeRoute() {},
  });
  expect(await lifecycle.down(target)).toEqual({ outcome: "stopped" });
  expect(keys).toEqual(["t1:web", "t1:api"]);
});

test("down attempts every process even when a hook or another process stop fails", async () => {
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
      return { state: "running" };
    },
    async shutdown() {},
  };
  const lifecycle = createTargetLifecycle({
    async checkpoint(record) {
      return { targetId: record.id, async commit() {}, async rollback() {} };
    },
    async restoreEffects() {},
    async commitEffects() {},
    async retireSuperseded() {},
    async retireArtifacts() {},
    supervisor: () => supervisor,
    async prepare() {},
    async environment() {
      return {};
    },
    async hook() {
      throw new Error("hook failed");
    },
    async health() {
      return true;
    },
    async install() {
      return { outcome: "unchanged" };
    },
    async route() {},
    async removeRoute() {},
  });
  await expect(
    lifecycle.down({
      ...target,
      plan: { ...target.plan, hooks: { preStop: "cleanup" } },
    }),
  ).rejects.toThrow();
  expect(stopped).toEqual(["t1:web", "t1:api"]);
});

import { stopHookFixture } from "./stop-hook-fixture";

function targetWithStopHooks(): TargetRecord {
  const record = structuredClone(target);
  record.plan.hooks = { preStop: "target-pre", postStop: "target-post" };
  for (const component of record.plan.components) {
    if (component.kind === "managed")
      component.hooks = { preStop: `${component.name}-pre`, postStop: `${component.name}-post` };
  }
  return record;
}

test("down on an already-stopped Target skips all pre-stop hooks and remains unchanged", async () => {
  const f = stopHookFixture();
  f.hookFailures.add("target-pre");
  expect(await f.lifecycle.down(targetWithStopHooks())).toEqual({ outcome: "unchanged" });
  expect(f.hooks).toEqual([]);
  expect(f.stops).toEqual(["t1:web", "t1:api"]);
});

test("mixed Targets run pre-stop only for active components, and repeated down invokes no hooks", async () => {
  const f = stopHookFixture(["t1:api"]);
  const record = targetWithStopHooks();
  expect(await f.lifecycle.down(record)).toEqual({ outcome: "stopped" });
  expect(f.hooks).toEqual(["target-pre", "api-pre", "api-post", "target-post"]);
  expect(await f.lifecycle.down(record)).toEqual({ outcome: "unchanged" });
  expect(f.hooks).toEqual(["target-pre", "api-pre", "api-post", "target-post"]);
  expect(f.stops).toEqual(["t1:web", "t1:api", "t1:web", "t1:api"]);
  expect([...f.running]).toEqual([]);
});

test.each(["unknown", "failed-observation", "restart-pending"] as const)(
  "%s is not proof of absence and keeps pre-stop hooks before verified shutdown",
  async (state) => {
    const f = stopHookFixture(["t1:web"]);
    f.observations.set("t1:web", state === "failed-observation"
      ? new Error("Observation failed")
      : state === "restart-pending" ? { state: "stopped", restartPending: true } : { state: "unknown" });
    expect(await f.lifecycle.down(targetWithStopHooks())).toEqual({ outcome: "stopped" });
    expect(f.hooks).toEqual(["target-pre", "web-pre", "web-post", "target-post"]);
    expect([...f.running]).toEqual([]);
  },
);

test("pre-stop failure reports STOP_HOOKS after successful shutdown and retains post-stop cleanup", async () => {
  const f = stopHookFixture(["t1:web", "t1:api"]);
  f.hookFailures.add("target-pre");
  f.hookFailures.add("web-pre");
  await expect(f.lifecycle.down(targetWithStopHooks())).rejects.toMatchObject({
    code: "STOP_HOOKS",
    details: { processesStopped: true, outcome: "stopped", hookFailures: [expect.any(Error), expect.any(Error)] },
  });
  expect(f.hooks).toEqual(["target-pre", "web-pre", "web-post", "api-pre", "api-post", "target-post"]);
  expect([...f.running]).toEqual([]);
});

test("failed process shutdown reports STOP_INCOMPLETE with hook failures and still stops other components", async () => {
  const f = stopHookFixture(["t1:web", "t1:api"]);
  f.hookFailures.add("web-pre");
  f.stopFailures.add("t1:web");
  await expect(f.lifecycle.down(targetWithStopHooks())).rejects.toMatchObject({
    code: "STOP_INCOMPLETE",
    details: { processFailures: [expect.any(Error)], hookFailures: [expect.any(Error)] },
  });
  expect(f.hooks).toEqual(["target-pre", "web-pre", "api-pre", "api-post", "target-post"]);
  expect([...f.running]).toEqual(["t1:web"]);
  expect(f.stops).toEqual(["t1:web", "t1:api"]);
});

test("Targets without managed components have no pre-stop work", async () => {
  const f = stopHookFixture();
  const record = targetWithStopHooks();
  record.plan.components = [];
  expect(await f.lifecycle.down(record)).toEqual({ outcome: "unchanged" });
  expect(f.hooks).toEqual([]);
  expect(f.stops).toEqual([]);
});

test("port contention after selection fails startup and preserves an already running component", async () => {
  const { createRuntimeFiles } = await import("../src/adapters/runtime-files");
  const { createChildSupervisor } = await import("../src/providers/child-supervisor");
  const { mkdtemp, mkdir, rm, writeFile, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const base = await mkdtemp(join(tmpdir(), "rig-port-contention-"));
  const root = join(base, ".rig");
  await mkdir(root);
  const supervisor = createChildSupervisor({ stateRoot: root, restartLimit: 0 });
  const ports = await createRuntimeFiles().selectPorts({ requests: [{ name: "api" }, { name: "web" }], occupied: new Set(), policy: "dynamic" });
  const record = structuredClone(target);
  record.plan.workspacePath = root;
  record.plan.dataRoot = root;
  record.logRoot = join(root, "logs");
  await writeFile(join(root, "server.ts"), "Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>new Response('owned')});");
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
    async checkpoint(record) { return { targetId: record.id, async commit() {}, async rollback() { rollback = true; } }; },
    async restoreEffects() {}, async commitEffects() {}, async retireSuperseded() {}, async retireArtifacts() {},
    supervisor: () => supervisor, async prepare() {}, async environment(_target, component) { return component.env; },
    async hook() {}, async health(component) {
      try { return (await fetch(component.health!)).ok; } catch { return false; }
    }, async install() { return { outcome: "unchanged" }; },
    async route() {}, async removeRoute() {},
  };
  const lifecycle = createTargetLifecycle(effects);
  const prior = structuredClone(record);
  prior.plan.components = prior.plan.components.slice(0, 1);
  let competitor: ReturnType<typeof Bun.serve> | undefined;
  try {
    await lifecycle.up(prior);
    competitor = Bun.serve({ hostname: "127.0.0.1", port: ports.web!, fetch: () => new Response("competitor", { status: 503 }) });
    await expect(lifecycle.up(record)).rejects.toMatchObject({ code: "HEALTH_FAILED", hint: expect.any(String) });
    expect(rollback).toBe(true);
    expect(await supervisor.observe("t1:api")).toMatchObject({ state: "running" });
    expect(await supervisor.observe("t1:web")).toMatchObject({ state: "stopped" });
    expect(await (await fetch(`http://127.0.0.1:${ports.api}`)).text()).toBe("owned");
    expect(await readFile(join(root, "precious"), "utf8")).toBe("prior Target work");
    expect(await readFile(join(record.logRoot, "target.jsonl"), "utf8")).toContain("EADDRINUSE");
  } finally {
    competitor?.stop(true);
    await supervisor.shutdown();
    await rm(base, { recursive: true, force: true });
  }
  for (const port of Object.values(ports)) {
    const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    probe.stop();
  }
}, 15000);
