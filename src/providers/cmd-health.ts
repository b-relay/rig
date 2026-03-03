import { Effect, Layer } from "effect"

import {
  HealthChecker,
  type HealthCheckConfig,
  type HealthChecker as HealthCheckerService,
  type HealthResult,
} from "../interfaces/health-checker.js"
import { HealthCheckError } from "../schema/errors.js"

// ── Constants ───────────────────────────────────────────────────────────────

const SINGLE_CHECK_TIMEOUT_MS = 10_000

// ── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

// ── CmdHealthChecker ────────────────────────────────────────────────────────

export class CmdHealthChecker implements HealthCheckerService {
  check(config: HealthCheckConfig): Effect.Effect<HealthResult, HealthCheckError> {
    return Effect.tryPromise({
      try: async () => {
        const start = performance.now()
        const child = Bun.spawn(["sh", "-c", config.target], {
          stdout: "pipe",
          stderr: "pipe",
        })

        const timeoutId = setTimeout(() => {
          child.kill()
        }, SINGLE_CHECK_TIMEOUT_MS)

        const [stderr, exitCode] = await Promise.all([
          child.stderr ? new Response(child.stderr).text() : Promise.resolve(""),
          child.exited,
        ])

        clearTimeout(timeoutId)

        const responseTime = Math.round(performance.now() - start)
        const healthy = exitCode === 0

        return {
          healthy,
          responseTime,
          statusCode: null,
          message: healthy ? null : (stderr.trim() || `exit code ${exitCode}`),
        } satisfies HealthResult
      },
      catch: (err) =>
        new HealthCheckError(
          config.service,
          config.target,
          0,
          null,
          `Unexpected error during command health check: ${err instanceof Error ? err.message : String(err)}`,
          "Check that the health check command is valid and executable.",
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
          `Command health check for ${config.service} did not succeed within ${timeout}ms.`,
          `Run "${config.target}" manually to diagnose. Check service logs for errors.`,
        ),
      )
    })
  }
}

export const CmdHealthCheckerLive = Layer.succeed(HealthChecker, new CmdHealthChecker())
