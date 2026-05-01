import { Effect } from "effect"

import type { V2DeploymentRecord } from "../deployments.js"
import { V2RuntimeError } from "../errors.js"
import type { V2ProviderPlugin } from "../provider-contracts.js"

export const sourceRepoPath = (
  deployment: V2DeploymentRecord,
  provider: V2ProviderPlugin,
  configured?: string,
): Effect.Effect<string, V2RuntimeError> => {
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
    new V2RuntimeError(
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
