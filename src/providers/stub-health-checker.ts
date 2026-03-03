import { Effect, Layer } from "effect"

import { HealthChecker, type HealthCheckConfig, type HealthChecker as HealthCheckerService, type HealthResult } from "../interfaces/health-checker.js"
import type { HealthCheckError } from "../schema/errors.js"

const healthyResult = (config: HealthCheckConfig): HealthResult => ({
  healthy: true,
  responseTime: 0,
  statusCode: config.type === "http" ? 200 : null,
  message: "ok",
})

export class StubHealthChecker implements HealthCheckerService {
  check(config: HealthCheckConfig): Effect.Effect<HealthResult, HealthCheckError> {
    return Effect.succeed(healthyResult(config))
  }

  poll(config: HealthCheckConfig, _interval: number, _timeout: number): Effect.Effect<HealthResult, HealthCheckError> {
    return Effect.succeed(healthyResult(config))
  }
}

export const StubHealthCheckerLive = Layer.succeed(HealthChecker, new StubHealthChecker())
