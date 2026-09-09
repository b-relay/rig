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
