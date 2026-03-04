import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { runDeployCommand } from "../core/deploy.js"
import { runRestartCommand, runStartCommand, runStopCommand } from "../core/lifecycle.js"
import { BinInstaller } from "../interfaces/bin-installer.js"
import { EnvLoader, type EnvLoader as EnvLoaderService } from "../interfaces/env-loader.js"
import { FileSystem, type FileSystem as FileSystemService } from "../interfaces/file-system.js"
import { HealthChecker } from "../interfaces/health-checker.js"
import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
import { PortChecker } from "../interfaces/port-checker.js"
import { ProcessManager } from "../interfaces/process-manager.js"
import { Registry, type Registry as RegistryService } from "../interfaces/registry.js"
import { ReverseProxy } from "../interfaces/reverse-proxy.js"
import { ServiceRunner } from "../interfaces/service-runner.js"
import { Workspace } from "../interfaces/workspace.js"
import { StubBinInstaller } from "../providers/stub-bin-installer.js"
import { StubHealthChecker } from "../providers/stub-health-checker.js"
import { StubPortChecker } from "../providers/stub-port-checker.js"
import { StubProcessManager } from "../providers/stub-process-manager.js"
import { StubReverseProxy } from "../providers/stub-reverse-proxy.js"
import { StubServiceRunner } from "../providers/stub-service-runner.js"
import { StubWorkspace } from "../providers/stub-workspace.js"
import {
  BinInstallerError,
  ConfigValidationError,
  FileSystemError,
  HealthCheckError,
  PortConflictError,
  ProcessError,
  RegistryError,
  ServiceRunnerError,
  WorkspaceError,
  type RigError,
} from "../schema/errors.js"

const fileSystemError = (
  operation: FileSystemError["operation"],
  path: string,
  message: string,
) => new FileSystemError(operation, path, message, "Check test setup for the in-memory filesystem.")

class InMemoryFileSystem implements FileSystemService {
  readonly files = new Map<string, string>()
  readonly dirs = new Set<string>()
  readonly symlinks = new Map<string, string>()
  readonly writes: Array<{ readonly path: string; readonly content: string }> = []
  readonly removes: string[] = []

  seedDir(path: string): void {
    this.dirs.add(path)
  }

  seedFile(path: string, content: string): void {
    this.files.set(path, content)
    this.ensureParentDirs(path)
  }

  readJson<T>(path: string): T {
    const raw = this.files.get(path)
    if (!raw) {
      throw new Error(`Expected JSON file at ${path}`)
    }
    return JSON.parse(raw) as T
  }

  read(path: string) {
    const content = this.files.get(path)
    if (content === undefined) {
      return Effect.fail(fileSystemError("read", path, "ENOENT"))
    }
    return Effect.succeed(content)
  }

  write(path: string, content: string) {
    return Effect.sync(() => {
      this.ensureParentDirs(path)
      this.files.set(path, content)
      this.writes.push({ path, content })
    })
  }

  copy(src: string, dest: string) {
    return Effect.sync(() => {
      const content = this.files.get(src)
      if (content === undefined) {
        throw fileSystemError("copy", src, "ENOENT")
      }
      this.ensureParentDirs(dest)
      this.files.set(dest, content)
    })
  }

  symlink(target: string, link: string) {
    return Effect.sync(() => {
      this.ensureParentDirs(link)
      this.symlinks.set(link, target)
    })
  }

  exists(path: string) {
    return Effect.succeed(this.files.has(path) || this.dirs.has(path) || this.symlinks.has(path))
  }

  remove(path: string) {
    return Effect.sync(() => {
      this.files.delete(path)
      this.dirs.delete(path)
      this.symlinks.delete(path)
      this.removes.push(path)
    })
  }

  mkdir(path: string) {
    return Effect.sync(() => {
      this.ensureParentDirs(path)
      this.dirs.add(path)
    })
  }

  list(path: string) {
    const entries = new Set<string>()
    const candidates = [...this.files.keys(), ...this.dirs.values(), ...this.symlinks.keys()]

    for (const candidate of candidates) {
      if (!candidate.startsWith(path + "/")) {
        continue
      }

      const relative = candidate.slice(path.length + 1)
      if (!relative || relative.includes("/")) {
        continue
      }

      entries.add(relative)
    }

    return Effect.succeed([...entries])
  }

  chmod(_path: string, _mode: number) {
    return Effect.void
  }

  private ensureParentDirs(path: string): void {
    let parent = dirname(path)
    while (parent !== "." && parent !== "/" && parent.length > 0) {
      this.dirs.add(parent)
      parent = dirname(parent)
    }
    if (path.startsWith("/")) {
      this.dirs.add("/")
    }
  }
}

class CaptureLogger implements LoggerService {
  readonly infos: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []
  readonly warnings: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []
  readonly errors: RigError[] = []
  readonly successes: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []

  info(message: string, details?: Record<string, unknown>) {
    this.infos.push({ message, details })
    return Effect.void
  }

  warn(message: string, details?: Record<string, unknown>) {
    this.warnings.push({ message, details })
    return Effect.void
  }

  error(structured: RigError) {
    this.errors.push(structured)
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
  readonly resolveCalls: string[] = []

  constructor(private readonly entries: Readonly<Record<string, string>>) {}

  register(_name: string, _repoPath: string) {
    return Effect.void
  }

  unregister(_name: string) {
    return Effect.void
  }

  resolve(name: string) {
    this.resolveCalls.push(name)
    const resolved = this.entries[name]
    if (!resolved) {
      return Effect.fail(
        new RegistryError("resolve", name, `Project '${name}' is not registered.`, "Register the project first."),
      )
    }

    return Effect.succeed(resolved)
  }

  list() {
    return Effect.succeed(
      Object.entries(this.entries).map(([name, repoPath]) => ({
        name,
        repoPath,
        registeredAt: new Date(0),
      })),
    )
  }
}

class StaticEnvLoader implements EnvLoaderService {
  readonly loadCalls: Array<{ readonly envFile: string; readonly workdir: string }> = []

  constructor(private readonly values: Readonly<Record<string, Readonly<Record<string, string>>>>) {}

  load(envFile: string, workdir: string) {
    this.loadCalls.push({ envFile, workdir })
    return Effect.succeed(this.values[envFile] ?? {})
  }
}

interface Harness {
  readonly projectName: string
  readonly repoPath: string
  readonly layer: Layer.Layer<any>
  readonly fileSystem: InMemoryFileSystem
  readonly logger: CaptureLogger
  readonly workspace: StubWorkspace
  readonly reverseProxy: StubReverseProxy
  readonly processManager: StubProcessManager
  readonly serviceRunner: StubServiceRunner
  readonly healthChecker: StubHealthChecker
  readonly portChecker: StubPortChecker
  readonly binInstaller: StubBinInstaller
  readonly envLoader: StaticEnvLoader
}

interface HarnessOptions {
  readonly config: unknown
  readonly projectName?: string
  readonly repoPath?: string
  readonly envFiles?: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly workspace?: ConstructorParameters<typeof StubWorkspace>[0]
  readonly reverseProxy?: ConstructorParameters<typeof StubReverseProxy>[0]
  readonly processManager?: ConstructorParameters<typeof StubProcessManager>[0]
  readonly serviceRunner?: ConstructorParameters<typeof StubServiceRunner>[0]
  readonly healthChecker?: ConstructorParameters<typeof StubHealthChecker>[0]
  readonly portChecker?: ConstructorParameters<typeof StubPortChecker>[0]
  readonly binInstaller?: ConstructorParameters<typeof StubBinInstaller>[0]
}

const createHarness = (options: HarnessOptions): Harness => {
  const inferredName =
    typeof options.config === "object" &&
    options.config !== null &&
    "name" in options.config &&
    typeof (options.config as { name?: unknown }).name === "string"
      ? (options.config as { name: string }).name
      : "project"
  const projectName = options.projectName ?? inferredName
  const repoPath = options.repoPath ?? join("/tmp", `rig-e2e-${projectName}-${randomUUID()}`)
  const configPath = join(repoPath, "rig.json")

  const fileSystem = new InMemoryFileSystem()
  fileSystem.seedDir(repoPath)
  fileSystem.seedFile(configPath, `${JSON.stringify(options.config, null, 2)}\n`)

  const logger = new CaptureLogger()
  const registry = new StaticRegistry({ [projectName]: repoPath })
  const workspace = new StubWorkspace(options.workspace)
  const reverseProxy = new StubReverseProxy(options.reverseProxy)
  const processManager = new StubProcessManager(options.processManager)
  const serviceRunner = new StubServiceRunner(options.serviceRunner)
  const healthChecker = new StubHealthChecker(options.healthChecker)
  const portChecker = new StubPortChecker(options.portChecker)
  const binInstaller = new StubBinInstaller(options.binInstaller)
  const envLoader = new StaticEnvLoader(options.envFiles ?? {})

  const layer = Layer.mergeAll(
    Layer.succeed(Logger, logger),
    Layer.succeed(Registry, registry),
    Layer.succeed(FileSystem, fileSystem),
    Layer.succeed(Workspace, workspace),
    Layer.succeed(ReverseProxy, reverseProxy),
    Layer.succeed(ProcessManager, processManager),
    Layer.succeed(ServiceRunner, serviceRunner),
    Layer.succeed(HealthChecker, healthChecker),
    Layer.succeed(PortChecker, portChecker),
    Layer.succeed(BinInstaller, binInstaller),
    Layer.succeed(EnvLoader, envLoader),
  )

  return {
    projectName,
    repoPath,
    layer,
    fileSystem,
    logger,
    workspace,
    reverseProxy,
    processManager,
    serviceRunner,
    healthChecker,
    portChecker,
    binInstaller,
    envLoader,
  }
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const runEither = <A, E>(effect: Effect.Effect<A, E>) => run(effect.pipe(Effect.either))

const workspaceRuntimePath = (workspace: StubWorkspace, name: string, env: "dev" | "prod"): string => {
  const path = workspace.currentPath(name, env)
  if (!path) {
    throw new Error(`No workspace path found for ${name}:${env}`)
  }
  return path
}

const withMockedSpawn = async (
  spawnImpl: typeof Bun.spawn,
  runScenario: () => Promise<void>,
): Promise<void> => {
  const original = Bun.spawn
  ;(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = spawnImpl
  try {
    await runScenario()
  } finally {
    ;(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = original
  }
}

describe("GIVEN suite context WHEN E2E workflow coverage THEN behavior is covered", () => {
  test("GIVEN a dev project with one server WHEN deploy then start then stop are executed THEN workspace, runtime state, and shutdown are completed", async () => {
    const harness = createHarness({
      config: {
        name: "pantry",
        version: "1.0.0",
        environments: {
          dev: {
            services: [
              {
                name: "api",
                type: "server",
                command: "bun api.ts",
                port: 3110,
                healthCheck: "http://127.0.0.1:3110/health",
              },
            ],
          },
        },
      },
    })

    const deploy = await run(runDeployCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(harness.layer)))
    const start = await run(runStartCommand({ name: "pantry", env: "dev", foreground: false }).pipe(Effect.provide(harness.layer)))
    const stop = await run(runStopCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(harness.layer)))

    expect(deploy).toBe(0)
    expect(start).toBe(0)
    expect(stop).toBe(0)
    expect(harness.workspace.createCalls).toHaveLength(1)
    expect(harness.workspace.syncCalls).toHaveLength(1)
    expect(harness.serviceRunner.startCalls.map((call) => call.service)).toEqual(["api"])
    expect(harness.serviceRunner.stopCalls.map((call) => call.service)).toEqual(["api"])
    expect(harness.healthChecker.pollCalls.map((call) => call.config.service)).toEqual(["api"])
  })

  test("GIVEN a prod project with multiple services, proxy, and daemon WHEN deploy then start then stop run THEN proxy and daemon lifecycle are orchestrated", async () => {
    const harness = createHarness({
      config: {
        name: "pantry",
        version: "2.3.4",
        domain: "pantry.example.com",
        daemon: {
          enabled: true,
          keepAlive: true,
        },
        environments: {
          prod: {
            proxy: { upstream: "api" },
            services: [
              {
                name: "db",
                type: "server",
                command: "bun db.ts",
                port: 5420,
              },
              {
                name: "api",
                type: "server",
                command: "bun api.ts",
                port: 3080,
                dependsOn: ["db"],
                healthCheck: "http://127.0.0.1:3080/health",
              },
            ],
          },
        },
      },
    })

    const deploy = await run(runDeployCommand({ name: "pantry", env: "prod" }).pipe(Effect.provide(harness.layer)))
    const start = await run(runStartCommand({ name: "pantry", env: "prod", foreground: false }).pipe(Effect.provide(harness.layer)))
    const stop = await run(runStopCommand({ name: "pantry", env: "prod" }).pipe(Effect.provide(harness.layer)))

    expect(deploy).toBe(0)
    expect(start).toBe(0)
    expect(stop).toBe(0)
    expect(harness.reverseProxy.addCalls).toEqual([
      {
        name: "pantry",
        env: "prod",
        domain: "pantry.example.com",
        upstream: "api",
        port: 3080,
      },
    ])
    expect(harness.processManager.installCalls.map((call) => call.label)).toEqual(["rig.pantry.prod"])
    expect(harness.serviceRunner.startCalls.map((call) => call.service)).toEqual(["db", "api"])
    expect(harness.serviceRunner.stopCalls.map((call) => call.service)).toEqual(["api", "db"])
  })

  test("GIVEN a deployed dev project WHEN start then restart are executed THEN stop happens before the second start sequence", async () => {
    const harness = createHarness({
      config: {
        name: "pantry",
        version: "1.5.0",
        environments: {
          dev: {
            services: [
              { name: "db", type: "server", command: "bun db.ts", port: 3210 },
              { name: "api", type: "server", command: "bun api.ts", port: 3211, dependsOn: ["db"] },
            ],
          },
        },
      },
    })

    await run(runDeployCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(harness.layer)))
    await run(runStartCommand({ name: "pantry", env: "dev", foreground: false }).pipe(Effect.provide(harness.layer)))
    const restart = await run(runRestartCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(harness.layer)))

    expect(restart).toBe(0)
    expect(harness.serviceRunner.startCalls).toHaveLength(4)
    expect(harness.serviceRunner.stopCalls).toHaveLength(2)

    const restartStopMaxSequence = Math.max(...harness.serviceRunner.stopCalls.map((call) => call.sequence))
    const secondStartMinSequence = Math.min(...harness.serviceRunner.startCalls.slice(2).map((call) => call.sequence))
    expect(restartStopMaxSequence).toBeLessThan(secondStartMinSequence)
  })

  test("GIVEN a config with a missing proxy upstream WHEN deploy runs THEN it fails with ConfigValidationError", async () => {
    const harness = createHarness({
      config: {
        name: "pantry",
        version: "1.0.0",
        domain: "pantry.example.com",
        environments: {
          dev: {
            proxy: { upstream: "ghost" },
            services: [{ name: "api", type: "server", command: "bun api.ts", port: 3000 }],
          },
        },
      },
    })

    const result = await runEither(
      runDeployCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(harness.layer)),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ConfigValidationError)
    }
    expect(harness.reverseProxy.addCalls).toEqual([])
  })

  test("GIVEN an existing prod workspace WHEN deploy runs THEN it recovers and continues successfully", async () => {
    const workspacePath = "/tmp/rig-existing-workspace/pantry/prod/v1.0.0"
    const harness = createHarness({
      config: {
        name: "pantry",
        version: "1.0.0",
        environments: {
          prod: {
            services: [{ name: "web", type: "server", command: "bun web.ts", port: 3070 }],
          },
        },
      },
      workspace: {
        createFailures: {
          "pantry:prod": new WorkspaceError(
            "create",
            "pantry",
            "prod",
            `Workspace already exists at ${workspacePath}`,
            "Reuse existing workspace.",
          ),
        },
        initialCurrent: {
          "pantry:prod": workspacePath,
        },
      },
    })

    const result = await run(runDeployCommand({ name: "pantry", env: "prod" }).pipe(Effect.provide(harness.layer)))

    expect(result).toBe(0)
    expect(harness.workspace.resolveCalls).toEqual([{ name: "pantry", env: "prod" }])
  })

  test("GIVEN a conflicting port WHEN start runs THEN it fails with PortConflictError before services start", async () => {
    const harness = createHarness({
      config: {
        name: "pantry",
        version: "1.0.0",
        environments: {
          dev: {
            services: [{ name: "api", type: "server", command: "bun api.ts", port: 3222 }],
          },
        },
      },
      portChecker: {
        conflicts: [{ port: 3222, service: "api", existingPid: 999 }],
      },
    })

    const result = await runEither(
      runStartCommand({ name: "pantry", env: "dev", foreground: false }).pipe(Effect.provide(harness.layer)),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(PortConflictError)
    }
    expect(harness.serviceRunner.startCalls).toEqual([])
  })

  test("GIVEN one unhealthy service WHEN start runs THEN the error is surfaced and started services are rolled back", async () => {
    const harness = createHarness({
      config: {
        name: "pantry",
        version: "1.0.0",
        environments: {
          dev: {
            services: [
              { name: "db", type: "server", command: "bun db.ts", port: 3230, healthCheck: "echo ok" },
              {
                name: "api",
                type: "server",
                command: "bun api.ts",
                port: 3231,
                dependsOn: ["db"],
                healthCheck: "echo fail",
              },
            ],
          },
        },
      },
      healthChecker: {
        pollFailures: {
          api: new HealthCheckError(
            "api",
            "echo fail",
            30_000,
            "unhealthy",
            "health check failed",
            "Inspect service logs.",
          ),
        },
      },
    })

    const result = await runEither(
      runStartCommand({ name: "pantry", env: "dev", foreground: false }).pipe(Effect.provide(harness.layer)),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(HealthCheckError)
    }
    expect(harness.serviceRunner.stopCalls.map((call) => call.service)).toEqual(["api", "db"])
  })

  test("GIVEN a failing project preStart hook WHEN start runs THEN no services are started", async () => {
    const harness = createHarness({
      config: {
        name: "pantry",
        version: "1.0.0",
        hooks: {
          preStart: "echo fail",
        },
        environments: {
          dev: {
            services: [{ name: "api", type: "server", command: "bun api.ts", port: 3250 }],
          },
        },
      },
    })

    const failingSpawn = (() =>
      ({
        stdout: null,
        stderr: null,
        exited: Promise.resolve(1),
      }) as unknown as ReturnType<typeof Bun.spawn>) as unknown as typeof Bun.spawn

    await withMockedSpawn(failingSpawn, async () => {
      const result = await runEither(
        runStartCommand({ name: "pantry", env: "dev", foreground: false }).pipe(Effect.provide(harness.layer)),
      )

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(ServiceRunnerError)
      }
      expect(harness.serviceRunner.startCalls).toEqual([])
    })
  })

  test("GIVEN a project with bin services WHEN start then stop run THEN binaries are installed then uninstalled", async () => {
    const harness = createHarness({
      config: {
        name: "pantry",
        version: "1.0.0",
        environments: {
          dev: {
            services: [
              { name: "api", type: "server", command: "bun api.ts", port: 3260 },
              {
                name: "cli",
                type: "bin",
                build: "bun build --compile cli.ts --outfile dist/cli",
                entrypoint: "dist/cli",
              },
            ],
          },
        },
      },
    })

    await run(runDeployCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(harness.layer)))
    const start = await run(runStartCommand({ name: "pantry", env: "dev", foreground: false }).pipe(Effect.provide(harness.layer)))
    const stop = await run(runStopCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(harness.layer)))

    expect(start).toBe(0)
    expect(stop).toBe(0)
    expect(harness.binInstaller.installCalls.map((call) => call.name)).toEqual(["cli"])
    expect(harness.binInstaller.uninstallCalls.map((call) => call.name)).toEqual(["cli"])
  })

  test("GIVEN started services and a later bin install failure WHEN start runs THEN services roll back, bins roll back, and PIDs are cleaned", async () => {
    const harness = createHarness({
      config: {
        name: "pantry",
        version: "1.0.0",
        environments: {
          dev: {
            services: [
              { name: "api", type: "server", command: "bun api.ts", port: 3270 },
              {
                name: "cli-one",
                type: "bin",
                build: "bun build --compile cli-one.ts --outfile dist/cli-one",
                entrypoint: "dist/cli-one",
              },
              {
                name: "cli-two",
                type: "bin",
                build: "bun build --compile cli-two.ts --outfile dist/cli-two",
                entrypoint: "dist/cli-two",
              },
            ],
          },
        },
      },
      binInstaller: {
        installFailures: {
          "cli-two:dev": new BinInstallerError(
            "install",
            "cli-two",
            "simulated install failure",
            "Fix shim install.",
          ),
        },
      },
    })

    await run(runDeployCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(harness.layer)))
    const workspacePath = workspaceRuntimePath(harness.workspace, "pantry", "dev")
    const pidsPath = join(workspacePath, ".rig", "pids.json")

    const result = await runEither(
      runStartCommand({ name: "pantry", env: "dev", foreground: false }).pipe(Effect.provide(harness.layer)),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(BinInstallerError)
    }
    expect(harness.serviceRunner.stopCalls.map((call) => call.service)).toEqual(["api"])
    expect(harness.binInstaller.uninstallCalls.map((call) => call.name)).toEqual(["cli-one"])
    expect(await run(harness.fileSystem.exists(pidsPath))).toBe(false)
  })

  test("GIVEN orphaned PID entries WHEN stop runs THEN unknown processes are cleaned and PID tracking is normalized", async () => {
    const harness = createHarness({
      config: {
        name: "pantry",
        version: "1.0.0",
        environments: {
          dev: {
            services: [{ name: "api", type: "server", command: "bun api.ts", port: 3280 }],
          },
        },
      },
    })

    await run(runDeployCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(harness.layer)))
    const workspacePath = workspaceRuntimePath(harness.workspace, "pantry", "dev")
    const pidsPath = join(workspacePath, ".rig", "pids.json")
    harness.fileSystem.seedFile(
      pidsPath,
      `${JSON.stringify(
        {
          api: { pid: 7001, port: 3280, startedAt: new Date(0).toISOString() },
          orphan: { pid: 7999, port: 3999, startedAt: new Date(0).toISOString() },
        },
        null,
        2,
      )}\n`,
    )

    const stop = await run(runStopCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(harness.layer)))

    expect(stop).toBe(0)
    expect(harness.serviceRunner.stopCalls.map((call) => call.service)).toEqual(["api", "orphan"])
    const normalized = harness.fileSystem.readJson<Record<string, unknown>>(pidsPath)
    expect(normalized).toEqual({})
  })

  test("GIVEN already-exited services WHEN stop is invoked repeatedly THEN stop remains idempotent", async () => {
    const harness = createHarness({
      config: {
        name: "pantry",
        version: "1.0.0",
        environments: {
          dev: {
            services: [{ name: "api", type: "server", command: "bun api.ts", port: 3290 }],
          },
        },
      },
    })

    await run(runDeployCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(harness.layer)))
    const workspacePath = workspaceRuntimePath(harness.workspace, "pantry", "dev")
    const pidsPath = join(workspacePath, ".rig", "pids.json")
    harness.fileSystem.seedFile(
      pidsPath,
      `${JSON.stringify(
        {
          api: { pid: 8100, port: 3290, startedAt: new Date(0).toISOString() },
        },
        null,
        2,
      )}\n`,
    )

    const firstStop = await run(runStopCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(harness.layer)))
    const secondStop = await run(runStopCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(harness.layer)))

    expect(firstStop).toBe(0)
    expect(secondStop).toBe(0)
    expect(harness.serviceRunner.stopCalls.map((call) => call.service)).toEqual(["api"])
  })

  test("GIVEN daemon enabled WHEN deploy runs THEN process manager install is called", async () => {
    const harness = createHarness({
      config: {
        name: "pantry",
        version: "1.0.0",
        daemon: {
          enabled: true,
          keepAlive: false,
        },
        environments: {
          dev: {
            services: [{ name: "api", type: "server", command: "bun api.ts", port: 3300 }],
          },
        },
      },
    })

    const result = await run(runDeployCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(harness.layer)))
    expect(result).toBe(0)
    expect(harness.processManager.installCalls.map((call) => call.label)).toEqual(["rig.pantry.dev"])
  })

  test("GIVEN daemon disabled and no existing plist WHEN deploy runs THEN uninstall is attempted and ENOENT is treated as idempotent", async () => {
    const harness = createHarness({
      config: {
        name: "pantry",
        version: "1.0.0",
        daemon: {
          enabled: false,
        },
        environments: {
          dev: {
            services: [{ name: "api", type: "server", command: "bun api.ts", port: 3301 }],
          },
        },
      },
      processManager: {
        uninstallFailures: {
          "rig.pantry.dev": new ProcessError(
            "uninstall",
            "rig.pantry.dev",
            "ENOENT: no such file or directory",
            "No plist present.",
          ),
        },
      },
    })

    const result = await run(runDeployCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(harness.layer)))
    expect(result).toBe(0)
    expect(harness.processManager.uninstallCalls).toEqual(["rig.pantry.dev"])
  })

  test("GIVEN environment and service env files WHEN start runs THEN env vars from env files are loaded per service", async () => {
    const harness = createHarness({
      config: {
        name: "pantry",
        version: "1.0.0",
        environments: {
          dev: {
            envFile: ".env.shared",
            services: [
              { name: "db", type: "server", command: "bun db.ts", port: 3330 },
              {
                name: "api",
                type: "server",
                command: "bun api.ts",
                port: 3331,
                envFile: ".env.api",
              },
            ],
          },
        },
      },
      envFiles: {
        ".env.shared": { SHARED: "true" },
        ".env.api": { API_ONLY: "yes" },
      },
    })

    await run(runDeployCommand({ name: "pantry", env: "dev" }).pipe(Effect.provide(harness.layer)))
    const result = await run(runStartCommand({ name: "pantry", env: "dev", foreground: false }).pipe(Effect.provide(harness.layer)))

    expect(result).toBe(0)
    const dbStart = harness.serviceRunner.startCalls.find((call) => call.service === "db")
    const apiStart = harness.serviceRunner.startCalls.find((call) => call.service === "api")
    expect(dbStart?.opts.envVars).toEqual({ SHARED: "true" })
    expect(apiStart?.opts.envVars).toEqual({ API_ONLY: "yes" })
    expect(harness.envLoader.loadCalls.map((call) => call.envFile).sort()).toEqual([
      ".env.api",
      ".env.shared",
      ".env.shared",
    ])
  })
})
