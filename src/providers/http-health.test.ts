import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { HttpHealthChecker } from "./http-health.js"
import type { HealthCheckConfig } from "../interfaces/health-checker.js"
import { HealthCheckError } from "../schema/errors.js"

let server: ReturnType<typeof Bun.serve>
let baseUrl: string

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/healthy") {
        return new Response("ok", { status: 200 })
      }
      if (url.pathname === "/error") {
        return new Response("internal server error", { status: 500 })
      }
      return new Response("not found", { status: 404 })
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterAll(async () => {
  await server.stop(true)
})

const checker = new HttpHealthChecker()

describe("GIVEN suite context WHEN HttpHealthChecker THEN behavior is covered", () => {
  describe("GIVEN suite context WHEN check THEN behavior is covered", () => {
    test("GIVEN test setup WHEN returns healthy for 2xx responses THEN expected behavior is observed", async () => {
      const config: HealthCheckConfig = {
        type: "http",
        target: `${baseUrl}/healthy`,
        service: "web",
      }
      const result = await Effect.runPromise(checker.check(config))

      expect(result.healthy).toBe(true)
      expect(result.statusCode).toBe(200)
      expect(result.responseTime).toBeGreaterThanOrEqual(0)
      expect(result.message).toBeNull()
    })

    test("GIVEN test setup WHEN returns unhealthy for 5xx responses THEN expected behavior is observed", async () => {
      const config: HealthCheckConfig = {
        type: "http",
        target: `${baseUrl}/error`,
        service: "web",
      }
      const result = await Effect.runPromise(checker.check(config))

      expect(result.healthy).toBe(false)
      expect(result.statusCode).toBe(500)
      expect(result.message).toContain("500")
    })

    test("GIVEN test setup WHEN returns unhealthy for 4xx responses THEN expected behavior is observed", async () => {
      const config: HealthCheckConfig = {
        type: "http",
        target: `${baseUrl}/missing`,
        service: "web",
      }
      const result = await Effect.runPromise(checker.check(config))

      expect(result.healthy).toBe(false)
      expect(result.statusCode).toBe(404)
    })

    test("GIVEN test setup WHEN returns unhealthy on connection refused THEN expected behavior is observed", async () => {
      const config: HealthCheckConfig = {
        type: "http",
        target: "http://127.0.0.1:1",
        service: "web",
      }
      const result = await Effect.runPromise(checker.check(config))

      expect(result.healthy).toBe(false)
      expect(result.statusCode).toBeNull()
      expect(result.message).toBeTruthy()
    })
  })

  describe("GIVEN suite context WHEN poll THEN behavior is covered", () => {
    test("GIVEN test setup WHEN returns immediately when healthy on first check THEN expected behavior is observed", async () => {
      const config: HealthCheckConfig = {
        type: "http",
        target: `${baseUrl}/healthy`,
        service: "web",
      }
      const result = await Effect.runPromise(
        checker.poll(config, 100, 5000),
      )

      expect(result.healthy).toBe(true)
    })

    test("GIVEN test setup WHEN fails with HealthCheckError when timeout exceeded THEN expected behavior is observed", async () => {
      const config: HealthCheckConfig = {
        type: "http",
        target: "http://127.0.0.1:1",
        service: "web",
      }
      const result = await Effect.runPromise(
        checker.poll(config, 50, 200).pipe(Effect.either),
      )

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        const error = result.left
        expect(error).toBeInstanceOf(HealthCheckError)
        expect(error.service).toBe("web")
        expect(error.timeout).toBe(200)
      }
    })
  })
})
