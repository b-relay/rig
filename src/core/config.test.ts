import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { FileSystem, type FileSystem as FileSystemService } from "../interfaces/file-system.js"
import { Registry, type Registry as RegistryService } from "../interfaces/registry.js"
import { NodeFileSystemLive } from "../providers/node-fs.js"
import { ConfigValidationError, FileSystemError, RegistryError } from "../schema/errors.js"
import { loadProjectConfig, parseRigConfig, resolveEnvironment } from "./config.js"
import type { RigConfig } from "../schema/config.js"

class StaticRegistry implements RegistryService {
  constructor(private readonly repoPath: string) {}

  register(_name: string, _repoPath: string) {
    return Effect.void
  }

  unregister(_name: string) {
    return Effect.void
  }

  resolve(_name: string) {
    return Effect.succeed(this.repoPath)
  }

  list() {
    return Effect.succeed([])
  }
}

describe("GIVEN suite context WHEN config loader THEN behavior is covered", () => {
  test("GIVEN test setup WHEN maps schema failures to ConfigValidationError THEN expected behavior is observed", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-config-invalid-"))

    await writeFile(
      join(repoPath, "rig.json"),
      `${JSON.stringify(
        {
          name: "pantry",
          environments: {
            dev: {
              services: [
                {
                  name: "web",
                  type: "server",
                  command: "bunx vite dev --host 127.0.0.1 --port 5173",
                  port: 5173,
                },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    )

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
    )

    const result = await Effect.runPromise(
      loadProjectConfig("pantry").pipe(Effect.provide(layer), Effect.either),
    )

    expect(result._tag).toBe("Left")

    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ConfigValidationError)
      expect(result.left._tag).toBe("ConfigValidationError")
      expect(result.left.issues.length).toBeGreaterThan(0)
      expect(result.left.issues.some((issue) => issue.path[0] === "version")).toBe(true)
    }

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN test setup WHEN service name includes path traversal characters THEN schema validation rejects it THEN expected behavior is observed", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-config-invalid-service-name-"))

    await writeFile(
      join(repoPath, "rig.json"),
      `${JSON.stringify(
        {
          name: "pantry",
          version: "1.0.0",
          environments: {
            dev: {
              services: [
                {
                  name: "../escape",
                  type: "bin",
                  entrypoint: "cli/index.ts",
                },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    )

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
    )

    const result = await Effect.runPromise(
      loadProjectConfig("pantry").pipe(Effect.provide(layer), Effect.either),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ConfigValidationError)
      expect(
        result.left.issues.some(
          (issue) =>
            issue.path.join(".") === "environments.dev.services.0.name" &&
            issue.message.includes("Service name must be lowercase alphanumeric with hyphens only."),
        ),
      ).toBe(true)
    }

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN test setup WHEN invalid JSON yields ConfigValidationError with invalid_json code THEN expected behavior is observed", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-config-badjson-"))

    await writeFile(join(repoPath, "rig.json"), "{ broken json !!!", "utf8")

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
    )

    const result = await Effect.runPromise(
      loadProjectConfig("pantry").pipe(Effect.provide(layer), Effect.either),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ConfigValidationError)
      expect(result.left.issues.some((issue) => issue.code === "invalid_json")).toBe(true)
    }

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN test setup WHEN missing rig.json yields ConfigValidationError about unable to read THEN expected behavior is observed", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-config-missing-"))

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
    )

    const result = await Effect.runPromise(
      loadProjectConfig("pantry").pipe(Effect.provide(layer), Effect.either),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ConfigValidationError)
      expect(result.left.message).toContain("Unable to read")
    }

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN test setup WHEN missing environment yields ConfigValidationError with missing_environment code THEN expected behavior is observed", () => {
    const config: RigConfig = {
      name: "pantry",
      version: "1.0.0",
      environments: {
        dev: {
          services: [
            { name: "web", type: "server", command: "echo web", port: 5173, readyTimeout: 30 },
          ],
        },
      },
    }

    const result = Effect.runSync(
      resolveEnvironment("/fake/rig.json", config, "prod").pipe(Effect.either),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ConfigValidationError)
      expect(result.left.issues.some((issue) => issue.code === "missing_environment")).toBe(true)
    }
  })

  test("GIVEN test setup WHEN unregistered project yields ConfigValidationError about unable to resolve THEN expected behavior is observed", async () => {
    class FailingRegistry implements RegistryService {
      register(_name: string, _repoPath: string) {
        return Effect.void
      }
      unregister(_name: string) {
        return Effect.void
      }
      resolve(name: string) {
        return Effect.fail(new RegistryError("resolve", name, `Project '${name}' not found`, "Run rig init first."))
      }
      list() {
        return Effect.succeed([])
      }
    }

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Registry, new FailingRegistry()),
    )

    const result = await Effect.runPromise(
      loadProjectConfig("ghost").pipe(Effect.provide(layer), Effect.either),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ConfigValidationError)
      expect(result.left.message).toContain("Unable to resolve")
    }
  })

  test("GIVEN test setup WHEN valid config roundtrip returns correct LoadedProjectConfig shape THEN expected behavior is observed", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-config-valid-"))

    const validConfig = {
      name: "pantry",
      version: "1.0.0",
      domain: "pantry.example.com",
      environments: {
        dev: {
          services: [
            { name: "web", type: "server", command: "echo web", port: 5173 },
          ],
        },
      },
    }

    await writeFile(join(repoPath, "rig.json"), `${JSON.stringify(validConfig, null, 2)}\n`, "utf8")

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
    )

    const result = await Effect.runPromise(
      loadProjectConfig("pantry").pipe(Effect.provide(layer), Effect.either),
    )

    expect(result._tag).toBe("Right")
    if (result._tag === "Right") {
      expect(result.right.name).toBe("pantry")
      expect(result.right.repoPath).toBe(repoPath)
      expect(result.right.configPath).toBe(join(repoPath, "rig.json"))
      expect(result.right.config.name).toBe("pantry")
      expect(result.right.config.version).toBe("1.0.0")
      expect(result.right.config.domain).toBe("pantry.example.com")
      expect(result.right.config.environments.dev).toBeDefined()
    }

    await rm(repoPath, { recursive: true, force: true })
  })
})
