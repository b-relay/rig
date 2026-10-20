import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperatorEnvFiles } from "../src/adapters/operator-env";
import { createArtifactOwnership } from "../src/adapters/artifact-ownership";
import { parseProjectConfig, resolveTargetPlan } from "../src/config";
import { RigError } from "../src/domain/errors";
import type { ProjectRecord, RuntimeState } from "../src/domain/runtime";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import { renameProject, renamedPlan } from "../src/runtime/rename";
import { STATE_VERSION } from "../src/runtime/state-schema";
import { FileStateStore } from "../src/runtime/state-store";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "rig-rename-"));
  roots.push(root);
  return root;
}
/** Whether the temporary directory's disk ignores case, as a Mac's does by default. */
const caseInsensitive = await (async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-case-"));
  try {
    await writeFile(join(root, "probe"), "");
    return await stat(join(root, "PROBE")).then(
      () => true,
      () => false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
})();
async function envFile(root: string, path: string, text: string, mode = 0o600) {
  const file = join(root, "env", path);
  await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
  await writeFile(file, text, { mode });
}

test("carry renames a Project's env directory, files and modes intact, and undo puts it back", async () => {
  const root = await temporaryRoot();
  await envFile(root, "before/all.env", "A=1\n");
  await envFile(root, "before/web/stable.env", "B=2\n", 0o640);
  const env = createOperatorEnvFiles(root);
  const carry = await env.carry({
    from: ["before"],
    to: "after",
    sharedWith: [],
  });
  expect(carry).toEqual({ kind: "moved", from: "before", to: "after" });
  expect(await readFile(join(root, "env/after/web/stable.env"), "utf8")).toBe(
    "B=2\n",
  );
  expect(
    (await stat(join(root, "env/after/web/stable.env"))).mode & 0o777,
  ).toBe(0o640);
  await expect(lstat(join(root, "env/before"))).rejects.toThrow();
  await env.undo(carry);
  expect(await readFile(join(root, "env/before/all.env"), "utf8")).toBe(
    "A=1\n",
  );
  await expect(lstat(join(root, "env/after"))).rejects.toThrow();
});

test("carry refuses a name whose env directory exists, and finds the files under an interrupted rename's name", async () => {
  const root = await temporaryRoot();
  await envFile(root, "before/all.env", "A=1\n");
  await envFile(root, "after/all.env", "LEFT=over\n");
  const env = createOperatorEnvFiles(root);
  await expect(
    env.carry({ from: ["before"], to: "after", sharedWith: [] }),
  ).rejects.toMatchObject({ code: "ENV_CONFLICT" });
  expect(await readFile(join(root, "env/before/all.env"), "utf8")).toBe(
    "A=1\n",
  );
  // No directory under the name itself: the one a rename began to give it holds them.
  expect(
    await env.carry({ from: ["gone", "after"], to: "third", sharedWith: [] }),
  ).toEqual({ kind: "moved", from: "after", to: "third" });
  expect(
    await env.carry({ from: ["nothing"], to: "fourth", sharedWith: [] }),
  ).toEqual({ kind: "none" });
});

test.if(caseInsensitive)(
  "carry copies an env directory another Project reaches by a name that differs only in case, and renames one in place for a case-only rename",
  async () => {
    const root = await temporaryRoot();
    await envFile(root, "alpha/all.env", "SHARED=1\n", 0o600);
    const env = createOperatorEnvFiles(root);
    const carry = await env.carry({
      from: ["ALPHA"],
      to: "beta",
      sharedWith: ["alpha"],
    });
    expect(carry).toEqual({
      kind: "copied",
      from: "ALPHA",
      to: "beta",
      sharedWith: "alpha",
    });
    expect(await readFile(join(root, "env/alpha/all.env"), "utf8")).toBe(
      "SHARED=1\n",
    );
    expect(await readFile(join(root, "env/beta/all.env"), "utf8")).toBe(
      "SHARED=1\n",
    );
    expect((await stat(join(root, "env/beta/all.env"))).mode & 0o777).toBe(
      0o600,
    );
    await env.undo(carry);
    await expect(lstat(join(root, "env/beta"))).rejects.toThrow();
    expect(await readFile(join(root, "env/alpha/all.env"), "utf8")).toBe(
      "SHARED=1\n",
    );
    // alpha -> Alpha is the same directory, renamed in place.
    expect(
      await env.carry({ from: ["alpha"], to: "Alpha", sharedWith: [] }),
    ).toEqual({ kind: "moved", from: "alpha", to: "Alpha" });
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(root, "env"))).toEqual(["Alpha"]);
  },
);

test("a renamed plan reads its convention env files under the new name and keeps a listed one as written", () => {
  const config = parseProjectConfig({
    name: "before",
    env_file: "/srv/shared.env",
    services: { web: { command: "serve" } },
    jobs: { nightly: { command: "true", schedule: "0 3 * * *" } },
    targets: { stable: true },
  });
  const plan = resolveTargetPlan(
    {
      config,
      target: "stable",
      workspacePath: "/rig/work",
      dataRoot: "/rig/data",
    },
    { operatorHome: "/home/operator", envRoot: "/rig/env" },
  );
  const renamed = renamedPlan(plan, "/rig/env", "before", "after");
  expect(renamed.project).toBe("after");
  expect(renamed.envFiles).toEqual([
    { path: "/srv/shared.env", required: true },
    { path: "/rig/env/after/all.env", required: false },
    { path: "/rig/env/after/stable.env", required: false },
  ]);
  expect(renamed.components[0]!.envFiles!.map((file) => file.path)).toEqual([
    "/srv/shared.env",
    "/rig/env/after/all.env",
    "/rig/env/after/stable.env",
    "/rig/env/after/web/all.env",
    "/rig/env/after/web/stable.env",
  ]);
  expect(renamed.jobs![0]!.envFiles!.map((file) => file.path)).toContain(
    "/rig/env/after/nightly/stable.env",
  );
});

/** A registered Project `before` under a real state file and env tree, renamed through `renameProject` with a scripted rig.yaml. */
async function renaming(options: { failSave?: boolean } = {}) {
  const root = await temporaryRoot();
  const store = new FileStateStore(root);
  const project: ProjectRecord = {
    id: "p1",
    name: "before",
    repoPath: join(root, "repo"),
    configPath: join(root, "repo", "rig.yaml"),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const initial: RuntimeState = {
    version: STATE_VERSION,
    projects: [project],
    targets: [],
    activity: [],
  };
  await store.update((state) => {
    Object.assign(state, initial);
  });
  await envFile(root, "before/all.env", "A=1\n");
  let configName = "before";
  let saves = 0;
  const deps = {
    root,
    operatorEnv: createOperatorEnvFiles(root),
    store: {
      read: () => store.read(),
      async update(change: (state: RuntimeState) => void) {
        // The first write marks the rename; the second saves it.
        if (options.failSave && ++saves === 2)
          throw new RigError("STATE_WRITE", "disk full", "free space");
        await store.update(change);
      },
    },
    documents: {
      async read() {
        return {
          path: project.configPath,
          revision: "r",
          config: { name: configName },
        };
      },
      async rename(_project: ProjectRecord, name: string) {
        configName = name;
        return { path: project.configPath, revision: "r", config: { name } };
      },
    },
  } as unknown as Pick<
    RuntimeDependencies,
    "root" | "operatorEnv" | "store" | "documents"
  >;
  return { root, store, project, deps, config: () => configName };
}

test("a rename whose registration cannot be saved puts the env files and rig.yaml back, and leaves no mark", async () => {
  const world = await renaming({ failSave: true });
  await expect(
    renameProject(world.project, "after", world.deps),
  ).rejects.toMatchObject({ code: "STATE_WRITE" });
  expect(world.config()).toBe("before");
  expect(await readFile(join(world.root, "env/before/all.env"), "utf8")).toBe(
    "A=1\n",
  );
  await expect(lstat(join(world.root, "env/after"))).rejects.toThrow();
  expect((await world.store.read()).projects[0]).toEqual(world.project);
});

test("a rename interrupted after it moved the env files is finished, or replaced, by the next rename", async () => {
  const world = await renaming();
  // As a crash leaves it: marked, rig.yaml and env files already under the new name, the registration not.
  await world.store.update((state) => {
    state.projects[0]!.renaming = "after";
  });
  await world.deps.documents.rename(world.project, "after");
  await createOperatorEnvFiles(world.root).carry({
    from: ["before"],
    to: "after",
    sharedWith: [],
  });
  const marked = { ...world.project, renaming: "after" };
  const result = await renameProject(marked, "other", world.deps);
  expect(result.project).toMatchObject({
    name: "other",
    formerNames: ["before"],
  });
  expect(result.project.renaming).toBeUndefined();
  expect(await readFile(join(world.root, "env/other/all.env"), "utf8")).toBe(
    "A=1\n",
  );
  const saved = (await world.store.read()).projects[0]!;
  expect(saved).toMatchObject({ name: "other", formerNames: ["before"] });
  expect(saved.renaming).toBeUndefined();
});

test.if(caseInsensitive)(
  "an ownership conflict at a Tool path that differs only in case names the owner of the path as the disk holds it",
  async () => {
    const root = await temporaryRoot();
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    const owners = createArtifactOwnership(
      root,
      undefined,
      async () => new Set(["working-id"]),
      async (targetId) =>
        targetId === "working-id"
          ? { project: "renamed", target: "working" }
          : undefined,
    );
    await owners.publish(
      {
        targetId: "working-id",
        componentName: "cli",
        destination: join(bin, "cli-dev"),
        project: "demo",
        target: "working",
      },
      () => writeFile(join(bin, "cli-dev"), "#!/bin/sh\n", { mode: 0o755 }),
    );
    const refused = await owners
      .inspect({
        targetId: "preview-id",
        componentName: "cli",
        destination: join(bin, "cli-DEV"),
      })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({
      code: "ARTIFACT_CONFLICT",
      details: { alias: join(bin, "cli-dev") },
    });
    expect((refused as RigError).message).toContain(
      "Project 'renamed' Target 'working' Component 'cli' owns",
    );
    expect(await readFile(join(bin, "cli-dev"), "utf8")).toBe("#!/bin/sh\n");
  },
);
