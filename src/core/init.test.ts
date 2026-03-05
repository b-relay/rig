import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { runInitCommand } from "./init.js"
import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
import {
  Registry,
  type Registry as RegistryService,
  type RegistryEntry,
} from "../interfaces/registry.js"
import { RegistryError, type RigError } from "../schema/errors.js"

class CaptureLogger implements LoggerService {
  readonly successes: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []

  info(_message: string, _details?: Record<string, unknown>) {
    return Effect.void
  }

  warn(_message: string, _details?: Record<string, unknown>) {
    return Effect.void
  }

  error(_structured: RigError) {
    return Effect.void
  }

  success(message: string, details?: Record<string, unknown>) {
    this.successes.push({ message, details })
    return Effect.void
  }

  table(_rows: readonly Record<string, unknown>[]) {
    return Effect.void
  }
}

class InMemoryRegistry implements RegistryService {
  private readonly entries = new Map<string, RegistryEntry>()

  register(name: string, repoPath: string) {
    this.entries.set(name, {
      name,
      repoPath,
      registeredAt: new Date(),
    })
    return Effect.void
  }

  unregister(name: string) {
    this.entries.delete(name)
    return Effect.void
  }

  resolve(name: string) {
    const entry = this.entries.get(name)
    if (!entry) {
      return Effect.fail(
        new RegistryError("resolve", name, `Project '${name}' not found`, "Run rig init first."),
      )
    }

    return Effect.succeed(entry.repoPath)
  }

  list() {
    return Effect.succeed(
      [...this.entries.values()].sort((left, right) => left.name.localeCompare(right.name)),
    )
  }
}

const runWithLayer = (registry: InMemoryRegistry, logger: CaptureLogger, name: string, path: string) =>
  Effect.runPromise(
    runInitCommand({ name, path }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Logger, logger),
          Layer.succeed(Registry, registry),
        ),
      ),
    ),
  )

describe("GIVEN suite context WHEN init command executes THEN behavior is covered", () => {
  test("GIVEN valid name and path WHEN init is called THEN project is registered in registry", async () => {
    const registry = new InMemoryRegistry()
    const logger = new CaptureLogger()
    const absolutePath = "/tmp/rig-core-project"

    const exitCode = await runWithLayer(registry, logger, "core", absolutePath)

    expect(exitCode).toBe(0)
    const repoPath = await Effect.runPromise(registry.resolve("core"))
    expect(repoPath).toBe(absolutePath)
    expect(logger.successes.at(-1)?.message).toBe(`Registered core at ${absolutePath}`)
  })

  test("GIVEN valid name and relative path WHEN init is called THEN path is resolved to absolute", async () => {
    const registry = new InMemoryRegistry()
    const logger = new CaptureLogger()
    const relativePath = "./tmp/rig-core-relative"

    const exitCode = await runWithLayer(registry, logger, "core", relativePath)

    expect(exitCode).toBe(0)
    const repoPath = await Effect.runPromise(registry.resolve("core"))
    expect(repoPath).toBe(resolve(relativePath))
  })

  test("GIVEN a name that is already registered WHEN init is called THEN it overwrites with the new path", async () => {
    const registry = new InMemoryRegistry()
    const logger = new CaptureLogger()
    const oldPath = "/tmp/rig-core-old"
    const newPath = "/tmp/rig-core-new"

    await Effect.runPromise(registry.register("core", oldPath))

    const exitCode = await runWithLayer(registry, logger, "core", newPath)

    expect(exitCode).toBe(0)
    const repoPath = await Effect.runPromise(registry.resolve("core"))
    expect(repoPath).toBe(newPath)
    expect(repoPath).not.toBe(oldPath)
  })
})
