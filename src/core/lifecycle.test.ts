import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { runStartCommand, runStopCommand } from "./lifecycle.js"
import { BinInstaller, type BinInstaller as BinInstallerService } from "../interfaces/bin-installer.js"
import { EnvLoader, type EnvLoader as EnvLoaderService } from "../interfaces/env-loader.js"
import { HealthChecker, type HealthChecker as HealthCheckerService } from "../interfaces/health-checker.js"
import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
import {
  ProcessManager,
  type DaemonConfig,
  type DaemonStatus,
  type ProcessManager as ProcessManagerService,
} from "../interfaces/process-manager.js"
import { Registry, type Registry as RegistryService } from "../interfaces/registry.js"
import {
  ServiceRunner,
  type LogOpts,
  type RunOpts,
  type RunningService,
  type ServiceRunner as ServiceRunnerService,
} from "../interfaces/service-runner.js"
import { Workspace, type Workspace as WorkspaceService } from "../interfaces/workspace.js"
import { NodeFileSystemLive } from "../providers/node-fs.js"
import { HealthCheckError, type RigError } from "../schema/errors.js"
import type { BinService, ServerService } from "../schema/config.js"

class CaptureLogger implements LoggerService {
  readonly warnings: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []

  info(_message: string, _details?: Record<string, unknown>) {
    return Effect.void
  }

  warn(message: string, details?: Record<string, unknown>) {
    this.warnings.push({ message, details })
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

class StaticWorkspace implements WorkspaceService {
  constructor(private readonly path: string) {}

  create(_name: string, _env: "dev" | "prod", _version: string, _commitRef: string) {
    return Effect.succeed(this.path)
  }

  resolve(_name: string, _env: "dev" | "prod") {
    return Effect.succeed(this.path)
  }

  sync(_name: string, _env: "dev" | "prod") {
    return Effect.void
  }

  list(_name: string) {
    return Effect.succeed([])
  }
}

class CaptureServiceRunner implements ServiceRunnerService {
  readonly startOrder: string[] = []
  readonly stopOrder: string[] = []
  readonly runOptsByService = new Map<string, RunOpts>()
  private nextPid = 40000

  start(service: ServerService, opts: RunOpts) {
    this.startOrder.push(service.name)
    this.runOptsByService.set(service.name, opts)
    this.nextPid += 1

    return Effect.succeed({
      name: service.name,
      pid: this.nextPid,
      port: service.port,
      startedAt: new Date(),
    } satisfies RunningService)
  }

  stop(service: RunningService) {
    this.stopOrder.push(service.name)
    return Effect.void
  }

  health(_service: RunningService) {
    return Effect.succeed("healthy" as const)
  }

  logs(_service: string, _opts: LogOpts) {
    return Effect.succeed("")
  }
}

class CaptureHealthChecker implements HealthCheckerService {
  readonly polls: Array<{ readonly service: string; readonly interval: number; readonly timeout: number }> = []

  constructor(private readonly failService?: string) {}

  check(_config: { readonly type: "http" | "command"; readonly target: string; readonly service: string }) {
    return Effect.succeed({
      healthy: true,
      responseTime: 5,
      statusCode: 200,
      message: null,
    })
  }

  poll(
    config: { readonly type: "http" | "command"; readonly target: string; readonly service: string },
    interval: number,
    timeout: number,
  ) {
    this.polls.push({ service: config.service, interval, timeout })

    if (this.failService === config.service) {
      return Effect.fail(
        new HealthCheckError(
          config.service,
          config.target,
          timeout,
          "unhealthy",
          `health check failed for ${config.service}`,
          "inspect logs",
        ),
      )
    }

    return Effect.succeed({
      healthy: true,
      responseTime: 5,
      statusCode: 200,
      message: null,
    })
  }
}

class CaptureBinInstaller implements BinInstallerService {
  readonly uninstallCalls: Array<{ readonly name: string; readonly env: string }> = []

  build(_config: BinService, _workdir: string) {
    return Effect.succeed("shim:ok")
  }

  install(name: string, _env: string, _binaryPath: string) {
    return Effect.succeed(`/tmp/${name}`)
  }

  uninstall(name: string, env: string) {
    this.uninstallCalls.push({ name, env })
    return Effect.void
  }
}

class StaticProcessManager implements ProcessManagerService {
  install(_config: DaemonConfig) {
    return Effect.void
  }

  uninstall(_label: string) {
    return Effect.void
  }

  start(_label: string) {
    return Effect.void
  }

  stop(_label: string) {
    return Effect.void
  }

  status(label: string) {
    return Effect.succeed({
      label,
      running: false,
      pid: null,
      loaded: false,
    } satisfies DaemonStatus)
  }

  backup(_label: string) {
    return Effect.succeed("/tmp/backup.plist")
  }
}

class StaticEnvLoader implements EnvLoaderService {
  constructor(private readonly envs: Readonly<Record<string, Readonly<Record<string, string>>>>) {}

  load(envFile: string, _workdir: string) {
    return Effect.succeed(this.envs[envFile] ?? {})
  }
}

const writeRigConfig = async (repoPath: string, config: unknown) => {
  await writeFile(join(repoPath, "rig.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

describe("lifecycle command orchestration", () => {
  test("start uses dependency order, runs hooks, and applies env precedence", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-start-"))
    const hookLog = join(repoPath, "hooks.log")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.2.3",
      hooks: {
        preStart: "printf 'top-pre\\n' >> hooks.log",
        postStart: "printf 'top-post\\n' >> hooks.log",
      },
      environments: {
        dev: {
          envFile: ".env.default",
          services: [
            {
              name: "db",
              type: "server",
              command: "echo db",
              port: 3210,
              healthCheck: "http://127.0.0.1:3210/health",
              readyTimeout: 9,
              hooks: {
                preStart: "printf 'db-pre\\n' >> hooks.log",
                postStart: "printf 'db-post\\n' >> hooks.log",
              },
            },
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3211,
              healthCheck: "echo ok",
              readyTimeout: 4,
              dependsOn: ["db"],
              envFile: ".env.api",
              hooks: {
                preStart: "printf 'api-pre\\n' >> hooks.log",
                postStart: "printf 'api-post\\n' >> hooks.log",
              },
            },
          ],
        },
      },
    })

    const logger = new CaptureLogger()
    const serviceRunner = new CaptureServiceRunner()
    const healthChecker = new CaptureHealthChecker()
    const envLoader = new StaticEnvLoader({
      ".env.default": { SOURCE: "default" },
      ".env.api": { SOURCE: "api" },
    })

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, serviceRunner),
      Layer.succeed(HealthChecker, healthChecker),
      Layer.succeed(EnvLoader, envLoader),
      Layer.succeed(BinInstaller, new CaptureBinInstaller()),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    const exitCode = await Effect.runPromise(
      runStartCommand({ name: "pantry", env: "dev", foreground: false }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(serviceRunner.startOrder).toEqual(["db", "api"])
    expect(healthChecker.polls).toEqual([
      { service: "db", interval: 500, timeout: 9000 },
      { service: "api", interval: 500, timeout: 4000 },
    ])
    expect(serviceRunner.runOptsByService.get("db")?.envVars).toEqual({ SOURCE: "default" })
    expect(serviceRunner.runOptsByService.get("api")?.envVars).toEqual({ SOURCE: "api" })

    const lines = (await readFile(hookLog, "utf8")).trim().split("\n")
    expect(lines).toEqual(["top-pre", "db-pre", "db-post", "api-pre", "api-post", "top-post"])

    await rm(repoPath, { recursive: true, force: true })
  })

  test("start failure stops already-started services best effort", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-cleanup-"))

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.2.3",
      environments: {
        dev: {
          services: [
            {
              name: "db",
              type: "server",
              command: "echo db",
              port: 3310,
              healthCheck: "http://127.0.0.1:3310/health",
            },
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3311,
              healthCheck: "http://127.0.0.1:3311/health",
              dependsOn: ["db"],
            },
          ],
        },
      },
    })

    const serviceRunner = new CaptureServiceRunner()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, serviceRunner),
      Layer.succeed(HealthChecker, new CaptureHealthChecker("api")),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, new CaptureBinInstaller()),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    const result = await Effect.runPromise(
      runStartCommand({ name: "pantry", env: "dev", foreground: false }).pipe(
        Effect.provide(layer),
        Effect.either,
      ),
    )

    expect(result._tag).toBe("Left")
    expect(serviceRunner.stopOrder).toEqual(["api", "db"])

    await rm(repoPath, { recursive: true, force: true })
  })

  test("stop uses reverse dependency order, runs stop hooks, and never uninstalls bins", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-stop-"))
    const hookLog = join(repoPath, "hooks-stop.log")
    const pidsPath = join(repoPath, ".rig", "pids.json")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.2.3",
      hooks: {
        preStop: "printf 'top-pre-stop\\n' >> hooks-stop.log",
        postStop: "printf 'top-post-stop\\n' >> hooks-stop.log",
      },
      environments: {
        dev: {
          services: [
            {
              name: "db",
              type: "server",
              command: "echo db",
              port: 3410,
              hooks: {
                preStop: "printf 'db-pre-stop\\n' >> hooks-stop.log",
                postStop: "printf 'db-post-stop\\n' >> hooks-stop.log",
              },
            },
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3411,
              dependsOn: ["db"],
              hooks: {
                preStop: "printf 'api-pre-stop\\n' >> hooks-stop.log",
                postStop: "printf 'api-post-stop\\n' >> hooks-stop.log",
              },
            },
            {
              name: "cli",
              type: "bin",
              entrypoint: "bun cli.ts",
            },
          ],
        },
      },
    })

    await mkdir(join(repoPath, ".rig"), { recursive: true })
    await writeFile(
      pidsPath,
      `${JSON.stringify(
        {
          db: { pid: 1234, port: 3410, startedAt: new Date(0).toISOString() },
          api: { pid: 1235, port: 3411, startedAt: new Date(0).toISOString() },
        },
        null,
        2,
      )}\n`,
      "utf8",
    )

    const serviceRunner = new CaptureServiceRunner()
    const binInstaller = new CaptureBinInstaller()

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, serviceRunner),
      Layer.succeed(HealthChecker, new CaptureHealthChecker()),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, binInstaller),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    const exitCode = await Effect.runPromise(
      runStopCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(serviceRunner.stopOrder).toEqual(["api", "db"])
    expect(binInstaller.uninstallCalls).toEqual([])

    const hookLines = (await readFile(hookLog, "utf8")).trim().split("\n")
    expect(hookLines).toEqual([
      "top-pre-stop",
      "api-pre-stop",
      "api-post-stop",
      "db-pre-stop",
      "db-post-stop",
      "top-post-stop",
    ])

    const pids = JSON.parse(await readFile(pidsPath, "utf8")) as Record<string, unknown>
    expect(pids).toEqual({})

    await rm(repoPath, { recursive: true, force: true })
  })
})
