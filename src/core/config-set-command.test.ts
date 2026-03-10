import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
import {
  Registry,
  type Registry as RegistryService,
  type RegistryEntry,
} from "../interfaces/registry.js"
import { NodeFileSystemLive } from "../providers/node-fs.js"
import { ConfigValidationError, RegistryError, type RigError } from "../schema/errors.js"
import { runConfigSetCommand } from "./config-set-command.js"
import { runConfigUnsetCommand } from "./config-unset-command.js"

class CaptureLogger implements LoggerService {
  readonly infos: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []
  readonly successes: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []

  info(message: string, details?: Record<string, unknown>) {
    this.infos.push({ message, details })
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

class StaticRegistry implements RegistryService {
  constructor(private readonly repoByName: Readonly<Record<string, string>>) {}

  register(_name: string, _repoPath: string) {
    return Effect.void
  }

  unregister(_name: string) {
    return Effect.void
  }

  resolve(name: string) {
    const repoPath = this.repoByName[name]
    if (!repoPath) {
      return Effect.fail(new RegistryError("resolve", name, `Project '${name}' not found`, "Register project first."))
    }

    return Effect.succeed(repoPath)
  }

  list() {
    return Effect.succeed([] as readonly RegistryEntry[])
  }
}

const makeRigConfig = () => ({
  name: "core",
  version: "0.1.0",
  environments: {
    dev: {
      services: [
        {
          name: "web",
          type: "server",
          command: "bun run dev --hostname 127.0.0.1 --port 3101",
          port: 3101,
        },
      ],
    },
  },
})

const writeRigConfig = async (repoPath: string, config: unknown) => {
  await writeFile(join(repoPath, "rig.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

const readRigConfig = async (repoPath: string): Promise<Record<string, unknown>> => {
  const raw = await readFile(join(repoPath, "rig.json"), "utf8")
  return JSON.parse(raw) as Record<string, unknown>
}

const makeLayer = (logger: CaptureLogger, repoPath: string) =>
  Layer.mergeAll(
    NodeFileSystemLive,
    Layer.succeed(Logger, logger),
    Layer.succeed(Registry, new StaticRegistry({ core: repoPath })),
  )

describe("GIVEN suite context WHEN config set command executes THEN behavior is covered", () => {
  test("GIVEN a registered project WHEN setting a top-level string field THEN rig.json is updated and old/new values are logged", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-config-set-description-"))
    await writeRigConfig(repoPath, {
      ...makeRigConfig(),
      description: "Old description",
    })

    const logger = new CaptureLogger()
    const layer = makeLayer(logger, repoPath)

    const exitCode = await Effect.runPromise(
      runConfigSetCommand("core", "description", "New description").pipe(Effect.provide(layer)),
    )

    const updated = await readRigConfig(repoPath)
    const infoLines = logger.infos.map((entry) => entry.message).join("\n")

    expect(exitCode).toBe(0)
    expect(updated["description"]).toBe("New description")
    expect(logger.successes.some((entry) => entry.message === "Updated description.")).toBe(true)
    expect(infoLines).toContain('Old value: "Old description"')
    expect(infoLines).toContain('New value: "New description"')

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN a non-settable but documented key WHEN setting version THEN a clear error is returned", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-config-set-version-blocked-"))
    await writeRigConfig(repoPath, makeRigConfig())

    const layer = makeLayer(new CaptureLogger(), repoPath)

    const result = await Effect.runPromise(
      runConfigSetCommand("core", "version", "0.2.0").pipe(Effect.provide(layer), Effect.either),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ConfigValidationError)
      expect(result.left.hint).toContain("Production release versions are tied to git tags")
    }

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN a registered project WHEN setting a nested field (daemon.enabled) THEN the nested value is updated correctly", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-config-set-daemon-"))
    await writeRigConfig(repoPath, {
      ...makeRigConfig(),
      daemon: {
        enabled: false,
        keepAlive: false,
      },
    })

    const logger = new CaptureLogger()
    const layer = makeLayer(logger, repoPath)

    const exitCode = await Effect.runPromise(
      runConfigSetCommand("core", "daemon.enabled", "true").pipe(Effect.provide(layer)),
    )

    const updated = await readRigConfig(repoPath)
    const daemon = updated["daemon"] as { enabled: boolean; keepAlive: boolean }

    expect(exitCode).toBe(0)
    expect(daemon.enabled).toBe(true)
    expect(daemon.keepAlive).toBe(false)

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN a registered project WHEN setting a value that fails validation THEN error is returned and file is NOT written", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-config-set-validation-"))
    await writeRigConfig(repoPath, makeRigConfig())

    const beforeRaw = await readFile(join(repoPath, "rig.json"), "utf8")
    const layer = makeLayer(new CaptureLogger(), repoPath)

    const result = await Effect.runPromise(
      runConfigSetCommand("core", "domain", "123").pipe(Effect.provide(layer), Effect.either),
    )

    const afterRaw = await readFile(join(repoPath, "rig.json"), "utf8")

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ConfigValidationError)
      if (result.left instanceof ConfigValidationError) {
        expect(result.left.issues.some((issue) => issue.path.join(".") === "domain")).toBe(true)
      }
    }
    expect(afterRaw).toBe(beforeRaw)

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN a registered project WHEN setting hooks.preStart THEN the hooks object is created if missing and the field is set", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-config-set-hooks-"))
    await writeRigConfig(repoPath, makeRigConfig())

    const layer = makeLayer(new CaptureLogger(), repoPath)

    const exitCode = await Effect.runPromise(
      runConfigSetCommand("core", "hooks.preStart", "bun install").pipe(Effect.provide(layer)),
    )

    const updated = await readRigConfig(repoPath)
    const hooks = updated["hooks"] as Record<string, unknown>

    expect(exitCode).toBe(0)
    expect(hooks["preStart"]).toBe("bun install")

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN an invalid key path WHEN setting THEN a clear error is returned", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-config-set-keypath-"))
    await writeRigConfig(repoPath, makeRigConfig())

    const layer = makeLayer(new CaptureLogger(), repoPath)

    const result = await Effect.runPromise(
      runConfigSetCommand("core", "environments.dev.services.0.command", "echo changed")
        .pipe(Effect.provide(layer), Effect.either),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ConfigValidationError)
      expect(result.left.message).toContain("Unsupported config key path")
      expect(result.left.hint).toContain("rig docs config")
    }

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN a registered project WHEN setting an environment-level field THEN the shared config field catalog allows it", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-config-set-env-field-"))
    await writeRigConfig(repoPath, makeRigConfig())

    const layer = makeLayer(new CaptureLogger(), repoPath)

    const exitCode = await Effect.runPromise(
      runConfigSetCommand("core", "environments.dev.envFile", ".env.dev").pipe(Effect.provide(layer)),
    )

    const updated = await readRigConfig(repoPath)
    const environments = updated["environments"] as Record<string, unknown>
    const dev = environments["dev"] as Record<string, unknown>

    expect(exitCode).toBe(0)
    expect(dev["envFile"]).toBe(".env.dev")

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN a non-primitive JSON value WHEN setting THEN config set rejects it clearly", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-config-set-non-primitive-"))
    await writeRigConfig(repoPath, makeRigConfig())

    const layer = makeLayer(new CaptureLogger(), repoPath)

    const result = await Effect.runPromise(
      runConfigSetCommand("core", "description", "{\"bad\":true}").pipe(Effect.provide(layer), Effect.either),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ConfigValidationError)
      expect(result.left.message).toContain("non-primitive value")
      expect(result.left.hint).toContain("string, number, boolean, or null")
    }

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN an optional primitive key WHEN unsetting THEN the key is removed from rig.json", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-config-unset-description-"))
    await writeRigConfig(repoPath, {
      ...makeRigConfig(),
      description: "To be removed",
    })

    const logger = new CaptureLogger()
    const layer = makeLayer(logger, repoPath)

    const exitCode = await Effect.runPromise(
      runConfigUnsetCommand("core", "description").pipe(Effect.provide(layer)),
    )

    const updated = await readRigConfig(repoPath)

    expect(exitCode).toBe(0)
    expect("description" in updated).toBe(false)
    expect(logger.successes.some((entry) => entry.message === "Unset description.")).toBe(true)

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN an optional nullable key WHEN unsetting THEN the key is removed and empty parent objects are pruned", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-config-unset-hook-"))
    await writeRigConfig(repoPath, {
      ...makeRigConfig(),
      hooks: {
        preStart: "bun install",
      },
    })

    const layer = makeLayer(new CaptureLogger(), repoPath)

    const exitCode = await Effect.runPromise(
      runConfigUnsetCommand("core", "hooks.preStart").pipe(Effect.provide(layer)),
    )

    const updated = await readRigConfig(repoPath)

    expect(exitCode).toBe(0)
    expect("hooks" in updated).toBe(false)

    await rm(repoPath, { recursive: true, force: true })
  })
})
