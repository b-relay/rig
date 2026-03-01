import { Context, Effect } from "effect"
import type { RigError } from "../schema/errors.js"

export interface Logger {
  readonly info: (message: string, details?: Record<string, unknown>) => Effect.Effect<void>
  readonly warn: (message: string, details?: Record<string, unknown>) => Effect.Effect<void>
  readonly error: (structured: RigError) => Effect.Effect<void>
  readonly success: (message: string, details?: Record<string, unknown>) => Effect.Effect<void>
  readonly table: (rows: readonly Record<string, unknown>[]) => Effect.Effect<void>
}

export const Logger = Context.GenericTag<Logger>("Logger")
