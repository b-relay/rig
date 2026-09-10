import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTargetEffects } from "../src/adapters/target-effects";
import { createArtifactInstaller } from "../src/providers/artifact-installer";
import { createCaddyRouter } from "../src/providers/caddy-router";
import { createTargetLifecycle } from "../src/runtime/lifecycle";
import { activateDeployment, stopForRecovery } from "../src/runtime/deploy";
import type { TargetRecord, RuntimeState } from "../src/domain/runtime";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import type { Supervisor } from "../src/providers/contracts";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rig-effect-transaction-"));
  roots.push(root);
  for (const revision of ["old", "new"]) {
    await mkdir(join(root, revision));
    await writeFile(
      join(root, revision, "tool"),
      `#!/bin/sh\necho ${revision}\n`,
    );
  }
  const running = new Set<string>();
  const supervisor: Supervisor = {
    async observe(key) {
      return { state: running.has(key) ? "running" : "stopped" };
    },
    async ensureRunning(request) {
      running.add(request.key);
      return { outcome: "started" };
    },
    async stop(key) {
      const changed = running.delete(key);
      return { outcome: changed ? "stopped" : "unchanged" };
    },
    async shutdown() {},
  };
  const router = createCaddyRouter({
    caddyfile: join(root, "Caddyfile"),
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });
  const adapters = () =>
    createTargetEffects({
      recordingTime: () => new Date().toISOString(),
      root,
      environment: {},
      supervisors: new Map([["child", supervisor]]),
      installer: createArtifactInstaller(),
      router,
      run: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "fixture hook failure",
      }),
    });
  const effects = adapters(),
    lifecycle = createTargetLifecycle(effects);
  const common = { env: {}, dependsOn: [] };
  const previous: TargetRecord = {
    id: "target",
    projectId: "project",
    name: "live",
    kind: "live",
    branch: "main",
    commit: "old",
    desired: "stopped",
    createdAt: "now",
    updatedAt: "now",
    logRoot: join(root, "logs"),
    plan: {
      project: "demo",
      target: "live",
      workspacePath: join(root, "old"),
      dataRoot: join(root, "data"),
      deploymentName: "live",
      branchSlug: "live",
      subdomain: "live",
      providerProfile: "default",
      providers: { processSupervisor: "child" },
      components: [
        { ...common, name: "tool", kind: "installed", entrypoint: "tool" },
        {
          ...common,
          name: "web",
          kind: "managed",
          command: "unused",
          port: 12345,
          readyTimeout: 1,
        },
      ],
      preparedComponents: [],
      domain: "old.test",
      proxy: { upstream: "web" },
    },
  };
  const candidate = structuredClone(previous);
  candidate.commit = "new";
  candidate.plan.workspacePath = join(root, "new");
  candidate.plan.domain = "new.test";
  const state: RuntimeState = {
    version: 2,
    projects: [],
    targets: [previous],
    activity: [],
  };
  const deps = {
    lifecycle,
    store: {
      async read() {
        return structuredClone(state);
      },
      async update(change: (state: RuntimeState) => void | Promise<void>) {
        const next = structuredClone(state);
        await change(next);
        Object.assign(state, next);
      },
    },
  } as RuntimeDependencies;
  return {
    root,
    previous,
    candidate,
    effects,
    lifecycle,
    adapters,
    state,
    deps,
    router,
    running,
  };
}
test("failed candidate restores stopped previous binaries and route before restoring its inventory", async () => {
  const f = await fixture();
  await f.lifecycle.up(f.previous);
  await f.lifecycle.down(f.previous);
  const route = await f.router.checkpoint(f.previous.id);
  f.candidate.plan.hooks = { postStart: "false" };
  await expect(
    activateDeployment(
      f.candidate,
      f.previous,
      { activation: "start" },
      f.deps,
    ),
  ).rejects.toMatchObject({ code: "HOOK_FAILED" });
  expect(f.state.targets[0]).toMatchObject({
    commit: "old",
    desired: "stopped",
  });
  expect(await readFile(join(f.root, "bin", "tool"), "utf8")).toBe(
    "#!/bin/sh\necho old\n",
  );
  expect(await f.router.checkpoint(f.previous.id)).toEqual(route);
  expect(f.running.size).toBe(0);
  const restoredTool = f.previous.plan.components.find(
    (component) => component.kind === "installed",
  )!;
  if (restoredTool.kind !== "installed")
    throw new Error("missing fixture tool");
  expect(
    await f.effects.observations.artifact(
      f.previous,
      restoredTool,
      new AbortController().signal,
    ),
  ).toBe("installed");
});
test("successful route-free deployment removes only its previous owned route", async () => {
  const f = await fixture();
  await f.lifecycle.up(f.previous);
  await f.router.apply({
    key: "other",
    hostname: "untouched.test",
    upstream: "localhost:9876",
  });
  delete f.candidate.plan.domain;
  delete f.candidate.plan.proxy;
  await activateDeployment(
    f.candidate,
    f.previous,
    { activation: "start" },
    f.deps,
  );
  expect(await f.router.checkpoint(f.previous.id)).toEqual({
    key: f.previous.id,
    value: null,
  });
  expect((await f.router.checkpoint("other")).value).toContain(
    "untouched.test",
  );
});
test("a new adapter restores durable executable and route checkpoints after interrupted activation", async () => {
  const f = await fixture();
  await f.lifecycle.up(f.previous);
  await f.lifecycle.down(f.previous);
  const route = await f.router.checkpoint(f.previous.id);
  const checkpoint = await f.lifecycle.checkpoint(f.candidate);
  await f.lifecycle.up(f.candidate, checkpoint);
  await f.lifecycle.down(f.candidate);
  const recovered = createTargetLifecycle(f.adapters());
  await expect(recovered.up(f.candidate)).rejects.toMatchObject({
    code: "EFFECTS_RECOVERY",
  });
  await recovered.restoreEffects(f.candidate);
  expect(await readFile(join(f.root, "bin", "tool"), "utf8")).toBe(
    "#!/bin/sh\necho old\n",
  );
  expect(await f.router.checkpoint(f.previous.id)).toEqual(route);
  await recovered.up(f.previous);
});
test("rollback refuses an external artifact edit and retains blocked recovery evidence", async () => {
  const f = await fixture();
  await f.lifecycle.up(f.previous);
  await f.lifecycle.down(f.previous);
  const normalUp = f.deps.lifecycle.up.bind(f.deps.lifecycle);
  f.deps.lifecycle.up = async (target, checkpoint) => {
    const result = await normalUp(target, checkpoint);
    if (target.commit === "new") {
      await writeFile(join(f.root, "bin", "tool"), "external change");
      throw new Error("late failure");
    }
    return result;
  };
  await expect(
    activateDeployment(
      f.candidate,
      f.previous,
      { activation: "start" },
      f.deps,
    ),
  ).rejects.toMatchObject({ code: "DEPLOY_ROLLBACK_BLOCKED" });
  expect(await readFile(join(f.root, "bin", "tool"), "utf8")).toBe(
    "external change",
  );
  expect(f.state.targets[0]).toMatchObject({
    commit: "new",
    desired: "stopped",
    recovery: { stage: "blocked", commit: "old" },
  });
  await expect(
    stopForRecovery(f.state.targets[0]!, f.deps),
  ).rejects.toMatchObject({ code: "EFFECTS_CHANGED" });
  expect(f.state.targets[0]!.recovery?.stage).toBe("blocked");
});
test("failed shutdown hooks do not prevent verified process rollback or explicit recovery", async () => {
  const f = await fixture();
  f.previous.plan.hooks = { preStop: "false" };
  await f.lifecycle.up(f.previous);
  await expect(f.lifecycle.down(f.previous)).rejects.toMatchObject({
    code: "STOP_HOOKS",
    details: { processesStopped: true },
  });
  f.candidate.plan.hooks = { postStart: "false", preStop: "false" };
  await expect(
    activateDeployment(
      f.candidate,
      f.previous,
      { activation: "start" },
      f.deps,
    ),
  ).rejects.toMatchObject({ code: "HOOK_FAILED" });
  expect(f.state.targets[0]).toMatchObject({
    commit: "old",
    desired: "stopped",
  });
  expect(f.state.targets[0]!.recovery).toBeUndefined();
  expect(await readFile(join(f.root, "bin", "tool"), "utf8")).toBe(
    "#!/bin/sh\necho old\n",
  );
});
test("unsupported historical profiles never invoke real lifecycle effects", async () => {
  const f = await fixture();
  f.previous.plan.providerProfile = "isolated-e2e";
  for (const invoke of [
    () => f.lifecycle.checkpoint(f.previous),
    () => f.lifecycle.up(f.previous),
    () => f.lifecycle.down(f.previous),
    () => f.lifecycle.restoreEffects(f.previous),
    () => f.lifecycle.retire(f.previous),
  ])
    await expect(invoke()).rejects.toMatchObject({
      code: "PROVIDER_PROFILE_UNSUPPORTED",
    });
  expect(f.running.size).toBe(0);
  await expect(readFile(join(f.root, "bin", "tool"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
test("retired Preview executables release their names without deleting persistent data or source", async () => {
  const f = await fixture();
  f.previous.kind = "preview";
  f.previous.name = "preview";
  f.previous.plan.target = "preview";
  await f.lifecycle.up(f.previous);
  await mkdir(f.previous.plan.dataRoot);
  await writeFile(join(f.previous.plan.dataRoot, "precious"), "keep");
  await f.lifecycle.retire(f.previous);
  await expect(
    readFile(join(f.root, "bin", "tool-preview")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    await readFile(join(f.previous.plan.dataRoot, "precious"), "utf8"),
  ).toBe("keep");
  expect(
    await readFile(join(f.previous.plan.workspacePath, "tool"), "utf8"),
  ).toBe("#!/bin/sh\necho old\n");
  const replacement = { ...f.previous, id: "replacement" };
  await f.lifecycle.up(replacement);
  expect(await readFile(join(f.root, "bin", "tool-preview"), "utf8")).toBe(
    "#!/bin/sh\necho old\n",
  );
});
test("state publication failure restores old effects, while an initial state failure leaves healthy processes untouched", async () => {
  const f = await fixture();
  await f.lifecycle.up(f.previous);
  f.previous.desired = "running";
  const update = f.deps.store.update.bind(f.deps.store);
  f.deps.store.update = async () => {
    throw new Error("initial publication failure");
  };
  await expect(
    activateDeployment(
      f.candidate,
      f.previous,
      { activation: "start" },
      f.deps,
    ),
  ).rejects.toThrow("initial publication failure");
  expect(f.running.size).toBe(1);
  expect(await readFile(join(f.root, "bin", "tool"), "utf8")).toBe(
    "#!/bin/sh\necho old\n",
  );
  let writes = 0;
  f.deps.store.update = async (change) => {
    if (++writes === 2) throw new Error("final publication failure");
    await update(change);
  };
  await expect(
    activateDeployment(
      f.candidate,
      f.previous,
      { activation: "start" },
      f.deps,
    ),
  ).rejects.toThrow("final publication failure");
  expect(f.state.targets[0]).toMatchObject({
    commit: "old",
    desired: "running",
  });
  expect(f.running.size).toBe(1);
  expect(await readFile(join(f.root, "bin", "tool"), "utf8")).toBe(
    "#!/bin/sh\necho old\n",
  );
  expect((await f.router.checkpoint(f.previous.id)).value).toContain(
    "old.test",
  );
});

test("review regression: removing an installed Component releases its previously owned executable", async () => {
  const f = await fixture();
  await f.lifecycle.up(f.previous);
  await f.lifecycle.down(f.previous);
  f.candidate.plan.components = f.candidate.plan.components.filter(
    (component) => component.name !== "tool",
  );
  await activateDeployment(
    f.candidate,
    f.previous,
    { activation: "start" },
    f.deps,
  );
  await expect(readFile(join(f.root, "bin", "tool"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("durable commit decision recovers new effects and policy after checkpoint finalization fails", async () => {
  const f = await fixture();
  await f.lifecycle.up(f.previous);
  await f.lifecycle.down(f.previous);
  const create = f.deps.lifecycle.checkpoint.bind(f.deps.lifecycle);
  f.deps.lifecycle.checkpoint = async (target, previous) => {
    const checkpoint = await create(target, previous);
    return {
      ...checkpoint,
      async commit() {
        throw new Error("process interrupted before checkpoint commit");
      },
    };
  };
  await expect(
    activateDeployment(
      f.candidate,
      f.previous,
      { activation: "start" },
      f.deps,
    ),
  ).rejects.toMatchObject({ code: "DEPLOY_COMMIT_PENDING" });
  expect(f.state.targets[0]).toMatchObject({
    commit: "new",
    recovery: { stage: "committing", commit: "old" },
  });
  f.deps.lifecycle = createTargetLifecycle(f.adapters());
  const stopped = await stopForRecovery(f.state.targets[0]!, f.deps);
  expect(stopped).toMatchObject({ commit: "new", desired: "stopped" });
  expect(stopped.recovery).toBeUndefined();
  expect(await readFile(join(f.root, "bin", "tool"), "utf8")).toBe(
    "#!/bin/sh\necho new\n",
  );
  expect((await f.router.checkpoint("target")).value).toContain("new.test");
});

test("first deployment and final inventory failure also retain a recoverable commit decision", async () => {
  for (const existing of [false, true]) {
    const f = await fixture();
    if (existing) {
      await f.lifecycle.up(f.previous);
      await f.lifecycle.down(f.previous);
    } else f.state.targets = [];
    const update = f.deps.store.update.bind(f.deps.store);
    let writes = 0;
    f.deps.store.update = async (change) => {
      if (++writes === 3) throw new Error("final inventory write failed");
      await update(change);
    };
    await expect(
      activateDeployment(
        f.candidate,
        existing ? f.previous : undefined,
        { activation: "start" },
        f.deps,
      ),
    ).rejects.toMatchObject({ code: "DEPLOY_COMMIT_PENDING" });
    expect(f.state.targets[0]).toMatchObject({
      commit: "new",
      recovery: { stage: "committing" },
    });
    f.deps.lifecycle = createTargetLifecycle(f.adapters());
    await stopForRecovery(f.state.targets[0]!, f.deps);
    expect(f.state.targets[0]).toMatchObject({
      commit: "new",
      desired: "stopped",
    });
    expect(f.state.targets[0]!.recovery).toBeUndefined();
    expect(await readFile(join(f.root, "bin", "tool"), "utf8")).toBe(
      "#!/bin/sh\necho new\n",
    );
  }
});

test("failed retirement inventory publication restores owned effects and previously running processes", async () => {
  const f = await fixture();
  f.previous.desired = "running";
  await f.lifecycle.up(f.previous);
  const route = await f.router.checkpoint(f.previous.id);
  await expect(
    f.lifecycle.retire(f.previous, async () => {
      throw new Error("inventory failure");
    }),
  ).rejects.toThrow("inventory failure");
  expect(await readFile(join(f.root, "bin", "tool"), "utf8")).toBe(
    "#!/bin/sh\necho old\n",
  );
  expect(await f.router.checkpoint(f.previous.id)).toEqual(route);
  expect(f.running.size).toBe(1);
});

test("failed retirement finalization never restores executables after inventory removal committed", async () => {
  const f = await fixture();
  await f.lifecycle.up(f.previous);
  const create = f.effects.checkpoint.bind(f.effects);
  f.effects.checkpoint = async (target) => {
    const checkpoint = await create(target);
    return {
      ...checkpoint,
      async commit() {
        throw new Error("checkpoint finalization failure");
      },
    };
  };
  await expect(
    f.lifecycle.retire(f.previous, async () => {
      f.state.targets = [];
    }),
  ).rejects.toMatchObject({ code: "RETIRE_COMMIT_PENDING" });
  expect(f.state.targets).toHaveLength(0);
  await expect(readFile(join(f.root, "bin", "tool"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(f.running.size).toBe(0);
});

test("changing installName retires the old destination and preserves receipt rollback", async () => {
  const f = await fixture();
  await f.lifecycle.up(f.previous);
  await f.lifecycle.down(f.previous);
  const tool = f.candidate.plan.components.find(
    (component) => component.kind === "installed",
  )!;
  if (tool.kind !== "installed") throw new Error("missing fixture tool");
  tool.installName = "next-tool";
  f.candidate.plan.hooks = { postStart: "false" };
  await expect(
    activateDeployment(
      f.candidate,
      f.previous,
      { activation: "start" },
      f.deps,
    ),
  ).rejects.toMatchObject({ code: "HOOK_FAILED" });
  expect(await readFile(join(f.root, "bin", "tool"), "utf8")).toBe(
    "#!/bin/sh\necho old\n",
  );
  await expect(
    readFile(join(f.root, "bin", "next-tool")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  delete f.candidate.plan.hooks;
  delete f.candidate.recovery;
  await activateDeployment(
    f.candidate,
    f.previous,
    { activation: "start" },
    f.deps,
  );
  await expect(readFile(join(f.root, "bin", "tool"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(join(f.root, "bin", "next-tool"), "utf8")).toBe(
    "#!/bin/sh\necho new\n",
  );
});

test("commit recovery refuses an external executable change without discarding the durable decision", async () => {
  const f = await fixture();
  await f.lifecycle.up(f.previous);
  await f.lifecycle.down(f.previous);
  const create = f.deps.lifecycle.checkpoint.bind(f.deps.lifecycle);
  f.deps.lifecycle.checkpoint = async (target, previous) => {
    const checkpoint = await create(target, previous);
    return {
      ...checkpoint,
      async commit() {
        throw new Error("interrupted");
      },
    };
  };
  await expect(
    activateDeployment(
      f.candidate,
      f.previous,
      { activation: "start" },
      f.deps,
    ),
  ).rejects.toMatchObject({ code: "DEPLOY_COMMIT_PENDING" });
  await writeFile(join(f.root, "bin", "tool"), "external bytes");
  f.deps.lifecycle = createTargetLifecycle(f.adapters());
  await expect(
    stopForRecovery(f.state.targets[0]!, f.deps),
  ).rejects.toMatchObject({ code: "EFFECTS_CHANGED" });
  expect(f.state.targets[0]!.recovery?.stage).toBe("committing");
  expect(await readFile(join(f.root, "bin", "tool"), "utf8")).toBe(
    "external bytes",
  );
});

test("no-up cannot certify the old installed binary as belonging to the newly recorded source", async () => {
  const f = await fixture();
  await f.lifecycle.up(f.previous);
  await f.lifecycle.down(f.previous);
  await activateDeployment(
    f.candidate,
    f.previous,
    { activation: "prepare" },
    f.deps,
  );
  const tool = f.candidate.plan.components.find(
    (component) => component.kind === "installed",
  )!;
  if (tool.kind !== "installed") throw new Error("missing fixture tool");
  expect(
    await f.effects.observations.artifact(
      f.candidate,
      tool,
      new AbortController().signal,
    ),
  ).toBe("unknown");
  expect(await readFile(join(f.root, "bin", "tool"), "utf8")).toBe(
    "#!/bin/sh\necho old\n",
  );
  await f.lifecycle.up(f.candidate);
  expect(
    await f.effects.observations.artifact(
      f.candidate,
      tool,
      new AbortController().signal,
    ),
  ).toBe("installed");
  expect(await readFile(join(f.root, "bin", "tool"), "utf8")).toBe(
    "#!/bin/sh\necho new\n",
  );
});
