import { Context, Effect, Layer } from "effect"

import type { V2ProjectConfig } from "./config.js"
import { V2Rigd, type V2RigdHealthState } from "./rigd.js"
import { V2Logger } from "./services.js"

export type V2LifecycleAction = "up" | "down" | "logs" | "status"
export type V2LifecycleLane = "local" | "live"

export interface V2LifecycleRequest {
  readonly action: V2LifecycleAction
  readonly project: string
  readonly lane: V2LifecycleLane
  readonly stateRoot: string
  readonly config?: V2ProjectConfig
  readonly follow?: boolean
  readonly lines?: number
}

export interface V2LifecycleService {
  readonly run: (request: V2LifecycleRequest) => Effect.Effect<void>
}

export const V2Lifecycle = Context.Service<V2LifecycleService>("rig/v2/V2Lifecycle")

const summarizeFailure = (failure: V2RigdHealthState["managedServiceFailures"][number]): string => [
  `${failure.deployment}/${failure.component} crashed at ${failure.occurredAt} after ${failure.recentCrashCount} recent ${
    failure.recentCrashCount === 1 ? "crash" : "crashes"
  }`,
  ...(failure.exitCode === undefined ? [] : [`exit code ${failure.exitCode}`]),
  ...(failure.stderr ? [`stderr: ${failure.stderr}`] : []),
].join("; ")

const summarizeRuntimeStatus = (status: V2RigdHealthState) => ({
  ...status,
  summary: {
    desiredDeployments: status.desiredDeployments.map((deployment) =>
      `${deployment.name} (${deployment.kind}) is ${deployment.desiredStatus} since ${deployment.updatedAt}`
    ),
    managedServiceFailures: status.managedServiceFailures.map(summarizeFailure),
  },
})

export const V2LifecycleLive = Layer.effect(
  V2Lifecycle,
  Effect.gen(function* () {
    const logger = yield* V2Logger
    const rigd = yield* V2Rigd

    return {
      run: (request) =>
        Effect.gen(function* () {
          if (request.action === "logs") {
            const entries = yield* rigd.logs({
              project: request.project,
              stateRoot: request.stateRoot,
              lines: request.lines ?? 50,
            })
            yield* logger.info("rig2 logs", {
              project: request.project,
              lane: request.lane,
              follow: request.follow ?? false,
              entries,
            })
            return
          }

          if (request.action === "status") {
            const status = yield* rigd.healthState({
              project: request.project,
              stateRoot: request.stateRoot,
              ...(request.config ? { config: request.config } : {}),
            })
            yield* logger.info("rig2 runtime status", summarizeRuntimeStatus(status))
            return
          }

          const receipt = yield* rigd.lifecycle({
            action: request.action,
            project: request.project,
            lane: request.lane,
            stateRoot: request.stateRoot,
            ...(request.config ? { config: request.config } : {}),
          })
          yield* logger.info("rig2 lifecycle accepted", receipt)
        }),
    } satisfies V2LifecycleService
  }),
)
