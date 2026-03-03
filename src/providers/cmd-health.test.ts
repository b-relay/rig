import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { CmdHealthChecker } from "./cmd-health.js"
import type { HealthCheckConfig } from "../interfaces/health-checker.js"
import { HealthCheckError } from "../schema/errors.js"

const checker = new CmdHealthChecker()

describe("CmdHealthChecker", () => {
  describe("check", () => {
    test("returns healthy when command exits 0", async () => {
      const config: HealthCheckConfig = {
        type: "command",
        target: "true",
        service: "backend",
      }
      const result = await Effect.runPromise(checker.check(config))

      expect(result.healthy).toBe(true)
      expect(result.statusCode).toBeNull()
      expect(result.responseTime).toBeGreaterThanOrEqual(0)
      expect(result.message).toBeNull()
    })

    test("returns unhealthy when command exits non-zero", async () => {
      const config: HealthCheckConfig = {
        type: "command",
        target: "false",
        service: "backend",
      }
      const result = await Effect.runPromise(checker.check(config))

      expect(result.healthy).toBe(false)
      expect(result.statusCode).toBeNull()
      expect(result.message).toBeTruthy()
    })

    test("captures stderr on failure", async () => {
      const config: HealthCheckConfig = {
        type: "command",
        target: "echo 'something went wrong' >&2 && exit 1",
        service: "backend",
      }
      const result = await Effect.runPromise(checker.check(config))

      expect(result.healthy).toBe(false)
      expect(result.message).toContain("something went wrong")
    })

    test("handles complex shell commands", async () => {
      const config: HealthCheckConfig = {
        type: "command",
        target: "test -f /bin/sh",
        service: "backend",
      }
      const result = await Effect.runPromise(checker.check(config))

      expect(result.healthy).toBe(true)
    })

    test("handles nonexistent commands gracefully", async () => {
      const config: HealthCheckConfig = {
        type: "command",
        target: "nonexistent_command_abc123",
        service: "backend",
      }
      const result = await Effect.runPromise(checker.check(config))

      expect(result.healthy).toBe(false)
    })
  })

  describe("poll", () => {
    test("returns immediately when command succeeds", async () => {
      const config: HealthCheckConfig = {
        type: "command",
        target: "true",
        service: "backend",
      }
      const result = await Effect.runPromise(
        checker.poll(config, 100, 5000),
      )

      expect(result.healthy).toBe(true)
    })

    test("fails with HealthCheckError when timeout exceeded", async () => {
      const config: HealthCheckConfig = {
        type: "command",
        target: "false",
        service: "backend",
      }
      const result = await Effect.runPromise(
        checker.poll(config, 50, 200).pipe(Effect.either),
      )

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        const error = result.left
        expect(error).toBeInstanceOf(HealthCheckError)
        expect(error.service).toBe("backend")
        expect(error.timeout).toBe(200)
      }
    })
  })
})
