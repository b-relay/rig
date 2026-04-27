import { Context, Effect, Layer } from "effect"

import { V2RuntimeError } from "./errors.js"

export type V2RigdActionKind = "lifecycle" | "deploy" | "destroy"

export interface V2RigdActionPreflightInput {
  readonly kind: V2RigdActionKind
  readonly project: string
  readonly stateRoot: string
  readonly target: string
}

export interface V2RigdActionPreflightService {
  readonly verify: (input: V2RigdActionPreflightInput) => Effect.Effect<void, V2RuntimeError>
}

export const V2RigdActionPreflight =
  Context.Service<V2RigdActionPreflightService>("rig/v2/V2RigdActionPreflight")

export const V2RigdActionPreflightLive = Layer.succeed(V2RigdActionPreflight, {
  verify: () => Effect.void,
} satisfies V2RigdActionPreflightService)
