import { test, expect } from "bun:test";
import { createRuntime } from "../src/runtime/application";
import type { RuntimeState } from "../src/domain/runtime";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import {
  parseProjectConfig,
  parseHostConfig,
  resolveTargetPlan,
} from "../src/config";
function fixture() {
  const state: RuntimeState = {
    version: 2,
    projects: [],
    targets: [],
    activity: [],
  };
  let id = 0;
  const config = parseProjectConfig({
    name: "demo",
    components: {
      web: { mode: "managed", command: "serve --host 127.0.0.1", port: 4567 },
    },
  });
  const plans: any[] = [];
  const deps: RuntimeDependencies = {
    root: "/tmp/isolated-rig",
    async assertOwnershipReady() {},
    async readAdminActivity() {
      return [];
    },
    async inspectHost() {
      return [];
    },
    store: {
      async read() {
        return structuredClone(state);
      },
      async update(change) {
        await change(state);
      },
    },
    documents: {
      async initializationInfo() {
        return {
          name: "demo",
          productionBranch: "main",
          gitRequired: false,
          existing: false,
        };
      },
      async identifyInitialization(path) {
        return { repoPath: path, name: config.name };
      },
      async discover(path) {
        return { repoPath: path, document: await this.read(path) };
      },
      async read(path) {
        return {
          path: `${path}/rig.yaml`,
          format: "yaml",
          revision: "abc",
          config,
        };
      },
      async initialize(path) {
        return await this.read(path);
      },
      async rename() {
        throw new Error("unused");
      },
      resolve: resolveTargetPlan,
      async host() {
        return parseHostConfig({});
      },
    },
    sources: {
      async preflight() {
        return { commit: "abc", warnings: [] };
      },
      async prepare(request) {
        return { workspacePath: request.destination, commit: "abc" };
      },
      async resolve() {
        return "abc";
      },
      async currentBranch() {
        return "main";
      },
    },
    lifecycle: {
      async checkpoint(target) {
        return { targetId: target.id, async commit() {}, async rollback() {} };
      },
      async restoreEffects() {},
      async commitEffects() {},
      async retireSuperseded() {},
      async retire(_target, publishRemoval) {
        await publishRemoval?.();
      },
      async up(target) {
        plans.push(target);
        return { outcome: "started" };
      },
      async down(target) {
        plans.push(target);
        return { outcome: "stopped" };
      },
    },
    observations: {
      async process() {
        return { state: "stopped" };
      },
      async health() {
        return false;
      },
      async artifact() {
        return "missing";
      },
      async persistent() {
        return true;
      },
    },
    files: {
      async reservePorts() {
        return { web: 4567 };
      },
      async logs() {
        return { entries: [], cursor: "0" };
      },
      async exists() {
        return true;
      },
    },
    now: () => new Date().toISOString(),
    id: () => `id${++id}`,
    async diagnostic() {},
  };
  return { runtime: createRuntime(deps), state, plans, config, deps };
}
test("init config name is authoritative; local up uses actual repo and later lifecycle reuses recorded policy", async () => {
  const { runtime, state, plans, config } = fixture();
  await runtime.command({ action: "init", repoPath: "/tmp/developer" });
  await runtime.command({ action: "up", project: "demo" });
  expect(plans[0].plan.workspacePath).toBe("/tmp/developer");
  config.components.web = { mode: "managed", command: "changed", port: 9999 };
  await runtime.command({ action: "down", project: "demo" });
  await runtime.command({ action: "up", project: "demo" });
  expect(plans[2].plan.components[0].command).toBe("serve --host 127.0.0.1");
  expect(state.activity.map((a) => a.outcome)).toEqual([
    "registered",
    "started",
    "stopped",
    "started",
  ]);
});
test("deployed source policy survives down/up and same commit is no-op", async () => {
  const { runtime, plans, state } = fixture();
  await runtime.command({ action: "init", repoPath: "/tmp/developer" });
  await runtime.command({
    action: "deploy",
    project: "demo",
    target: "live",
    branch: "main",
  });
  await runtime.command({ action: "down", project: "demo", target: "live" });
  await runtime.command({ action: "up", project: "demo", target: "live" });
  expect(plans.at(-1)).toMatchObject({ branch: "main", commit: "abc" });
  expect(
    await runtime.command({
      action: "deploy",
      project: "demo",
      target: "live",
      branch: "main",
    }),
  ).toMatchObject({ outcome: "unchanged" });
  expect(state.targets).toHaveLength(1);
});

test("unsafe candidate rollback never restores an old plan over surviving candidate processes", async () => {
  const { runtime, state, deps } = fixture();
  await runtime.command({ action: "init", repoPath: "/tmp/developer" });
  await runtime.command({
    action: "deploy",
    project: "demo",
    target: "live",
    branch: "main",
  });
  const previousWorkspace = state.targets[0]!.plan.workspacePath;
  deps.sources.resolve = async () => "def";
  deps.sources.preflight = async () => ({ commit: "def", warnings: [] });
  deps.sources.prepare = async (request) => ({
    workspacePath: request.destination,
    commit: "def",
  });
  deps.lifecycle.up = async () => {
    throw new Error("candidate failed");
  };
  deps.lifecycle.down = async (target) => {
    if (target.commit === "def") throw new Error("cannot stop candidate");
    return { outcome: "stopped" };
  };
  await expect(
    runtime.command({
      action: "deploy",
      project: "demo",
      target: "live",
      branch: "main",
    }),
  ).rejects.toThrow("process cleanup could not be verified");
  expect(state.targets[0]!.commit).toBe("def");
  expect(state.targets[0]!.plan.workspacePath).not.toBe(previousWorkspace);
  expect(state.targets[0]!.recovery).toMatchObject({
    stage: "blocked",
    commit: "abc",
  });
  await expect(
    runtime.command({ action: "up", project: "demo", target: "live" }),
  ).rejects.toThrow("unresolved deployment");
});

test("repoint uses the new config path while old registration is missing, and re-resolves local paths", async () => {
  const { runtime, state, deps } = fixture();
  await runtime.command({ action: "init", repoPath: "/tmp/developer" });
  await runtime.command({ action: "up", project: "demo" });
  await runtime.command({ action: "down", project: "demo" });
  const originalRead = deps.documents.read.bind(deps.documents);
  deps.documents.read = async (path) => {
    if (path === "/tmp/developer") throw new Error("old directory moved");
    return await originalRead(path);
  };
  await runtime.command({
    action: "repoint",
    project: "demo",
    newPath: "/tmp/moved",
  });
  expect(state.projects[0]?.repoPath).toBe("/tmp/moved");
  expect(state.targets[0]?.plan.workspacePath).toBe("/tmp/moved");
});

test("authenticated callers cannot destroy the local or live Target", async () => {
  const { runtime } = fixture();
  await runtime.command({ action: "init", repoPath: "/tmp/developer" });
  await runtime.command({ action: "up", project: "demo" });
  await expect(
    runtime.command({ action: "destroy", project: "demo", target: "local" }),
  ).rejects.toThrow("Only Previews");
});

test("status includes configured-only components and reports bad current config without hiding recorded evidence", async () => {
  const { runtime, deps } = fixture();
  await runtime.command({ action: "init", repoPath: "/tmp/developer" });
  expect(
    await runtime.command({ action: "status", project: "demo" }),
  ).toMatchObject({
    targets: [
      {
        name: "local",
        state: "configured",
        components: [{ name: "web", state: "configured", port: 4567 }],
      },
      { name: "live", state: "configured" },
    ],
  });
  await runtime.command({ action: "up", project: "demo" });
  deps.documents.read = async () => {
    throw new Error("bad config");
  };
  const report = (await runtime.command({
    action: "status",
    project: "demo",
  })) as { targets: unknown[]; warnings: string[] };
  expect(report.targets).toHaveLength(1);
  expect(report.warnings.length).toBe(1);
});

test("Preview names cannot overwrite or destroy the live and local Target identities", async () => {
  const { runtime, state } = fixture();
  await runtime.command({ action: "init", repoPath: "/tmp/developer" });
  await runtime.command({ action: "up", project: "demo" });
  for (const action of ["deploy", "destroy"] as const)
    await expect(
      runtime.command({
        action,
        project: "demo",
        target: "preview",
        branch: "feature",
        deployment: "local",
      }),
    ).rejects.toThrow("Preview names cannot");
  expect(state.targets[0]?.kind).toBe("local");
});
test("a stop failure preserves stopped intent so daemon reconciliation never resurrects the Target", async () => {
  const { runtime, deps, state, plans } = fixture();
  await runtime.command({ action: "init", repoPath: "/tmp/developer" });
  await runtime.command({ action: "up", project: "demo" });
  deps.lifecycle.down = async () => {
    throw new Error("hook failed");
  };
  await expect(
    runtime.command({ action: "down", project: "demo" }),
  ).rejects.toThrow("hook failed");
  expect(state.targets[0]?.desired).toBe("stopped");
  const before = plans.length;
  await runtime.reconcile();
  expect(plans.length).toBe(before);
});

test("Preview deployment defaults to the current Branch before computing its identity", async () => {
  const { runtime, state, deps } = fixture();
  deps.sources.currentBranch = async () => "feature/current";
  await runtime.command({ action: "init", repoPath: "/tmp/developer" });
  await runtime.command({
    action: "deploy",
    project: "demo",
    target: "preview",
  });
  expect(state.targets[0]).toMatchObject({
    kind: "preview",
    branch: "feature/current",
  });
  expect(state.targets[0]?.name).toMatch(/^feature-current-/);
  expect(
    await runtime.command({
      action: "deploy",
      project: "demo",
      target: "preview",
    }),
  ).toMatchObject({ outcome: "unchanged" });
  expect(state.targets).toHaveLength(1);
});

test("host Activity merges final daemon administration chronologically without adding it to Project history", async () => {
  const { runtime, state, deps } = fixture();
  deps.readAdminActivity = async () => [
    {
      id: "admin",
      action: "daemon-install",
      outcome: "installed",
      occurredAt: "2000-01-01T00:00:00.000Z",
    },
  ];
  await runtime.command({ action: "init", repoPath: "/tmp/developer" });
  const host = await runtime.command({ action: "activity" });
  expect(host).toMatchObject({
    operations: [{ id: "admin" }, { outcome: "registered" }],
  });
  expect(
    await runtime.command({ action: "activity", project: "demo" }),
  ).toMatchObject({ operations: [{ outcome: "registered" }] });
  expect(state.activity).toHaveLength(1);
});

test("explicit down restores interrupted non-process effects after verified stop even when stop hooks fail", async () => {
  const { runtime, state, deps } = fixture();
  const { RigError } = await import("../src/domain/errors");
  await runtime.command({ action: "init", repoPath: "/tmp/developer" });
  await runtime.command({ action: "up", project: "demo" });
  let restored = false;
  deps.lifecycle.down = async () => {
    throw new RigError("STOP_HOOKS", "Hook failed.", "Fix hook.");
  };
  deps.lifecycle.restoreEffects = async () => {
    restored = true;
  };
  await expect(
    runtime.command({ action: "down", project: "demo" }),
  ).rejects.toMatchObject({ code: "STOP_HOOKS" });
  expect(restored).toBe(true);
  expect(state.targets[0]?.desired).toBe("stopped");
});

test("Preview destruction passes inventory publication into the retirement transaction", async () => {
  const { runtime, deps, state } = fixture();
  await runtime.command({ action: "init", repoPath: "/tmp/developer" });
  await runtime.command({
    action: "deploy",
    target: "preview",
    branch: "feature",
    project: "demo",
    deployment: "review",
  });
  let retirementReceivedPublication = false;
  deps.lifecycle.retire = async (_target, publishRemoval) => {
    retirementReceivedPublication = !!publishRemoval;
    await publishRemoval?.();
  };
  deps.store.update = async () => {
    throw new Error("inventory unavailable");
  };
  await expect(
    runtime.command({
      action: "destroy",
      target: "preview",
      deployment: "review",
      project: "demo",
    }),
  ).rejects.toThrow("inventory unavailable");
  expect(retirementReceivedPublication).toBe(true);
  expect(state.targets).toHaveLength(1);
});
