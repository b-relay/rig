import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect-v3"
import { Effect as EffectV4 } from "effect"

import { runInitCommand } from "./init.js"
import { FileSystem, type FileSystem as FileSystemService } from "../interfaces/file-system.js"
import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
import {
  Registry,
  type Registry as RegistryService,
  type RegistryEntry,
} from "../interfaces/registry.js"
import { decodeV2ProjectConfig } from "../v2/config.js"
import { FileSystemError, RegistryError, type RigError } from "../schema/errors.js"

class CaptureLogger implements LoggerService {
  readonly infos: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []
  readonly warnings: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []
  readonly successes: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []

  info(message: string, details?: Record<string, unknown>) {
    this.infos.push({ message, details })
    return Effect.void
  }

  warn(message: string, details?: Record<string, unknown>) {
    this.warnings.push({ message, details })
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

class InMemoryFileSystem implements FileSystemService {
  readonly files = new Map<string, string>()

  read(path: string) {
    const value = this.files.get(path)
    if (value === undefined) {
      return Effect.fail(
        new FileSystemError("read", path, `File '${path}' does not exist.`, "Create the file first."),
      )
    }
    return Effect.succeed(value)
  }

  write(path: string, content: string) {
    this.files.set(path, content)
    return Effect.void
  }

  exists(path: string) {
    return Effect.succeed(this.files.has(path))
  }

  rename() {
    return Effect.die("rename not implemented")
  }

  append() {
    return Effect.die("append not implemented")
  }

  copy() {
    return Effect.die("copy not implemented")
  }

  symlink() {
    return Effect.die("symlink not implemented")
  }

  remove() {
    return Effect.die("remove not implemented")
  }

  mkdir() {
    return Effect.void
  }

  list() {
    return Effect.die("list not implemented")
  }

  chmod() {
    return Effect.die("chmod not implemented")
  }
}

const runWithLayer = (
  registry: InMemoryRegistry,
  logger: CaptureLogger,
  fileSystem: InMemoryFileSystem,
  args: Parameters<typeof runInitCommand>[0],
) =>
  Effect.runPromise(
    runInitCommand(args).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Logger, logger),
          Layer.succeed(Registry, registry),
          Layer.succeed(FileSystem, fileSystem),
        ),
      ),
    ),
  )

describe("GIVEN suite context WHEN init command executes THEN behavior is covered", () => {
  test("GIVEN valid name and path WHEN init is called THEN project is registered in registry", async () => {
    const registry = new InMemoryRegistry()
    const logger = new CaptureLogger()
    const fileSystem = new InMemoryFileSystem()
    const absolutePath = "/tmp/rig-core-project"

    const exitCode = await runWithLayer(registry, logger, fileSystem, {
      name: "core",
      path: absolutePath,
    })

    expect(exitCode).toBe(0)
    const repoPath = await Effect.runPromise(registry.resolve("core"))
    expect(repoPath).toBe(absolutePath)
    expect(logger.successes.at(-1)?.message).toBe(`Registered core at ${absolutePath}`)
  })

  test("GIVEN valid name and relative path WHEN init is called THEN path is resolved to absolute", async () => {
    const registry = new InMemoryRegistry()
    const logger = new CaptureLogger()
    const fileSystem = new InMemoryFileSystem()
    const relativePath = "./tmp/rig-core-relative"

    const exitCode = await runWithLayer(registry, logger, fileSystem, {
      name: "core",
      path: relativePath,
    })

    expect(exitCode).toBe(0)
    const repoPath = await Effect.runPromise(registry.resolve("core"))
    expect(repoPath).toBe(resolve(relativePath))
  })

  test("GIVEN a name that is already registered WHEN init is called THEN it overwrites with the new path", async () => {
    const registry = new InMemoryRegistry()
    const logger = new CaptureLogger()
    const fileSystem = new InMemoryFileSystem()
    const oldPath = "/tmp/rig-core-old"
    const newPath = "/tmp/rig-core-new"

    await Effect.runPromise(registry.register("core", oldPath))

    const exitCode = await runWithLayer(registry, logger, fileSystem, {
      name: "core",
      path: newPath,
    })

    expect(exitCode).toBe(0)
    const repoPath = await Effect.runPromise(registry.resolve("core"))
    expect(repoPath).toBe(newPath)
    expect(repoPath).not.toBe(oldPath)
  })

  test("GIVEN v2 scaffold option WHEN init runs THEN it writes a valid lane-wired v2 config", async () => {
    const registry = new InMemoryRegistry()
    const logger = new CaptureLogger()
    const fileSystem = new InMemoryFileSystem()
    const repoPath = "/tmp/rig-v2-project"

    const exitCode = await runWithLayer(registry, logger, fileSystem, {
      name: "pantry",
      path: repoPath,
      v2: true,
      providerProfile: "stub",
    })

    expect(exitCode).toBe(0)
    const rawConfig = fileSystem.files.get(`${repoPath}/rig.json`)
    expect(rawConfig).toBeDefined()
    const parsed = JSON.parse(rawConfig ?? "{}") as unknown
    const decoded = await EffectV4.runPromise(decodeV2ProjectConfig(parsed))

    expect(decoded).toMatchObject({
      name: "pantry",
      components: {},
      local: { providerProfile: "stub" },
      live: { providerProfile: "stub" },
      deployments: {
        subdomain: "${branchSlug}",
        providerProfile: "stub",
      },
    })
    expect(logger.successes.map((entry) => entry.message)).toContain("Scaffolded v2 rig.json for pantry")
  })

  test("GIVEN package script option WHEN package.json exists THEN rig scripts are added without overwriting existing scripts", async () => {
    const registry = new InMemoryRegistry()
    const logger = new CaptureLogger()
    const fileSystem = new InMemoryFileSystem()
    const repoPath = "/tmp/rig-js-project"
    fileSystem.files.set(`${repoPath}/package.json`, `${JSON.stringify({
      scripts: {
        dev: "vite dev",
        "rig:up": "custom rig up",
      },
    }, null, 2)}\n`)

    const exitCode = await runWithLayer(registry, logger, fileSystem, {
      name: "pantry",
      path: repoPath,
      packageScripts: true,
    })

    expect(exitCode).toBe(0)
    const packageJson = JSON.parse(fileSystem.files.get(`${repoPath}/package.json`) ?? "{}") as {
      readonly scripts: Record<string, string>
    }
    expect(packageJson.scripts.dev).toBe("vite dev")
    expect(packageJson.scripts["rig:up"]).toBe("custom rig up")
    expect(packageJson.scripts["rig:down"]).toBe("rig2 down")
    expect(packageJson.scripts["rig:status"]).toBe("rig2 status")
    expect(packageJson.scripts["rig:logs"]).toBe("rig2 logs")
    expect(packageJson.scripts["rig:deploy"]).toBeUndefined()
  })

  test("GIVEN package script option WHEN package.json is absent THEN non JavaScript projects are skipped", async () => {
    const registry = new InMemoryRegistry()
    const logger = new CaptureLogger()
    const fileSystem = new InMemoryFileSystem()
    const repoPath = "/tmp/rig-native-project"

    const exitCode = await runWithLayer(registry, logger, fileSystem, {
      name: "native",
      path: repoPath,
      packageScripts: true,
    })

    expect(exitCode).toBe(0)
    expect(fileSystem.files.has(`${repoPath}/package.json`)).toBe(false)
    expect(logger.warnings.at(-1)?.message).toBe("Skipped package-manager integration; package.json was not found.")
  })
})
