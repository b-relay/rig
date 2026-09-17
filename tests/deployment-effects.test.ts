import { localActivation } from "./support/activation-doubles";
import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTargetEffects } from "../src/adapters/target-effects";
import { createArtifactInstaller } from "../src/providers/artifact-installer";
import { runCommand } from "../src/providers/command-runner";
import type { ArtifactInstaller } from "../src/providers/artifact-installer";
import { createCaddyRouter } from "../src/providers/caddy-router";
import type { Router } from "../src/providers/caddy-router";
import type { InstalledComponent } from "../src/config/types";
import { createTargetLifecycle } from "../src/runtime/lifecycle";
import { activateDeployment, stopForRecovery } from "../src/runtime/deploy";
import type { TargetRecord, RuntimeState } from "../src/domain/runtime";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import type { Supervisor } from "../src/providers/contracts";
import { RigError, diagnosticCauses } from "../src/domain/errors";
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
      return running.has(key)
        ? { state: "running", pid: 1 }
        : { state: "stopped" };
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
    async detach() {},
  };
  const router = createCaddyRouter({
    caddyfile: join(root, "Caddyfile"),
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });
  const adapters = (
    overrides: { installer?: ArtifactInstaller; router?: Router } = {},
  ) =>
    createTargetEffects({
      ...localActivation([12345]),
      recordingTime: () => new Date().toISOString(),
      root,
      environment: {},
      supervisors: new Map([["child", supervisor]]),
      installer:
        overrides.installer ??
        createArtifactInstaller({
          run: runCommand,
          bunExecutable: process.execPath,
        }),
      router: overrides.router ?? router,
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
    version: 3,
    projects: [],
    targets: [previous],
    activity: [],
  };
  const deps = {
    lifecycle,
    now: () => "2026-01-01T00:00:00.000Z",
    id: () => crypto.randomUUID(),
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
  ).rejects.toMatchObject({
    code: "HOOK_FAILED",
    message: "Hook postStart for the Project exited with code 1.",
    details: { hook: "postStart", exitCode: 1 },
  });
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
    routes: [{ prefix: "/", upstream: "localhost:9876" }],
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
test("a crash between an applied route and its journal capture is rolled back by the next daemon", async () => {
  const f = await fixture();
  await f.lifecycle.up(f.previous);
  await f.lifecycle.down(f.previous);
  const route = await f.router.checkpoint(f.previous.id);
  let crashed = false;
  const crashing: Router = {
    ...f.router,
    async checkpoint(key) {
      if (crashed) throw new Error("rigd died before capture");
      return f.router.checkpoint(key);
    },
  };
  const effects = f.adapters({ router: crashing });
  await effects.checkpoint(f.candidate);
  crashed = true;
  await expect(effects.route(f.candidate)).rejects.toThrow("rigd died");
  expect((await f.router.checkpoint(f.candidate.id)).value).toContain(
    "new.test",
  );
  const recovered = createTargetLifecycle(f.adapters());
  await recovered.restoreEffects(f.candidate);
  expect(await f.router.checkpoint(f.previous.id)).toEqual(route);
  await recovered.up(f.previous);
});
test("a crash between a published executable and its journal capture is rolled back by the next daemon", async () => {
  const f = await fixture();
  await f.lifecycle.up(f.previous);
  await f.lifecycle.down(f.previous);
  const checkpoints = join(
    f.root,
    "effect-checkpoints",
    createHash("sha256").update(f.candidate.id).digest("hex"),
  );
  const installer = createArtifactInstaller({
    run: runCommand,
    bunExecutable: process.execPath,
  });
  const crashing: ArtifactInstaller = {
    ...installer,
    async install(request) {
      const result = await installer.install(request);
      await chmod(checkpoints, 0o500);
      return result;
    },
  };
  const effects = f.adapters({ installer: crashing });
  const tool = f.candidate.plan.components[0] as InstalledComponent;
  await effects.checkpoint(f.candidate);
  await expect(effects.install(tool, f.candidate)).rejects.toThrow();
  await chmod(checkpoints, 0o700);
  expect(await readFile(join(f.root, "bin", "tool"), "utf8")).toBe(
    "#!/bin/sh\necho new\n",
  );
  const recovered = createTargetLifecycle(f.adapters());
  await recovered.restoreEffects(f.candidate);
  expect(await readFile(join(f.root, "bin", "tool"), "utf8")).toBe(
    "#!/bin/sh\necho old\n",
  );
  await recovered.up(f.previous);
});
test("rollback refuses an external artifact edit and retains blocked recovery evidence", async () => {
  const f = await fixture();
  await f.lifecycle.up(f.previous);
  await f.lifecycle.down(f.previous);
  const normalUp = f.deps.lifecycle.up.bind(f.deps.lifecycle);
  f.deps.lifecycle.up = async (target, checkpoint, journal) => {
    const result = await normalUp(target, checkpoint, journal);
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
    // The final inventory write is the first one that clears the recovery record.
    let refused = false;
    f.deps.store.update = async (change) =>
      update(async (state) => {
        await change(state);
        if (refused || state.targets[0]?.recovery) return;
        refused = true;
        throw new Error("final inventory write failed");
      });
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

/** A fixture whose checkpoint commit and rollback fail on demand. */
async function faultyCheckpointFixture() {
  const f = await fixture();
  f.previous.desired = "running";
  await f.lifecycle.up(f.previous);
  const create = f.effects.checkpoint.bind(f.effects);
  const faults: { commit?: unknown; rollback?: unknown } = {};
  f.effects.checkpoint = async (target) => {
    const checkpoint = await create(target);
    return {
      ...checkpoint,
      async commit() {
        if (faults.commit !== undefined) throw faults.commit;
        await checkpoint.commit();
      },
      async rollback() {
        if (faults.rollback !== undefined) throw faults.rollback;
        await checkpoint.rollback();
      },
    };
  };
  return { ...f, faults };
}
/** An untrusted throwable whose properties reject even inspection. */
const malformedThrowable = () =>
  Object.create(null, {
    message: {
      get() {
        throw new Error("property read failure");
      },
    },
  }) as unknown;
test("a retirement whose rollback succeeds rethrows the initiating failure unchanged and can be retried", async () => {
  const f = await faultyCheckpointFixture();
  const initiating = new Error("inventory failure");
  await expect(
    f.lifecycle.retire(f.previous, async () => {
      throw initiating;
    }),
  ).rejects.toBe(initiating);
  expect(await readFile(join(f.root, "bin", "tool"), "utf8")).toBe(
    "#!/bin/sh\necho old\n",
  );
  expect(f.running.size).toBe(1);
  await f.lifecycle.retire(f.previous);
  expect(f.running.size).toBe(0);
});
test.each([
  ["without a publication callback", undefined, { odd: true }, "non-error"],
  [
    "with a publication callback",
    async () => {},
    new RigError("STATE_CORRUPT", "state is corrupt", "hint"),
    "storage",
  ],
] as const)(
  "a retirement commit failure %s keeps the safe initiating category and leaves the unfinished transaction for recovery",
  async (_, publish, failure, category) => {
    const f = await faultyCheckpointFixture();
    f.faults.commit = failure;
    const error: unknown = await f.lifecycle
      .retire(f.previous, publish)
      .catch((e) => e);
    expect(error).toMatchObject({
      code: "RETIRE_COMMIT_PENDING",
      causes: { primaryCause: category },
    });
    expect(diagnosticCauses(error)).toEqual({ primaryCause: category });
    expect(f.running.size).toBe(0);
    await expect(f.lifecycle.retire(f.previous)).rejects.toMatchObject({
      code: expect.stringMatching(/^EFFECTS_/),
    });
  },
);
test("a retirement whose rollback also fails keeps both categories, projects malformed throwables safely, and preserves the transaction", async () => {
  const f = await faultyCheckpointFixture();
  f.faults.rollback = malformedThrowable();
  const targets = structuredClone(f.state.targets);
  const error: unknown = await f.lifecycle
    .retire(f.previous, async () => {
      throw new RigError("STATE_CORRUPT", "state is corrupt", "hint");
    })
    .catch((e) => e);
  expect(error).toMatchObject({
    code: "RETIRE_ROLLBACK",
    causes: { primaryCause: "storage", recoveryCause: "non-error" },
  });
  expect(diagnosticCauses(error)).toEqual({
    primaryCause: "storage",
    recoveryCause: "non-error",
  });
  expect(f.state.targets).toEqual(targets);
  await expect(f.lifecycle.retire(f.previous)).rejects.toMatchObject({
    code: expect.stringMatching(/^EFFECTS_/),
  });
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
