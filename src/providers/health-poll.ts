import { Effect } from "effect-v3"

import type {
  HealthCheckConfig,
  HealthChecker as HealthCheckerService,
  HealthResult,
} from "../interfaces/health-checker.js"
import { HealthCheckError } from "../schema/errors.js"

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export const pollUntilHealthy = (
  checker: Pick<HealthCheckerService, "check">,
  config: HealthCheckConfig,
  interval: number,
  timeout: number,
  onTimeout: (lastResult: HealthResult | null) => HealthCheckError,
): Effect.Effect<HealthResult, HealthCheckError> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeout
    let lastResult: HealthResult | null = null

    while (Date.now() < deadline) {
      const result = yield* checker.check(config)

      if (result.healthy) {
        return result
      }

      lastResult = result

      const remaining = deadline - Date.now()
      if (remaining > 0) {
        yield* Effect.promise(() => sleep(Math.min(interval, remaining)))
      }
    }

    return yield* Effect.fail(onTimeout(lastResult))
  })
