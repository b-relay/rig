import { Effect, Layer } from "effect"

import {
  HealthChecker,
  type HealthCheckConfig,
  type HealthChecker as HealthCheckerService,
  type HealthResult,
} from "../interfaces/health-checker.js"
import { HealthCheckError } from "../schema/errors.js"

// ── Constants ───────────────────────────────────────────────────────────────

const SINGLE_CHECK_TIMEOUT_MS = 5_000

// ── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

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
    return Effect.gen(this, function* () {
      const deadline = Date.now() + timeout
      let lastResult: HealthResult | null = null

      while (Date.now() < deadline) {
        const result = yield* this.check(config)

        if (result.healthy) {
          return result
        }

        lastResult = result

        const remaining = deadline - Date.now()
        if (remaining > 0) {
          yield* Effect.promise(() => sleep(Math.min(interval, remaining)))
        }
      }

      return yield* Effect.fail(
        new HealthCheckError(
          config.service,
          config.target,
          timeout,
          lastResult?.message ?? null,
          `Health check for ${config.service} did not become healthy within ${timeout}ms.`,
          `Check ${config.target} manually. Review service logs for startup errors.`,
        ),
      )
    })
  }
}

export const HttpHealthCheckerLive = Layer.succeed(HealthChecker, new HttpHealthChecker())
