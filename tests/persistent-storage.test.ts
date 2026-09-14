import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectConfig, resolveTargetPlan } from "../src/config/index";
import { createTargetEffects } from "../src/adapters/target-effects";
import { createArtifactInstaller } from "../src/providers/artifact-installer";
import { runCommand } from "../src/providers/command-runner";
import type { TargetRecord } from "../src/domain/runtime";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const config = parseProjectConfig({
  name: "demo",
  components: {
    db: { uses: "sqlite", path: "data/app.db" },
    api: { uses: "convex", port: 3210 },
    def: { uses: "sqlite" },
  },
});
const prepared = (target: "local" | "live" | "preview", revision: string) => {
  const plan = resolveTargetPlan({
    config,
    target,
    workspacePath: target === "local" ? "/repo" : `/root/targets/p/t/revisions/${revision}`,
    dataRoot: target === "local" ? "/root/targets/p/t/data" : "/root/targets/p/t/data",
    assignedPorts: { "api.site": 3211 },
  });
  const find = (name: string) => plan.preparedComponents.find((c) => c.name === name)!;
  return { plan, sqlite: (find("db") as { path: string }).path, convex: (find("api") as { stateDir: string }).stateDir, defaultSqlite: (find("def") as { path: string }).path };
};

test("live and preview plans keep relative sqlite paths and Convex state under the Target's persistent storage across revisions", () => {
  for (const target of ["live", "preview"] as const) {
    const first = prepared(target, "r1"), second = prepared(target, "r2");
    expect(first.sqlite).toBe("/root/targets/p/t/data/data/app.db");
    expect(second.sqlite).toBe(first.sqlite);
    expect(first.convex).toBe("/root/targets/p/t/data/convex/api");
    expect(second.convex).toBe(first.convex);
    expect(first.defaultSqlite).toBe("/root/targets/p/t/data/sqlite/def.sqlite");
    const db = first.plan.components.find((c) => c.name === "db")!;
    expect(db).toMatchObject({ kind: "persistent", path: first.sqlite });
  }
});

test("local plans resolve relative sqlite paths and Convex state inside the working copy", () => {
  const local = prepared("local", "unused");
  expect(local.sqlite).toBe("/repo/data/app.db");
  expect(local.convex).toBe("/repo/.convex/local/default");
});

function record(root: string, workspacePath: string, stateDir: string): TargetRecord {
  return {
    id: "t",
    projectId: "p",
    name: "live",
    kind: "live",
    desired: "running",
    createdAt: "now",
    updatedAt: "now",
    logRoot: join(root, "logs"),
    plan: {
      project: "demo",
      target: "live",
      workspacePath,
      dataRoot: join(root, "data"),
      deploymentName: "live",
      branchSlug: "main",
      subdomain: "live",
      providers: { processSupervisor: "child" },
      providerProfile: "default",
      components: [],
      preparedComponents: [{ name: "api", uses: "convex", stateDir }],
    },
  };
}
function effects(root: string) {
  return createTargetEffects({
    root,
    recordingTime: () => new Date().toISOString(),
    supervisors: new Map(),
    run: runCommand,
    installer: createArtifactInstaller({ run: runCommand, bunExecutable: process.execPath }),
    router: {
      async apply() {},
      async remove() {},
      async checkpoint(key) {
        return { key, value: null };
      },
      async restore() {},
    },
    environment: { PATH: process.env.PATH! },
  });
}

test("prepare links the checkout's .convex/local/default to the persistent Convex state so a new revision reuses it", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rig-convex-state-")));
  roots.push(root);
  const stateDir = join(root, "data", "convex", "api");
  const link = (workspace: string) => join(workspace, ".convex", "local", "default");
  const first = join(root, "revisions", "r1"), second = join(root, "revisions", "r2");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await effects(root).prepare(record(root, first, stateDir));
  expect((await stat(stateDir)).isDirectory()).toBe(true);
  expect(await readlink(link(first))).toBe(stateDir);
  await writeFile(join(link(first), "config.json"), "{}");
  await effects(root).prepare(record(root, second, stateDir));
  expect(await readlink(link(second))).toBe(stateDir);
  expect((await stat(join(link(second), "config.json"))).isFile()).toBe(true);
  // Re-preparing the same revision is idempotent.
  await effects(root).prepare(record(root, second, stateDir));
  expect(await readlink(link(second))).toBe(stateDir);
});

test("prepare refuses to replace a real .convex/local/default directory in the checkout with a tagged error", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rig-convex-conflict-")));
  roots.push(root);
  const workspace = join(root, "revisions", "r1");
  await mkdir(join(workspace, ".convex", "local", "default"), { recursive: true });
  await expect(effects(root).prepare(record(root, workspace, join(root, "data", "convex", "api")))).rejects.toMatchObject({
    code: "CONVEX_STATE_CONFLICT",
    hint: expect.stringContaining(".convex/local/default"),
  });
});

test("prepare leaves a local Target's in-workspace Convex state alone", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rig-convex-local-")));
  roots.push(root);
  const stateDir = join(root, ".convex", "local", "default");
  const local = { ...record(root, root, stateDir), kind: "local" as const };
  local.plan = { ...local.plan, target: "local", dataRoot: root };
  await effects(root).prepare(local);
  expect((await stat(stateDir)).isDirectory()).toBe(true);
  expect((await stat(stateDir)).isSymbolicLink()).toBe(false);
});
