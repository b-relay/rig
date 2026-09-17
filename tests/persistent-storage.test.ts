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
  services: {
    api: {
      run: "serve --db ${rig.data}/app.db",
      ports: { http: "auto" },
      env: { DATA_DIR: "${rig.data}" },
    },
  },
  targets: { preview: { services: { api: { env: { DATA_DIR: "${rig.data}/preview" } } } } },
});
const api = (target: "local" | "live" | "preview", revision: string) =>
  resolveTargetPlan({
    config,
    target,
    workspacePath: target === "local" ? "/repo" : `/root/targets/p/t/revisions/${revision}`,
    dataRoot: "/root/targets/p/t/data",
    branch: "feature",
    assignedPorts: { api: 3210 },
  }).components.find((c) => c.name === "api")!;

// `uses: sqlite|convex` plugins are retired: a Service reaches Persistent storage only through ${rig.data}.
test("every Target's plan resolves ${rig.data} to the Service's directory under the Target's persistent storage, unchanged across revisions", () => {
  for (const target of ["local", "live", "preview"] as const) {
    const first = api(target, "r1"), second = api(target, "r2");
    expect(first).toMatchObject({
      kind: "managed",
      command: "serve --db /root/targets/p/t/data/api/app.db",
      env: { DATA_DIR: target === "preview" ? "/root/targets/p/t/data/api/preview" : "/root/targets/p/t/data/api" },
    });
    expect({ command: second.kind === "managed" && second.command, env: second.env }).toEqual({
      command: first.kind === "managed" && first.command,
      env: first.env,
    });
  }
});

test("a config that still declares a uses plugin is refused as the retired component schema", () => {
  expect(() =>
    parseProjectConfig({ name: "demo", components: { db: { uses: "sqlite", path: "data/app.db" } } }),
  ).toThrow(expect.objectContaining({ code: "legacy_config" }));
  expect(() =>
    parseProjectConfig({ name: "demo", services: { db: { uses: "sqlite" } } }),
  ).toThrow("Invalid Project configuration");
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
