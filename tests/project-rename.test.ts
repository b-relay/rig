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
import { prepareRegistration } from "../src/runtime/projects";
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

const read = (root: string, path: string) =>
  readFile(join(root, "env", path), "utf8");
const absent = async (root: string, path: string) =>
  expect(lstat(join(root, "env", path))).rejects.toThrow();

test("plan and carry rename a Project's env directory, files and modes intact; carry again does nothing; undo puts it back", async () => {
  const root = await temporaryRoot();
  await envFile(root, "before/all.env", "A=1\n");
  await envFile(root, "before/web/stable.env", "B=2\n", 0o640);
  const env = createOperatorEnvFiles(root);
  const how = await env.plan({ from: "before", to: "after", sharedWith: [] });
  expect(how).toBe("move");
  await env.carry({ from: "before", to: "after", how });
  await env.carry({ from: "before", to: "after", how });
  expect(await read(root, "after/web/stable.env")).toBe("B=2\n");
  expect(
    (await stat(join(root, "env/after/web/stable.env"))).mode & 0o777,
  ).toBe(0o640);
  await absent(root, "before");
  await env.undo({ from: "before", to: "after", how });
  await env.undo({ from: "before", to: "after", how });
  expect(await read(root, "before/all.env")).toBe("A=1\n");
  await absent(root, "after");
});

test("a destination with env files of its own is refused, whether or not the Project has any", async () => {
  const root = await temporaryRoot();
  await envFile(root, "after/all.env", "LEFT=over\n");
  const env = createOperatorEnvFiles(root);
  // No env/before: before the fix the leftover env/after was silently adopted.
  await expect(
    env.plan({ from: "before", to: "after", sharedWith: [] }),
  ).rejects.toMatchObject({ code: "ENV_DIRECTORY_TAKEN" });
  await envFile(root, "before/all.env", "A=1\n");
  await expect(
    env.plan({ from: "before", to: "after", sharedWith: [] }),
  ).rejects.toMatchObject({ code: "ENV_DIRECTORY_TAKEN" });
  // One that appeared after a rename with nothing to carry began is refused when it is carried.
  await expect(
    env.carry({ from: "other", to: "after", how: "none" }),
  ).rejects.toMatchObject({ code: "ENV_DIRECTORY_TAKEN" });
  expect(await read(root, "after/all.env")).toBe("LEFT=over\n");
  expect(await read(root, "before/all.env")).toBe("A=1\n");
});

test.if(caseInsensitive)(
  "a shared env directory is copied aside and published whole; a copy cut short is made again, a published one is kept, and undo removes it",
  async () => {
    const root = await temporaryRoot();
    await envFile(root, "alpha/all.env", "SHARED=1\n");
    await envFile(root, "alpha/web/stable.env", "WEB=1\n");
    const env = createOperatorEnvFiles(root);
    const how = await env.plan({
      from: "ALPHA",
      to: "beta",
      sharedWith: ["alpha"],
    });
    expect(how).toBe("copy");
    // As a crash during the copy leaves it: part of it aside, nothing published.
    await envFile(root, ".renaming-beta/all.env", "SHAR");
    await env.carry({ from: "ALPHA", to: "beta", how });
    expect(await read(root, "beta/all.env")).toBe("SHARED=1\n");
    expect(await read(root, "beta/web/stable.env")).toBe("WEB=1\n");
    await absent(root, ".renaming-beta");
    expect(await read(root, "alpha/all.env")).toBe("SHARED=1\n");
    // Published before a crash: carried again, it is this rename's own copy.
    await env.carry({ from: "ALPHA", to: "beta", how });
    expect(await read(root, "beta/all.env")).toBe("SHARED=1\n");
    await env.undo({ from: "ALPHA", to: "beta", how });
    await absent(root, "beta");
    expect(await read(root, "alpha/all.env")).toBe("SHARED=1\n");
    // alpha -> Alpha is the same directory, renamed in place.
    expect(await env.plan({ from: "alpha", to: "Alpha", sharedWith: [] })).toBe(
      "move",
    );
    await env.carry({ from: "alpha", to: "Alpha", how: "move" });
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(root, "env"))).toEqual(["Alpha"]);
  },
);

/** Where a rename stops when rigd dies: the step it never returns from. */
type Crash = "config" | "env" | "save";
/** Project `before` (and `others`) registered in a real state file, with `before`'s env file, renamed by `rename`, each
 * call a new rigd over the same root and rig.yaml. `crash` makes that call stop for good at a step, as a dead rigd does;
 * `failSave` fails its final save, `commitSave` after the write committed; `unreadable` fails the state read after that. */
async function world(others: string[] = []) {
  const root = await temporaryRoot();
  const store = new FileStateStore(root);
  const record = (id: string, name: string): ProjectRecord => ({
    id,
    name,
    repoPath: join(root, id),
    configPath: join(root, id, "rig.yaml"),
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const project = record("p1", "before");
  const initial: RuntimeState = {
    version: STATE_VERSION,
    projects: [project, ...others.map((name, i) => record(`o${i}`, name))],
    targets: [],
    activity: [],
  };
  await store.update((state) => {
    Object.assign(state, initial);
  });
  await envFile(root, "before/all.env", "A=1\n");
  const rigYaml = { name: "before" };
  const never = () => new Promise<never>(() => {});
  const deps = (
    options: {
      crash?: Crash;
      failSave?: "before" | "after";
      unreadable?: boolean;
    } = {},
  ) => {
    const env = createOperatorEnvFiles(root);
    let writes = 0,
      failed = false;
    return {
      root,
      operatorEnv: {
        ...env,
        carry: async (input: Parameters<typeof env.carry>[0]) =>
          options.crash === "env" ? never() : env.carry(input),
      },
      store: {
        async read() {
          if (failed && options.unreadable)
            throw new RigError("STATE_READ", "unreadable", "");
          return await store.read();
        },
        async update(change: (state: RuntimeState) => void) {
          // The first write while the rename is recorded is the one that saves it.
          const final =
            !!(await store.read()).projects[0]!.renaming && ++writes === 1;
          if (final && options.crash === "save") return never();
          if (final && options.failSave) {
            failed = true;
            if (options.failSave === "after") await store.update(change);
            throw new RigError("STATE_WRITE", "disk full", "free space");
          }
          await store.update(change);
        },
      },
      documents: {
        async read() {
          return { path: project.configPath, revision: "r", config: rigYaml };
        },
        async rename(_project: ProjectRecord, name: string) {
          if (options.crash === "config") return never();
          rigYaml.name = name;
          return { path: project.configPath, revision: "r", config: { name } };
        },
      },
    } as unknown as Pick<
      RuntimeDependencies,
      "root" | "operatorEnv" | "store" | "documents"
    >;
  };
  const registered = async () => (await store.read()).projects[0]!;
  return {
    root,
    store,
    rigYaml,
    registered,
    /** Renames the Project as registered now, through a new rigd. */
    async rename(name: string, options: Parameters<typeof deps>[0] = {}) {
      const run = renameProject(await registered(), name, deps(options));
      if (options.crash) {
        // It never returns; what it wrote is what the next rigd finds.
        await Bun.sleep(50);
        return undefined;
      }
      return await run;
    },
  };
}
/** The Project renamed `after` completely: registration, rig.yaml and env files, nothing pending. */
async function expectRenamed(w: Awaited<ReturnType<typeof world>>) {
  expect(await w.registered()).toMatchObject({
    name: "after",
    formerNames: ["before"],
  });
  expect((await w.registered()).renaming).toBeUndefined();
  expect(w.rigYaml.name).toBe("after");
  expect(await read(w.root, "after/all.env")).toBe("A=1\n");
  await absent(w.root, "before");
}
/** The Project as it was before any rename: registration, rig.yaml and env files, nothing pending. */
async function expectNotRenamed(w: Awaited<ReturnType<typeof world>>) {
  const project = await w.registered();
  expect(project.name).toBe("before");
  expect(project.renaming).toBeUndefined();
  expect(project.formerNames).toBeUndefined();
  expect(w.rigYaml.name).toBe("before");
  expect(await read(w.root, "before/all.env")).toBe("A=1\n");
  await absent(w.root, "after");
}

for (const crash of ["config", "env", "save"] as const)
  test(`a rename rigd died in before its ${crash === "config" ? "rig.yaml was written" : crash === "env" ? "env files moved" : "registration was saved"} is finished by running it again, or undone`, async () => {
    for (const next of ["finish", "undo"] as const) {
      const w = await world();
      await w.rename("after", { crash });
      expect((await w.registered()).renaming).toEqual({
        to: "after",
        env: "move",
        config: "before",
      });
      if (next === "finish") {
        await w.rename("after");
        await expectRenamed(w);
      } else {
        await w.rename("before");
        await expectNotRenamed(w);
      }
    }
  });

test("while a rename is unfinished, its new name is taken from init and from every other rename, and the Project renames to nothing else", async () => {
  const w = await world(["other"]);
  await w.rename("after", { crash: "save" });
  expect(await read(w.root, "after/all.env")).toBe("A=1\n");
  const state = await w.store.read();
  // Another repository registering the name, in any case, would read the first Project's env files.
  for (const name of ["after", "AFTER"])
    await expect(
      prepareRegistration({ action: "init", repoPath: "/tmp/elsewhere" }, {
        store: w.store,
        documents: {
          async identifyInitialization(repoPath: string) {
            return { repoPath, name };
          },
        },
      } as unknown as Parameters<typeof prepareRegistration>[1]),
    ).rejects.toMatchObject({ code: "PROJECT_CONFLICT" });
  await expect(
    renameProject(state.projects[1]!, "After", {
      root: w.root,
      store: w.store,
      documents: {} as RuntimeDependencies["documents"],
    }),
  ).rejects.toMatchObject({ code: "PROJECT_CONFLICT" });
  // A new name would lose where the env files are: refused, and nothing changes.
  await expect(w.rename("third")).rejects.toMatchObject({
    code: "RENAME_PENDING",
  });
  expect((await w.registered()).renaming?.to).toBe("after");
  expect(await read(w.root, "after/all.env")).toBe("A=1\n");
  await w.rename("after");
  await expectRenamed(w);
});

test("a rename whose final save fails is undone whole, also when it was finishing an interrupted one", async () => {
  for (const interrupted of [false, true]) {
    const w = await world();
    if (interrupted) await w.rename("after", { crash: "save" });
    await expect(
      w.rename("after", { failSave: "before" }),
    ).rejects.toMatchObject({ code: "STATE_WRITE" });
    await expectNotRenamed(w);
  }
});

test("a final save that reached the disk is never undone, and one that cannot be read back stays to be finished", async () => {
  const saved = await world();
  const result = await saved.rename("after", { failSave: "after" });
  expect(result!.warnings.join(" ")).toContain("confirming it on disk failed");
  await expectRenamed(saved);
  const unknown = await world();
  await expect(
    unknown.rename("after", { failSave: "before", unreadable: true }),
  ).rejects.toMatchObject({ code: "RENAME_UNCERTAIN" });
  expect((await unknown.registered()).renaming?.to).toBe("after");
  expect(await read(unknown.root, "after/all.env")).toBe("A=1\n");
  await unknown.rename("after");
  await expectRenamed(unknown);
});

test.if(caseInsensitive)(
  "a rename that copies a shared env directory and dies before its save is finished by running it again",
  async () => {
    const w = await world(["BEFORE"]);
    await w.rename("after", { crash: "save" });
    expect((await w.registered()).renaming?.env).toBe("copy");
    const result = await w.rename("after");
    expect(result!.warnings.join(" ")).toContain("'BEFORE'");
    expect(await read(w.root, "after/all.env")).toBe("A=1\n");
    // The original stays with the Project that shares it.
    expect(await read(w.root, "BEFORE/all.env")).toBe("A=1\n");
    expect((await w.registered()).name).toBe("after");
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
