import { RigError } from "../domain/errors";
import { isGitCommit } from "../domain/git";
import type { CommandRunner } from "../providers/contracts";

/** CLI deploy requires a local named Branch; upstream warnings inspect cached refs only. */
export async function preflightDeployment(
  input: { repoPath: string; branch: string; productionBranch: string },
  run: CommandRunner,
): Promise<{ commit: string; warnings: string[] }> {
  const ref = `refs/heads/${input.branch}`;
  const valid = await run({
    command: ["git", "check-ref-format", ref],
    cwd: input.repoPath,
  });
  const exists =
    valid.exitCode === 0
      ? await run({
          command: ["git", "show-ref", "--verify", "--quiet", ref],
          cwd: input.repoPath,
        })
      : undefined;
  if (!exists || exists.exitCode !== 0)
    throw new RigError(
      "GIT_LOCAL_BRANCH",
      `Branch '${input.branch}' does not exist locally.`,
      "Create or check out a local Branch before deploying it.",
    );
  const resolved = await run({
    command: [
      "git",
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ],
    cwd: input.repoPath,
  });
  const commit = resolved.stdout.trim();
  if (resolved.exitCode !== 0 || !isGitCommit(commit))
    throw new RigError(
      "GIT_COMMIT",
      "The Branch does not resolve to a Commit.",
      "Create a Commit before deploying.",
    );
  const tracking = await run({
    command: ["git", "for-each-ref", "--format=%(upstream)", ref],
    cwd: input.repoPath,
  });
  if (tracking.exitCode !== 0)
    throw new RigError(
      "GIT_UPSTREAM",
      "Unable to inspect upstream configuration.",
      "Check Git repository configuration before deploying.",
    );
  const upstream = tracking.stdout.trim();
  if (!upstream)
    return {
      commit,
      warnings:
        input.branch === input.productionBranch
          ? [`Production Branch '${input.branch}' has no configured upstream.`]
          : [],
    };
  const counts = await run({
    command: [
      "git",
      "rev-list",
      "--left-right",
      "--count",
      `${ref}...${upstream}`,
    ],
    cwd: input.repoPath,
  });
  if (counts.exitCode !== 0)
    return {
      commit,
      warnings: [
        `Cached upstream '${upstream}' is unavailable. Run git fetch to refresh it.`,
      ],
    };
  const parsed = /^(\d+)\s+(\d+)$/.exec(counts.stdout.trim());
  if (!parsed)
    throw new RigError(
      "GIT_UPSTREAM",
      "Git returned an invalid upstream comparison.",
      "Inspect local Git refs before deploying.",
    );
  const ahead = Number(parsed[1]),
    behind = Number(parsed[2]),
    warnings: string[] = [];
  if (ahead)
    warnings.push(
      `Branch '${input.branch}' is ${ahead} ${ahead === 1 ? "commit" : "commits"} ahead of '${upstream}'.`,
    );
  if (behind)
    warnings.push(
      `Branch '${input.branch}' is ${behind} ${behind === 1 ? "commit" : "commits"} behind '${upstream}'.`,
    );
  return { commit, warnings };
}
