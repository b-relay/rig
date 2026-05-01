import { dirname } from "node:path"
import { Effect } from "effect"

import type { V2DeploymentRecord } from "../deployments.js"
import {
  platformMakeDirectory,
  platformRemove,
} from "../effect-platform.js"
import { V2RuntimeError } from "../errors.js"
import type {
  V2ProviderPlugin,
  V2ProviderPluginForFamily,
} from "../provider-contracts.js"
import { sourceRepoPath } from "./source-repo.js"

export interface V2GitWorktreeCommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export type V2GitWorktreeCommandRunner = (args: readonly string[]) => Promise<V2GitWorktreeCommandResult>

export interface V2GitWorktreeMaterializerOptions {
  readonly sourceRepoPath?: string
  readonly runCommand?: V2GitWorktreeCommandRunner
}

export interface V2GitWorktreeMaterializerAdapter {
  readonly materialize: (
    input: {
      readonly deployment: V2DeploymentRecord
      readonly ref: string
    },
    selected: V2ProviderPluginForFamily<"workspace-materializer">,
  ) => Effect.Effect<string, V2RuntimeError>
  readonly remove: (
    input: {
      readonly deployment: V2DeploymentRecord
    },
    selected: V2ProviderPluginForFamily<"workspace-materializer">,
  ) => Effect.Effect<string, V2RuntimeError>
}

export const gitWorktreeMaterializerProvider = {
  id: "git-worktree",
  family: "workspace-materializer",
  source: "first-party",
  displayName: "Git Worktree",
  capabilities: ["branch-workspace", "generated-deployment"],
} satisfies V2ProviderPlugin

const missingWorktree = (stderr: string): boolean => {
  const normalized = stderr.toLowerCase()
  return normalized.includes("is not a working tree") ||
    normalized.includes("not a working tree") ||
    normalized.includes("no such file") ||
    normalized.includes("does not exist")
}

export const createGitWorktreeMaterializerAdapter = (
  options: V2GitWorktreeMaterializerOptions | undefined,
  defaultCommandRunner: V2GitWorktreeCommandRunner,
): V2GitWorktreeMaterializerAdapter => {
  const runGit = options?.runCommand ?? defaultCommandRunner

  const materialize = (input: {
    readonly deployment: V2DeploymentRecord
    readonly ref: string
  }, selected: V2ProviderPluginForFamily<"workspace-materializer">): Effect.Effect<string, V2RuntimeError> =>
    Effect.gen(function* () {
      const repoPath = yield* sourceRepoPath(input.deployment, selected, options?.sourceRepoPath)
      const workspacePath = input.deployment.workspacePath
      yield* Effect.tryPromise({
        try: async () => {
          await Effect.runPromise(platformMakeDirectory(dirname(workspacePath)))
          const removeResult = await runGit(["git", "-C", repoPath, "worktree", "remove", "--force", workspacePath])
          if (removeResult.exitCode !== 0 && !missingWorktree(removeResult.stderr)) {
            throw new V2RuntimeError(
              `Unable to remove existing workspace '${input.deployment.name}'.`,
              "Inspect the generated deployment workspace and retry the deploy.",
              {
                providerId: selected.id,
                repoPath,
                workspacePath,
                stderr: removeResult.stderr,
              },
            )
          }

          const addResult = await runGit([
            "git",
            "-C",
            repoPath,
            "worktree",
            "add",
            "--force",
            "--detach",
            workspacePath,
            input.ref,
          ])
          if (addResult.exitCode !== 0) {
            throw new V2RuntimeError(
              `Unable to materialize workspace '${input.deployment.name}' at ref '${input.ref}'.`,
              "Ensure the ref exists in the source repository and retry the deploy.",
              {
                providerId: selected.id,
                repoPath,
                workspacePath,
                ref: input.ref,
                stderr: addResult.stderr,
              },
            )
          }
        },
        catch: (cause) =>
          cause instanceof V2RuntimeError
            ? cause
            : new V2RuntimeError(
              `Unable to materialize workspace '${input.deployment.name}'.`,
              "Ensure the source repository and v2 workspace directory are writable.",
              {
                providerId: selected.id,
                repoPath,
                workspacePath,
                ref: input.ref,
                cause: cause instanceof Error ? cause.message : String(cause),
              },
            ),
      })

      return `${selected.family}:${selected.id}:materialize:${workspacePath}:${input.ref}`
    })

  const remove = (input: {
    readonly deployment: V2DeploymentRecord
  }, selected: V2ProviderPluginForFamily<"workspace-materializer">): Effect.Effect<string, V2RuntimeError> =>
    Effect.gen(function* () {
      const repoPath = yield* sourceRepoPath(input.deployment, selected, options?.sourceRepoPath)
      const workspacePath = input.deployment.workspacePath
      yield* Effect.tryPromise({
        try: async () => {
          const result = await runGit(["git", "-C", repoPath, "worktree", "remove", "--force", workspacePath])
          if (result.exitCode !== 0 && !missingWorktree(result.stderr)) {
            throw new V2RuntimeError(
              `Unable to remove workspace '${input.deployment.name}'.`,
              "Inspect the generated deployment workspace and retry teardown.",
              {
                providerId: selected.id,
                repoPath,
                workspacePath,
                stderr: result.stderr,
              },
            )
          }
          await Effect.runPromise(platformRemove(workspacePath, { recursive: true, force: true }))
        },
        catch: (cause) =>
          cause instanceof V2RuntimeError
            ? cause
            : new V2RuntimeError(
              `Unable to remove workspace '${input.deployment.name}'.`,
              "Ensure the v2 workspace path is writable and retry teardown.",
              {
                providerId: selected.id,
                repoPath,
                workspacePath,
                cause: cause instanceof Error ? cause.message : String(cause),
              },
            ),
      })

      return `${selected.family}:${selected.id}:remove:${workspacePath}`
    })

  return { materialize, remove }
}
