import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import type { HealthCheckConfig, HealthChecker as HealthCheckerService, HealthResult } from "../interfaces/health-checker.js"
import { HealthCheckError } from "../schema/errors.js"
import { DispatchHealthChecker } from "./health-checker-dispatch.js"

class SpyHealthChecker implements HealthCheckerService {
  readonly calls: HealthCheckConfig[] = []

  check(config: HealthCheckConfig) {
    this.calls.push(config)
    return Effect.succeed({
      healthy: true,
      responseTime: 1,
      statusCode: 200,
      message: null,
    } satisfies HealthResult)
  }

  poll(config: HealthCheckConfig, _interval: number, _timeout: number) {
    this.calls.push(config)
    return Effect.succeed({
      healthy: true,
      responseTime: 1,
      statusCode: 200,
      message: null,
    } satisfies HealthResult)
  }
}

describe("DispatchHealthChecker", () => {
  test("type='command' with HTTP target routes to command checker", async () => {
    const httpSpy = new SpyHealthChecker()
    const cmdSpy = new SpyHealthChecker()
    const dispatch = new DispatchHealthChecker(httpSpy, cmdSpy)

    const config: HealthCheckConfig = {
      type: "command",
      target: "http://localhost:3000/health",
      service: "api",
    }

    await Effect.runPromise(dispatch.check(config))

    expect(cmdSpy.calls).toHaveLength(1)
    expect(httpSpy.calls).toHaveLength(0)
    expect(cmdSpy.calls[0].service).toBe("api")
  })

  test("type='http' routes to http checker", async () => {
    const httpSpy = new SpyHealthChecker()
    const cmdSpy = new SpyHealthChecker()
    const dispatch = new DispatchHealthChecker(httpSpy, cmdSpy)

    const config: HealthCheckConfig = {
      type: "http",
      target: "http://127.0.0.1:3000/health",
      service: "api",
    }

    await Effect.runPromise(dispatch.check(config))

    expect(httpSpy.calls).toHaveLength(1)
    expect(cmdSpy.calls).toHaveLength(0)
  })

  test("type='command' with non-HTTP target routes to command checker", async () => {
    const httpSpy = new SpyHealthChecker()
    const cmdSpy = new SpyHealthChecker()
    const dispatch = new DispatchHealthChecker(httpSpy, cmdSpy)

    const config: HealthCheckConfig = {
      type: "command",
      target: "pg_isready -h 127.0.0.1",
      service: "db",
    }

    await Effect.runPromise(dispatch.poll(config, 500, 5000))

    expect(cmdSpy.calls).toHaveLength(1)
    expect(httpSpy.calls).toHaveLength(0)
  })
})
