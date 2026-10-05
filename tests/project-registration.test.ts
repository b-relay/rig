import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  realpath,
  readdir,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProjectDocuments } from "../src/adapters/project-documents";
import { TARGET_ROLES, targetOn } from "../src/config/schema";
import {
  prepareRegistration,
  registerProject as register,
} from "../src/runtime/projects";
import type { RuntimeCommand } from "../src/daemon/protocol";
const registerProject = async (
  command: RuntimeCommand,
  deps: Pick<RuntimeDependencies, "documents" | "store" | "id" | "now">,
) =>
  (await register(command, await prepareRegistration(command, deps), deps))
    .project;
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
    version: 5,
    projects: [],
    targets: [],
    activity: [],
  };
  let id = 0,
    writes = 0,
    fail = false;
  const deps: Pick<RuntimeDependencies, "store" | "documents" | "id" | "now"> =
    {
      documents: createProjectDocuments(root, run, {}, join(root, "home")),
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
test("duplicate name preflight rejects before creating Git or config in a second directory", async () => {
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
  const config =
    "name: canonical\n# Keep this comment.\ntools:\n  cli:\n    bin: cli\n";
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
  // Registration adds no Git remote.
  const remotes = await run({ command: ["git", "remote"], cwd: f.repo });
  expect(remotes.exitCode).toBe(0);
  expect(remotes.stdout.split("\n").filter(Boolean)).not.toContain("rig");
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
test("init --path registers the nearest Project config inside the repository, the one other commands discover", async () => {
  const f = await fixture();
  expect((await run({ command: ["git", "init"], cwd: f.repo })).exitCode).toBe(
    0,
  );
  const web = join(f.repo, "packages", "web");
  await mkdir(web, { recursive: true });
  const config = "name: web\ntools:\n  cli:\n    bin: cli\n";
  await writeFile(join(web, "rig.yaml"), config);
  expect(await f.deps.documents.initializationInfo(web)).toMatchObject({
    name: "web",
    existing: true,
  });
  const registered = await registerProject(
    { action: "init", repoPath: web },
    f.deps,
  );
  expect(registered).toMatchObject({
    name: "web",
    repoPath: web,
    configPath: join(web, "rig.yaml"),
  });
  expect(await readdir(f.repo)).not.toContain("rig.yaml");
  expect(await readFile(join(web, "rig.yaml"), "utf8")).toBe(config);
  // Registration adds no Git remote.
  const remotes = await run({ command: ["git", "remote"], cwd: web });
  expect(remotes.exitCode).toBe(0);
  expect(remotes.stdout.split("\n").filter(Boolean)).not.toContain("rig");
  expect((await f.deps.documents.discover(web)).repoPath).toBe(web);
  expect(
    await registerProject({ action: "init", repoPath: web }, f.deps),
  ).toEqual(registered);
});

test("a registered path conflict preserves its existing config and adds no remote", async () => {
  const f = await fixture();
  expect((await run({ command: ["git", "init"], cwd: f.repo })).exitCode).toBe(
    0,
  );
  const config = "name: new-name\ntools:\n  cli:\n    bin: cli\n";
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
  const remotes = await run({ command: ["git", "remote"], cwd: f.repo });
  expect(remotes.exitCode).toBe(0);
  expect(remotes.stdout).toBe("");
  expect(f.writes()).toBe(0);
});
test("config identity mismatch is rejected before creating Git", async () => {
  const f = await fixture();
  const config = "name: canonical\ntools:\n  cli:\n    bin: cli\n";
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
    tool: { name: "cli", bin: "cli.ts" },
    createGit: true,
  };
  await expect(registerProject(command, f.deps)).rejects.toMatchObject({
    code: "REGISTRATION_INCOMPLETE",
    hint: expect.stringContaining("rerun rig init"),
  });
  expect(f.state.projects).toEqual([]);
  const config = await readFile(join(f.repo, "rig.yaml"), "utf8");
  // Registration adds no Git remote.
  const remotes = await run({ command: ["git", "remote"], cwd: f.repo });
  expect(remotes.exitCode).toBe(0);
  expect(remotes.stdout.split("\n").filter(Boolean)).not.toContain("rig");
  f.fail(false);
  const project = await registerProject(command, f.deps);
  expect(f.state.projects).toEqual([project]);
  expect(await readFile(join(f.repo, "rig.yaml"), "utf8")).toBe(config);
});
test("init records the host's Production branch default, never the checked-out branch, unless --production-branch is given", async () => {
  const f = await fixture();
  for (const command of [
    ["git", "init", "-b", "feature/wip"],
    [
      "git",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "--allow-empty",
      "-m",
      "start",
    ],
  ])
    expect((await run({ command, cwd: f.repo })).exitCode).toBe(0);
  expect(await f.deps.documents.initializationInfo(f.repo)).toMatchObject({
    productionBranch: "main",
    currentBranch: "feature/wip",
  });
  await writeFile(
    join(f.root, "config.yaml"),
    "deploy:\n  production_branch: trunk\n",
  );
  expect(await f.deps.documents.initializationInfo(f.repo)).toMatchObject({
    productionBranch: "trunk",
    currentBranch: "feature/wip",
  });
  const project = await registerProject(
    {
      action: "init",
      repoPath: f.repo,
      project: "demo",
      tool: { name: "cli", bin: "cli.ts" },
    },
    f.deps,
  );
  expect(await readFile(project.configPath, "utf8")).toContain(
    "production_branch: trunk",
  );
  const other = join(f.root, "other");
  await mkdir(other);
  expect(
    (await run({ command: ["git", "init", "-b", "feature/wip"], cwd: other }))
      .exitCode,
  ).toBe(0);
  const explicit = await registerProject(
    {
      action: "init",
      repoPath: other,
      project: "other",
      service: { name: "web", command: "serve", port: 4567 },
      productionBranch: "release",
    },
    f.deps,
  );
  expect(await readFile(explicit.configPath, "utf8")).toContain(
    "production_branch: release",
  );
});
test("init, from rig init or the dashboard's new-project form, writes working and preview on and stable off", async () => {
  const f = await fixture();
  expect(
    (await run({ command: ["git", "init", "-b", "main"], cwd: f.repo }))
      .exitCode,
  ).toBe(0);
  // The init command the dashboard's form sends, as rig init does.
  const project = await registerProject(
    {
      action: "init",
      repoPath: f.repo,
      project: "demo",
      domain: "demo.test",
      service: { name: "web", command: "serve", port: 4567 },
    },
    f.deps,
  );
  const written = await readFile(project.configPath, "utf8");
  // Every switch is written out, so turning stable on is one word.
  expect(written).toContain(
    "targets:\n  working: true\n  stable: false\n  preview: true\n",
  );
  const { config } = await f.deps.documents.read(f.repo);
  expect(TARGET_ROLES.filter((role) => targetOn(config, role))).toEqual([
    "working",
    "preview",
  ]);
});
test("discovery stops at the nearest Git toplevel and reports whether the directory is a working repository", async () => {
  const f = await fixture();
  expect((await run({ command: ["git", "init"], cwd: f.repo })).exitCode).toBe(
    0,
  );
  await writeFile(
    join(f.repo, "rig.yaml"),
    "name: outer\ntools:\n  cli:\n    bin: cli\n",
  );
  const nested = join(f.repo, "src", "nested");
  await mkdir(nested, { recursive: true });
  expect(await f.deps.documents.discover(nested)).toMatchObject({
    repoPath: f.repo,
    document: { config: { name: "outer" } },
    gitRequired: false,
  });
  const inner = join(f.repo, "vendor", "inner");
  await mkdir(inner, { recursive: true });
  expect((await run({ command: ["git", "init"], cwd: inner })).exitCode).toBe(
    0,
  );
  await expect(f.deps.documents.discover(inner)).rejects.toMatchObject({
    code: "missing_config",
  });
  const plain = join(f.root, "plain");
  await mkdir(plain);
  await writeFile(
    join(plain, "rig.yaml"),
    "name: plain\ntools:\n  cli:\n    bin: cli\n",
  );
  expect(await f.deps.documents.discover(plain)).toMatchObject({
    repoPath: plain,
    gitRequired: true,
  });
  await expect(
    f.deps.documents.discover(join(f.root, "absent")),
  ).rejects.toMatchObject({ code: "GIT_PATH_MISSING" });
});
test("a linked worktree, beside or inside the repository, discovers the Project its main checkout registers", async () => {
  const f = await fixture();
  const git = async (args: string[], cwd = f.repo) =>
    expect(
      (
        await run({
          command: [
            "git",
            "-c",
            "user.name=Rig Test",
            "-c",
            "user.email=test@example.invalid",
            ...args,
          ],
          cwd,
        })
      ).exitCode,
    ).toBe(0);
  await git(["init", "-b", "main"]);
  await writeFile(
    join(f.repo, "rig.yaml"),
    "name: demo\ntools:\n  cli:\n    bin: cli\n",
  );
  await writeFile(join(f.repo, ".gitignore"), ".worktrees/\n");
  await git(["add", "."]);
  await git(["commit", "-m", "fixture"]);
  const beside = join(f.root, "wt"),
    inside = join(f.repo, ".worktrees", "inside");
  await git(["worktree", "add", "-b", "feature", beside]);
  await git(["worktree", "add", "-b", "other", inside]);
  // The branch's edit stays in the worktree: the Project is read from the main checkout.
  await writeFile(
    join(beside, "rig.yaml"),
    "name: edited\ntools:\n  cli:\n    bin: cli\n",
  );
  const branchOnly = join(beside, "only", "on", "feature");
  await mkdir(branchOnly, { recursive: true });
  for (const path of [beside, inside, branchOnly])
    expect(await f.deps.documents.discover(path)).toMatchObject({
      repoPath: f.repo,
      document: { path: join(f.repo, "rig.yaml"), config: { name: "demo" } },
      gitRequired: false,
    });
  expect(
    await prepareRegistration({ action: "init", repoPath: beside }, f.deps),
  ).toMatchObject({ repoPath: f.repo, name: "demo" });
});
test("a worktree directory the main tree holds as a separate repository or a symlink still discovers the main checkout's Project", async () => {
  const f = await fixture();
  const git = async (args: string[], cwd = f.repo) =>
    expect(
      (
        await run({
          command: [
            "git",
            "-c",
            "user.name=Rig Test",
            "-c",
            "user.email=test@example.invalid",
            ...args,
          ],
          cwd,
        })
      ).exitCode,
    ).toBe(0);
  const config = (name: string) =>
    `name: ${name}\ntools:\n  cli:\n    bin: cli\n`;
  await git(["init", "-b", "main"]);
  await writeFile(join(f.repo, "rig.yaml"), config("demo"));
  await git(["add", "."]);
  await git(["commit", "-m", "fixture"]);
  const worktree = join(f.root, "wt");
  await git(["worktree", "add", "-b", "feature", worktree]);
  // The Branch tracks plain directories at both places.
  for (const directory of [join("vendor", "inner"), "linked"]) {
    await mkdir(join(worktree, directory), { recursive: true });
    await writeFile(join(worktree, directory, "file"), "tracked\n");
  }
  await git(["add", "."], worktree);
  await git(["commit", "-m", "feat: directories"], worktree);
  // The main checkout holds a separate repository and a symlink out of the repository there.
  const inner = join(f.repo, "vendor", "inner");
  await mkdir(inner, { recursive: true });
  await git(["init", "-b", "main"], inner);
  await writeFile(join(inner, "rig.yaml"), config("inner"));
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "rig.yaml"), config("outside"));
  await symlink(outside, join(f.repo, "linked"));
  for (const directory of [join("vendor", "inner"), "linked"])
    expect(
      await f.deps.documents.discover(join(worktree, directory)),
    ).toMatchObject({
      repoPath: f.repo,
      document: { config: { name: "demo" } },
    });
});
test("discovery never reads a config above the repository, so an invalid one there cannot block init", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "rig.yaml"), "name: [unclosed\n");
  const plain = join(f.root, "plain");
  await mkdir(plain);
  expect((await run({ command: ["git", "init"], cwd: f.repo })).exitCode).toBe(
    0,
  );
  await expect(f.deps.documents.discover(f.repo)).rejects.toMatchObject({
    code: "missing_config",
  });
  expect(
    await prepareRegistration(
      { action: "init", repoPath: f.repo, project: "demo" },
      f.deps,
    ),
  ).toMatchObject({ repoPath: f.repo, name: "demo" });
  expect(
    await prepareRegistration(
      { action: "init", repoPath: plain, project: "plain", createGit: true },
      f.deps,
    ),
  ).toMatchObject({ repoPath: plain, name: "plain" });
});
