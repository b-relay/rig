import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileStateStore } from "../src/runtime/state-store";
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

test("repoint uses the new config path and retains assigned ports, including Convex site ports", async () => {
  const { runtime, state, deps, config } = fixture();
  config.components.api = { uses: "convex" };
  config.components.db = { uses: "sqlite" };
  config.components.cli = { mode: "installed", entrypoint: "cli.ts" };
  deps.files.reservePorts = async () => ({
    web: 4567,
    api: 4568,
    "api.site": 4569,
  });
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
  expect(state.targets[0]?.plan.components).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "api", port: 4568, sitePort: 4569 }),
    ]),
  );
  expect(
    await runtime.command({ action: "doctor", project: "demo" }),
  ).toMatchObject({
    checks: expect.arrayContaining([
      expect.objectContaining({ name: "local/config", ok: true }),
    ]),
  });
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

test.each(["pending", "blocked", "committing"] as const)(
  "uninstall rejects stopped Targets with %s recovery and still permits explicit down",
  async (stage) => {
    const { runtime, state } = fixture();
    await runtime.command({ action: "init", repoPath: "/tmp/developer" });
    await runtime.command({ action: "up", project: "demo" });
    await runtime.command({ action: "down", project: "demo" });
    const candidate = state.targets[0]!;
    candidate.recovery = {
      plan: structuredClone(candidate.plan),
      desired: "running",
      stage,
    };
    candidate.plan.components = [];
    const savedTargets = structuredClone(state.targets);

    await expect(
      runtime.command({ action: "prepare-uninstall" }),
    ).rejects.toMatchObject({
      code: "DEPLOY_RECOVERY",
      hint: expect.stringContaining("rig down"),
    });
    expect(state.targets).toEqual(savedTargets);
    await expect(
      runtime.command({ action: "down", project: "demo" }),
    ).resolves.toMatchObject({ outcome: "stopped" });
    expect(state.targets[0]!.recovery).toBeUndefined();
    await expect(
      runtime.command({ action: "prepare-uninstall" }),
    ).resolves.toEqual({ ready: true });
  },
);

test.each(["pending", "blocked", "committing"] as const)(
  "matching deploy rejects %s recovery without changing its evidence or recording unchanged",
  async (stage) => {
    const { runtime, state } = fixture();
    await runtime.command({ action: "init", repoPath: "/tmp/developer" });
    const deploy = {
      action: "deploy",
      project: "demo",
      target: "live",
      branch: "main",
    } as const;
    await runtime.command(deploy);
    const target = state.targets[0]!;
    target.recovery = {
      plan: structuredClone(target.plan),
      branch: "previous-branch",
      commit: "previous-commit",
      desired: "running",
      stage,
    };
    const before = structuredClone(state.targets);
    const activityCount = state.activity.length;
    await expect(runtime.command(deploy)).rejects.toMatchObject({
      code: "DEPLOY_RECOVERY",
      message: "The previous deployment has an unresolved transition.",
      hint: "Run down for this Target to finish stopping both plans before deploying again.",
    });
    expect(state.targets).toEqual(before);
    expect(state.activity.slice(activityCount)).toEqual([
      expect.objectContaining({
        action: "deploy",
        outcome: "failed",
        message: "DEPLOY_RECOVERY",
      }),
    ]);
  },
);

test.each(["running", "deliberately stopped", "prepared no-up"] as const)(
  "completed matching deploy remains unchanged when %s",
  async (mode) => {
    const { runtime, state, plans } = fixture();
    await runtime.command({ action: "init", repoPath: "/tmp/developer" });
    const deploy = {
      action: "deploy",
      project: "demo",
      target: "live",
      branch: "main",
    } as const;
    await runtime.command({ ...deploy, noUp: mode === "prepared no-up" });
    if (mode === "deliberately stopped")
      await runtime.command({ action: "down", project: "demo", target: "live" });
    const before = structuredClone(state.targets);
    const effects = plans.length;
    const activityCount = state.activity.length;
    expect(before[0]!.recovery).toBeUndefined();
    expect(before[0]!.desired).toBe(mode === "running" ? "running" : "stopped");
    expect(await runtime.command(deploy)).toMatchObject({ outcome: "unchanged" });
    expect(state.targets).toEqual(before);
    expect(plans).toHaveLength(effects);
    expect(state.activity.slice(activityCount)).toEqual([
      expect.objectContaining({ action: "deploy", outcome: "unchanged" }),
    ]);
  },
);

test("failed first activation can deploy the same Commit after reopening without losing Target storage", async () => {
  const { deps, config } = fixture();
  const root = await mkdtemp(join(tmpdir(), "rig-first-deploy-"));
  try {
    deps.root = root;
    deps.store = new FileStateStore(root);
    config.components.db = { uses: "sqlite" };
    let activations = 0;
    deps.lifecycle.up = async (target) => {
      activations++;
      const path = join(target.plan.dataRoot, "retained-data");
      if (activations === 1) {
        await mkdir(target.plan.dataRoot, { recursive: true });
        await writeFile(path, "data from first attempt");
        throw new Error("readiness failed");
      }
      expect(await readFile(path, "utf8")).toBe("data from first attempt");
      return { outcome: "started" };
    };
    const runtime = createRuntime(deps);
    await runtime.command({ action: "init", repoPath: "/tmp/developer" });
    const deploy = {
      action: "deploy", project: "demo", target: "live", branch: "main",
    } as const;
    await expect(runtime.command(deploy)).rejects.toThrow("readiness failed");
    const failed = (await deps.store.read()).targets[0]!;
    expect(failed.recovery).toBeUndefined();
    expect(failed.desired).toBe("stopped");
    deps.store = new FileStateStore(root);
    const reopened = createRuntime(deps);
    expect(await reopened.command(deploy)).toMatchObject({ outcome: "deployed" });
    expect(activations).toBe(2);
    const saved = await deps.store.read();
    expect(saved.targets).toHaveLength(1);
    expect(saved.targets[0]).toMatchObject({
      id: failed.id,
      projectId: failed.projectId,
      name: failed.name,
      createdAt: failed.createdAt,
      logRoot: failed.logRoot,
      branch: "main",
      commit: "abc",
      desired: "running",
      plan: {
        dataRoot: failed.plan.dataRoot,
        preparedComponents: failed.plan.preparedComponents,
      },
    });
    expect(
      saved.activity.filter((a) => a.action === "deploy").map((a) => a.outcome),
    ).toEqual(["failed", "deployed"]);
    expect(await reopened.command(deploy)).toMatchObject({ outcome: "unchanged" });
    expect(activations).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["incomplete", "completed"] as const)(
  "reopened rollback preserves %s deployment semantics",
  async (prior) => {
    const { deps } = fixture();
    const root = await mkdtemp(join(tmpdir(), "rig-retry-recovery-"));
    try {
      deps.root = root;
      deps.store = new FileStateStore(root);
      const runtime = createRuntime(deps);
      await runtime.command({ action: "init", repoPath: "/tmp/developer" });
      const deploy = {
        action: "deploy", project: "demo", target: "live", branch: "main",
      } as const;
      let failActivation = prior === "incomplete";
      let activations = 0;
      deps.lifecycle.up = async () => {
        activations++;
        if (failActivation) throw new Error("readiness failed");
        return { outcome: "started" };
      };
      if (prior === "incomplete")
        await expect(runtime.command(deploy)).rejects.toThrow("readiness failed");
      else await runtime.command(deploy);
      failActivation = true;
      let stops = 0;
      deps.lifecycle.down = async () => {
        if (++stops > 1) throw new Error("cleanup blocked");
        return { outcome: "stopped" };
      };
      await expect(runtime.command({ ...deploy, force: true })).rejects.toThrow(
        "cleanup could not be verified",
      );
      deps.store = new FileStateStore(root);
      const reopened = createRuntime(deps);
      await expect(reopened.command(deploy)).rejects.toThrow(
        "unresolved transition",
      );
      deps.lifecycle.down = async () => ({ outcome: "stopped" });
      await reopened.command({ action: "down", project: "demo", target: "live" });
      failActivation = false;
      const before = activations;
      expect(await reopened.command(deploy)).toMatchObject({
        outcome: prior === "incomplete" ? "deployed" : "unchanged",
      });
      expect(activations).toBe(before + (prior === "incomplete" ? 1 : 0));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("legacy completion metadata is neither inferred nor rewritten on reopen", async () => {
  const { deps, state, runtime } = fixture();
  const root = await mkdtemp(join(tmpdir(), "rig-legacy-completion-"));
  try {
    await runtime.command({ action: "init", repoPath: "/tmp/developer" });
    await runtime.command({
      action: "deploy", project: "demo", target: "live", noUp: true,
    });
    const content = JSON.stringify(state);
    expect(content).not.toContain("deploymentIncomplete");
    await mkdir(join(root, "runtime"));
    const path = join(root, "runtime", "state.json");
    await writeFile(path, content);
    deps.store = new FileStateStore(root);
    expect(await deps.store.read()).toEqual(state);
    expect(await readFile(path, "utf8")).toBe(content);
    expect(
      await createRuntime(deps).command({
        action: "deploy", project: "demo", target: "live",
      }),
    ).toMatchObject({ outcome: "unchanged" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
