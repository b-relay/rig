import { Effect, Layer } from "effect"

import { HealthChecker, type HealthCheckConfig, type HealthChecker as HealthCheckerService, type HealthResult } from "../interfaces/health-checker.js"
import { HealthCheckError } from "../schema/errors.js"

const healthyResult = (config: HealthCheckConfig): HealthResult => ({
  healthy: true,
  responseTime: 0,
  statusCode: config.type === "http" ? 200 : null,
  message: "ok",
})

interface StubHealthCheckerOptions {
  readonly checkFailures?: Readonly<Record<string, HealthCheckError>>
  readonly pollFailures?: Readonly<Record<string, HealthCheckError>>
  readonly checkResults?: Readonly<Record<string, HealthResult>>
  readonly pollResults?: Readonly<Record<string, HealthResult>>
}

export class StubHealthChecker implements HealthCheckerService {
  readonly checkCalls: HealthCheckConfig[] = []
  readonly pollCalls: Array<{ readonly config: HealthCheckConfig; readonly interval: number; readonly timeout: number }> = []

  constructor(private readonly options: StubHealthCheckerOptions = {}) {}

  check(config: HealthCheckConfig): Effect.Effect<HealthResult, HealthCheckError> {
    this.checkCalls.push(config)
    const failure = this.options.checkFailures?.[config.service]
    if (failure) {
      return Effect.fail(failure)
    }

    const result = this.options.checkResults?.[config.service]
    if (result) {
      return Effect.succeed(result)
    }

    return Effect.succeed(healthyResult(config))
  }

  poll(config: HealthCheckConfig, interval: number, timeout: number): Effect.Effect<HealthResult, HealthCheckError> {
    this.pollCalls.push({ config, interval, timeout })
    const failure = this.options.pollFailures?.[config.service]
    if (failure) {
      return Effect.fail(failure)
    }

    const result = this.options.pollResults?.[config.service]
    if (result) {
      return Effect.succeed(result)
    }

    return Effect.succeed(healthyResult(config))
  }
}

export const StubHealthCheckerLive = Layer.succeed(HealthChecker, new StubHealthChecker())
