import { Effect } from "effect"

import type { RigDeploymentRecord } from "../deployments.js"
import { RigRuntimeError } from "../errors.js"
import type {
  RigProviderPlugin,
  RigProviderPluginForFamily,
} from "../provider-contracts.js"
import { sourceRepoPath } from "./source-repo.js"

export interface RigLocalGitCommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export type RigLocalGitCommandRunner = (args: readonly string[]) => Promise<RigLocalGitCommandResult>

export interface RigLocalGitScmOptions {
  readonly sourceRepoPath?: string
  readonly runCommand?: RigLocalGitCommandRunner
}

export interface RigLocalGitScmAdapter {
  readonly checkout: (
    input: {
      readonly deployment: RigDeploymentRecord
      readonly ref: string
    },
    selected: RigProviderPluginForFamily<"scm">,
  ) => Effect.Effect<string, RigRuntimeError>
}

export const localGitScmProvider = {
  id: "local-git",
  family: "scm",
  source: "first-party",
  displayName: "Local Git",
  capabilities: ["ref-resolution", "rollback-anchor"],
} satisfies RigProviderPlugin

export const createLocalGitScmAdapter = (
  options: RigLocalGitScmOptions | undefined,
  defaultCommandRunner: RigLocalGitCommandRunner,
): RigLocalGitScmAdapter => {
  const runGit = options?.runCommand ?? defaultCommandRunner

  const checkout = (input: {
    readonly deployment: RigDeploymentRecord
    readonly ref: string
  }, selected: RigProviderPluginForFamily<"scm">): Effect.Effect<string, RigRuntimeError> =>
    Effect.gen(function* () {
      const repoPath = yield* sourceRepoPath(input.deployment, selected, options?.sourceRepoPath)
      const commit = yield* Effect.tryPromise({
        try: async () => {
          const fetchResult = await runGit(["git", "-C", repoPath, "fetch", "--prune", "origin"])
          if (fetchResult.exitCode !== 0) {
            throw new RigRuntimeError(
              `Unable to fetch refs for '${input.deployment.name}'.`,
              "Ensure the source repository has an origin remote and network access before retrying deploy.",
              {
                providerId: selected.id,
                repoPath,
                ref: input.ref,
                stderr: fetchResult.stderr,
              },
            )
          }

          const verifyResult = await runGit([
            "git",
            "-C",
            repoPath,
            "rev-parse",
            "--verify",
            `${input.ref}^{commit}`,
          ])
          if (verifyResult.exitCode !== 0) {
            throw new RigRuntimeError(
              `Unable to resolve deploy ref '${input.ref}'.`,
              "Push or fetch the ref into the source repository before retrying deploy.",
              {
                providerId: selected.id,
                repoPath,
                ref: input.ref,
                stderr: verifyResult.stderr,
              },
            )
          }

          return verifyResult.stdout.trim()
        },
        catch: (cause) =>
          cause instanceof RigRuntimeError
            ? cause
            : new RigRuntimeError(
              `Unable to prepare local git checkout for '${input.deployment.name}'.`,
              "Ensure git is installed and the source repository path is valid.",
              {
                providerId: selected.id,
                repoPath,
                ref: input.ref,
                cause: cause instanceof Error ? cause.message : String(cause),
              },
            ),
      })

      return `${selected.family}:${selected.id}:checkout:${input.ref}:${commit}`
    })

  return { checkout }
}
