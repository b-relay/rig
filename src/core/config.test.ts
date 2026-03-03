import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { Registry, type Registry as RegistryService } from "../interfaces/registry.js"
import { NodeFileSystemLive } from "../providers/node-fs.js"
import { ConfigValidationError } from "../schema/errors.js"
import { loadProjectConfig } from "./config.js"

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

describe("config loader", () => {
  test("maps schema failures to ConfigValidationError", async () => {
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
})
