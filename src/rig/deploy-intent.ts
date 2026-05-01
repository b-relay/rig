import { Context, Effect, Layer } from "effect"

import type { RigProjectConfig } from "./config.js"
import { branchSlug } from "./deployments.js"
import { RigRuntimeError } from "./errors.js"
import { RigHomeConfigStore } from "./home-config.js"

export type RigDeploySource = "git-push" | "cli"
export type RigDeployTarget = "live" | "generated"
export type RigVersionBump = "patch" | "minor" | "major"

export interface RigDeployIntent {
  readonly source: RigDeploySource
  readonly project: string
  readonly stateRoot: string
  readonly ref: string
  readonly target: RigDeployTarget
  readonly lane: "live" | "deployment"
  readonly deploymentName?: string
  readonly version?: string
  readonly rollbackAnchor?: string
}

export interface RigGitPushDeployInput {
  readonly project: string
  readonly stateRoot: string
  readonly ref: string
  readonly mainRef?: string
  readonly config?: RigProjectConfig
  readonly dirty?: boolean
  readonly staleRelease?: boolean
}

export interface RigCliDeployInput {
  readonly project: string
  readonly stateRoot: string
  readonly ref: string
  readonly target: RigDeployTarget
  readonly deploymentName?: string
  readonly config?: RigProjectConfig
  readonly dirty?: boolean
  readonly staleRelease?: boolean
}

export interface RigBumpInput {
  readonly project: string
  readonly currentVersion: string
  readonly bump?: RigVersionBump
  readonly set?: string
}

export interface RigBumpMetadata {
  readonly project: string
  readonly previousVersion: string
  readonly nextVersion: string
  readonly tag: string
  readonly rollbackAnchor: string
}

export interface RigDeployIntentsService {
  readonly fromGitPush: (input: RigGitPushDeployInput) => Effect.Effect<RigDeployIntent, RigRuntimeError>
  readonly fromCliDeploy: (input: RigCliDeployInput) => Effect.Effect<RigDeployIntent, RigRuntimeError>
  readonly bump: (input: RigBumpInput) => Effect.Effect<RigBumpMetadata, RigRuntimeError>
}

export const RigDeployIntents =
  Context.Service<RigDeployIntentsService>("rig/rig/RigDeployIntents")

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/

const edgeCaseError = (
  reason: "dirty" | "stale-release",
  project: string,
  ref: string,
): RigRuntimeError =>
  reason === "dirty"
    ? new RigRuntimeError(
      `Cannot create deploy intent for dirty ref '${ref}'.`,
      "Commit or stash local changes before deploying this ref.",
      { project, ref, reason },
    )
    : new RigRuntimeError(
      `Cannot create deploy intent from stale release state for '${ref}'.`,
      "Refresh release metadata or choose an explicit rollback anchor before deploying.",
      { project, ref, reason },
    )

const validateDeployEdges = (input: {
  readonly project: string
  readonly ref: string
  readonly dirty?: boolean
  readonly staleRelease?: boolean
}): Effect.Effect<void, RigRuntimeError> => {
  if (input.dirty) {
    return Effect.fail(edgeCaseError("dirty", input.project, input.ref))
  }
  if (input.staleRelease) {
    return Effect.fail(edgeCaseError("stale-release", input.project, input.ref))
  }
  return Effect.void
}

const semverError = (version: string): RigRuntimeError =>
  new RigRuntimeError(
    `Invalid semantic version '${version}'.`,
    "Use MAJOR.MINOR.PATCH, for example 1.2.3.",
    { version },
  )

const parseSemver = (version: string): Effect.Effect<readonly [number, number, number], RigRuntimeError> => {
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
  bump: RigVersionBump,
): Effect.Effect<string, RigRuntimeError> =>
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

export const RigDeployIntentsLive = Layer.effect(
  RigDeployIntents,
  Effect.gen(function* () {
    const homeConfigStore = yield* RigHomeConfigStore

    const generatedIntent = (
      source: RigDeploySource,
      input: {
        readonly project: string
        readonly stateRoot: string
        readonly ref: string
        readonly deploymentName?: string
        readonly config?: RigProjectConfig
      },
    ) =>
      Effect.succeed({
        source,
        project: input.project,
        stateRoot: input.stateRoot,
        ref: input.ref,
        target: "generated",
        lane: "deployment",
        deploymentName: branchSlug(input.deploymentName ?? input.ref),
      } satisfies RigDeployIntent)

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
                } satisfies RigDeployIntent
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
              } satisfies RigDeployIntent)
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
          } satisfies RigBumpMetadata
        }),
    } satisfies RigDeployIntentsService
  }),
)
