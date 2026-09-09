import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureProjectGit,
  inspectProjectGit,
  createProjectDiscovery,
} from "../src/git/project";
import { runCommand } from "../src/providers/command-runner";
import type { CommandRunner } from "../src/providers/contracts";
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

test("explicit Git creation and nested discovery use one repository root and an idempotent Rig remote", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "rig-git-project-")),
  );
  try {
    await expect(
      inspectProjectGit(directory, createProjectDiscovery(run)),
    ).rejects.toMatchObject({
      code: "GIT_REQUIRED",
    });
    const first = await ensureProjectGit(
      { path: directory, project: "example", createGit: true },
      createProjectDiscovery(run),
    );
    expect(first.repoPath).toBe(directory);
    expect(first.remoteUrl).toBe("rig://localhost/example");
    expect(first.createdGit).toBe(true);
    const nested = join(directory, "nested");
    await mkdir(nested);
    const link = join(directory, "linked");
    await symlink(nested, link);
    expect(
      (await inspectProjectGit(link, createProjectDiscovery(run))).repoPath,
    ).toBe(directory);
    const second = await ensureProjectGit(
      { path: nested, project: "example" },
      createProjectDiscovery(run),
    );
    expect(second.repoPath).toBe(directory);
    expect(second.remoteConfigured).toBe(false);
    expect(
      (
        await run({
          command: ["git", "remote", "get-url", "rig"],
          cwd: directory,
        })
      ).stdout.trim(),
    ).toBe("rig://localhost/example");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("conflicting fetch or push destinations are preserved and reported explicitly", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "rig-git-project-")),
  );
  try {
    await ensureProjectGit(
      { path: directory, project: "original", createGit: true },
      createProjectDiscovery(run),
    );
    await expect(
      ensureProjectGit(
        { path: directory, project: "renamed" },
        createProjectDiscovery(run),
      ),
    ).rejects.toMatchObject({ code: "GIT_REMOTE_CONFLICT" });
    expect(
      (
        await run({
          command: ["git", "remote", "get-url", "rig"],
          cwd: directory,
        })
      ).stdout.trim(),
    ).toBe("rig://localhost/original");
    await run({
      command: [
        "git",
        "remote",
        "set-url",
        "--push",
        "rig",
        "https://example.com/unrelated",
      ],
      cwd: directory,
    });
    await expect(
      ensureProjectGit(
        { path: directory, project: "original" },
        createProjectDiscovery(run),
      ),
    ).rejects.toMatchObject({ code: "GIT_REMOTE_CONFLICT" });
    expect(
      (
        await run({
          command: ["git", "remote", "get-url", "--push", "rig"],
          cwd: directory,
        })
      ).stdout.trim(),
    ).toBe("https://example.com/unrelated");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Project rename updates fetch and explicit push URLs and can compensate without touching another edit", async () => {
  const { renameRigRemote } = await import("../src/git/remotes");
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "rig-git-project-")),
  );
  try {
    await ensureProjectGit(
      { path: directory, project: "old", createGit: true },
      createProjectDiscovery(run),
    );
    await run({
      command: [
        "git",
        "remote",
        "set-url",
        "--push",
        "rig",
        "rig://localhost/old",
      ],
      cwd: directory,
    });
    const change = await renameRigRemote(
      { repoPath: directory, oldName: "old", newName: "new" },
      run,
    );
    expect(
      (
        await run({
          command: ["git", "remote", "get-url", "rig"],
          cwd: directory,
        })
      ).stdout.trim(),
    ).toBe("rig://localhost/new");
    expect(
      (
        await run({
          command: ["git", "remote", "get-url", "--push", "rig"],
          cwd: directory,
        })
      ).stdout.trim(),
    ).toBe("rig://localhost/new");
    await change.restore();
    expect(
      (
        await run({
          command: ["git", "remote", "get-url", "rig"],
          cwd: directory,
        })
      ).stdout.trim(),
    ).toBe("rig://localhost/old");
    const changed = await renameRigRemote(
      { repoPath: directory, oldName: "old", newName: "new" },
      run,
    );
    await run({
      command: ["git", "remote", "set-url", "rig", "rig://localhost/third"],
      cwd: directory,
    });
    await expect(changed.restore()).rejects.toMatchObject({
      code: "GIT_REMOTE_CONFLICT",
    });
    expect(
      (
        await run({
          command: ["git", "remote", "get-url", "rig"],
          cwd: directory,
        })
      ).stdout.trim(),
    ).toBe("rig://localhost/third");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real local Branch preflight reports ahead/behind from cached refs and only warns missing upstream for Production", async () => {
  const { preflightDeployment } = await import("../src/git/preflight");
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "rig-git-project-")),
  );
  const git = async (args: string[]) => {
    const result = await run({ command: ["git", ...args], cwd: directory });
    expect(result.exitCode).toBe(0);
    return result.stdout.trim();
  };
  let commits = 0;
  const commit = () =>
    git([
      "-c",
      "user.name=Rig Test",
      "-c",
      "user.email=rig@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      `test ${++commits}`,
    ]);
  try {
    await git(["init", "-b", "main"]);
    await commit();
    const initial = await git(["rev-parse", "HEAD"]);
    const noUpstream = await preflightDeployment(
      { repoPath: directory, branch: "main", productionBranch: "main" },
      run,
    );
    expect(noUpstream.warnings).toHaveLength(1);
    await git(["branch", "preview"]);
    expect(
      (
        await preflightDeployment(
          { repoPath: directory, branch: "preview", productionBranch: "main" },
          run,
        )
      ).warnings,
    ).toEqual([]);
    await commit();
    const deployed = await git(["rev-parse", "HEAD"]);
    await git(["checkout", "-b", "other", initial]);
    await commit();
    await git([
      "update-ref",
      "refs/remotes/team/main",
      await git(["rev-parse", "HEAD"]),
    ]);
    await git(["remote", "add", "team", "/unreachable-without-fetch"]);
    await git(["config", "branch.main.remote", "team"]);
    await git(["config", "branch.main.merge", "refs/heads/main"]);
    const result = await preflightDeployment(
      { repoPath: directory, branch: "main", productionBranch: "main" },
      run,
    );
    expect(result.commit).toBe(deployed);
    expect(result.warnings.join(" ")).toContain("1 commit ahead");
    expect(result.warnings.join(" ")).toContain("1 commit behind");
    await expect(
      preflightDeployment(
        { repoPath: directory, branch: deployed, productionBranch: "main" },
        run,
      ),
    ).rejects.toMatchObject({ code: "GIT_LOCAL_BRANCH" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real unborn, origin default, detached and bare repositories preserve discovery policy", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "rig-discovery-")),
  );
  const commands: (readonly string[])[] = [];
  const discovery = createProjectDiscovery(async (input) => {
    commands.push(input.command);
    return await run(input);
  });
  const git = (args: string[]) =>
    run({ command: ["git", ...args], cwd: directory });
  try {
    await git(["init", "-b", "work"]);
    expect(
      (await inspectProjectGit(directory, discovery)).productionBranch,
    ).toBe("work");
    await git([
      "-c",
      "user.name=Rig Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
    await git(["update-ref", "refs/remotes/origin/trunk", "HEAD"]);
    await git([
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/trunk",
    ]);
    expect(
      (await inspectProjectGit(directory, discovery)).productionBranch,
    ).toBe("trunk");
    await git(["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
    await git(["checkout", "--detach"]);
    expect(
      (await inspectProjectGit(directory, discovery)).productionBranch,
    ).toBe("main");
    expect(
      commands.every((command) =>
        ["rev-parse", "symbolic-ref"].includes(command[1]!),
      ),
    ).toBe(true);
    const bare = join(directory, "bare");
    await git(["init", "--bare", bare]);
    await expect(inspectProjectGit(bare, discovery)).rejects.toMatchObject({
      code: "GIT_BARE",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit setup executes exactly init and missing remote add mutations", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "rig-setup-")));
  const mutations: (readonly string[])[] = [];
  const discovery = createProjectDiscovery(async (input) => {
    if (
      input.command[1] === "init" ||
      (input.command[1] === "remote" && input.command[2] === "add")
    )
      mutations.push(input.command);
    return await run(input);
  });
  try {
    await ensureProjectGit(
      { path: directory, project: "example", createGit: true },
      discovery,
    );
    await ensureProjectGit(
      { path: directory, project: "example", createGit: true },
      discovery,
    );
    expect(mutations).toEqual([
      ["git", "init"],
      ["git", "remote", "add", "rig", "rig://localhost/example"],
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
