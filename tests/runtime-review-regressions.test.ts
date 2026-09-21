import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntime } from "../src/runtime/application";
import {
  discoverProject,
  readProjectConfig,
  parseProjectConfig,
  resolveTargetPlan as resolvePlanWithHost,
  ConfigError,
} from "../src/config";
import type { RuntimeState } from "../src/domain/runtime";
import type { RuntimeDependencies } from "../src/runtime/contracts";
const RESOLVE_HOST = { operatorHome: "/home/operator", envRoot: "/rig/env" };
const resolveTargetPlan = (input: Parameters<typeof resolvePlanWithHost>[0]) =>
  resolvePlanWithHost(input, RESOLVE_HOST);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
function fixture() {
  const state: RuntimeState = {
    version: 4,
    projects: [],
    targets: [],
    activity: [],
  };
  const config = parseProjectConfig({
    name: "demo",
    tools: { cli: { bin: "cli" } },
  });
  const deps = {
    async inspectHost() {
      return [{ name: "host-check", ok: true, message: "Host inspected." }];
    },
    async inspectProxy() {
      return {
        proxyFile: "/tmp/proxy/Caddyfile",
        routes: 0,
        state: "unpublished" as const,
      };
    },
    store: {
      async read() {
        return structuredClone(state);
      },
      async update(change: (state: RuntimeState) => void) {
        await change(state);
      },
    },
    documents: {
      discover: discoverProject,
      read: readProjectConfig,
      resolve: resolveTargetPlan,
    },
    observations: {},
    observationBudgetMs: 2000,
    observationDeadline: { schedule: () => () => {} },
    now: () => new Date().toISOString(),
    id: () => "operation",
    async diagnostic() {},
  } as unknown as RuntimeDependencies;
  return { state, config, deps, runtime: createRuntime(deps) };
}
test("repoint through a symlink retains canonical workspace selection on the next public status request", async () => {
  const { state, deps, runtime } = fixture();
  const root = await mkdtemp(join(tmpdir(), "rig-repoint-review-"));
  roots.push(root);
  const repository = join(root, "actual"),
    alias = join(root, "alias");
  await mkdir(repository);
  await symlink(repository, alias);
  await writeFile(
    join(repository, "rig.yaml"),
    "name: demo\ntools:\n  cli:\n    bin: cli\n",
  );
  state.projects.push({
    id: "p",
    name: "demo",
    repoPath: "/missing/old",
    configPath: "/missing/old/rig.yaml",
    createdAt: deps.now(),
  });
  await runtime.command({ action: "repoint", project: "demo", newPath: alias });
  expect(state.projects[0]!.repoPath).toBe(await realpath(repository));
  expect(
    await runtime.command({ action: "status", repoPath: alias }),
  ).toMatchObject({ project: "demo" });
});
test("invalid Project discovery does not suppress Host doctor checks", async () => {
  const { runtime, deps } = fixture();
  deps.documents.discover = async () => {
    throw new ConfigError("Invalid project", "invalid_config");
  };
  expect(
    await runtime.command({ action: "doctor", repoPath: "/project" }),
  ).toMatchObject({
    ok: false,
    checks: expect.arrayContaining([
      expect.objectContaining({ name: "host-check", ok: true }),
      expect.objectContaining({ name: "project-config", ok: false }),
    ]),
  });
});
test("doctor reports blocked deployment recovery instead of healthy matching configuration", async () => {
  const { runtime, deps, state, config } = fixture();
  state.projects.push({
    id: "p",
    name: "demo",
    repoPath: "/project",
    configPath: "/project/rig.yaml",
    createdAt: deps.now(),
  });
  deps.documents.read = async () => ({
    path: "/project/rig.yaml",
    revision: "revision",
    config,
  });
  const plan = resolveTargetPlan({
    config,
    target: "local",
    workspacePath: "/project",
    dataRoot: "/data",
  });
  state.targets.push({
    id: "t",
    projectId: "p",
    name: "local",
    kind: "local",
    plan,
    desired: "running",
    createdAt: deps.now(),
    updatedAt: deps.now(),
    logRoot: "/logs",
    recovery: { plan, desired: "running", stage: "blocked" },
  });
  expect(
    await runtime.command({ action: "doctor", project: "demo" }),
  ).toMatchObject({
    ok: false,
    checks: expect.arrayContaining([
      expect.objectContaining({ name: "local/recovery", ok: false }),
    ]),
  });
});
