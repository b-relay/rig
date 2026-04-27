import { Context, Effect, Layer } from "effect-v4"

import type { V2ProjectConfig } from "./config.js"
import {
  branchSlug,
  V2DeploymentManager,
  type V2DeploymentRecord,
} from "./deployments.js"
import { V2RuntimeError } from "./errors.js"
import { V2HomeConfigStore, type V2HomeConfig } from "./home-config.js"

export type V2DeploySource = "git-push" | "cli"
export type V2DeployTarget = "live" | "generated"
export type V2VersionBump = "patch" | "minor" | "major"

export interface V2DeployIntent {
  readonly source: V2DeploySource
  readonly project: string
  readonly stateRoot: string
  readonly ref: string
  readonly target: V2DeployTarget
  readonly lane: "live" | "deployment"
  readonly deploymentName?: string
  readonly generatedDeployment?: V2DeploymentRecord
  readonly version?: string
  readonly rollbackAnchor?: string
}

export interface V2GitPushDeployInput {
  readonly project: string
  readonly stateRoot: string
  readonly ref: string
  readonly mainRef?: string
  readonly config?: V2ProjectConfig
  readonly dirty?: boolean
  readonly staleRelease?: boolean
}

export interface V2CliDeployInput {
  readonly project: string
  readonly stateRoot: string
  readonly ref: string
  readonly target: V2DeployTarget
  readonly deploymentName?: string
  readonly config?: V2ProjectConfig
  readonly dirty?: boolean
  readonly staleRelease?: boolean
}

export interface V2BumpInput {
  readonly project: string
  readonly currentVersion: string
  readonly bump?: V2VersionBump
  readonly set?: string
}

export interface V2BumpMetadata {
  readonly project: string
  readonly previousVersion: string
  readonly nextVersion: string
  readonly tag: string
  readonly rollbackAnchor: string
}

export interface V2DeployIntentsService {
  readonly fromGitPush: (input: V2GitPushDeployInput) => Effect.Effect<V2DeployIntent, V2RuntimeError>
  readonly fromCliDeploy: (input: V2CliDeployInput) => Effect.Effect<V2DeployIntent, V2RuntimeError>
  readonly bump: (input: V2BumpInput) => Effect.Effect<V2BumpMetadata, V2RuntimeError>
}

export const V2DeployIntents =
  Context.Service<V2DeployIntentsService>("rig/v2/V2DeployIntents")

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/

const edgeCaseError = (
  reason: "dirty" | "stale-release",
  project: string,
  ref: string,
): V2RuntimeError =>
  reason === "dirty"
    ? new V2RuntimeError(
      `Cannot create deploy intent for dirty ref '${ref}'.`,
      "Commit or stash local changes before deploying this ref.",
      { project, ref, reason },
    )
    : new V2RuntimeError(
      `Cannot create deploy intent from stale release state for '${ref}'.`,
      "Refresh release metadata or choose an explicit rollback anchor before deploying.",
      { project, ref, reason },
    )

const validateDeployEdges = (input: {
  readonly project: string
  readonly ref: string
  readonly dirty?: boolean
  readonly staleRelease?: boolean
}): Effect.Effect<void, V2RuntimeError> => {
  if (input.dirty) {
    return Effect.fail(edgeCaseError("dirty", input.project, input.ref))
  }
  if (input.staleRelease) {
    return Effect.fail(edgeCaseError("stale-release", input.project, input.ref))
  }
  return Effect.void
}

const semverError = (version: string): V2RuntimeError =>
  new V2RuntimeError(
    `Invalid semantic version '${version}'.`,
    "Use MAJOR.MINOR.PATCH, for example 1.2.3.",
    { version },
  )

const parseSemver = (version: string): Effect.Effect<readonly [number, number, number], V2RuntimeError> => {
  const match = SEMVER_RE.exec(version)
  if (!match) {
    return Effect.fail(semverError(version))
  }

  return Effect.succeed([
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ] as const)
}

const incrementVersion = (
  current: string,
  bump: V2VersionBump,
): Effect.Effect<string, V2RuntimeError> =>
  parseSemver(current).pipe(
    Effect.map(([major, minor, patch]) => {
      if (bump === "major") {
        return `${major + 1}.0.0`
      }
      if (bump === "minor") {
        return `${major}.${minor + 1}.0`
      }
      return `${major}.${minor}.${patch + 1}`
    }),
  )

const maybeMaterializeGenerated = (
  deployments: V2DeploymentManager,
  input: {
    readonly project: string
    readonly stateRoot: string
    readonly ref: string
    readonly deploymentName?: string
    readonly config?: V2ProjectConfig
  },
): Effect.Effect<V2DeploymentRecord | undefined, V2RuntimeError> => {
  if (!input.config) {
    return Effect.succeed(undefined)
  }

  return deployments.materializeGenerated({
    config: input.config,
    stateRoot: input.stateRoot,
    branch: input.ref,
    ...(input.deploymentName ? { name: input.deploymentName } : {}),
  })
}

const enforceGeneratedDeploymentCap = (
  deployments: V2DeploymentManager,
  input: {
    readonly project: string
    readonly stateRoot: string
    readonly ref: string
    readonly deploymentName?: string
    readonly config?: V2ProjectConfig
  },
  homeConfig: V2HomeConfig,
): Effect.Effect<void, V2RuntimeError> => {
  if (!input.config) {
    return Effect.void
  }

  return Effect.gen(function* () {
    const requestedDeployment = branchSlug(input.deploymentName ?? input.ref)
    const inventory = yield* deployments.list({
      config: input.config,
      stateRoot: input.stateRoot,
    })
    const generated = inventory.filter((deployment) => deployment.kind === "generated")
    const existing = generated.find((deployment) => deployment.name === requestedDeployment)

    if (existing || generated.length < homeConfig.deploy.generated.maxActive) {
      return
    }

    if (homeConfig.deploy.generated.replacePolicy === "reject") {
      return yield* Effect.fail(
        new V2RuntimeError(
          `Generated deployment cap reached for '${input.project}'.`,
          "Destroy an existing generated deployment or raise deploy.generated.maxActive in the home rig config.",
          {
            reason: "generated-deployment-cap-reached",
            project: input.project,
            maxActive: homeConfig.deploy.generated.maxActive,
            replacePolicy: homeConfig.deploy.generated.replacePolicy,
            requestedDeployment,
            activeDeployments: generated.map((deployment) => deployment.name),
          },
        ),
      )
    }

    const oldest = generated[0]
    if (oldest) {
      yield* deployments.destroyGenerated({
        config: input.config,
        stateRoot: input.stateRoot,
        name: oldest.name,
      })
    }
  })
}

export const V2DeployIntentsLive = Layer.effect(
  V2DeployIntents,
  Effect.gen(function* () {
    const deployments = yield* V2DeploymentManager
    const homeConfigStore = yield* V2HomeConfigStore

    const generatedIntent = (
      source: V2DeploySource,
      input: {
        readonly project: string
        readonly stateRoot: string
        readonly ref: string
        readonly deploymentName?: string
        readonly config?: V2ProjectConfig
      },
    ) =>
      Effect.gen(function* () {
        const homeConfig = yield* homeConfigStore.read({ stateRoot: input.stateRoot })
        yield* enforceGeneratedDeploymentCap(deployments, input, homeConfig)
        const generatedDeployment = yield* maybeMaterializeGenerated(deployments, input)
        const deploymentName =
          input.deploymentName ?? generatedDeployment?.name ?? branchSlug(input.ref)
        return {
          source,
          project: input.project,
          stateRoot: input.stateRoot,
          ref: input.ref,
          target: "generated",
          lane: "deployment",
          deploymentName,
          ...(generatedDeployment ? { generatedDeployment } : {}),
        } satisfies V2DeployIntent
      })

    return {
      fromGitPush: (input) =>
        validateDeployEdges(input).pipe(
          Effect.flatMap(() =>
            Effect.gen(function* () {
              const homeConfig = yield* homeConfigStore.read({ stateRoot: input.stateRoot })
              const productionBranch =
                input.mainRef ?? input.config?.live?.deployBranch ?? homeConfig.deploy.productionBranch

              if (input.ref === productionBranch) {
                return {
                  source: "git-push",
                  project: input.project,
                  stateRoot: input.stateRoot,
                  ref: input.ref,
                  target: "live",
                  lane: "live",
                } satisfies V2DeployIntent
              }

              return yield* generatedIntent("git-push", input)
            }),
          ),
        ),
      fromCliDeploy: (input) =>
        validateDeployEdges(input).pipe(
          Effect.flatMap(() => {
            if (input.target === "live") {
              return Effect.succeed({
                source: "cli",
                project: input.project,
                stateRoot: input.stateRoot,
                ref: input.ref,
                target: "live",
                lane: "live",
              } satisfies V2DeployIntent)
            }

            return generatedIntent("cli", input)
          }),
        ),
      bump: (input) =>
        Effect.gen(function* () {
          const nextVersion = input.set
            ? yield* parseSemver(input.set).pipe(Effect.as(input.set))
            : yield* incrementVersion(input.currentVersion, input.bump ?? "patch")

          return {
            project: input.project,
            previousVersion: input.currentVersion,
            nextVersion,
            tag: `v${nextVersion}`,
            rollbackAnchor: `v${input.currentVersion}`,
          } satisfies V2BumpMetadata
        }),
    } satisfies V2DeployIntentsService
  }),
)
