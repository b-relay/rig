import { expect, test } from "bun:test";
import {
  inspectProjectGit,
  inspectProjectLocation,
  ensureProjectGit,
  type ProjectDiscovery,
} from "../src/git/project";

test("discovery controls canonical filesystem identity as well as Git without real paths", async () => {
  const paths: string[] = [];
  const commands: (readonly string[])[] = [];
  const project = await inspectProjectGit("/fictional/link/nested", {
    async canonicalize(path: string) {
      paths.push(path);
      return path.endsWith("nested")
        ? "/canonical/repo/nested"
        : "/canonical/repo";
    },
    async run(input: { command: readonly string[] }) {
      commands.push(input.command);
      const stdout = input.command.includes("--show-toplevel")
        ? "/canonical/repo\n"
        : input.command.includes("--is-bare-repository")
          ? "false\n"
          : "origin/trunk\n";
      return { exitCode: 0, stdout, stderr: "" };
    },
  });
  expect(project).toEqual({
    repoPath: "/canonical/repo",
    productionBranch: "trunk",
  });
  expect(paths).toEqual(["/fictional/link/nested", "/canonical/repo"]);
  expect(
    commands.every(
      (command) => !command.includes("init") && !command.includes("remote"),
    ),
  ).toBe(true);
});

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
const absent = { exitCode: 1, stdout: "", stderr: "" };
function controlled(
  responses: Awaited<ReturnType<ProjectDiscovery["run"]>>[],
): ProjectDiscovery {
  return {
    canonicalize: async (path) => path,
    run: async () => {
      const result = responses.shift();
      if (!result) throw new Error("Unexpected command");
      return result;
    },
  };
}

test("missing and unreadable paths and failed or malformed Git are distinct safe failures", async () => {
  for (const [code, expected] of [
    ["ENOENT", "GIT_PATH_MISSING"],
    ["EACCES", "GIT_PATH_UNREADABLE"],
  ]) {
    await expect(
      inspectProjectGit("/virtual", {
        canonicalize: async () => {
          throw Object.assign(new Error("private data"), { code });
        },
        run: async () => {
          throw new Error("must not execute");
        },
      }),
    ).rejects.toMatchObject({ code: expected });
  }
  for (const responses of [
    [ok("true")],
    [ok("unexpected secret")],
    [{ exitCode: 128, stdout: "", stderr: "private failure" }],
    [ok("false"), ok("relative/root")],
    [ok("false"), ok("/repo"), ok("origin/")],
    [ok("false"), ok("/repo"), { exitCode: 128, stdout: "", stderr: "secret" }],
  ]) {
    const bare = responses[0]?.stdout === "true";
    await expect(
      inspectProjectGit("/virtual", controlled(responses)),
    ).rejects.toMatchObject({ code: bare ? "GIT_BARE" : "GIT_DISCOVERY" });
  }
});

test("read-only discovery retains current, detached and configured initial Branch defaults", async () => {
  expect(
    await inspectProjectGit(
      "/repo",
      controlled([ok("false"), ok("/repo"), absent, ok("feature/work")]),
    ),
  ).toEqual({ repoPath: "/repo", productionBranch: "feature/work" });
  expect(
    await inspectProjectGit(
      "/repo",
      controlled([ok("false"), ok("/repo"), absent, absent]),
    ),
  ).toEqual({ repoPath: "/repo", productionBranch: "main" });
  const notRepo = {
    exitCode: 128,
    stdout: "",
    stderr: "fatal: not a git repository (or any parent)",
  };
  expect(
    await inspectProjectLocation("/repo", controlled([notRepo, ok("trunk")])),
  ).toEqual({
    repoPath: "/repo",
    productionBranch: "trunk",
    gitRequired: true,
  });
  await expect(
    inspectProjectGit("/repo", controlled([notRepo, absent])),
  ).rejects.toMatchObject({ code: "GIT_REQUIRED" });
});

test("create Git authorization does not initialize after uncertain discovery or invalid identity", async () => {
  for (const project of ["example", "invalid name"]) {
    const calls: (readonly string[])[] = [];
    await expect(
      ensureProjectGit(
        { path: "/virtual", project, createGit: true },
        {
          canonicalize: async (path) => path,
          run: async (input) => {
            calls.push(input.command);
            return { exitCode: 128, stdout: "", stderr: "permission denied" };
          },
        },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(
      calls.some(
        (command) => command.includes("init") || command.includes("remote"),
      ),
    ).toBe(false);
  }
});
