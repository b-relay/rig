import type { SourceStore } from "../providers/git-source-store";
import type { CommandRunner } from "../providers/contracts";
import type { DeploymentSources } from "../runtime/contracts";
import { preflightDeployment } from "../git/preflight";
import { RigError } from "../domain/errors";
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
