import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { runRestartCommand, runStartCommand, runStopCommand } from "./lifecycle.js"
import { BinInstaller, type BinInstaller as BinInstallerService } from "../interfaces/bin-installer.js"
import { EnvLoader, type EnvLoader as EnvLoaderService } from "../interfaces/env-loader.js"
import { HealthChecker, type HealthChecker as HealthCheckerService } from "../interfaces/health-checker.js"
import { HookRunner } from "../interfaces/hook-runner.js"
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
import { StubHookRunner, StubHookRunnerLive } from "../providers/stub-hook-runner.js"
import { StubProcessManager } from "../providers/stub-process-manager.js"
import { PortChecker, type PortChecker as PortCheckerService } from "../interfaces/port-checker.js"
import { BunPortCheckerLive } from "../providers/bun-port-checker.js"
import { StubPortCheckerLive } from "../providers/stub-port-checker.js"
import {
  BinInstallerError,
  ConfigValidationError,
  EnvLoaderError,
  HealthCheckError,
  PortConflictError,
  ServiceRunnerError,
  type RigError,
} from "../schema/errors.js"
import type { BinService, ServerService } from "../schema/config.js"

class CaptureLogger implements LoggerService {
  readonly infoCalls: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []
  readonly warnings: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []

  info(message: string, details?: Record<string, unknown>) {
    this.infoCalls.push({ message, details })
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

  activate(_name: string, _env: "dev" | "prod", _version: string) {
    return Effect.succeed(this.path)
  }

  removeVersion(_name: string, _env: "dev" | "prod", _version: string) {
    return Effect.void
  }

  renameVersion(_name: string, _env: "dev" | "prod", _fromVersion: string, _toVersion: string) {
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

  stop(service: RunningService): Effect.Effect<void, ServiceRunnerError> {
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

class ForegroundExitServiceRunner extends CaptureServiceRunner {
  override start(service: ServerService, opts: RunOpts) {
    this.startOrder.push(service.name)
    this.runOptsByService.set(service.name, opts)

    const child = Bun.spawn(["sh", "-c", "sleep 1"], {
      cwd: opts.workdir,
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    })
    child.unref()

    return Effect.succeed({
      name: service.name,
      pid: child.pid,
      port: service.port,
      startedAt: new Date(),
    } satisfies RunningService)
  }
}

class FailingStopServiceRunner extends CaptureServiceRunner {
  constructor(private readonly failService: string) {
    super()
  }

  override stop(service: RunningService): Effect.Effect<void, ServiceRunnerError> {
    this.stopOrder.push(service.name)

    if (service.name === this.failService) {
      return Effect.fail(
        new ServiceRunnerError(
          "stop",
          service.name,
          `failed to stop ${service.name}`,
          "test failure",
        ),
      )
    }

    return Effect.void
  }
}

class MultiFailingStopServiceRunner extends CaptureServiceRunner {
  constructor(private readonly failServices: ReadonlySet<string>) {
    super()
  }

  override stop(service: RunningService): Effect.Effect<void, ServiceRunnerError> {
    this.stopOrder.push(service.name)

    if (this.failServices.has(service.name)) {
      return Effect.fail(
        new ServiceRunnerError(
          "stop",
          service.name,
          `failed to stop ${service.name}`,
          "test failure",
        ),
      )
    }

    return Effect.void
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
  constructor(private readonly failBuildService?: string) {}

  build(config: BinService, _workdir: string) {
    if (this.failBuildService === config.name) {
      return Effect.fail(
        new BinInstallerError("build", config.name, `build failed for ${config.name}`, "test requested failure"),
      )
    }

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

class FailingEnvLoader implements EnvLoaderService {
  constructor(
    private readonly envs: Readonly<Record<string, Readonly<Record<string, string>>>>,
    private readonly failingEnvFile: string,
  ) {}

  load(envFile: string, _workdir: string) {
    if (envFile === this.failingEnvFile) {
      return Effect.fail(
        new EnvLoaderError(
          envFile,
          `failed to load ${envFile}`,
          "test failure",
        ),
      )
    }

    return Effect.succeed(this.envs[envFile] ?? {})
  }
}

class TrackingBinInstaller extends CaptureBinInstaller {
  readonly installCalls: Array<{ readonly name: string; readonly env: string; readonly binaryPath: string }> = []

  constructor(failBuildService?: string) {
    super(failBuildService)
  }

  override install(name: string, env: string, binaryPath: string) {
    this.installCalls.push({ name, env, binaryPath })
    return super.install(name, env, binaryPath)
  }
}

const writeRigConfig = async (repoPath: string, config: unknown) => {
  await writeFile(join(repoPath, "rig.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

describe("GIVEN suite context WHEN lifecycle command orchestration THEN behavior is covered", () => {
  test("GIVEN test setup WHEN start uses dependency order, runs hooks, and applies env precedence THEN expected behavior is observed", async () => {
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
      StubPortCheckerLive,
      StubHookRunnerLive,
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

  test("GIVEN test setup WHEN start fails fast with PortConflictError when declared port is already in use THEN expected behavior is observed", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-port-conflict-"))
    const hookLog = join(repoPath, "hooks-conflict.log")

    // Occupy a port using Bun.listen
    const blocker = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    })
    const blockedPort = blocker.port

    try {
      await writeRigConfig(repoPath, {
        name: "pantry",
        version: "1.2.3",
        hooks: {
          preStart: "printf 'top-pre\\n' >> hooks-conflict.log",
        },
        environments: {
          dev: {
            services: [
              {
                name: "api",
                type: "server",
                command: "echo api",
                port: blockedPort,
              },
            ],
          },
        },
      })

      const serviceRunner = new CaptureServiceRunner()
      const layer = Layer.mergeAll(
        NodeFileSystemLive,
        BunPortCheckerLive,
        StubHookRunnerLive,
        Layer.succeed(Logger, new CaptureLogger()),
        Layer.succeed(Registry, new StaticRegistry(repoPath)),
        Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
        Layer.succeed(ServiceRunner, serviceRunner),
        Layer.succeed(HealthChecker, new CaptureHealthChecker()),
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

      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(PortConflictError)

        if (result.left instanceof PortConflictError) {
          expect(result.left.port).toBe(blockedPort)
          expect(result.left.service).toBe("api")
        }
      }

      // No services should have been started
      expect(serviceRunner.startOrder).toEqual([])

      // preStart hook should NOT have run (port check is before hooks)
      const preStartRan = await readFile(hookLog, "utf8")
        .then(() => true)
        .catch(() => false)
      expect(preStartRan).toBe(false)
    } finally {
      blocker.stop(true)
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  test("GIVEN test setup WHEN start persists PIDs to pids.json after server services start THEN expected behavior is observed", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-pids-"))

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.0.0",
      environments: {
        dev: {
          services: [
            {
              name: "db",
              type: "server",
              command: "echo db",
              port: 3510,
            },
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3511,
              dependsOn: ["db"],
            },
          ],
        },
      },
    })

    const serviceRunner = new CaptureServiceRunner()

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      StubPortCheckerLive,
      StubHookRunnerLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, serviceRunner),
      Layer.succeed(HealthChecker, new CaptureHealthChecker()),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, new CaptureBinInstaller()),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    const exitCode = await Effect.runPromise(
      runStartCommand({ name: "pantry", env: "dev", foreground: false }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)

    const pidsPath = join(repoPath, ".rig", "pids.json")
    const pids = JSON.parse(await readFile(pidsPath, "utf8")) as Record<string, { pid: number; port: number; startedAt: string }>

    expect(Object.keys(pids).sort()).toEqual(["api", "db"])
    expect(pids.db.port).toBe(3510)
    expect(pids.api.port).toBe(3511)
    expect(typeof pids.db.pid).toBe("number")
    expect(typeof pids.api.pid).toBe("number")
    expect(typeof pids.db.startedAt).toBe("string")
    expect(typeof pids.api.startedAt).toBe("string")

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN valid dev config with one server service WHEN runStartCommand succeeds THEN progress info logs include configuration load and service start", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-start-progress-"))

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.0.0",
      environments: {
        dev: {
          services: [
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3521,
            },
          ],
        },
      },
    })

    const logger = new CaptureLogger()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      StubPortCheckerLive,
      StubHookRunnerLive,
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, new CaptureServiceRunner()),
      Layer.succeed(HealthChecker, new CaptureHealthChecker()),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, new CaptureBinInstaller()),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    const exitCode = await Effect.runPromise(
      runStartCommand({ name: "pantry", env: "dev", foreground: false }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(logger.infoCalls.some((entry) => entry.message.includes("Loaded configuration"))).toBe(true)
    expect(logger.infoCalls.some((entry) => entry.message.includes("Starting service"))).toBe(true)

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN a start with foreground true WHEN a child exits THEN start command completes", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-foreground-"))

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.0.0",
      environments: {
        dev: {
          services: [
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3522,
            },
          ],
        },
      },
    })

    const serviceRunner = new ForegroundExitServiceRunner()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      StubPortCheckerLive,
      StubHookRunnerLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, serviceRunner),
      Layer.succeed(HealthChecker, new CaptureHealthChecker()),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, new CaptureBinInstaller()),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    const startedAt = Date.now()
    const exitCode = await Effect.runPromise(
      runStartCommand({ name: "pantry", env: "dev", foreground: true }).pipe(Effect.provide(layer)),
    )
    const elapsedMs = Date.now() - startedAt

    expect(exitCode).toBe(0)
    expect(serviceRunner.startOrder).toEqual(["api"])
    expect(elapsedMs).toBeGreaterThanOrEqual(500)

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN test setup WHEN start failure stops already-started services best effort THEN expected behavior is observed", async () => {
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
      StubPortCheckerLive,
      StubHookRunnerLive,
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

  test("GIVEN test setup WHEN start rollback removes pid tracking when a bin service fails after server start THEN expected behavior is observed", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-start-bin-fail-"))
    const pidsPath = join(repoPath, ".rig", "pids.json")

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
              port: 3610,
            },
            {
              name: "cli",
              type: "bin",
              build: "bun build --compile cli.ts --outfile dist/cli",
              entrypoint: "dist/cli",
            },
          ],
        },
      },
    })

    const serviceRunner = new CaptureServiceRunner()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      StubPortCheckerLive,
      StubHookRunnerLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, serviceRunner),
      Layer.succeed(HealthChecker, new CaptureHealthChecker()),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, new CaptureBinInstaller("cli")),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    const result = await Effect.runPromise(
      runStartCommand({ name: "pantry", env: "dev", foreground: false }).pipe(
        Effect.provide(layer),
        Effect.either,
      ),
    )

    expect(result._tag).toBe("Left")
    expect(serviceRunner.stopOrder).toEqual(["db"])

    const pids = await readFile(pidsPath, "utf8")
      .then((raw) => JSON.parse(raw) as Record<string, unknown>)
      .catch((cause) => {
        const code =
          typeof cause === "object" && cause !== null && "code" in cause
            ? String((cause as { code?: unknown }).code)
            : ""
        if (code === "ENOENT") {
          return null
        }

        throw cause
      })

    if (pids !== null) {
      expect(pids).toEqual({})
    }

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN test setup WHEN stop uses reverse dependency order, runs stop hooks, and never uninstalls bins THEN expected behavior is observed", async () => {
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
      StubPortCheckerLive,
      StubHookRunnerLive,
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

  test("GIVEN stop failure WHEN runStopCommand completes THEN failed service PID remains tracked for retry", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-stop-failure-pids-"))
    const pidsPath = join(repoPath, ".rig", "pids.json")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.2.3",
      environments: {
        dev: {
          services: [
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3720,
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
          api: { pid: 4321, port: 3720, startedAt: new Date(0).toISOString() },
        },
        null,
        2,
      )}\n`,
      "utf8",
    )

    const serviceRunner = new FailingStopServiceRunner("api")
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      StubPortCheckerLive,
      StubHookRunnerLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, serviceRunner),
      Layer.succeed(HealthChecker, new CaptureHealthChecker()),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, new CaptureBinInstaller()),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    try {
      const result = await Effect.runPromise(
        runStopCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer), Effect.either),
      )

      expect(result._tag).toBe("Left")
      expect(serviceRunner.stopOrder).toEqual(["api"])

      const pids = JSON.parse(await readFile(pidsPath, "utf8")) as Record<string, unknown>
      expect("api" in pids).toBe(true)
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  test("GIVEN a daemon is loaded but not running WHEN stop is requested THEN stop uninstalls daemon instead of stopping it", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-stop-daemon-loaded-"))

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.2.3",
      environments: {
        dev: {
          services: [
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3710,
            },
          ],
        },
      },
    })

    const processManager = new StubProcessManager({
      initialStates: [
        {
          label: "rig.pantry.dev",
          loaded: true,
          running: false,
          pid: null,
        },
      ],
    })

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      StubPortCheckerLive,
      StubHookRunnerLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, new CaptureServiceRunner()),
      Layer.succeed(HealthChecker, new CaptureHealthChecker()),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, new CaptureBinInstaller()),
      Layer.succeed(ProcessManager, processManager),
    )

    try {
      const exitCode = await Effect.runPromise(
        runStopCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer)),
      )

      expect(exitCode).toBe(0)
      expect(processManager.uninstallCalls).toEqual(["rig.pantry.dev"])
      expect(processManager.stopCalls).toEqual([])
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  test("GIVEN test setup WHEN stop cleans orphaned pid entries that are not in current config THEN expected behavior is observed", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-stop-orphan-"))
    const pidsPath = join(repoPath, ".rig", "pids.json")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.2.3",
      environments: {
        dev: {
          services: [
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3711,
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
          api: { pid: 2235, port: 3711, startedAt: new Date(0).toISOString() },
          "old-worker": { pid: 8899, port: 3999, startedAt: new Date(0).toISOString() },
        },
        null,
        2,
      )}\n`,
      "utf8",
    )

    const logger = new CaptureLogger()
    const serviceRunner = new CaptureServiceRunner()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      StubPortCheckerLive,
      StubHookRunnerLive,
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, serviceRunner),
      Layer.succeed(HealthChecker, new CaptureHealthChecker()),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, new CaptureBinInstaller()),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    try {
      const exitCode = await Effect.runPromise(
        runStopCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer)),
      )

      expect(exitCode).toBe(0)
      expect(serviceRunner.stopOrder).toEqual(["api", "old-worker"])
      expect(
        logger.warnings.some(
          (warning) =>
            warning.message === "Cleaned up orphaned PID entry not present in current config." &&
            warning.details?.service === "old-worker",
        ),
      ).toBe(true)

      const pids = JSON.parse(await readFile(pidsPath, "utf8")) as Record<string, unknown>
      expect(pids).toEqual({})
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  test("GIVEN circular server dependencies WHEN start is requested THEN ConfigValidationError mentions circular dependency", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-circular-dep-"))

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.2.3",
      environments: {
        dev: {
          services: [
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3811,
              dependsOn: ["worker"],
            },
            {
              name: "worker",
              type: "server",
              command: "echo worker",
              port: 3812,
              dependsOn: ["api"],
            },
          ],
        },
      },
    })

    const serviceRunner = new CaptureServiceRunner()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      StubPortCheckerLive,
      StubHookRunnerLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, serviceRunner),
      Layer.succeed(HealthChecker, new CaptureHealthChecker()),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, new CaptureBinInstaller()),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    try {
      const result = await Effect.runPromise(
        runStartCommand({ name: "pantry", env: "dev", foreground: false }).pipe(
          Effect.provide(layer),
          Effect.either,
        ),
      )

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(ConfigValidationError)
        if (result.left instanceof ConfigValidationError) {
          expect(result.left.message).toContain("Circular dependency")
        }
      }

      expect(serviceRunner.startOrder).toEqual([])
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  test("GIVEN server dependsOn references a bin service WHEN start is requested THEN ConfigValidationError is returned", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-bin-dep-"))

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.2.3",
      environments: {
        dev: {
          services: [
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3821,
              dependsOn: ["cli"],
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

    const serviceRunner = new CaptureServiceRunner()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      StubPortCheckerLive,
      StubHookRunnerLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, serviceRunner),
      Layer.succeed(HealthChecker, new CaptureHealthChecker()),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, new CaptureBinInstaller()),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    try {
      const result = await Effect.runPromise(
        runStartCommand({ name: "pantry", env: "dev", foreground: false }).pipe(
          Effect.provide(layer),
          Effect.either,
        ),
      )

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(ConfigValidationError)
        if (result.left instanceof ConfigValidationError) {
          expect(result.left.message).toContain("not a server service")
        }
      }

      expect(serviceRunner.startOrder).toEqual([])
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  test("GIVEN second service fails health check WHEN start is requested THEN rollback stops the first started service", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-second-health-fail-"))

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
              port: 3831,
            },
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3832,
              dependsOn: ["db"],
              healthCheck: "http://127.0.0.1:3832/health",
            },
          ],
        },
      },
    })

    const serviceRunner = new CaptureServiceRunner()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      StubPortCheckerLive,
      StubHookRunnerLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, serviceRunner),
      Layer.succeed(HealthChecker, new CaptureHealthChecker("api")),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, new CaptureBinInstaller()),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    try {
      const result = await Effect.runPromise(
        runStartCommand({ name: "pantry", env: "dev", foreground: false }).pipe(
          Effect.provide(layer),
          Effect.either,
        ),
      )

      expect(result._tag).toBe("Left")
      expect(serviceRunner.startOrder).toEqual(["db", "api"])
      expect(serviceRunner.stopOrder).toEqual(["api", "db"])
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  test("GIVEN whitespace-only hooks WHEN start is requested THEN hook execution is skipped as no-op", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-whitespace-hooks-"))

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.2.3",
      hooks: {
        preStart: "   ",
        postStart: "   ",
      },
      environments: {
        dev: {
          services: [
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3841,
              hooks: {
                preStart: "   ",
                postStart: "   ",
              },
            },
          ],
        },
      },
    })

    const hookRunner = new StubHookRunner()
    const serviceRunner = new CaptureServiceRunner()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      StubPortCheckerLive,
      Layer.succeed(HookRunner, hookRunner),
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, serviceRunner),
      Layer.succeed(HealthChecker, new CaptureHealthChecker()),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, new CaptureBinInstaller()),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    try {
      const exitCode = await Effect.runPromise(
        runStartCommand({ name: "pantry", env: "dev", foreground: false }).pipe(Effect.provide(layer)),
      )

      expect(exitCode).toBe(0)
      expect(serviceRunner.startOrder).toEqual(["api"])
      expect(hookRunner.calls).toEqual([])
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  test("GIVEN pid tracking file is missing WHEN stop is requested THEN command succeeds with no services stopped", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-stop-missing-pids-"))
    const pidsPath = join(repoPath, ".rig", "pids.json")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.2.3",
      environments: {
        dev: {
          services: [
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3851,
            },
          ],
        },
      },
    })

    const serviceRunner = new CaptureServiceRunner()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      StubPortCheckerLive,
      StubHookRunnerLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, serviceRunner),
      Layer.succeed(HealthChecker, new CaptureHealthChecker()),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, new CaptureBinInstaller()),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    try {
      const exitCode = await Effect.runPromise(
        runStopCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer)),
      )

      expect(exitCode).toBe(0)
      expect(serviceRunner.stopOrder).toEqual([])
      expect(JSON.parse(await readFile(pidsPath, "utf8"))).toEqual({})
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  test("GIVEN pid tracking file contains a JSON array WHEN stop is requested THEN ServiceRunnerError reports invalid pid file", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-stop-invalid-pids-array-"))
    const pidsPath = join(repoPath, ".rig", "pids.json")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.2.3",
      environments: {
        dev: {
          services: [
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3861,
            },
          ],
        },
      },
    })

    await mkdir(join(repoPath, ".rig"), { recursive: true })
    await writeFile(pidsPath, "[]\n", "utf8")

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      StubPortCheckerLive,
      StubHookRunnerLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, new CaptureServiceRunner()),
      Layer.succeed(HealthChecker, new CaptureHealthChecker()),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, new CaptureBinInstaller()),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    try {
      const result = await Effect.runPromise(
        runStopCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer), Effect.either),
      )

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(ServiceRunnerError)
        if (result.left instanceof ServiceRunnerError) {
          expect(result.left.service).toBe("runtime")
          expect(result.left.message).toContain("Invalid PID file")
        }
      }
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  test("GIVEN pid tracking file is corrupt JSON WHEN stop is requested THEN ServiceRunnerError is returned", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-stop-corrupt-pids-"))
    const pidsPath = join(repoPath, ".rig", "pids.json")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.2.3",
      environments: {
        dev: {
          services: [
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3871,
            },
          ],
        },
      },
    })

    await mkdir(join(repoPath, ".rig"), { recursive: true })
    await writeFile(pidsPath, "{not-json", "utf8")

    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      StubPortCheckerLive,
      StubHookRunnerLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, new CaptureServiceRunner()),
      Layer.succeed(HealthChecker, new CaptureHealthChecker()),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, new CaptureBinInstaller()),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    try {
      const result = await Effect.runPromise(
        runStopCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer), Effect.either),
      )

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(ServiceRunnerError)
        if (result.left instanceof ServiceRunnerError) {
          expect(result.left.service).toBe("runtime")
          expect(result.left.message).toContain("Invalid PID file")
        }
      }
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  test("GIVEN one service preStop hook fails WHEN stop is requested THEN other services still stop and first failure is returned", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-stop-best-effort-"))
    const pidsPath = join(repoPath, ".rig", "pids.json")

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
              port: 3881,
            },
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3882,
              hooks: {
                preStop: "exit 7",
              },
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
          db: { pid: 18881, port: 3881, startedAt: new Date(0).toISOString() },
          api: { pid: 18882, port: 3882, startedAt: new Date(0).toISOString() },
        },
        null,
        2,
      )}\n`,
      "utf8",
    )

    const logger = new CaptureLogger()
    const serviceRunner = new CaptureServiceRunner()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      StubPortCheckerLive,
      StubHookRunnerLive,
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, serviceRunner),
      Layer.succeed(HealthChecker, new CaptureHealthChecker()),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, new CaptureBinInstaller()),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    try {
      const result = await Effect.runPromise(
        runStopCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer), Effect.either),
      )

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(ServiceRunnerError)
      }

      expect(serviceRunner.stopOrder).toEqual(["api", "db"])
      expect(
        logger.warnings.some(
          (warning) => warning.message === "Service preStop hook failed." && warning.details?.service === "api",
        ),
      ).toBe(true)
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  test("GIVEN bins tracking contains services not in config WHEN stop is requested THEN orphaned bins are uninstalled", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-stop-orphan-bins-"))
    const binsPath = join(repoPath, ".rig", "bins.json")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.2.3",
      environments: {
        dev: {
          services: [
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3891,
            },
          ],
        },
      },
    })

    await mkdir(join(repoPath, ".rig"), { recursive: true })
    await writeFile(
      binsPath,
      `${JSON.stringify(
        {
          "legacy-cli": { installedAt: new Date(0).toISOString(), shimPath: "/tmp/legacy-cli" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    )

    const binInstaller = new CaptureBinInstaller()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      StubPortCheckerLive,
      StubHookRunnerLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, new CaptureServiceRunner()),
      Layer.succeed(HealthChecker, new CaptureHealthChecker()),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, binInstaller),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    try {
      const exitCode = await Effect.runPromise(
        runStopCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer)),
      )

      expect(exitCode).toBe(0)
      expect(binInstaller.uninstallCalls).toEqual([{ name: "legacy-cli", env: "dev" }])
      expect(JSON.parse(await readFile(binsPath, "utf8"))).toEqual({})
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  test("GIVEN tracked running services WHEN restart is requested THEN stop executes before start", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-restart-sequence-"))
    const hookLog = join(repoPath, "hooks-restart.log")
    const pidsPath = join(repoPath, ".rig", "pids.json")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.2.3",
      hooks: {
        preStop: "printf 'top-pre-stop\\n' >> hooks-restart.log",
        postStop: "printf 'top-post-stop\\n' >> hooks-restart.log",
        preStart: "printf 'top-pre-start\\n' >> hooks-restart.log",
        postStart: "printf 'top-post-start\\n' >> hooks-restart.log",
      },
      environments: {
        dev: {
          services: [
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3901,
              hooks: {
                preStop: "printf 'api-pre-stop\\n' >> hooks-restart.log",
                postStop: "printf 'api-post-stop\\n' >> hooks-restart.log",
                preStart: "printf 'api-pre-start\\n' >> hooks-restart.log",
                postStart: "printf 'api-post-start\\n' >> hooks-restart.log",
              },
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
          api: { pid: 19001, port: 3901, startedAt: new Date(0).toISOString() },
        },
        null,
        2,
      )}\n`,
      "utf8",
    )

    const serviceRunner = new CaptureServiceRunner()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      StubPortCheckerLive,
      StubHookRunnerLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, serviceRunner),
      Layer.succeed(HealthChecker, new CaptureHealthChecker()),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, new CaptureBinInstaller()),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    try {
      const exitCode = await Effect.runPromise(
        runRestartCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer)),
      )

      expect(exitCode).toBe(0)
      expect(serviceRunner.stopOrder).toEqual(["api"])
      expect(serviceRunner.startOrder).toEqual(["api"])

      const lines = (await readFile(hookLog, "utf8")).trim().split("\n")
      expect(lines).toEqual([
        "top-pre-stop",
        "api-pre-stop",
        "api-post-stop",
        "top-post-stop",
        "top-pre-start",
        "api-pre-start",
        "api-post-start",
        "top-post-start",
      ])
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  test("GIVEN restart request WHEN stop fails THEN stop failure is returned and start is not attempted", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-restart-stop-fails-"))
    const pidsPath = join(repoPath, ".rig", "pids.json")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.2.3",
      environments: {
        dev: {
          services: [
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3911,
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
          api: { pid: 12345, port: 3911, startedAt: new Date(0).toISOString() },
        },
        null,
        2,
      )}\n`,
      "utf8",
    )

    const serviceRunner = new FailingStopServiceRunner("api")
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      StubPortCheckerLive,
      StubHookRunnerLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, serviceRunner),
      Layer.succeed(HealthChecker, new CaptureHealthChecker()),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, new CaptureBinInstaller()),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    try {
      const result = await Effect.runPromise(
        runRestartCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer), Effect.either),
      )

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(ServiceRunnerError)
        if (result.left instanceof ServiceRunnerError) {
          expect(result.left.operation).toBe("stop")
          expect(result.left.service).toBe("api")
        }
      }

      expect(serviceRunner.stopOrder).toEqual(["api"])
      expect(serviceRunner.startOrder).toEqual([])
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  test("GIVEN three tracked services WHEN two stops fail THEN all are attempted only successful pid is removed and first failure is returned", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-stop-two-failures-"))
    const pidsPath = join(repoPath, ".rig", "pids.json")

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
              port: 3921,
            },
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3922,
              dependsOn: ["db"],
            },
            {
              name: "worker",
              type: "server",
              command: "echo worker",
              port: 3923,
              dependsOn: ["api"],
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
          db: { pid: 201, port: 3921, startedAt: new Date(0).toISOString() },
          api: { pid: 202, port: 3922, startedAt: new Date(0).toISOString() },
          worker: { pid: 203, port: 3923, startedAt: new Date(0).toISOString() },
        },
        null,
        2,
      )}\n`,
      "utf8",
    )

    const serviceRunner = new MultiFailingStopServiceRunner(new Set(["worker", "api"]))
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      StubPortCheckerLive,
      StubHookRunnerLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, serviceRunner),
      Layer.succeed(HealthChecker, new CaptureHealthChecker()),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, new CaptureBinInstaller()),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    try {
      const result = await Effect.runPromise(
        runStopCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer), Effect.either),
      )

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(ServiceRunnerError)
        if (result.left instanceof ServiceRunnerError) {
          expect(result.left.service).toBe("worker")
        }
      }

      expect(serviceRunner.stopOrder).toEqual(["worker", "api", "db"])

      const pids = JSON.parse(await readFile(pidsPath, "utf8")) as Record<string, unknown>
      expect(Object.keys(pids).sort()).toEqual(["api", "worker"])
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  test("GIVEN project preStart hook exits non-zero WHEN start is requested THEN ServiceRunnerError is returned and no services are started", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-project-prestart-fails-"))

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.2.3",
      hooks: {
        preStart: "exit 23",
      },
      environments: {
        dev: {
          services: [
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3931,
            },
          ],
        },
      },
    })

    const serviceRunner = new CaptureServiceRunner()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      StubPortCheckerLive,
      StubHookRunnerLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, serviceRunner),
      Layer.succeed(HealthChecker, new CaptureHealthChecker()),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, new CaptureBinInstaller()),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    try {
      const result = await Effect.runPromise(
        runStartCommand({ name: "pantry", env: "dev", foreground: false }).pipe(
          Effect.provide(layer),
          Effect.either,
        ),
      )

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(ServiceRunnerError)
        if (result.left instanceof ServiceRunnerError) {
          expect(result.left.operation).toBe("start")
          expect(result.left.service).toBe("project:pantry")
        }
      }

      expect(serviceRunner.startOrder).toEqual([])
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  test("GIVEN two servers started and first bin installed WHEN later bin build fails THEN servers are stopped in reverse bins are cleaned and pid tracking is removed", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-start-rollback-bin-cleanup-"))
    const pidsPath = join(repoPath, ".rig", "pids.json")
    const binsPath = join(repoPath, ".rig", "bins.json")

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
              port: 3941,
            },
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3942,
              dependsOn: ["db"],
            },
            {
              name: "cli-one",
              type: "bin",
              build: "echo build-cli-one",
              entrypoint: "dist/cli-one",
            },
            {
              name: "cli-two",
              type: "bin",
              build: "echo build-cli-two",
              entrypoint: "dist/cli-two",
            },
          ],
        },
      },
    })

    const serviceRunner = new CaptureServiceRunner()
    const binInstaller = new TrackingBinInstaller("cli-two")
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      StubPortCheckerLive,
      StubHookRunnerLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, serviceRunner),
      Layer.succeed(HealthChecker, new CaptureHealthChecker()),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, binInstaller),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    try {
      const result = await Effect.runPromise(
        runStartCommand({ name: "pantry", env: "dev", foreground: false }).pipe(
          Effect.provide(layer),
          Effect.either,
        ),
      )

      expect(result._tag).toBe("Left")
      expect(serviceRunner.startOrder).toEqual(["db", "api"])
      expect(serviceRunner.stopOrder).toEqual(["api", "db"])
      expect(binInstaller.installCalls.map((call) => call.name)).toEqual(["cli-one"])
      expect(binInstaller.uninstallCalls).toEqual([{ name: "cli-one", env: "dev" }])

      const pidsCleanup = await readFile(pidsPath, "utf8")
        .then(() => "present")
        .catch((cause) => {
          const code =
            typeof cause === "object" && cause !== null && "code" in cause
              ? String((cause as { code?: unknown }).code)
              : ""
          return code === "ENOENT" ? "missing" : "error"
        })
      expect(pidsCleanup).toBe("missing")

      const binsState = await readFile(binsPath, "utf8")
        .then((raw) => JSON.parse(raw) as Record<string, unknown>)
        .catch((cause) => {
          const code =
            typeof cause === "object" && cause !== null && "code" in cause
              ? String((cause as { code?: unknown }).code)
              : ""
          if (code === "ENOENT") {
            return null
          }
          throw cause
        })
      expect(binsState).toBe(null)
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  test("GIVEN service envFile load fails after an earlier service started WHEN start is requested THEN start fails and previously started services are rolled back", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-start-envfile-fail-"))

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.2.3",
      environments: {
        dev: {
          envFile: ".env.default",
          services: [
            {
              name: "db",
              type: "server",
              command: "echo db",
              port: 3951,
            },
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3952,
              dependsOn: ["db"],
              envFile: ".env.bad",
            },
          ],
        },
      },
    })

    const serviceRunner = new CaptureServiceRunner()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      StubPortCheckerLive,
      StubHookRunnerLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, serviceRunner),
      Layer.succeed(HealthChecker, new CaptureHealthChecker()),
      Layer.succeed(EnvLoader, new FailingEnvLoader({ ".env.default": { SOURCE: "default" } }, ".env.bad")),
      Layer.succeed(BinInstaller, new CaptureBinInstaller()),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    try {
      const result = await Effect.runPromise(
        runStartCommand({ name: "pantry", env: "dev", foreground: false }).pipe(
          Effect.provide(layer),
          Effect.either,
        ),
      )

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(EnvLoaderError)
        if (result.left instanceof EnvLoaderError) {
          expect(result.left.envFile).toBe(".env.bad")
        }
      }

      expect(serviceRunner.startOrder).toEqual(["db"])
      expect(serviceRunner.stopOrder).toEqual(["db"])
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  test("GIVEN configured and orphaned services both fail stop WHEN stop is requested THEN both are attempted neither pid is removed and first failure is returned", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-lifecycle-stop-configured-and-orphan-fail-"))
    const pidsPath = join(repoPath, ".rig", "pids.json")

    await writeRigConfig(repoPath, {
      name: "pantry",
      version: "1.2.3",
      environments: {
        dev: {
          services: [
            {
              name: "api",
              type: "server",
              command: "echo api",
              port: 3961,
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
          api: { pid: 501, port: 3961, startedAt: new Date(0).toISOString() },
          "old-worker": { pid: 502, port: 4961, startedAt: new Date(0).toISOString() },
        },
        null,
        2,
      )}\n`,
      "utf8",
    )

    const serviceRunner = new MultiFailingStopServiceRunner(new Set(["api", "old-worker"]))
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      StubPortCheckerLive,
      StubHookRunnerLive,
      Layer.succeed(Logger, new CaptureLogger()),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Workspace, new StaticWorkspace(repoPath)),
      Layer.succeed(ServiceRunner, serviceRunner),
      Layer.succeed(HealthChecker, new CaptureHealthChecker()),
      Layer.succeed(EnvLoader, new StaticEnvLoader({})),
      Layer.succeed(BinInstaller, new CaptureBinInstaller()),
      Layer.succeed(ProcessManager, new StaticProcessManager()),
    )

    try {
      const result = await Effect.runPromise(
        runStopCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(layer), Effect.either),
      )

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(ServiceRunnerError)
        if (result.left instanceof ServiceRunnerError) {
          expect(result.left.service).toBe("api")
        }
      }

      expect(serviceRunner.stopOrder).toEqual(["api", "old-worker"])
      const pids = JSON.parse(await readFile(pidsPath, "utf8")) as Record<string, unknown>
      expect(Object.keys(pids).sort()).toEqual(["api", "old-worker"])
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })
})
