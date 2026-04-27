import { Effect, Layer } from "effect-v3"

import {
  HealthChecker,
  type HealthCheckConfig,
  type HealthChecker as HealthCheckerService,
  type HealthResult,
} from "../interfaces/health-checker.js"
import { pollUntilHealthy } from "./health-poll.js"
import { HealthCheckError } from "../schema/errors.js"

// ── Constants ───────────────────────────────────────────────────────────────

const SINGLE_CHECK_TIMEOUT_MS = 5_000

// ── HttpHealthChecker ───────────────────────────────────────────────────────

export class HttpHealthChecker implements HealthCheckerService {
  check(config: HealthCheckConfig): Effect.Effect<HealthResult, HealthCheckError> {
    return Effect.tryPromise({
      try: async () => {
        const start = performance.now()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), SINGLE_CHECK_TIMEOUT_MS)

        try {
          const response = await fetch(config.target, {
            signal: controller.signal,
          })
          const responseTime = Math.round(performance.now() - start)
          const healthy = response.status >= 200 && response.status < 300

          return {
            healthy,
            responseTime,
            statusCode: response.status,
            message: healthy ? null : `HTTP ${response.status} ${response.statusText}`,
          } satisfies HealthResult
        } catch (err) {
          const responseTime = Math.round(performance.now() - start)
          const message =
            err instanceof Error ? err.message : String(err)

          return {
            healthy: false,
            responseTime,
            statusCode: null,
            message,
          } satisfies HealthResult
        } finally {
          clearTimeout(timer)
        }
      },
      catch: (err) =>
        new HealthCheckError(
          config.service,
          config.target,
          0,
          null,
          `Unexpected error during HTTP health check: ${err instanceof Error ? err.message : String(err)}`,
          "Check that the health check URL is valid and the service is reachable.",
        ),
    })
  }

  poll(
    config: HealthCheckConfig,
    interval: number,
    timeout: number,
  ): Effect.Effect<HealthResult, HealthCheckError> {
    return pollUntilHealthy(this, config, interval, timeout, (lastResult) =>
        new HealthCheckError(
          config.service,
          config.target,
          timeout,
          lastResult?.message ?? null,
          `Health check for ${config.service} did not become healthy within ${timeout}ms.`,
          `Check ${config.target} manually. Review service logs for startup errors.`,
        ),
    )
  }
}

export const HttpHealthCheckerLive = Layer.succeed(HealthChecker, new HttpHealthChecker())
