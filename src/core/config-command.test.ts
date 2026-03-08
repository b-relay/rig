import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { runConfigCommand } from "./config-command.js"
import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
import {
  Registry,
  type Registry as RegistryService,
  type RegistryEntry,
} from "../interfaces/registry.js"
import { NodeFileSystemLive } from "../providers/node-fs.js"
import { ConfigValidationError, RegistryError, type RigError } from "../schema/errors.js"

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

const writeRigConfig = async (repoPath: string, config: unknown) => {
  await writeFile(join(repoPath, "rig.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

describe("GIVEN suite context WHEN config command executes THEN behavior is covered", () => {
  test("GIVEN a registered project WHEN running config THEN prints project overview with all sections", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-config-command-overview-"))
    await writeRigConfig(repoPath, {
      name: "core",
      version: "1.0.0",
      description: "Core relay service",
      domain: "core.example.com",
      mainBranch: "main",
      hooks: {
        preStart: "bun install && bun run build",
      },
      environments: {
        dev: {
          envFile: ".env.dev",
          proxy: {
            upstream: "web",
          },
          services: [
            {
              name: "web",
              type: "server",
              command: "bun run dev --hostname 127.0.0.1 --port 3101",
              port: 3101,
              healthCheck: "http://127.0.0.1:3101",
              readyTimeout: 60,
              dependsOn: ["worker"],
              hooks: {
                preStart: "echo boot web",
              },
              envFile: ".env.web",
            },
            {
              name: "worker",
              type: "bin",
              entrypoint: "src/worker.ts",
              build: "bun build src/worker.ts --outfile worker",
              hooks: {
                postStart: "echo worker ready",
              },
              envFile: ".env.worker",
            },
          ],
        },
      },
      daemon: {
        enabled: true,
        keepAlive: true,
      },
    })

    const logger = new CaptureLogger()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry({ core: repoPath })),
    )

    const exitCode = await Effect.runPromise(runConfigCommand("core").pipe(Effect.provide(layer)))
    const output = logger.infos.join("\n\n")

    expect(exitCode).toBe(0)
    expect(output).toContain("Project: core")
    expect(output).toContain("Version: 1.0.0")
    expect(output).toContain("Description: Core relay service")
    expect(output).toContain("Domain: core.example.com")
    expect(output).toContain("Main Branch: main")
    expect(output).toContain("Hooks:")
    expect(output).toContain("preStart: bun install && bun run build")
    expect(output).toContain("Environment: dev")
    expect(output).toContain("Env File: .env.dev")
    expect(output).toContain("Proxy: -> web")
    expect(output).toContain("web (server)")
    expect(output).toContain("Command: bun run dev --hostname 127.0.0.1 --port 3101")
    expect(output).toContain("Port: 3101")
    expect(output).toContain("Health Check: http://127.0.0.1:3101")
    expect(output).toContain("Ready Timeout: 60s")
    expect(output).toContain("Depends On: worker")
    expect(output).toContain("worker (bin)")
    expect(output).toContain("Entrypoint: src/worker.ts")
    expect(output).toContain("Build: bun build src/worker.ts --outfile worker")
    expect(output).toContain("Daemon:")
    expect(output).toContain("Enabled: true")
    expect(output).toContain("Keep Alive: true")

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN a project with multiple environments WHEN running config THEN shows both environments", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-config-command-multi-env-"))
    await writeRigConfig(repoPath, {
      name: "core",
      version: "1.0.0",
      environments: {
        dev: {
          services: [
            {
              name: "web-dev",
              type: "server",
              command: "bun run dev --hostname 127.0.0.1 --port 3101",
              port: 3101,
            },
          ],
        },
        prod: {
          services: [
            {
              name: "web-prod",
              type: "server",
              command: "bun run start --hostname 127.0.0.1 --port 3000",
              port: 3000,
            },
          ],
        },
      },
    })

    const logger = new CaptureLogger()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry({ core: repoPath })),
    )

    const exitCode = await Effect.runPromise(runConfigCommand("core").pipe(Effect.provide(layer)))
    const output = logger.infos.join("\n\n")

    expect(exitCode).toBe(0)
    expect(output).toContain("Environment: dev")
    expect(output).toContain("web-dev (server)")
    expect(output).toContain("Environment: prod")
    expect(output).toContain("web-prod (server)")

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN a project with hooks WHEN running config THEN shows hooks section", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-config-command-hooks-"))
    await writeRigConfig(repoPath, {
      name: "hooks-app",
      version: "1.0.0",
      hooks: {
        preStart: "bun install",
        postStop: "echo done",
      },
      environments: {
        dev: {
          services: [
            {
              name: "api",
              type: "server",
              command: "bun run api --hostname 127.0.0.1 --port 3200",
              port: 3200,
            },
          ],
        },
      },
    })

    const logger = new CaptureLogger()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry({ "hooks-app": repoPath })),
    )

    const exitCode = await Effect.runPromise(runConfigCommand("hooks-app").pipe(Effect.provide(layer)))
    const output = logger.infos.join("\n\n")

    expect(exitCode).toBe(0)
    expect(output).toContain("Hooks:")
    expect(output).toContain("preStart: bun install")
    expect(output).toContain("postStop: echo done")

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN an unregistered project name WHEN running config THEN fails with registry error", async () => {
    const logger = new CaptureLogger()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry({})),
    )

    const result = await Effect.runPromise(
      runConfigCommand("missing-app").pipe(Effect.provide(layer), Effect.either),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ConfigValidationError)
      expect(result.left.message).toContain("Unable to resolve project 'missing-app' in registry.")
    }
  })
})
