import { Effect, Layer } from "effect"

import { Git, type Git as GitService } from "../interfaces/git.js"
import { GitError, MainBranchDetectionError } from "../schema/errors.js"

type GitCommandResult = {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const createGitError = (
  operation: string,
  repoPath: string,
  exitCode: number | null,
  stderr: string,
  hint: string,
): GitError =>
  new GitError(
    operation,
    repoPath,
    exitCode,
    stderr,
    `Git ${operation} failed.`,
    hint,
  )

const parseChangedPath = (line: string): string => {
  const rawPath = line.slice(3).trim()
  const renamed = rawPath.split(" -> ")
  return renamed.at(-1) ?? rawPath
}

export class BunGit implements GitService {
  detectMainBranch(repoPath: string): Effect.Effect<string, MainBranchDetectionError | GitError> {
    const tryRemoteHead = this.runGitExpectingSuccess(
      repoPath,
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      "detectMainBranch",
      "Ensure the repository has an origin remote and that origin/HEAD is configured.",
    ).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.flatMap((ref) => {
        const prefix = "refs/remotes/origin/"
        if (ref.startsWith(prefix) && ref.length > prefix.length) {
          return Effect.succeed(ref.slice(prefix.length))
        }

        return Effect.fail(
          createGitError(
            "detectMainBranch",
            repoPath,
            null,
            `Unexpected origin/HEAD ref format: '${ref || "<empty>"}'.`,
            "Ensure origin/HEAD points to a branch like refs/remotes/origin/main.",
          ),
        )
      }),
    )

    const tryConvention = Effect.gen(this, function* () {
      if (yield* this.branchExists(repoPath, "main")) {
        return "main"
      }

      if (yield* this.branchExists(repoPath, "master")) {
        return "master"
      }

      return yield* Effect.fail(
        new MainBranchDetectionError(
          repoPath,
          ["remote-head", "convention"],
          "Could not detect main branch.",
          'Set "mainBranch" in rig.json or create a main/master branch.',
        ),
      )
    })

    return tryRemoteHead.pipe(
      Effect.catchAll((error) =>
        error instanceof GitError ? tryConvention : Effect.fail(error),
      ),
    )
  }

  isDirty(repoPath: string): Effect.Effect<boolean, GitError> {
    return this.runGitExpectingSuccess(
      repoPath,
      ["status", "--porcelain"],
      "isDirty",
      "Ensure the repository path is valid and readable.",
    ).pipe(Effect.map((result) => result.stdout.trim().length > 0))
  }

  currentBranch(repoPath: string): Effect.Effect<string, GitError> {
    return this.runGitExpectingSuccess(
      repoPath,
      ["rev-parse", "--abbrev-ref", "HEAD"],
      "currentBranch",
      "Ensure HEAD points to a valid branch or commit.",
    ).pipe(Effect.map((result) => result.stdout.trim()))
  }

  commitHash(repoPath: string, ref = "HEAD"): Effect.Effect<string, GitError> {
    return this.runGitExpectingSuccess(
      repoPath,
      ["rev-parse", ref],
      "commitHash",
      `Ensure '${ref}' resolves to a valid commit in this repository.`,
    ).pipe(Effect.map((result) => result.stdout.trim()))
  }

  changedFiles(repoPath: string): Effect.Effect<readonly string[], GitError> {
    return this.runGitExpectingSuccess(
      repoPath,
      ["status", "--porcelain"],
      "changedFiles",
      "Ensure the repository path is valid and readable.",
    ).pipe(
      Effect.map((result) =>
        result.stdout
          .split("\n")
          .map((line) => line.trimEnd())
          .filter((line) => line.length > 0)
          .map(parseChangedPath),
      ),
    )
  }

  createTag(repoPath: string, tag: string): Effect.Effect<void, GitError> {
    return this.runGitExpectingSuccess(
      repoPath,
      ["tag", "-a", tag, "-m", `rig ${tag}`],
      "createTag",
      `Ensure tag '${tag}' is valid and does not already exist.`,
    ).pipe(Effect.asVoid)
  }

  deleteTag(repoPath: string, tag: string): Effect.Effect<void, GitError> {
    return this.runGitExpectingSuccess(
      repoPath,
      ["tag", "-d", tag],
      "deleteTag",
      `Ensure tag '${tag}' exists before deletion.`,
    ).pipe(Effect.asVoid)
  }

  tagExists(repoPath: string, tag: string): Effect.Effect<boolean, GitError> {
    return this.runGit(repoPath, ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]).pipe(
      Effect.flatMap((result) => {
        if (result.exitCode === 0) {
          return Effect.succeed(true)
        }

        if (result.exitCode === 1) {
          return Effect.succeed(false)
        }

        return Effect.fail(
          createGitError(
            "tagExists",
            repoPath,
            result.exitCode,
            result.stderr.trim(),
            `Unable to verify whether tag '${tag}' exists.`,
          ),
        )
      }),
    )
  }

  commitHasTag(repoPath: string, commit: string): Effect.Effect<string | null, GitError> {
    return this.runGitExpectingSuccess(
      repoPath,
      ["tag", "--points-at", commit],
      "commitHasTag",
      `Ensure commit '${commit}' resolves to an existing commit.`,
    ).pipe(
      Effect.map((result) => {
        const tags = result.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)

        return tags[0] ?? null
      }),
    )
  }

  createWorktree(repoPath: string, dest: string, ref: string): Effect.Effect<void, GitError> {
    return this.runGitExpectingSuccess(
      repoPath,
      ["worktree", "add", "--detach", dest, ref],
      "createWorktree",
      `Ensure '${ref}' is valid and '${dest}' is writable.`,
    ).pipe(Effect.asVoid)
  }

  removeWorktree(repoPath: string, dest: string): Effect.Effect<void, GitError> {
    return this.runGitExpectingSuccess(
      repoPath,
      ["worktree", "remove", "--force", dest],
      "removeWorktree",
      `Ensure '${dest}' is an existing git worktree path.`,
    ).pipe(Effect.asVoid)
  }

  private branchExists(repoPath: string, branch: string): Effect.Effect<boolean, GitError> {
    return this.runGit(
      repoPath,
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    ).pipe(
      Effect.flatMap((result) => {
        if (result.exitCode === 0) {
          return Effect.succeed(true)
        }

        if (result.exitCode === 1) {
          return Effect.succeed(false)
        }

        return Effect.fail(
          createGitError(
            "detectMainBranch",
            repoPath,
            result.exitCode,
            result.stderr.trim(),
            `Unable to verify whether branch '${branch}' exists.`,
          ),
        )
      }),
    )
  }

  private runGitExpectingSuccess(
    repoPath: string,
    args: readonly string[],
    operation: string,
    hint: string,
  ): Effect.Effect<GitCommandResult, GitError> {
    return this.runGit(repoPath, args).pipe(
      Effect.flatMap((result) => {
        if (result.exitCode === 0) {
          return Effect.succeed(result)
        }

        return Effect.fail(
          createGitError(
            operation,
            repoPath,
            result.exitCode,
            result.stderr.trim(),
            hint,
          ),
        )
      }),
    )
  }

  private runGit(repoPath: string, args: readonly string[]): Effect.Effect<GitCommandResult, GitError> {
    return Effect.tryPromise({
      try: async () => {
        const child = Bun.spawn(["git", ...args], {
          cwd: repoPath,
          stdout: "pipe",
          stderr: "pipe",
        })

        const [stdout, stderr, exitCode] = await Promise.all([
          child.stdout ? new Response(child.stdout).text() : Promise.resolve(""),
          child.stderr ? new Response(child.stderr).text() : Promise.resolve(""),
          child.exited,
        ])

        return {
          stdout,
          stderr,
          exitCode,
        }
      },
      catch: (cause) =>
        createGitError(
          "run",
          repoPath,
          null,
          causeMessage(cause),
          "Ensure git is installed and the repository path is valid.",
        ),
    })
  }
}

export const BunGitLive = Layer.succeed(Git, new BunGit())
