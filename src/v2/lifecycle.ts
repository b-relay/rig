import { Context, Effect, Layer } from "effect-v4"

import { V2Rigd } from "./rigd.js"
import { V2Logger } from "./services.js"

export type V2LifecycleAction = "up" | "down" | "logs" | "status"
export type V2LifecycleLane = "local" | "live"

export interface V2LifecycleRequest {
  readonly action: V2LifecycleAction
  readonly project: string
  readonly lane: V2LifecycleLane
  readonly stateRoot: string
  readonly follow?: boolean
  readonly lines?: number
}

export interface V2LifecycleService {
  readonly run: (request: V2LifecycleRequest) => Effect.Effect<void>
}

export const V2Lifecycle = Context.Service<V2LifecycleService>("rig/v2/V2Lifecycle")

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
            })
            yield* logger.info("rig2 runtime status", status)
            return
          }

          const receipt = yield* rigd.lifecycle({
            action: request.action,
            project: request.project,
            lane: request.lane,
            stateRoot: request.stateRoot,
          })
          yield* logger.info("rig2 lifecycle accepted", receipt)
        }),
    } satisfies V2LifecycleService
  }),
)
