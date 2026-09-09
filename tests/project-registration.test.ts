import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  realpath,
  readdir,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProjectDocuments } from "../src/adapters/project-documents";
import { registerProject } from "../src/runtime/projects";
import type { RuntimeState } from "../src/domain/runtime";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import type { CommandRunner } from "../src/providers/contracts";
import { runCommand } from "../src/providers/command-runner";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const run: CommandRunner = (input) =>
  runCommand({
    ...input,
    command:
      input.command[0] === "git"
        ? [
            "/Library/Developer/CommandLineTools/usr/bin/git",
            ...input.command.slice(1),
          ]
        : input.command,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "rig-registration-")),
  );
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  const state: RuntimeState = {
    version: 2,
    projects: [],
    targets: [],
    activity: [],
  };
  let id = 0,
    writes = 0,
    fail = false;
  const deps: Pick<RuntimeDependencies, "store" | "documents" | "id" | "now"> =
    {
      documents: createProjectDocuments(root, run),
      store: {
        async read() {
          return structuredClone(state);
        },
        async update(change) {
          writes++;
          if (fail) throw Error("disk failure with private detail");
          const next = structuredClone(state);
          await change(next);
          Object.assign(state, next);
        },
      },
      id: () => `id-${++id}`,
      now: () => new Date().toISOString(),
    };
  return {
    root,
    repo,
    state,
    deps,
    writes: () => writes,
    fail: (value: boolean) => {
      fail = value;
    },
  };
}
test("duplicate name preflight rejects before creating Git, remote, or config in a second directory", async () => {
  const f = await fixture();
  f.state.projects.push({
    id: "existing",
    name: "demo",
    repoPath: "/somewhere/else",
    configPath: "/somewhere/else/rig.yaml",
    createdAt: "today",
  });
  await expect(
    registerProject(
      { action: "init", repoPath: f.repo, project: "demo", createGit: true },
      f.deps,
    ),
  ).rejects.toMatchObject({ code: "PROJECT_CONFLICT" });
  expect(await readdir(f.repo)).toEqual([]);
  expect(f.writes()).toBe(0);
});
test("nested init uses the Git root and existing config identity, and rerunning preserves registration and files", async () => {
  const f = await fixture();
  expect((await run({ command: ["git", "init"], cwd: f.repo })).exitCode).toBe(
    0,
  );
  const config = "name: canonical\n# Keep this comment.\ncomponents: {}\n";
  await writeFile(join(f.repo, "rig.yaml"), config);
  const nested = join(f.repo, "src", "nested");
  await mkdir(nested, { recursive: true });
  const first = await registerProject(
    { action: "init", repoPath: nested },
    f.deps,
  );
  expect(first).toMatchObject({
    name: "canonical",
    repoPath: f.repo,
    configPath: join(f.repo, "rig.yaml"),
  });
  const gitConfig = await readFile(join(f.repo, ".git", "config"), "utf8");
  expect(
    (
      await run({ command: ["git", "remote", "get-url", "rig"], cwd: f.repo })
    ).stdout.trim(),
  ).toBe("rig://localhost/canonical");
  expect(
    await registerProject({ action: "init", repoPath: nested }, f.deps),
  ).toEqual(first);
  expect(f.state.projects).toEqual([first]);
  expect(await readFile(join(f.repo, "rig.yaml"), "utf8")).toBe(config);
  expect(await readFile(join(f.repo, ".git", "config"), "utf8")).toBe(
    gitConfig,
  );
  expect(await readdir(nested)).toEqual([]);
});
test("a registered path conflict preserves its existing config and leaves its remote unconfigured", async () => {
  const f = await fixture();
  expect((await run({ command: ["git", "init"], cwd: f.repo })).exitCode).toBe(
    0,
  );
  const config = "name: new-name\ncomponents: {}\n";
  await writeFile(join(f.repo, "rig.yaml"), config);
  f.state.projects.push({
    id: "existing",
    name: "old-name",
    repoPath: f.repo,
    configPath: join(f.repo, "rig.yaml"),
    createdAt: "today",
  });
  await expect(
    registerProject({ action: "init", repoPath: f.repo }, f.deps),
  ).rejects.toMatchObject({ code: "PROJECT_CONFLICT" });
  expect(await readFile(join(f.repo, "rig.yaml"), "utf8")).toBe(config);
  expect((await run({ command: ["git", "remote"], cwd: f.repo })).stdout).toBe(
    "",
  );
  expect(f.writes()).toBe(0);
});
test("config identity mismatch is rejected before creating Git or a Rig remote", async () => {
  const f = await fixture();
  const config = "name: canonical\ncomponents: {}\n";
  await writeFile(join(f.repo, "rig.yaml"), config);
  await expect(
    registerProject(
      { action: "init", repoPath: f.repo, project: "other", createGit: true },
      f.deps,
    ),
  ).rejects.toMatchObject({ code: "PROJECT_IDENTITY" });
  expect(await readdir(f.repo)).toEqual(["rig.yaml"]);
  expect(await readFile(join(f.repo, "rig.yaml"), "utf8")).toBe(config);
  expect(f.writes()).toBe(0);
});
test("store failure reports preserved initialization and rerunning completes the same Project", async () => {
  const f = await fixture();
  f.fail(true);
  const command = {
    action: "init" as const,
    repoPath: f.repo,
    project: "demo",
    createGit: true,
  };
  await expect(registerProject(command, f.deps)).rejects.toMatchObject({
    code: "REGISTRATION_INCOMPLETE",
    hint: expect.stringContaining("rerun rig init"),
  });
  expect(f.state.projects).toEqual([]);
  const config = await readFile(join(f.repo, "rig.yaml"), "utf8");
  expect(
    (
      await run({ command: ["git", "remote", "get-url", "rig"], cwd: f.repo })
    ).stdout.trim(),
  ).toBe("rig://localhost/demo");
  f.fail(false);
  const project = await registerProject(command, f.deps);
  expect(f.state.projects).toEqual([project]);
  expect(await readFile(join(f.repo, "rig.yaml"), "utf8")).toBe(config);
});
