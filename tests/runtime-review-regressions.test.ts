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
  resolveTargetPlan,
  ConfigError,
} from "../src/config";
import { RigError } from "../src/domain/errors";
import type { RuntimeState } from "../src/domain/runtime";
import type { RuntimeDependencies } from "../src/runtime/contracts";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
function fixture() {
  const state: RuntimeState = {
    version: 2,
    projects: [],
    targets: [],
    activity: [],
  };
  const config = parseProjectConfig({ name: "demo", components: {} });
  const deps = {
    async inspectHost() {
      return [{ name: "host-check", ok: true, message: "Host inspected." }];
    },
    async assertOwnershipReady() {},
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
  await writeFile(join(repository, "rig.yaml"), "name: demo\ncomponents: {}\n");
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
test("host-only doctor exposes pending ownership while retaining independent Host observations", async () => {
  const { runtime, deps } = fixture();
  deps.documents.discover = async () => {
    throw new ConfigError("No project", "missing_config");
  };
  deps.assertOwnershipReady = async () => {
    throw new RigError(
      "LEGACY_ADOPTION_PENDING",
      "Adoption is pending.",
      "Verify legacy owners.",
    );
  };
  expect(
    await runtime.command({ action: "doctor", repoPath: "/outside" }),
  ).toMatchObject({
    ok: false,
    checks: expect.arrayContaining([
      { name: "host-check", ok: true, message: "Host inspected." },
      expect.objectContaining({ name: "runtime-ownership", ok: false }),
    ]),
  });
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
    format: "yaml",
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
