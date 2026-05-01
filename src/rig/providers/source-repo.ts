import { Effect } from "effect"

import type { RigDeploymentRecord } from "../deployments.js"
import { RigRuntimeError } from "../errors.js"
import type { RigProviderPlugin } from "../provider-contracts.js"

export const sourceRepoPath = (
  deployment: RigDeploymentRecord,
  provider: RigProviderPlugin,
  configured?: string,
): Effect.Effect<string, RigRuntimeError> => {
  if (configured && configured.trim().length > 0) {
    return Effect.succeed(configured)
  }

  const maybeResolvedRepoPath = (deployment.resolved as { readonly sourceRepoPath?: unknown }).sourceRepoPath
  if (typeof maybeResolvedRepoPath === "string" && maybeResolvedRepoPath.trim().length > 0) {
    return Effect.succeed(maybeResolvedRepoPath)
  }

  const maybeRepoPath = (deployment.resolved.v1Config as { readonly repoPath?: unknown } | undefined)?.repoPath
  if (typeof maybeRepoPath === "string" && maybeRepoPath.trim().length > 0) {
    return Effect.succeed(maybeRepoPath)
  }

  return Effect.fail(
    new RigRuntimeError(
      `Unable to resolve source repo for deployment '${deployment.name}'.`,
      "Run from a managed repo or pass a config path that preserves the source repository before deploying.",
      {
        providerId: provider.id,
        deployment: deployment.name,
        workspacePath: deployment.workspacePath,
      },
    ),
  )
}
