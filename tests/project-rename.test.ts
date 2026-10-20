import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
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
import {
  pendingRenameAdvice,
  renameProject,
  renamedPlan,
} from "../src/runtime/rename";
import { writeEnvFile } from "../src/adapters/env-store";
import { ABSENT_REVISION } from "../src/adapters/env-file-edit";
import { prepareRegistration } from "../src/runtime/projects";
import { STATE_VERSION } from "../src/runtime/state-schema";
import { FileStateStore } from "../src/runtime/state-store";
import { syncDirectory } from "../src/providers/private-files";

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
type Crash = "config" | "env" | "flush" | "save";
/** Project `before` (and `others`) registered in a real state file, with `before`'s env file, renamed by `rename`, each
 * call a new rigd over the same root and rig.yaml. `crash` makes that call stop for good at a step, as a dead rigd does;
 * `failSave` fails its final save, `commitSave` after the write committed; `unreadable` fails the state read after that. */
async function world(others: string[] = [], configName = "before") {
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
  const rigYaml = { name: configName };
  const deps = (
    options: {
      crash?: Crash;
      failSave?: "before" | "after";
      unreadable?: boolean;
      /** Every flush of the env directory fails. */
      failFlush?: boolean;
    } = {},
    /** Told when the rename reaches its crash point, where it then waits for good. */
    crashed: () => void = () => {},
  ) => {
    /** The crash point: the rename stops here for good, as a dead rigd does, and nothing after it runs. */
    const never = () => {
      crashed();
      return new Promise<never>(() => {});
    };
    const env = createOperatorEnvFiles(root, async (directory) => {
      if (options.crash === "flush") return never();
      if (options.failFlush) throw new Error("EIO");
      await syncDirectory(directory);
    });
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
      if (!options.crash)
        return await renameProject(await registered(), name, deps(options));
      // It stops at its crash point and never returns; what it wrote by then is what the next rigd finds.
      let reached!: () => void;
      const crashed = new Promise<void>((resolve) => (reached = resolve));
      const run = renameProject(
        await registered(),
        name,
        deps(options, reached),
      );
      const settled = run.then(
        () =>
          new Error(
            `the rename returned before its ${options.crash} crash point`,
          ),
        (error: unknown) => error,
      );
      const ended = await Promise.race([
        crashed.then(() => undefined),
        settled,
      ]);
      if (ended !== undefined) throw ended;
      return undefined;
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

test("env files written under the old name while a rename is unfinished are never left unread: finish and undo refuse, keeping the record and the name", async () => {
  const w = await world(["other"]);
  await w.rename("after", { crash: "save" });
  // The env editor writes the registered name's file, as the dashboard does after the restart.
  await writeEnvFile(
    join(w.root, "env", "before", "all.env"),
    {},
    ABSENT_REVISION,
    [{ op: "set", key: "NEW", value: "1" }],
    join(w.root, "env"),
  );
  for (const name of ["before", "after"])
    await expect(w.rename(name)).rejects.toMatchObject({ code: "ENV_SPLIT" });
  expect((await w.registered()).renaming?.to).toBe("after");
  expect(await read(w.root, "after/all.env")).toBe("A=1\n");
  expect(await read(w.root, "before/all.env")).toContain("NEW=");
  await expect(
    renameProject((await w.store.read()).projects[1]!, "after", {
      root: w.root,
      store: w.store,
      documents: {} as RuntimeDependencies["documents"],
    }),
  ).rejects.toMatchObject({ code: "PROJECT_CONFLICT" });
  // Once the new file is moved in and the directory aside, the rename finishes.
  await writeFile(join(w.root, "env/after/all.env"), "A=1\nNEW=1\n");
  await rename(join(w.root, "env/before"), join(w.root, "env/.aside"));
  await w.rename("after");
  expect((await w.registered()).name).toBe("after");
  expect(await read(w.root, "after/all.env")).toBe("A=1\nNEW=1\n");
});

test.if(caseInsensitive)(
  "undoing a copy withdraws it whole before deleting it, so a deletion cut short is finished or undone without a missing file",
  async () => {
    const w = await world(["BEFORE"]);
    await envFile(w.root, "before/a/all.env", "A=a\n");
    await envFile(w.root, "before/z/all.env", "Z=z\n");
    await w.rename("after", { crash: "save" });
    expect(await read(w.root, "after/z/all.env")).toBe("Z=z\n");
    // A directory the deletion cannot empty stops the undo partway, as a crash would.
    await chmod(join(w.root, "env/after/a"), 0o500);
    await expect(w.rename("before")).rejects.toMatchObject({
      code: "RENAME_ROLLBACK",
    });
    await chmod(join(w.root, "env/.removing-after/a"), 0o700);
    expect((await w.registered()).renaming?.to).toBe("after");
    await absent(w.root, "after");
    // Finished now, the copy is made again, whole.
    await w.rename("after");
    expect(await read(w.root, "after/a/all.env")).toBe("A=a\n");
    expect(await read(w.root, "after/z/all.env")).toBe("Z=z\n");
    await absent(w.root, ".removing-after");
    expect((await w.registered()).name).toBe("after");
  },
);

test.if(caseInsensitive)(
  "a copy's undo cut short is undone by running it again",
  async () => {
    const w = await world(["BEFORE"]);
    await envFile(w.root, "before/a/all.env", "A=a\n");
    await w.rename("after", { crash: "save" });
    await chmod(join(w.root, "env/after/a"), 0o500);
    await expect(w.rename("before")).rejects.toMatchObject({
      code: "RENAME_ROLLBACK",
    });
    await chmod(join(w.root, "env/.removing-after/a"), 0o700);
    await w.rename("before");
    await absent(w.root, "after");
    await absent(w.root, ".removing-after");
    expect((await w.registered()).renaming).toBeUndefined();
    expect(await read(w.root, "BEFORE/a/all.env")).toBe("A=a\n");
  },
);

test("an interrupted repair of rig.yaml's name back to the registered one is finished by the same command", async () => {
  // rig.yaml was edited by hand to 'edited'; rig rename before puts the registered name back.
  const w = await world([], "edited");
  await w.rename("before", { crash: "env" });
  expect((await w.registered()).renaming).toEqual({
    to: "before",
    env: "none",
    config: "edited",
  });
  expect(
    pendingRenameAdvice({ name: "before", repoPath: "/r" }, { to: "before" }),
  ).toBe(
    "Run rig rename before --project before to finish writing name: before to rig.yaml.",
  );
  await w.rename("before");
  expect(w.rigYaml.name).toBe("before");
  const project = await w.registered();
  expect(project.name).toBe("before");
  expect(project.renaming).toBeUndefined();
  expect(project.formerNames).toBeUndefined();
});

test("a withdrawn copy is deleted only once its withdrawal is flushed, by undo and by finish, also when an earlier attempt left it", async () => {
  const root = await temporaryRoot();
  await envFile(root, "alpha/all.env", "A=1\n");
  const aside = join(root, "env", ".removing-beta");
  let failing = false;
  const flushes: string[] = [];
  const env = createOperatorEnvFiles(root, async () => {
    const present = await lstat(aside).then(
      () => "with",
      () => "without",
    );
    flushes.push(`${failing ? "failed" : "flushed"} ${present}`);
    if (failing) throw new Error("EIO");
  });
  const move = { from: "alpha", to: "beta", how: "copy" } as const;
  await env.carry(move);
  failing = true;
  // The withdrawal is made, and its flush fails: nothing is deleted.
  await expect(env.undo(move)).rejects.toThrow("EIO");
  await absent(root, "beta");
  expect(await read(root, ".removing-beta/all.env")).toBe("A=1\n");
  // Retried while flushing still fails, neither undo nor finish begins deleting the copy left aside.
  await expect(env.undo(move)).rejects.toThrow("EIO");
  await expect(env.carry(move)).rejects.toThrow();
  expect(await read(root, ".removing-beta/all.env")).toBe("A=1\n");
  failing = false;
  flushes.length = 0;
  await env.carry(move);
  // Flushed while the withdrawn copy was still there, before it was deleted, then the new copy published.
  expect(flushes).toEqual(["flushed with", "flushed without"]);
  await absent(root, ".removing-beta");
  expect(await read(root, "beta/all.env")).toBe("A=1\n");
  failing = true;
  await expect(env.undo(move)).rejects.toThrow("EIO");
  failing = false;
  flushes.length = 0;
  await env.undo(move);
  // Flushed before the withdrawn copy is deleted, then once more as the undo reports done.
  expect(flushes).toEqual(["flushed with", "flushed without"]);
  await absent(root, ".removing-beta");
  await absent(root, "beta");
});

test("the advice for an unfinished rename of a name too long to select names the command that works from the repository", () => {
  expect(
    pendingRenameAdvice(
      { name: "a".repeat(129), repoPath: "/work/long" },
      { to: "short" },
    ),
  ).toBe("Run rig rename short in /work/long to finish the rename.");
  expect(
    pendingRenameAdvice({ name: "before", repoPath: "/r" }, { to: "after" }),
  ).toBe(
    "Run rig rename after --project before to finish the rename, or rig rename before --project before to undo it.",
  );
});

test("a rename's env step is reported done only once its directory is flushed, also when an earlier attempt already made the change", async () => {
  // Undo of a move: it moves back, its flush fails; run again, the move is already undone, and its flush fails again.
  const undo = await world();
  await undo.rename("after", { crash: "save" });
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(
      undo.rename("before", { failFlush: true }),
    ).rejects.toMatchObject({ code: "RENAME_ROLLBACK" });
  expect((await undo.registered()).renaming?.to).toBe("after");
  await undo.rename("before");
  await expectNotRenamed(undo);
  // A move rigd died in before its flush: run again, the files are already moved, and the flush must still succeed.
  const move = await world();
  await move.rename("after", { crash: "flush" });
  expect(await read(move.root, "after/all.env")).toBe("A=1\n");
  await expect(move.rename("after", { failFlush: true })).rejects.toMatchObject(
    { code: "RENAME_ROLLBACK" },
  );
  expect((await move.registered()).renaming?.to).toBe("after");
  await move.rename("after");
  await expectRenamed(move);
});

test.if(caseInsensitive)(
  "a published copy rigd died in before its flush is reported done only once a later attempt flushes it",
  async () => {
    const w = await world(["BEFORE"]);
    await w.rename("after", { crash: "flush" });
    expect(await read(w.root, "after/all.env")).toBe("A=1\n");
    await expect(w.rename("after", { failFlush: true })).rejects.toMatchObject({
      code: "RENAME_ROLLBACK",
    });
    expect((await w.registered()).renaming?.to).toBe("after");
    await w.rename("after");
    expect((await w.registered()).name).toBe("after");
    expect(await read(w.root, "after/all.env")).toBe("A=1\n");
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
