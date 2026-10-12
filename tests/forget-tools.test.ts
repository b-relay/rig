import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { loopbackListeners } from "./support/activation-doubles";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { controlledDeadline } from "./controlled-observation-deadline";
import { createRuntime } from "../src/runtime/application";
import { createTargetLifecycle } from "../src/runtime/lifecycle";
import { createTargetEffects } from "../src/adapters/target-effects";
import { createArtifactInstaller } from "../src/providers/artifact-installer";
import { runCommand } from "../src/providers/command-runner";
import { createCaddyRouter } from "../src/providers/caddy-router";
import { inspectProxyPublication } from "../src/domain/proxy-publication";
import type { Supervisor } from "../src/providers/contracts";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import type { RuntimeState } from "../src/domain/runtime";
import { STATE_VERSION } from "../src/runtime/state-schema";
import { FileStateStore } from "../src/runtime/state-store";
import {
  parseHostConfig,
  parseProjectConfig,
  resolveTargetPlan,
} from "../src/config";
import type { ProjectConfig } from "../src/config/types";

// Issue #343: `rig forget` left the Project's published Tools in <RIG_ROOT>/bin with ownership records naming Target ids
// nothing in state names any more, so the same repository registered again (new Target ids) could never publish a Tool of
// the same name: ARTIFACT_CONFLICT, for as long as the Rig root existed.

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** Each repository's config. `rig` is Rig's own Project: it publishes the `rig` and `rigd` Tools, and rigd's system job runs
 * `<RIG_ROOT>/bin/rigd`. */
const configs: Record<string, ProjectConfig> = {
  "/tmp/ledger": parseProjectConfig({
    name: "ledger",
    tools: { ledger: { bin: "ledger.sh" } },
    targets: { stable: true },
  }),
  "/tmp/other": parseProjectConfig({
    name: "other",
    tools: { ledger: { bin: "ledger.sh" }, rigd: { bin: "rigd.sh" } },
    targets: { stable: true },
  }),
  "/tmp/rig": parseProjectConfig({
    name: "rig",
    tools: { rig: { bin: "rig.sh" }, rigd: { bin: "rigd.sh" } },
    targets: { stable: true },
  }),
};

/** A runtime over an in-memory state whose Targets publish their Tools into a real `<root>/bin` through the real lifecycle,
 * effects, ownership and installer. Each deploy's checkout holds every Tool's `bin` as a script naming `build`. */
const idle: Supervisor = {
  async observe() {
    return { state: "stopped" };
  },
  async ensureRunning() {
    throw new Error("no Service runs here");
  },
  async stop() {
    return { outcome: "unchanged" };
  },
  async shutdown() {},
  async detach() {},
};

async function rigWorld() {
  const root = await mkdtemp(join(tmpdir(), "rig-tools-"));
  roots.push(root);
  let build = "v1";
  /** Which repository each prepared checkout was made from, so its committed config is that repository's. */
  const checkouts = new Map<string, string>();
  const state: RuntimeState = {
    version: STATE_VERSION,
    projects: [],
    targets: [],
    activity: [],
  };
  const store = {
    async read() {
      return structuredClone(state);
    },
    async update(change: (state: RuntimeState) => void | Promise<void>) {
      const next = structuredClone(state);
      await change(next);
      Object.assign(state, next);
    },
  };
  const effects = createTargetEffects({
    root,
    recordingTime: () => new Date().toISOString(),
    // Tool-only Projects run no Service: the supervisor is only asked what runs.
    supervisors: new Map([["rigd", idle]]),
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    installer: createArtifactInstaller({
      run: runCommand,
      bunExecutable: process.execPath,
    }),
    // No Target here has a route: the router is never asked to publish one.
    router: createCaddyRouter({
      caddyfile: join(root, "proxy", "Caddyfile"),
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }),
    connect: async () => ({ ready: true }),
    listeners: { inspect: async (pid) => loopbackListeners(pid, []) },
    environment: {},
    // What rigd hands its effects: the Target ids state records now, read from whichever store the world uses.
    recordedTargets: async () =>
      new Set((await deps.store.read()).targets.map((target) => target.id)),
  });
  effects.prepare = async () => {};
  effects.build = async () => {};
  effects.environment = async () => ({});
  delete effects.digestEnvironment;
  let id = 0;
  const deps: RuntimeDependencies = {
    reconcileGate: "open",
    root,
    async readAdminActivity() {
      return [];
    },
    async inspectHost() {
      return [];
    },
    async inspectProxy() {
      return await inspectProxyPublication({
        proxyFile: join(root, "proxy", "Caddyfile"),
        hostCaddyfiles: [],
        environment: {},
        read: (file) => readFile(file, "utf8").catch(() => undefined),
      });
    },
    orphanedTools: (recorded) => effects.orphanedTools(recorded),
    store,
    documents: {
      async initializationInfo() {
        return {
          name: "ledger",
          productionBranch: "main",
          gitRequired: false,
          existing: true,
        };
      },
      async identifyInitialization(path) {
        return {
          repoPath: path,
          name: configs[path]!.name,
          configPath: `${path}/rig.yaml`,
        };
      },
      async discover(path) {
        return {
          repoPath: path,
          document: await this.read(path),
          gitRequired: false,
        };
      },
      async read(path) {
        return {
          path: `${path}/rig.yaml`,
          revision: "abc",
          config: configs[checkouts.get(path) ?? path]!,
        };
      },
      async initialize(path) {
        return await this.read(path);
      },
      async rename() {
        throw new Error("unused");
      },
      resolve: (input) =>
        resolveTargetPlan(input, {
          operatorHome: "/home/operator",
          envRoot: join(root, "env"),
        }),
      async host() {
        return parseHostConfig({});
      },
    },
    sources: {
      async preflight() {
        return { commit: "abc", warnings: [] };
      },
      async prepare(request) {
        // The checkout of this deploy: every Tool's bin, as `build` makes it.
        await mkdir(request.destination, { recursive: true });
        checkouts.set(request.destination, request.repository);
        for (const name of ["ledger.sh", "rig.sh", "rigd.sh"])
          await writeFile(
            join(request.destination, name),
            `#!/bin/sh\necho ${name} ${build}\n`,
            { mode: 0o755 },
          );
        return { workspacePath: request.destination, commit: "abc" };
      },
      async resolve() {
        return "abc";
      },
      async currentBranch() {
        return "main";
      },
      async release() {},
      async changed() {
        return true;
      },
      async unmatched() {
        return [];
      },
    },
    lifecycle: createTargetLifecycle(effects),
    observations: effects.observations,
    files: {
      async destroyPreview() {},
      async inspectPreviewDeletion() {},
      async selectPorts({ requests }) {
        return Object.fromEntries(requests.map((r) => [r.name, 4567]));
      },
      async logs() {
        return { entries: [], cursor: "0" };
      },
    },
    observationBudgetMs: 2000,
    observationDeadline: controlledDeadline(),
    now: () => new Date().toISOString(),
    id: () => `id${++id}`,
    async diagnostic() {},
  };
  const runtime = createRuntime(deps);
  const bin = (name: string) => join(root, "bin", name);
  const ownerFile = (name: string) =>
    join(
      root,
      "installed",
      "owners",
      createHash("sha256").update(bin(name)).digest("hex") + ".json",
    );
  return {
    root,
    runtime,
    state,
    deps,
    bin,
    /** The next deploy's checkout holds Tools that print `next`. */
    rebuild(next: string) {
      build = next;
    },
    tool: (name: string) => readFile(bin(name), "utf8"),
    owner: async (name: string) =>
      JSON.parse(await readFile(ownerFile(name), "utf8")) as {
        targetId: string;
        project?: string;
        revision: string;
      },
    stableId: (project: string) =>
      state.targets.find(
        (target) =>
          target.kind === "stable" &&
          state.projects.find((p) => p.id === target.projectId)?.name ===
            project,
      )?.id,
    /** Registers `project`'s repository and deploys its stable Target, which publishes its Tools. */
    async registerAndDeploy(project = "ledger") {
      await runtime.command({ action: "init", repoPath: `/tmp/${project}` });
      return await runtime.command({
        action: "deploy",
        project,
        target: "stable",
      });
    },
    async stop(project = "ledger") {
      await runtime.command({ action: "down", project, target: "stable" });
    },
    /** What a forget left on a Host before #343 was fixed, or a state that lost the Project: its records go, its Tools and
     * their ownership records stay. */
    dropRecords(project = "ledger") {
      const gone = state.projects.find((p) => p.name === project)!.id;
      state.projects = state.projects.filter((p) => p.id !== gone);
      state.targets = state.targets.filter((t) => t.projectId !== gone);
    },
    async doctor() {
      return (await runtime.command({ action: "doctor" })) as {
        checks: {
          name: string;
          ok: boolean;
          message: string;
          reason?: string;
          hint?: string;
        }[];
      };
    },
  };
}

test("forget, register the same repository again, deploy: its Tool is published again under the new Target", async () => {
  const w = await rigWorld();
  await w.registerAndDeploy();
  const forgottenId = w.stableId("ledger");
  expect((await w.owner("ledger")).targetId).toBe(forgottenId!);
  await w.stop();
  const forgotten = (await w.runtime.command({
    action: "forget",
    project: "ledger",
  })) as { outcome: string; warnings?: string[] };
  expect(forgotten.outcome).toBe("forgotten");
  // The Tool stays where it is, and the forget says so.
  expect(await w.tool("ledger")).toBe("#!/bin/sh\necho ledger.sh v1\n");
  expect(forgotten.warnings).toContainEqual(
    expect.stringContaining(`Its Tools stay installed: ${w.bin("ledger")}`),
  );
  w.rebuild("v2");
  // Before #343 this was ARTIFACT_CONFLICT, naming the forgotten Target, for as long as the Rig root existed.
  expect(await w.registerAndDeploy()).toMatchObject({ outcome: "deployed" });
  expect(await w.tool("ledger")).toBe("#!/bin/sh\necho ledger.sh v2\n");
  const owner = await w.owner("ledger");
  expect(owner.targetId).toBe(w.stableId("ledger")!);
  expect(owner.targetId).not.toBe(forgottenId!);
  expect((await w.doctor()).checks.map((check) => check.name)).not.toContain(
    "tool-owners",
  );
});

test("forget is saved with its Tools left in place; when the write does not commit, they stay owned by the registered Project", async () => {
  const w = await rigWorld();
  await w.registerAndDeploy();
  await w.stop();
  const update = w.deps.store.update.bind(w.deps.store);
  let failed = false;
  w.deps.store.update = async (change) => {
    // The forget's own write: the one that drops the registration.
    const probe = structuredClone(w.state);
    await change(probe);
    if (!failed && probe.projects.length === 0) {
      failed = true;
      throw new Error("state write failed");
    }
    await update(change);
  };
  await expect(
    w.runtime.command({ action: "forget", project: "ledger" }),
  ).rejects.toThrow("state write failed");
  expect(failed).toBe(true);
  expect(w.state.projects.map((p) => p.name)).toEqual(["ledger"]);
  // Nothing was released: the Tool is still its registered Target's, so another Project cannot take it.
  expect((await w.owner("ledger")).targetId).toBe(w.stableId("ledger")!);
  expect(await w.tool("ledger")).toBe("#!/bin/sh\necho ledger.sh v1\n");
  await expect(w.registerAndDeploy("other")).rejects.toMatchObject({
    code: "ARTIFACT_CONFLICT",
    message: expect.stringContaining("Project 'ledger' Target 'stable'"),
  });
  expect(await w.tool("ledger")).toBe("#!/bin/sh\necho ledger.sh v1\n");
  expect((await w.doctor()).checks.map((check) => check.name)).not.toContain(
    "tool-owners",
  );
  // Retrying once the store works forgets it, and the Tool is released.
  await w.runtime.command({ action: "forget", project: "ledger" });
  w.rebuild("v2");
  expect(
    await w.runtime.command({
      action: "deploy",
      project: "other",
      target: "stable",
    }),
  ).toMatchObject({ outcome: "deployed" });
  expect(await w.tool("ledger")).toBe("#!/bin/sh\necho ledger.sh v2\n");
  expect((await w.owner("ledger")).project).toBe("other");
});

test("a forget whose state write commits and then fails is reported forgotten, and its Tools are released", async () => {
  const w = await rigWorld();
  // The real store: a write is renamed into place, then its directory synced; the sync is what fails here.
  const store = new FileStateStore(w.root);
  let failed = false;
  w.deps.store = {
    read: () => store.read(),
    async update(change) {
      await store.update(change);
      if (!failed && (await store.read()).projects.length === 0) {
        failed = true;
        throw new Error("fsync of the runtime directory failed");
      }
    },
  };
  await w.registerAndDeploy();
  await w.stop();
  const forgotten = (await w.runtime.command({
    action: "forget",
    project: "ledger",
  })) as { outcome: string; warnings: string[] };
  expect(failed).toBe(true);
  expect(forgotten.outcome).toBe("forgotten");
  expect(forgotten.warnings).toContainEqual(
    expect.stringContaining(
      "The forget was saved, but confirming it on disk failed",
    ),
  );
  expect(forgotten.warnings).toContainEqual(
    expect.stringContaining(`Its Tools stay installed: ${w.bin("ledger")}`),
  );
  expect((await store.read()).projects).toEqual([]);
  w.rebuild("v2");
  expect(await w.registerAndDeploy()).toMatchObject({ outcome: "deployed" });
  expect(await w.tool("ledger")).toBe("#!/bin/sh\necho ledger.sh v2\n");
});

test("a Tool a forget left before #343 was fixed is named by doctor and taken over by the next deploy that publishes it", async () => {
  const w = await rigWorld();
  await w.registerAndDeploy();
  await w.stop();
  w.dropRecords();
  const report = await w.doctor();
  expect(report.checks).toContainEqual(
    expect.objectContaining({
      name: "tool-owners",
      // Reported, not failed: it keeps working and the next publication takes it over.
      ok: true,
      reason: "tool-orphaned",
      message: expect.stringContaining(
        `${w.bin("ledger")} (Project 'ledger' Target 'stable' Tool 'ledger')`,
      ),
      hint: expect.stringContaining("replaces one"),
    }),
  );
  // Another Project's Tool of the same name takes it over as well as the same repository would.
  w.rebuild("v2");
  expect(await w.registerAndDeploy("other")).toMatchObject({
    outcome: "deployed",
  });
  expect(await w.tool("ledger")).toBe("#!/bin/sh\necho ledger.sh v2\n");
  expect(await w.owner("ledger")).toMatchObject({
    targetId: w.stableId("other")!,
    project: "other",
  });
  expect((await w.doctor()).checks.map((check) => check.name)).not.toContain(
    "tool-owners",
  );
  // Now it is owned again: the old repository registered again is refused, naming its new owner.
  await expect(w.registerAndDeploy()).rejects.toMatchObject({
    code: "ARTIFACT_CONFLICT",
    message: expect.stringContaining("Project 'other' Target 'stable'"),
  });
});

test("an orphaned Tool changed since Rig published it is never replaced: ARTIFACT_CHANGED, and doctor says why", async () => {
  const w = await rigWorld();
  await w.registerAndDeploy();
  await w.stop();
  w.dropRecords();
  const edited = "#!/bin/sh\necho edited by hand\n";
  await writeFile(w.bin("ledger"), edited);
  const owner = await w.owner("ledger");
  const report = await w.doctor();
  expect(report.checks).toContainEqual(
    expect.objectContaining({
      name: "tool-owners",
      ok: false,
      reason: "tool-changed",
      message: expect.stringContaining(
        "changed since Rig published it: " + w.bin("ledger"),
      ),
      hint: expect.stringContaining("Move or delete a changed one"),
    }),
  );
  w.rebuild("v2");
  await expect(w.registerAndDeploy()).rejects.toMatchObject({
    code: "ARTIFACT_CHANGED",
    message: expect.stringContaining("whose Target no longer exists"),
    hint: expect.stringContaining(`Move or delete ${w.bin("ledger")}`),
  });
  expect(await w.tool("ledger")).toBe(edited);
  expect(await w.owner("ledger")).toEqual(owner);
  // Moved away, the path is free and the deploy publishes.
  await rm(w.bin("ledger"));
  expect(
    await w.runtime.command({
      action: "deploy",
      project: "ledger",
      target: "stable",
    }),
  ).toMatchObject({ outcome: "deployed" });
  expect(await w.tool("ledger")).toBe("#!/bin/sh\necho ledger.sh v2\n");
});

test("an orphaned Tool deleted by hand is not reported, and its name is published again", async () => {
  const w = await rigWorld();
  await w.registerAndDeploy();
  await w.stop();
  w.dropRecords();
  await rm(w.bin("ledger"));
  expect((await w.doctor()).checks.map((check) => check.name)).not.toContain(
    "tool-owners",
  );
  expect(await w.registerAndDeploy("other")).toMatchObject({
    outcome: "deployed",
  });
  expect((await w.owner("ledger")).project).toBe("other");
});

test("Rig's own rig and rigd Tools are never taken while their Target is recorded, and a forget leaves them in place", async () => {
  const w = await rigWorld();
  await w.registerAndDeploy("rig");
  await w.stop("rig");
  const daemon = w.bin("rigd");
  const before = { bytes: await w.tool("rigd"), ino: (await stat(daemon)).ino };
  // The running rigd holds its executable open: that file must never be written in place.
  const running = await open(daemon, "r");
  try {
    // Another Project's Tool named rigd is refused, before anything of it is published.
    await expect(w.registerAndDeploy("other")).rejects.toMatchObject({
      code: "ARTIFACT_CONFLICT",
      message: expect.stringContaining("Project 'rig' Target 'stable'"),
    });
    await expect(stat(w.bin("ledger"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await w.tool("rigd")).toBe(before.bytes);
    expect((await stat(daemon)).ino).toBe(before.ino);
    expect((await w.owner("rigd")).targetId).toBe(w.stableId("rig")!);
    expect((await w.doctor()).checks.map((check) => check.name)).not.toContain(
      "tool-owners",
    );
    // Forgetting Rig's own Project removes neither rig nor rigd, and says rigd must stay.
    const forgotten = (await w.runtime.command({
      action: "forget",
      project: "rig",
    })) as { warnings: string[] };
    expect(forgotten.warnings).toContainEqual(
      expect.stringContaining(`except ${daemon}, which rigd's system job runs`),
    );
    expect(await w.tool("rigd")).toBe(before.bytes);
    expect((await stat(daemon)).ino).toBe(before.ino);
    expect(await w.tool("rig")).toBe("#!/bin/sh\necho rig.sh v1\n");
    // Released, rigd still goes to no other Project: launchd must never start another Project's binary as the daemon.
    await expect(
      w.runtime.command({
        action: "deploy",
        project: "other",
        target: "stable",
      }),
    ).rejects.toMatchObject({
      code: "ARTIFACT_CONFLICT",
      message: expect.stringContaining(`${daemon} is Rig itself`),
    });
    expect(await w.tool("rigd")).toBe(before.bytes);
    expect((await stat(daemon)).ino).toBe(before.ino);
    expect((await w.doctor()).checks).toContainEqual(
      expect.objectContaining({
        name: "tool-owners",
        hint: expect.stringContaining(
          `Never delete ${w.bin("rig")} or ${w.bin("rigd")}: they are Rig itself`,
        ),
      }),
    );
    // Registered again, its deploy takes them over by atomic rename: the file rigd runs from is never rewritten.
    w.rebuild("v2");
    expect(await w.registerAndDeploy("rig")).toMatchObject({
      outcome: "deployed",
    });
    expect(await w.tool("rigd")).toBe("#!/bin/sh\necho rigd.sh v2\n");
    expect((await stat(daemon)).ino).not.toBe(before.ino);
    expect((await running.readFile()).toString()).toBe(before.bytes);
    expect((await w.owner("rigd")).targetId).toBe(w.stableId("rig")!);
  } finally {
    await running.close();
  }
});

test("forget names a Tool edited since Rig published it apart: it stays, and publishing there is refused until it is moved", async () => {
  const w = await rigWorld();
  await w.registerAndDeploy();
  await w.stop();
  await writeFile(w.bin("ledger"), "#!/bin/sh\necho edited\n");
  const forgotten = (await w.runtime.command({
    action: "forget",
    project: "ledger",
  })) as { warnings: string[] };
  expect(forgotten.warnings).toContainEqual(
    expect.stringContaining(
      `Its Tools ${w.bin("ledger")} changed since Rig published them and stay as they are`,
    ),
  );
  expect(forgotten.warnings).not.toContainEqual(
    expect.stringContaining("Its Tools stay installed"),
  );
  expect(await w.tool("ledger")).toBe("#!/bin/sh\necho edited\n");
});
