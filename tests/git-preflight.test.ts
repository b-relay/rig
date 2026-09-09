import { expect, test } from "bun:test";
import { preflightDeployment } from "../src/git/preflight";
import type { CommandRunner } from "../src/providers/contracts";

test.each(["a".repeat(40), "b".repeat(64)])("CLI preflight preserves exact Commit identity and reports cached divergence without fetching (%s)", async (commit) => {
  const commands: string[][] = [];
  const run: CommandRunner = async (input) => {
    const args = [...input.command];
    commands.push(args);
    if (args.includes("check-ref-format"))
      return { exitCode: 0, stdout: "", stderr: "" };
    if (args.includes("show-ref"))
      return {
        exitCode: args.at(-1) === "refs/heads/origin/main" ? 1 : 0,
        stdout: "",
        stderr: "",
      };
    if (args.includes("rev-parse"))
      return { exitCode: 0, stdout: commit, stderr: "" };
    if (args.includes("for-each-ref"))
      return {
        exitCode: 0,
        stdout: "refs/remotes/upstream/main\n",
        stderr: "",
      };
    if (args.includes("rev-list"))
      return { exitCode: 0, stdout: "2\t3\n", stderr: "" };
    throw new Error("Unexpected command");
  };
  await expect(
    preflightDeployment(
      { repoPath: "/repo", branch: "origin/main", productionBranch: "main" },
      run,
    ),
  ).rejects.toMatchObject({ code: "GIT_LOCAL_BRANCH" });
  const result = await preflightDeployment(
    { repoPath: "/repo", branch: "main", productionBranch: "main" },
    run,
  );
  expect(result.commit).toBe(commit);
  expect(result.warnings.join(" ")).toContain("2 commits ahead");
  expect(result.warnings.join(" ")).toContain("3 commits behind");
  expect(commands.flat()).not.toContain("fetch");
});
