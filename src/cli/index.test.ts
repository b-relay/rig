import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { renderCommandHelp } from "./help.js"
import { runCli } from "./index.js"
import { EnvLoader } from "../interfaces/env-loader.js"
import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
import { Registry, type Registry as RegistryService, type RegistryEntry } from "../interfaces/registry.js"
import { StubBinInstallerLive } from "../providers/stub-bin-installer.js"
import { StubGitLive } from "../providers/stub-git.js"
import { StubHealthCheckerLive } from "../providers/stub-health-checker.js"
import { StubPortCheckerLive } from "../providers/stub-port-checker.js"
import { NodeFileSystemLive } from "../providers/node-fs.js"
import { StubProcessManagerLive } from "../providers/stub-process-manager.js"
import { StubReverseProxyLive } from "../providers/stub-reverse-proxy.js"
import { StubServiceRunnerLive } from "../providers/stub-service-runner.js"
import { StubWorkspaceLive } from "../providers/stub-workspace.js"
import type { RigError } from "../schema/errors.js"

class CaptureLogger implements LoggerService {
  readonly infos: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []
  readonly successes: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []
  readonly warnings: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []
  readonly errors: RigError[] = []
  readonly tables: Array<readonly Record<string, unknown>[]> = []

  info(message: string, details?: Record<string, unknown>) {
    this.infos.push({ message, details })
    return Effect.void
  }

  warn(message: string, details?: Record<string, unknown>) {
    this.warnings.push({ message, details })
    return Effect.void
  }

  success(message: string, details?: Record<string, unknown>) {
    this.successes.push({ message, details })
    return Effect.void
  }

  error(structured: RigError) {
    this.errors.push(structured)
    return Effect.void
  }

  table(rows: readonly Record<string, unknown>[]) {
    this.tables.push(rows)
    return Effect.void
  }
}

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
    const entry: RegistryEntry = {
      name: "pantry",
      repoPath: this.repoPath,
      registeredAt: new Date(0),
    }

    return Effect.succeed([entry])
  }
}

const writeValidRigConfig = async (repoPath: string) => {
  await writeFile(
    join(repoPath, "rig.json"),
    `${JSON.stringify(
      {
        name: "pantry",
        version: "0.1.0",
        environments: {
          dev: {
            services: [
              {
                name: "web",
                type: "server",
                command: "bunx vite dev --host 127.0.0.1 --port 5173",
                port: 5173,
                healthCheck: "http://127.0.0.1:5173",
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
}

describe("cli start foreground", () => {
  test("accepts --foreground and forwards it to runtime handler", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-cli-foreground-"))
    await writeValidRigConfig(repoPath)

    const logger = new CaptureLogger()
    const layer = Layer.mergeAll(
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      NodeFileSystemLive,
      StubGitLive,
      StubReverseProxyLive,
      StubProcessManagerLive,
      StubWorkspaceLive,
      StubHealthCheckerLive,
      StubPortCheckerLive,
      StubServiceRunnerLive,
      StubBinInstallerLive,
      Layer.succeed(EnvLoader, {
        load: () => Effect.succeed({}),
      }),
    )

    const exitCode = await Effect.runPromise(
      runCli(["start", "pantry", "--dev", "--foreground"]).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)

    const started = logger.successes.find((entry) => entry.message === "Services started.")
    expect(started).toBeDefined()
    expect(started?.details?.foreground).toBe(true)

    await rm(repoPath, { recursive: true, force: true })
  })

  test("start help text documents --foreground", () => {
    const help = renderCommandHelp("start")
    expect(help).toContain("--foreground")
  })
})
