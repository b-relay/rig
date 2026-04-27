import { Context, Effect } from "effect-v3"
import type { HealthCheckError } from "../schema/errors.js"

export interface HealthCheckConfig {
  readonly type: "http" | "command"
  readonly target: string
  readonly service: string
}

export interface HealthResult {
  readonly healthy: boolean
  readonly responseTime: number | null
  readonly statusCode: number | null
  readonly message: string | null
}

export interface HealthChecker {
  readonly check: (
    config: HealthCheckConfig
  ) => Effect.Effect<HealthResult, HealthCheckError>
  readonly poll: (
    config: HealthCheckConfig,
    interval: number,
    timeout: number
  ) => Effect.Effect<HealthResult, HealthCheckError>
}

export const HealthChecker = Context.GenericTag<HealthChecker>("HealthChecker")
