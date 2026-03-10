import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { runDocsCommand } from "./docs-command.js"
import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
import { type RigError } from "../schema/errors.js"

class CaptureLogger implements LoggerService {
  readonly infos: string[] = []

  info(message: string, _details?: Record<string, unknown>) {
    this.infos.push(message)
    return Effect.void
  }

  warn(_message: string, _details?: Record<string, unknown>) {
    return Effect.void
  }

  error(_structured: RigError) {
    return Effect.void
  }

  success(_message: string, _details?: Record<string, unknown>) {
    return Effect.void
  }

  table(_rows: readonly Record<string, unknown>[]) {
    return Effect.void
  }
}

describe("GIVEN docs command WHEN rendering config docs THEN behavior is covered", () => {
  test("GIVEN no docs topic WHEN running docs THEN it prints a docs table of contents", async () => {
    const logger = new CaptureLogger()
    const layer = Layer.succeed(Logger, logger)

    const exitCode = await Effect.runPromise(runDocsCommand().pipe(Effect.provide(layer)))

    expect(exitCode).toBe(0)
    expect(logger.infos).toHaveLength(1)
    expect(logger.infos[0]).toContain("Docs")
    expect(logger.infos[0]).toContain("config")
  })

  test("GIVEN the config docs topic WHEN listing keys THEN it shows short descriptions and array members", async () => {
    const logger = new CaptureLogger()
    const layer = Layer.succeed(Logger, logger)

    const exitCode = await Effect.runPromise(runDocsCommand("config").pipe(Effect.provide(layer)))

    expect(exitCode).toBe(0)
    expect(logger.infos[0]).toContain("settable")
    expect(logger.infos[0]).toContain("rig config unset")
    expect(logger.infos.some((line) => line.startsWith("version (semver string):"))).toBe(true)
    expect(logger.infos.some((line) => line.startsWith("environments.dev.services (array):"))).toBe(true)
    expect(logger.infos.some((line) => line.startsWith("environments.dev.services[] (object):"))).toBe(true)
    expect(logger.infos.some((line) => line.startsWith("environments.dev.services[].port (number):"))).toBe(true)
  })

  test("GIVEN a specific config key WHEN showing docs THEN it prints long details and child keys", async () => {
    const logger = new CaptureLogger()
    const layer = Layer.succeed(Logger, logger)

    const exitCode = await Effect.runPromise(
      runDocsCommand("config", "environments.dev.services").pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(logger.infos).toHaveLength(1)
    expect(logger.infos[0]).toContain("environments.dev.services")
    expect(logger.infos[0]).toContain("Type: array")
    expect(logger.infos[0]).toContain("Settable: no")
    expect(logger.infos[0]).toContain("Unsettable: no")
    expect(logger.infos[0]).toContain("Services to run in this environment.")
    expect(logger.infos[0]).toContain("Child Keys:")
    expect(logger.infos[0]).toContain("environments.dev.services[] (object):")
  })

  test("GIVEN the version key WHEN showing docs THEN it includes the manual edit warning and no direct set command", async () => {
    const logger = new CaptureLogger()
    const layer = Layer.succeed(Logger, logger)

    const exitCode = await Effect.runPromise(
      runDocsCommand("config", "version").pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(logger.infos[0]).toContain("Settable: no")
    expect(logger.infos[0]).toContain("Manual Edit Warning:")
    expect(logger.infos[0]).not.toContain("rig config set <name> version <value>")
  })
})
