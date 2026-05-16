import { Context, Effect, Layer } from "effect"

import { RigRuntimeError } from "./errors.js"
import { runPlatformCommand } from "./provider-command-runner.js"

export interface RigGitUpstreamStatus {
  readonly upstream?: string
  readonly ahead: number
  readonly behind: number
}

export interface RigGitWorkspaceService {
  readonly currentBranch: (repoPath: string) => Effect.Effect<string, RigRuntimeError>
  readonly branchCommit: (repoPath: string, branch: string) => Effect.Effect<string, RigRuntimeError>
  readonly branchExists: (repoPath: string, branch: string) => Effect.Effect<boolean, RigRuntimeError>
  readonly upstreamStatus: (repoPath: string, branch: string) => Effect.Effect<RigGitUpstreamStatus, RigRuntimeError>
}

export const RigGitWorkspace =
  Context.Service<RigGitWorkspaceService>("rig/rig/RigGitWorkspace")

const gitCommand = (repoPath: string, args: readonly string[]) =>
  runPlatformCommand(["git", "-C", repoPath, ...args])

const commandFailure = (
  message: string,
  hint: string,
  details: Readonly<Record<string, unknown>>,
  result: { readonly stderr: string; readonly stdout: string; readonly exitCode: number },
) =>
  new RigRuntimeError(message, hint, {
    ...details,
    exitCode: result.exitCode,
    stderr: result.stderr.trim(),
    stdout: result.stdout.trim(),
  })

const nonNegativeInteger = (value: string | undefined): number =>
  value && /^\d+$/.test(value) ? Number(value) : 0

export const RigGitWorkspaceLive = Layer.succeed(RigGitWorkspace, {
  currentBranch: (repoPath) =>
    Effect.gen(function* () {
      const result = yield* gitCommand(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]).pipe(
        Effect.catch(() => Effect.succeed({ stdout: "", stderr: "", exitCode: 1 })),
      )
      const branch = result.stdout.trim()
      if (result.exitCode === 0 && branch.length > 0) {
        return branch
      }
      return yield* Effect.fail(
        commandFailure(
          "Cannot deploy preview from detached HEAD.",
          "Check out a local Branch, or pass an explicit Branch such as 'rig deploy preview feature/name'.",
          { repoPath, reason: "detached-head" },
          result,
        ),
      )
    }),
  branchCommit: (repoPath, branch) =>
    Effect.gen(function* () {
      const result = yield* gitCommand(repoPath, ["rev-parse", "--verify", `${branch}^{commit}`]).pipe(
        Effect.catch(() => Effect.succeed({ stdout: "", stderr: "", exitCode: 1 })),
      )
      const commit = result.stdout.trim()
      if (result.exitCode === 0 && commit.length > 0) {
        return commit
      }
      return yield* Effect.fail(
        commandFailure(
          `Unable to resolve local Branch '${branch}'.`,
          "Create or check out the Branch locally before deploying it.",
          { repoPath, branch, reason: "branch-commit-not-found" },
          result,
        ),
      )
    }),
  branchExists: (repoPath, branch) =>
    Effect.gen(function* () {
      const result = yield* gitCommand(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).pipe(
        Effect.catch(() => Effect.succeed({ stdout: "", stderr: "", exitCode: 1 })),
      )
      return result.exitCode === 0
    }),
  upstreamStatus: (repoPath, branch) =>
    Effect.gen(function* () {
      const upstream = yield* gitCommand(repoPath, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]).pipe(
        Effect.catch(() => Effect.succeed({ stdout: "", stderr: "", exitCode: 1 })),
      )
      const upstreamName = upstream.exitCode === 0 ? upstream.stdout.trim() : ""
      if (upstreamName.length === 0) {
        return { ahead: 0, behind: 0 }
      }

      const counts = yield* gitCommand(repoPath, [
        "rev-list",
        "--left-right",
        "--count",
        `${branch}...${upstreamName}`,
      ]).pipe(
        Effect.catch(() => Effect.succeed({ stdout: "", stderr: "", exitCode: 1 })),
      )
      const [aheadRaw, behindRaw] = counts.stdout.trim().split(/\s+/)
      return {
        upstream: upstreamName,
        ahead: counts.exitCode === 0 ? nonNegativeInteger(aheadRaw) : 0,
        behind: counts.exitCode === 0 ? nonNegativeInteger(behindRaw) : 0,
      }
    }),
} satisfies RigGitWorkspaceService)
