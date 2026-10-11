import type { SourceStore } from "../providers/git-source-store";
import type { CommandRunner } from "../providers/contracts";
import type { DeploymentSources } from "../runtime/contracts";
import { preflightDeployment } from "../git/preflight";
import { RigError } from "../domain/errors";
import { isGitCommit } from "../domain/git";
/** What a comparison of two trees always says, whatever the user's git config: no textconv filter, every submodule Commit
 * change (diff.ignoreSubmodules may hide them), and paths from the repository root (diff.relative). With --quiet only the
 * exit status is read, so settings that change how output looks (core.quotepath, diff.noprefix) cannot matter. */
const DIFF_OPTIONS = [
  "--no-textconv",
  "--ignore-submodules=none",
  "--no-relative",
] as const;
/** How long one comparison or listing of Commits may take; one that takes longer cannot tell, and the deploy restarts. */
const COMPARE_TIMEOUT_MS = 30_000;
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
          ...DIFF_OPTIONS,
          from,
          to,
          "--",
          ...(paths ?? []).map((path) => `:(glob)${path}`),
        ],
        cwd: repository,
        timeoutMs: COMPARE_TIMEOUT_MS,
      });
      if (result.exitCode === 0) return false;
      if (result.exitCode === 1) return true;
      throw diffFailure(
        "Git could not compare the two Commits; one may no longer be in the repository.",
      );
    },
    async unmatched({ repository, commit, paths }) {
      if (!isGitCommit(commit))
        throw diffFailure("The Commit to list is not a full Commit id.");
      if (!paths.length) return [];
      const listing = () =>
        diffFailure(
          "Git could not list the Commit's files; it may no longer be in the repository.",
        );
      // ls-tree takes no pathspec magic, so each entry is compared with the empty tree instead: a difference is a match.
      const empty = await run({
        command: ["git", "hash-object", "-t", "tree", "/dev/null"],
        cwd: repository,
        timeoutMs: COMPARE_TIMEOUT_MS,
      });
      const emptyTree = empty.stdout.trim();
      if (empty.exitCode !== 0 || !isGitCommit(emptyTree)) throw listing();
      const missing: string[] = [];
      for (const path of paths) {
        const result = await run({
          command: [
            "git",
            "diff",
            "--quiet",
            "--no-ext-diff",
            ...DIFF_OPTIONS,
            emptyTree,
            commit,
            "--",
            `:(glob)${path}`,
          ],
          cwd: repository,
          timeoutMs: COMPARE_TIMEOUT_MS,
        });
        if (result.exitCode === 0) missing.push(path);
        else if (result.exitCode !== 1) throw listing();
      }
      return missing;
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
