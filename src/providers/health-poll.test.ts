import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import type {
  HealthCheckConfig,
  HealthChecker as HealthCheckerService,
  HealthResult,
} from "../interfaces/health-checker.js"
import { HealthCheckError } from "../schema/errors.js"
import { pollUntilHealthy } from "./health-poll.js"

const config: HealthCheckConfig = {
  type: "http",
  target: "http://127.0.0.1:3070/health",
  service: "api",
}

const timeoutError = (timeout: number) =>
  new HealthCheckError(
    config.service,
    config.target,
    timeout,
    null,
    `Health check timed out after ${timeout}ms.`,
    "Inspect service logs and health endpoint output.",
  )

const healthyResult: HealthResult = {
  healthy: true,
  responseTime: 1,
  statusCode: 200,
  message: null,
}

const unhealthyResult = (message: string): HealthResult => ({
  healthy: false,
  responseTime: 1,
  statusCode: 503,
  message,
})

describe("GIVEN suite context WHEN pollUntilHealthy THEN behavior is covered", () => {
  test("GIVEN healthy immediately WHEN poll runs THEN returns healthy result on first check", async () => {
    let calls = 0
    const checker: Pick<HealthCheckerService, "check"> = {
      check: () =>
        Effect.sync(() => {
          calls += 1
          return healthyResult
        }),
    }

    const result = await Effect.runPromise(
      pollUntilHealthy(checker, config, 10, 100, () => timeoutError(100)),
    )

    expect(calls).toBe(1)
    expect(result).toEqual(healthyResult)
  })

  test("GIVEN unhealthy then healthy WHEN poll runs THEN returns healthy after retry", async () => {
    let calls = 0
    const checker: Pick<HealthCheckerService, "check"> = {
      check: () =>
        Effect.sync(() => {
          calls += 1
          return calls === 1 ? unhealthyResult("booting") : healthyResult
        }),
    }

    const result = await Effect.runPromise(
      pollUntilHealthy(checker, config, 5, 200, () => timeoutError(200)),
    )

    expect(calls).toBe(2)
    expect(result.healthy).toBe(true)
  })

  test("GIVEN always unhealthy WHEN timeout expires THEN calls onTimeout with last result", async () => {
    let calls = 0
    let onTimeoutArg: HealthResult | null | undefined
    const checker: Pick<HealthCheckerService, "check"> = {
      check: () =>
        Effect.sync(() => {
          calls += 1
          return unhealthyResult(`attempt-${calls}`)
        }),
    }

    const exit = await Effect.runPromiseExit(
      pollUntilHealthy(checker, config, 10, 40, (lastResult) => {
        onTimeoutArg = lastResult
        return timeoutError(40)
      }),
    )

    expect(exit._tag).toBe("Failure")
    expect(calls).toBeGreaterThan(0)
    expect(onTimeoutArg).not.toBeNull()
    expect(onTimeoutArg?.message).toBe(`attempt-${calls}`)
  })

  test("GIVEN always unhealthy WHEN timeout expires THEN onTimeout receives null if no checks completed", async () => {
    let calls = 0
    let onTimeoutArg: HealthResult | null | undefined
    const checker: Pick<HealthCheckerService, "check"> = {
      check: () =>
        Effect.sync(() => {
          calls += 1
          return unhealthyResult("never reached")
        }),
    }

    const exit = await Effect.runPromiseExit(
      pollUntilHealthy(checker, config, 10, -1, (lastResult) => {
        onTimeoutArg = lastResult
        return timeoutError(-1)
      }),
    )

    expect(exit._tag).toBe("Failure")
    expect(calls).toBe(0)
    expect(onTimeoutArg).toBeNull()
  })

  test("GIVEN check becomes healthy on 3rd attempt WHEN poll with short interval THEN succeeds after retries", async () => {
    let calls = 0
    const checker: Pick<HealthCheckerService, "check"> = {
      check: () =>
        Effect.sync(() => {
          calls += 1
          return calls >= 3 ? healthyResult : unhealthyResult(`attempt-${calls}`)
        }),
    }

    const result = await Effect.runPromise(
      pollUntilHealthy(checker, config, 5, 300, () => timeoutError(300)),
    )

    expect(calls).toBe(3)
    expect(result.healthy).toBe(true)
  })

  test("GIVEN interval longer than remaining time WHEN poll runs THEN sleeps only remaining time", async () => {
    let timeoutCalls = 0
    const checker: Pick<HealthCheckerService, "check"> = {
      check: () => Effect.succeed(unhealthyResult("still starting")),
    }

    const startedAt = Date.now()
    const exit = await Effect.runPromiseExit(
      pollUntilHealthy(checker, config, 2_000, 70, (lastResult) => {
        timeoutCalls += 1
        return new HealthCheckError(
          config.service,
          config.target,
          70,
          lastResult?.message ?? null,
          "timed out",
          "retry",
        )
      }),
    )
    const elapsed = Date.now() - startedAt

    expect(exit._tag).toBe("Failure")
    expect(timeoutCalls).toBe(1)
    expect(elapsed).toBeGreaterThanOrEqual(40)
    expect(elapsed).toBeLessThan(500)
  })

  test("GIVEN zero timeout WHEN poll runs THEN fails immediately with onTimeout", async () => {
    let calls = 0
    let onTimeoutCalls = 0
    const expectedError = timeoutError(0)
    const checker: Pick<HealthCheckerService, "check"> = {
      check: () =>
        Effect.sync(() => {
          calls += 1
          return unhealthyResult("should not run")
        }),
    }

    const result = await Effect.runPromise(
      pollUntilHealthy(checker, config, 10, 0, () => {
        onTimeoutCalls += 1
        return expectedError
      }).pipe(Effect.either),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBe(expectedError)
    }
    expect(calls).toBe(0)
    expect(onTimeoutCalls).toBe(1)
  })
})
