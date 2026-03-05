import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import type { Logger as LoggerService } from "../interfaces/logger.js"
import { ProcessError, type RigError } from "../schema/errors.js"
import { CompositeLogger } from "./composite-logger.js"

type MessageCall = {
  readonly message: string
  readonly details?: Record<string, unknown>
}

class CaptureLogger implements LoggerService {
  readonly infoCalls: MessageCall[] = []
  readonly warnCalls: MessageCall[] = []
  readonly errorCalls: RigError[] = []
  readonly successCalls: MessageCall[] = []
  readonly tableCalls: Array<readonly Record<string, unknown>[]> = []

  info(message: string, details?: Record<string, unknown>) {
    this.infoCalls.push({ message, details })
    return Effect.void
  }

  warn(message: string, details?: Record<string, unknown>) {
    this.warnCalls.push({ message, details })
    return Effect.void
  }

  error(structured: RigError) {
    this.errorCalls.push(structured)
    return Effect.void
  }

  success(message: string, details?: Record<string, unknown>) {
    this.successCalls.push({ message, details })
    return Effect.void
  }

  table(rows: readonly Record<string, unknown>[]) {
    this.tableCalls.push(rows)
    return Effect.void
  }
}

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect)

describe("GIVEN suite context WHEN CompositeLogger THEN behavior is covered", () => {
  test("GIVEN two loggers WHEN info is called THEN both receive the message and details", async () => {
    const left = new CaptureLogger()
    const right = new CaptureLogger()
    const composite = new CompositeLogger([left, right])
    const details = { env: "dev", count: 2 }

    await run(composite.info("starting services", details))

    expect(left.infoCalls).toEqual([{ message: "starting services", details }])
    expect(right.infoCalls).toEqual([{ message: "starting services", details }])
  })

  test("GIVEN two loggers WHEN warn is called THEN both receive the message and details", async () => {
    const left = new CaptureLogger()
    const right = new CaptureLogger()
    const composite = new CompositeLogger([left, right])
    const details = { service: "web", reason: "slow startup" }

    await run(composite.warn("startup delayed", details))

    expect(left.warnCalls).toEqual([{ message: "startup delayed", details }])
    expect(right.warnCalls).toEqual([{ message: "startup delayed", details }])
  })

  test("GIVEN two loggers WHEN error is called THEN both receive the structured error", async () => {
    const left = new CaptureLogger()
    const right = new CaptureLogger()
    const composite = new CompositeLogger([left, right])
    const error = new ProcessError("install", "pantry-dev.web", "launchd failed", "run `launchctl print`")

    await run(composite.error(error))

    expect(left.errorCalls).toEqual([error])
    expect(right.errorCalls).toEqual([error])
  })

  test("GIVEN two loggers WHEN success is called THEN both receive the message and details", async () => {
    const left = new CaptureLogger()
    const right = new CaptureLogger()
    const composite = new CompositeLogger([left, right])
    const details = { servicesStarted: 3, env: "prod" }

    await run(composite.success("deployment complete", details))

    expect(left.successCalls).toEqual([{ message: "deployment complete", details }])
    expect(right.successCalls).toEqual([{ message: "deployment complete", details }])
  })

  test("GIVEN two loggers WHEN table is called THEN both receive the rows", async () => {
    const left = new CaptureLogger()
    const right = new CaptureLogger()
    const composite = new CompositeLogger([left, right])
    const rows = [
      { service: "web", status: "healthy", port: 5173 },
      { service: "api", status: "healthy", port: 4000 },
    ] satisfies readonly Record<string, unknown>[]

    await run(composite.table(rows))

    expect(left.tableCalls).toEqual([rows])
    expect(right.tableCalls).toEqual([rows])
  })

  test("GIVEN zero loggers WHEN any method is called THEN it succeeds (no-op)", async () => {
    const composite = new CompositeLogger([])
    const error = new ProcessError("kill", "pantry-dev.web", "already stopped", "no action needed")

    await run(
      Effect.all([
        composite.info("noop-info", { source: "test" }),
        composite.warn("noop-warn", { source: "test" }),
        composite.error(error),
        composite.success("noop-success", { source: "test" }),
        composite.table([{ service: "web" }]),
      ]),
    )

    expect(true).toBe(true)
  })

  test("GIVEN three loggers WHEN info is called THEN all three receive the message", async () => {
    const first = new CaptureLogger()
    const second = new CaptureLogger()
    const third = new CaptureLogger()
    const composite = new CompositeLogger([first, second, third])

    await run(composite.info("all targets enabled"))

    expect(first.infoCalls).toEqual([{ message: "all targets enabled", details: undefined }])
    expect(second.infoCalls).toEqual([{ message: "all targets enabled", details: undefined }])
    expect(third.infoCalls).toEqual([{ message: "all targets enabled", details: undefined }])
  })
})
