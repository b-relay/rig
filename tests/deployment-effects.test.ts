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
import type { Router } from "../src/providers/caddy-router";
import type { InstalledComponent } from "../src/config/types";
import { createTargetLifecycle } from "../src/runtime/lifecycle";
import { activateDeployment, stopForRecovery } from "../src/runtime/deploy";
import type { TargetRecord, RuntimeState } from "../src/domain/runtime";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import type { Supervisor } from "../src/providers/contracts";
import { RigError, diagnosticCauses } from "../src/domain/errors";
import { unreloadedCaddy } from "./support/router-doubles";
import { managedCaddyWorld } from "./support/managed-caddy-double";
import { STATE_VERSION } from "../src/runtime/state-schema";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(options: { router?: Router } = {}) {
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
  const router = options.router ?? unreloadedCaddy(root);
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
        stderr: "fixture command failure",
      }),
    });
  const effects = adapters(),
    lifecycle = createTargetLifecycle(effects);
  const common = { env: {}, dependsOn: [] };
  const previous: TargetRecord = {
    id: "target",
    projectId: "project",
    name: "stable",
    kind: "stable",
    branch: "main",
    commit: "old",
    desired: "stopped",
    createdAt: "now",
    updatedAt: "now",
    logRoot: join(root, "logs"),
    plan: {
      project: "demo",
      target: "stable",
      workspacePath: join(root, "old"),
      dataRoot: join(root, "data"),
      deploymentName: "stable",
      branchSlug: "stable",
      subdomain: "stable",
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
    version: STATE_VERSION,
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
/** Makes the candidate's Service fail its readiness gate, so activation fails after its Tool and route were published. */
function failReadiness(candidate: TargetRecord): void {
  const web = candidate.plan.components.find(
    (component) => component.kind === "managed",
  );
  if (web?.kind !== "managed") throw new Error("missing fixture service");
  web.health = "false";
}
test("failed candidate restores stopped previous binaries and route before restoring its inventory", async () => {
  const f = await fixture();
  await f.lifecycle.up(f.previous);
  await f.lifecycle.down(f.previous);
  const route = await f.router.checkpoint(f.previous.id);
  failReadiness(f.candidate);
  await expect(
    activateDeployment(
      f.candidate,
      f.previous,
      { activation: "start" },
      f.deps,
    ),
  ).rejects.toMatchObject({
    code: "HEALTH_FAILED",
    details: { component: "web", outcome: "unready" },
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
test("a failed deploy's rollback restores the previous route withheld: it reaches the stopped Services' ports only once the previous plan's start verifies them", async () => {
  const f = await fixture();
  f.previous.desired = "running";
  await f.lifecycle.up(f.previous);
  expect((await f.router.checkpoint(f.previous.id)).value).toContain(
    "reverse_proxy 127.0.0.1:12345",
  );
  failReadiness(f.candidate);
  // The previous plan cannot be started again, so whatever the rollback left is what stays published.
  const up = f.deps.lifecycle.up.bind(f.deps.lifecycle);
  f.deps.lifecycle.up = async (target, ...rest) => {
    if (target.commit === "old")
      throw new Error("the previous plan cannot start");
    return up(target, ...rest);
  };
  await expect(
    activateDeployment(
      f.candidate,
      f.previous,
      { activation: "start" },
      f.deps,
    ),
  ).rejects.toMatchObject({ code: "DEPLOY_RESTORE_FAILED" });
  const restored = (await f.router.checkpoint(f.previous.id)).value!;
  expect(restored).toContain("old.test {");
  expect(restored).toContain("respond 503");
  expect(restored).not.toContain("reverse_proxy");
});
test("rig down of an interrupted deploy withholds the route inside the interrupted transaction, so its recovery is not refused as an outside change", async () => {
  const f = await fixture();
  f.previous.desired = "running";
  await f.lifecycle.up(f.previous);
  // A rigd that stopped after the candidate's route was published, before the deploy was decided.
  await f.lifecycle.checkpoint(f.candidate, f.previous);
  await f.effects.route(f.candidate, { verified: new Set([12345]) });
  const recovering: TargetRecord = {
    ...f.candidate,
    recovery: {
      plan: f.previous.plan,
      branch: "main",
      commit: "old",
      desired: "running",
      stage: "pending",
    },
  };
  const next = createTargetLifecycle(f.adapters());
  await next.down(recovering);
  await next.restoreEffects(recovering);
  const route = (await f.router.checkpoint(f.previous.id)).value!;
  expect(route).toContain("old.test {");
  expect(route).not.toContain("reverse_proxy");
});
test("successful route-free deployment removes only its previous owned route", async () => {
  const f = await fixture();
  await f.lifecycle.up(f.previous);
  await f.router.apply({
    key: "other",
    sites: [
      {
        hostname: "untouched.test",
        routes: [{ prefix: "/", upstream: "localhost:9876" }],
      },
    ],
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
  // It dies once the route is applied, before the journal captures it.
  const crashing: Router = {
    ...f.router,
    async apply(request) {
      await f.router.apply(request);
      crashed = true;
    },
    async checkpoint(key) {
      if (crashed) throw new Error("rigd died before capture");
      return f.router.checkpoint(key);
    },
  };
  const effects = f.adapters({ router: crashing });
  await effects.checkpoint(f.candidate);
  await expect(
    effects.route(f.candidate, { verified: new Set() }),
  ).rejects.toThrow("rigd died");
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
  const { target: stopped } = await stopForRecovery(
    f.state.targets[0]!,
    f.deps,
  );
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
  failReadiness(f.candidate);
  await expect(
    activateDeployment(
      f.candidate,
      f.previous,
      { activation: "start" },
      f.deps,
    ),
  ).rejects.toMatchObject({ code: "HEALTH_FAILED" });
  expect(await readFile(join(f.root, "bin", "tool"), "utf8")).toBe(
    "#!/bin/sh\necho old\n",
  );
  await expect(
    readFile(join(f.root, "bin", "next-tool")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const web = f.candidate.plan.components.find(
    (component) => component.kind === "managed",
  )!;
  if (web.kind !== "managed") throw new Error("missing fixture service");
  delete web.health;
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

test("a working Target's Tool published under its name from before names were fixed is retired, and published as <tool>-dev, when the Target is planned again", async () => {
  const f = await fixture();
  /** The fixture's Tool on a working Target, as state version 4 is read (published as tool-local) or as planned now. */
  const working = (publishedAs?: string): TargetRecord => {
    const target = structuredClone(f.previous);
    target.kind = target.plan.target = "working";
    target.name = target.plan.deploymentName = "working";
    target.plan.branchSlug = target.plan.subdomain = "working";
    delete target.branch;
    delete target.commit;
    delete target.plan.domain;
    delete target.plan.proxy;
    target.plan.components = target.plan.components
      .filter((component) => component.kind === "installed")
      .map((component) => ({
        ...component,
        ...(publishedAs ? { publishedAs } : {}),
      }));
    return target;
  };
  const migrated = working("tool-local");
  f.state.targets = [migrated];
  await f.lifecycle.up(migrated);
  expect(await readFile(join(f.root, "bin", "tool-local"), "utf8")).toBe(
    "#!/bin/sh\necho old\n",
  );
  // Until it is planned again, the Tool is observed where it was published.
  const tool = migrated.plan.components[0] as InstalledComponent;
  expect(
    await f.effects.observations.artifact(
      migrated,
      tool,
      new AbortController().signal,
    ),
  ).toBe("installed");
  // What rig up does for a stopped working Target: retire what only the old plan names, publish the new one.
  await f.lifecycle.down(migrated);
  const replanned = working();
  const checkpoint = await f.lifecycle.checkpoint(replanned, migrated);
  await f.lifecycle.retireSuperseded(migrated, replanned);
  await checkpoint.commit();
  await f.lifecycle.up(replanned);
  await expect(
    readFile(join(f.root, "bin", "tool-local")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.root, "bin", "tool-dev"), "utf8")).toBe(
    "#!/bin/sh\necho old\n",
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

test("Host config Rig refused never takes an unrelated Project offline: B deploys and stays up while a route colliding with A is pending", async () => {
  const caddy = await managedCaddyWorld({ tls: { ca: "internal" } });
  roots.push(caddy.root);
  // Project A serves a.test; the owner then adds a proxy.routes entry for it, which Rig refuses and records as pending.
  await caddy.caddy.router.apply({
    key: "a",
    sites: [
      {
        hostname: "a.test",
        routes: [{ prefix: "/", upstream: "127.0.0.1:4000" }],
      },
    ],
  });
  const f = await fixture({ router: caddy.caddy.router });
  await f.lifecycle.up(f.previous);
  caddy.setSettings({ tls: { ca: "internal" }, routes: { "a.test": 3005 } });
  await expect(caddy.caddy.republish()).rejects.toMatchObject({
    code: "ROUTE_CONFLICT",
  });
  // Deploying B stops its previous Deployment and publishes its routes with the settings Caddy accepted.
  const deployed = await activateDeployment(
    f.candidate,
    f.previous,
    { activation: "start" },
    f.deps,
  );
  expect(deployed).toMatchObject({ commit: "new", desired: "running" });
  expect(f.running.size).toBe(1);
  expect(caddy.servedRoutes()).toContain("new.test");
  expect(caddy.servedRoutes()).toContain("a.test");
  expect(caddy.servedRoutes()).not.toContain("old.test");
});

test("a deploy whose route cannot be published is refused before the previous Deployment stops", async () => {
  const caddy = await managedCaddyWorld({
    tls: { ca: "internal" },
    routes: { "new.test": 3005 },
  });
  roots.push(caddy.root);
  const f = await fixture({ router: caddy.caddy.router });
  await f.lifecycle.up(f.previous);
  const served = caddy.servedRoutes();
  await expect(
    activateDeployment(
      f.candidate,
      f.previous,
      { activation: "start" },
      f.deps,
    ),
  ).rejects.toMatchObject({ code: "ROUTE_CONFLICT" });
  // B's previous Deployment never stopped, and Caddy still serves it.
  expect(f.running.size).toBe(1);
  expect(f.state.targets[0]).toMatchObject({ commit: "old" });
  expect(caddy.servedRoutes()).toBe(served);
  expect(served).toContain("old.test");
});

test("a deploy's reservation is released however it ends: activated, prepared without starting, or failed", async () => {
  for (const ending of ["activated", "prepared", "failed"] as const) {
    const caddy = await managedCaddyWorld({ tls: { ca: "internal" } });
    roots.push(caddy.root);
    const f = await fixture({ router: caddy.caddy.router });
    await f.lifecycle.up(f.previous);
    if (ending === "failed") failReadiness(f.candidate);
    const deployed = activateDeployment(
      f.candidate,
      f.previous,
      { activation: ending === "prepared" ? "prepare" : "start" },
      f.deps,
    );
    if (ending === "failed")
      await expect(deployed).rejects.toMatchObject({ code: "HEALTH_FAILED" });
    else await deployed;
    // The owner then claims the candidate's hostname for a route of their own.
    caddy.setSettings({
      tls: { ca: "internal" },
      routes: { "new.test": 3005 },
    });
    if (ending === "activated")
      // Served by the Target now: refused as the Target's, not as a deploy's reservation.
      await expect(caddy.caddy.republish()).rejects.toMatchObject({
        message: expect.stringContaining("new.test would belong to two owners"),
      });
    // Nothing holds it: the owner's route is accepted.
    else expect(await caddy.caddy.republish()).toEqual({ published: true });
  }
});

test("concurrent deploys of one hostname: the second is refused before it stops its previous Deployment", async () => {
  const caddy = await managedCaddyWorld({ tls: { ca: "internal" } });
  roots.push(caddy.root);
  // Another Target's deploy has checked new.test and is about to publish it.
  await caddy.caddy.router.check!({
    key: "other",
    sites: [
      {
        hostname: "new.test",
        routes: [{ prefix: "/", upstream: "127.0.0.1:4000" }],
      },
    ],
  });
  const f = await fixture({ router: caddy.caddy.router });
  await f.lifecycle.up(f.previous);
  await expect(
    activateDeployment(
      f.candidate,
      f.previous,
      { activation: "start" },
      f.deps,
    ),
  ).rejects.toMatchObject({ code: "ROUTE_CONFLICT" });
  expect(f.running.size).toBe(1);
  expect(caddy.servedRoutes()).toContain("old.test");
});

test("a reload cannot claim the previous Deployment's hostname while a failed deploy rolls back: the rollback restores it and the previous plan serves", async () => {
  const caddy = await managedCaddyWorld({ tls: { ca: "internal" } });
  roots.push(caddy.root);
  const f = await fixture({ router: caddy.caddy.router });
  await f.lifecycle.up(f.previous);
  failReadiness(f.candidate);
  const up = f.deps.lifecycle.up.bind(f.deps.lifecycle);
  let claimed: unknown;
  f.deps.lifecycle.up = async (target, checkpoint, journal) => {
    try {
      return await up(target, checkpoint, journal);
    } catch (error) {
      // The candidate failed; before the rollback restores old.test, the owner reloads a route claiming it.
      if (target.commit === "new") {
        caddy.setSettings({
          tls: { ca: "internal" },
          routes: { "old.test": 3005 },
        });
        claimed = await caddy.caddy.republish().catch((caught) => caught);
      }
      throw error;
    }
  };
  await expect(
    activateDeployment(
      f.candidate,
      f.previous,
      { activation: "start" },
      f.deps,
    ),
  ).rejects.toMatchObject({ code: "HEALTH_FAILED" });
  expect(claimed).toMatchObject({
    code: "ROUTE_CONFLICT",
    message: expect.stringContaining("which a deploy is about to publish"),
  });
  // Rolled back, not blocked: the previous plan runs and Caddy serves its hostname.
  expect(f.state.targets[0]).toMatchObject({ commit: "old" });
  expect(caddy.servedRoutes()).toContain("old.test");
});

test("a route-free deploy still reserves the hostname it would restore: a reload cannot claim it before a failed commit rolls back", async () => {
  const caddy = await managedCaddyWorld({ tls: { ca: "internal" } });
  roots.push(caddy.root);
  const f = await fixture({ router: caddy.caddy.router });
  await f.lifecycle.up(f.previous);
  f.previous.desired = "running";
  // The candidate serves no hostname: its route is removed.
  delete f.candidate.plan.domain;
  const update = f.deps.store.update.bind(f.deps.store);
  let claimed: unknown;
  f.deps.store.update = async (change) => {
    // The first inventory write after the candidate's route removal is published: the previous hostname is no longer in
    // the route file, so only the deploy's reservation protects it.
    if (claimed === undefined && !(await caddy.routes()).includes("old.test")) {
      // Before the inventory commit fails, the owner reloads a route claiming the previous hostname.
      caddy.setSettings({
        tls: { ca: "internal" },
        routes: { "old.test": 3005 },
      });
      claimed = await caddy.caddy.republish().catch((caught) => caught);
      throw new Error("inventory commit failure");
    }
    await update(change);
  };
  await expect(
    activateDeployment(
      f.candidate,
      f.previous,
      { activation: "start" },
      f.deps,
    ),
  ).rejects.toThrow("inventory commit failure");
  expect(claimed).toMatchObject({
    code: "ROUTE_CONFLICT",
    message: expect.stringContaining("which a deploy is about to publish"),
  });
  // Rolled back: the previous Service runs and Caddy serves its hostname again.
  expect(f.state.targets[0]).toMatchObject({
    commit: "old",
    desired: "running",
  });
  expect(f.running.size).toBe(1);
  expect(caddy.servedRoutes()).toContain("old.test");
});

test("a deploy blocked by an unrelated duplicate owner is refused before anything stops, naming the way out; removing one owner clears it", async () => {
  const caddy = await managedCaddyWorld({ tls: { ca: "internal" } });
  roots.push(caddy.root);
  const site = (key: string, hostname: string) => ({
    key,
    sites: [
      { hostname, routes: [{ prefix: "/", upstream: "127.0.0.1:4000" }] },
    ],
  });
  const f = await fixture({ router: caddy.caddy.router });
  await f.lifecycle.up(f.previous);
  await caddy.caddy.router.apply(site("b", "b.test"));
  await caddy.caddy.router.apply(site("c", "c.test"));
  const served = caddy.servedRoutes();
  // Seeded by hand (or a crash before the write-point check): C's block also claims b.test.
  const routesFile = join(caddy.root, "proxy", "Caddyfile");
  await writeFile(
    routesFile,
    (await readFile(routesFile, "utf8")).replace("c.test {", "b.test {"),
  );
  await expect(
    activateDeployment(
      f.candidate,
      f.previous,
      { activation: "start" },
      f.deps,
    ),
  ).rejects.toMatchObject({
    code: "ROUTE_CONFLICT",
    message: expect.stringContaining("b.test would belong to two owners"),
    hint: expect.stringContaining(
      "change the domain of the Target that should give it up and apply it",
    ),
  });
  // The previous Deployment never stopped, and Caddy serves what it served.
  expect(f.running.size).toBe(1);
  expect(f.state.targets[0]).toMatchObject({ commit: "old" });
  expect(caddy.servedRoutes()).toBe(served);
  // Removing one of the two owners (rig down or destroy of C) is allowed while the duplicate exists, and clears it.
  await caddy.caddy.router.remove("c");
  const deployed = await activateDeployment(
    f.candidate,
    f.previous,
    { activation: "start" },
    f.deps,
  );
  expect(deployed).toMatchObject({ commit: "new" });
  expect(caddy.servedRoutes()).toContain("new.test");
});
