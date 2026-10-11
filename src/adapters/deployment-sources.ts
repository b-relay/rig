import type { SourceStore } from "../providers/git-source-store";
import type { CommandRunner } from "../providers/contracts";
import type { DeploymentSources } from "../runtime/contracts";
import { preflightDeployment } from "../git/preflight";
import { RigError } from "../domain/errors";
import { isGitCommit } from "../domain/git";
/** A comparison of two Commits that could not be made; a deploy restarts the Service it was for. */
function diffFailure(message: string): RigError {
  return new RigError(
    "GIT_DIFF",
    message,
    "The deploy restarts the Service whose files it could not compare; nothing else is needed.",
  );
}
export function createDeploymentSources(
  store: SourceStore,
  run: CommandRunner,
): DeploymentSources {
  const git = async (repository: string, args: string[]) => {
    const result = await run({ command: ["git", ...args], cwd: repository });
    if (result.exitCode)
      throw new RigError(
        "GIT_SOURCE",
        "Unable to resolve the requested Git source.",
        "Check the repository and Branch or Commit.",
      );
    return result.stdout.trim();
  };
  return {
    preflight: (input) => preflightDeployment(input, run),
    prepare: (request) => store.prepare(request),
    release: (request) => store.release(request),
    async resolve(repository, ref) {
      if (ref.startsWith("-"))
        throw new RigError(
          "GIT_REF",
          "The Git reference is invalid.",
          "Choose a Branch or Commit.",
        );
      return await git(repository, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${ref}^{commit}`,
      ]);
    },
    async changed({ repository, from, to, paths }) {
      if (paths?.length === 0 || from === to) return false;
      if (!isGitCommit(from) || !isGitCommit(to))
        throw diffFailure("A Commit to compare is not a full Commit id.");
      // `glob` magic: `*` stays within one directory and `**` crosses them, as the watch setting documents.
      const result = await run({
        command: [
          "git",
          "diff",
          "--quiet",
          "--no-ext-diff",
          "--no-textconv",
          from,
          to,
          "--",
          ...(paths ?? []).map((path) => `:(glob)${path}`),
        ],
        cwd: repository,
      });
      if (result.exitCode === 0) return false;
      if (result.exitCode === 1) return true;
      throw diffFailure(
        "Git could not compare the two Commits; one may no longer be in the repository.",
      );
    },
    async currentBranch(repository) {
      const result = await run({
        command: ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
        cwd: repository,
      });
      if (result.exitCode === 1)
        throw new RigError(
          "GIT_DETACHED",
          "The checkout has detached HEAD.",
          "Choose a named Branch explicitly.",
        );
      if (result.exitCode !== 0)
        throw new RigError(
          "GIT_SOURCE",
          "Unable to inspect the current Git Branch.",
          "Check the repository.",
        );
      return result.stdout.trim();
    },
  };
}
