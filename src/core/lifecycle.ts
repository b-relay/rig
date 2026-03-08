import { join } from "node:path"
import { Effect } from "effect"

import { BinInstaller } from "../interfaces/bin-installer.js"
import { EnvLoader } from "../interfaces/env-loader.js"
import { FileSystem } from "../interfaces/file-system.js"
import { HealthChecker } from "../interfaces/health-checker.js"
import { HookRunner } from "../interfaces/hook-runner.js"
import { Logger } from "../interfaces/logger.js"
import { PortChecker } from "../interfaces/port-checker.js"
import { ProcessManager } from "../interfaces/process-manager.js"
import { ServiceRunner, type RunningService } from "../interfaces/service-runner.js"
import { Workspace } from "../interfaces/workspace.js"
import type {
  Environment,
  ServerService,
  Service,
  ServiceHooks,
  TopLevelHooks,
} from "../schema/config.js"
import type { RestartArgs, StartArgs, StopArgs } from "../schema/args.js"
import { ConfigValidationError, ServiceRunnerError } from "../schema/errors.js"
import { loadProjectConfig, resolveEnvironment } from "./config.js"
import { configError, daemonLabel } from "./shared.js"

type HookPhase = "preStart" | "postStart" | "preStop" | "postStop"

interface PidEntry {
  readonly pid: number
  readonly port: number
  readonly startedAt: string
}

type PidMap = Record<string, PidEntry>
type InstalledBinMap = Record<string, { readonly installedAt: string; readonly shimPath: string }>

const HEALTH_POLL_INTERVAL_MS = 500
const FOREGROUND_MONITOR_INTERVAL_MS = 500

const resolveCheckType = (target: string): "http" | "command" =>
  target.startsWith("http://") || target.startsWith("https://") ? "http" : "command"

const toServiceRunnerError = (
  operation: "start" | "stop",
  service: string,
  message: string,
  hint: string,
) => new ServiceRunnerError(operation, service, message, hint)

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const anyStartedServiceExited = (started: readonly RunningService[]): boolean => {
  if (started.length === 0) {
    return true
  }

  return started.some((service) => !isPidAlive(service.pid))
}

const monitorForegroundServices = (started: readonly RunningService[]) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve) => {
        if (anyStartedServiceExited(started)) {
          resolve()
          return
        }

        const interval = setInterval(() => {
          if (anyStartedServiceExited(started)) {
            clearInterval(interval)
            resolve()
          }
        }, FOREGROUND_MONITOR_INTERVAL_MS)
      }),
    catch: (cause) =>
      toServiceRunnerError(
        "start",
        "runtime",
        cause instanceof Error ? cause.message : String(cause),
        "Foreground monitor failed while waiting for service exit.",
      ),
  })

const loadHookEnv = (
  environment: Environment,
  workspacePath: string,
  envLoader: EnvLoader,
) => {
  if (!environment.envFile) {
    return Effect.succeed({} as Readonly<Record<string, string>>)
  }

  return envLoader.load(environment.envFile, workspacePath)
}

const loadServiceEnv = (
  service: Service,
  environment: Environment,
  workspacePath: string,
  envLoader: EnvLoader,
) => {
  const envFile = service.envFile ?? environment.envFile
  if (!envFile) {
    return Effect.succeed({} as Readonly<Record<string, string>>)
  }

  return envLoader.load(envFile, workspacePath)
}

const readPidMap = (fileSystem: FileSystem, pidsPath: string) =>
  Effect.gen(function* () {
    const exists = yield* fileSystem.exists(pidsPath).pipe(
      Effect.mapError((error) =>
        toServiceRunnerError(
          "stop",
          "runtime",
          error.message,
          `Unable to check PID file at ${pidsPath}.`,
        ),
      ),
    )

    if (!exists) {
      return {} as PidMap
    }

    const raw = yield* fileSystem.read(pidsPath).pipe(
      Effect.mapError((error) =>
        toServiceRunnerError(
          "stop",
          "runtime",
          error.message,
          `Unable to read PID file at ${pidsPath}.`,
        ),
      ),
    )

    return yield* Effect.try({
      try: () => {
        const parsed = JSON.parse(raw) as unknown
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("Expected a JSON object keyed by service name.")
        }

        return parsed as PidMap
      },
      catch: (cause) =>
        toServiceRunnerError(
          "stop",
          "runtime",
          `Invalid PID file ${pidsPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
          "Fix or remove the PID file so rig can recreate it.",
        ),
    })
  })

const writePidMap = (fileSystem: FileSystem, pidsPath: string, pids: PidMap) =>
  fileSystem.write(pidsPath, `${JSON.stringify(pids, null, 2)}\n`).pipe(
    Effect.mapError((error) =>
      toServiceRunnerError(
        "stop",
        "runtime",
        error.message,
        `Unable to write PID file at ${pidsPath}.`,
      ),
    ),
  )

const readInstalledBinMap = (fileSystem: FileSystem, binsPath: string) =>
  Effect.gen(function* () {
    const exists = yield* fileSystem.exists(binsPath).pipe(
      Effect.mapError((error) =>
        toServiceRunnerError(
          "stop",
          "runtime",
          error.message,
          `Unable to check bin tracking file at ${binsPath}.`,
        ),
      ),
    )

    if (!exists) {
      return {} as InstalledBinMap
    }

    const raw = yield* fileSystem.read(binsPath).pipe(
      Effect.mapError((error) =>
        toServiceRunnerError(
          "stop",
          "runtime",
          error.message,
          `Unable to read bin tracking file at ${binsPath}.`,
        ),
      ),
    )

    return yield* Effect.try({
      try: () => {
        const parsed = JSON.parse(raw) as unknown
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("Expected a JSON object keyed by bin service name.")
        }

        return parsed as InstalledBinMap
      },
      catch: (cause) =>
        toServiceRunnerError(
          "stop",
          "runtime",
          `Invalid bin tracking file ${binsPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
          "Fix or remove the bin tracking file so rig can recreate it.",
        ),
    })
  })

const writeInstalledBinMap = (
  fileSystem: FileSystem,
  binsPath: string,
  bins: InstalledBinMap,
  operation: "start" | "stop",
) =>
  fileSystem.write(binsPath, `${JSON.stringify(bins, null, 2)}\n`).pipe(
    Effect.mapError((error) =>
      toServiceRunnerError(
        operation,
        "runtime",
        error.message,
        `Unable to write bin tracking file at ${binsPath}.`,
      ),
    ),
  )

const hookCommand = (
  hooks: TopLevelHooks | ServiceHooks | undefined,
  phase: HookPhase,
): string | null | undefined => hooks?.[phase]

const runHook = (
  command: string | null | undefined,
  phase: HookPhase,
  scope: string,
  workdir: string,
  envVars: Readonly<Record<string, string>>,
): Effect.Effect<void, ServiceRunnerError, HookRunner> => {
  if (!command || command.trim().length === 0) {
    return Effect.void
  }

  const operation = phase === "preStop" || phase === "postStop" ? "stop" : "start"

  return Effect.gen(function* () {
    const hookRunner = yield* HookRunner
    const result = yield* hookRunner.runHook(command, { workdir, env: envVars }).pipe(
      Effect.mapError((error) =>
        toServiceRunnerError(operation, scope, error.message, `Fix hook '${phase}' for ${scope} and retry.`),
      ),
    )

    if (result.exitCode !== 0) {
      const output = [result.stderr.trim(), result.stdout.trim()]
        .filter((chunk) => chunk.length > 0)
        .join(" | ")
      yield* Effect.fail(
        toServiceRunnerError(
          operation,
          scope,
          `Hook '${phase}' for ${scope} exited ${result.exitCode}${output.length > 0 ? `: ${output}` : ""}`,
          `Fix hook '${phase}' for ${scope} and retry.`,
        ),
      )
    }
  })
}

const orderServerServices = (
  configPath: string,
  services: readonly ServerService[],
) =>
  Effect.gen(function* () {
    const byName = new Map(services.map((service) => [service.name, service] as const))
    const state = new Map<string, "visiting" | "visited">()
    const ordered: ServerService[] = []

    const visit = (
      service: ServerService,
      chain: readonly string[],
    ): Effect.Effect<void, ConfigValidationError> =>
      Effect.gen(function* () {
        const current = state.get(service.name)
        if (current === "visited") {
          return
        }

        if (current === "visiting") {
          return yield* Effect.fail(
            configError(
              configPath,
              `Circular dependency detected: ${[...chain, service.name].join(" -> ")}.`,
              "Remove the cycle in services[].dependsOn.",
              { code: "lifecycle", path: ["environments", "services", service.name, "dependsOn"] },
            ),
          )
        }

        state.set(service.name, "visiting")

        for (const dependencyName of service.dependsOn ?? []) {
          const dependency = byName.get(dependencyName)
          if (!dependency) {
            return yield* Effect.fail(
              configError(
                configPath,
                `Service '${service.name}' depends on '${dependencyName}', but it is not a server service.`,
                "Ensure dependsOn only references server services in this environment.",
                { code: "lifecycle", path: ["environments", "services", service.name, "dependsOn"] },
              ),
            )
          }

          yield* visit(dependency, [...chain, service.name])
        }

        state.set(service.name, "visited")
        ordered.push(service)
      })

    for (const service of services) {
      yield* visit(service, [])
    }

    return ordered as readonly ServerService[]
  })

const parseStartedAt = (value: string): Date => {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed
}

const buildRunningService = (service: ServerService, pidEntry: PidEntry): RunningService => ({
  name: service.name,
  pid: pidEntry.pid,
  port: pidEntry.port,
  startedAt: parseStartedAt(pidEntry.startedAt),
})

const buildOrphanRunningService = (serviceName: string, pidEntry: PidEntry): RunningService => ({
  name: serviceName,
  pid: pidEntry.pid,
  port: pidEntry.port,
  startedAt: parseStartedAt(pidEntry.startedAt),
})

// Starts all services for an environment, including hooks and health checks,
// then persists runtime state for later stop/restart operations.
export const runStartCommand = (args: StartArgs) => {
  const started: RunningService[] = []
  const installedBins: Array<{ readonly name: string; readonly shimPath: string }> = []

  const program = Effect.gen(function* () {
    const logger = yield* Logger
    const workspace = yield* Workspace
    const serviceRunner = yield* ServiceRunner
    const healthChecker = yield* HealthChecker
    const processManager = yield* ProcessManager
    const envLoader = yield* EnvLoader
    const binInstaller = yield* BinInstaller
    const portChecker = yield* PortChecker
    const fileSystem = yield* FileSystem

    const loaded = yield* loadProjectConfig(args.name)
    const environment = yield* resolveEnvironment(loaded.configPath, loaded.config, args.env)
    yield* logger.info("Loaded configuration.", {
      name: args.name,
      env: args.env,
      services: environment.services.length,
    })
    const workspacePath = yield* workspace.resolve(args.name, args.env)
    const logDir = join(workspacePath, ".rig", "logs")

    const serverServices = environment.services.filter((service) => service.type === "server")

    for (const service of serverServices) {
      yield* portChecker.check(service.port, service.name)
    }

    // Start servers in dependency order so dependents only start after prerequisites.
    const orderedServerServices = yield* orderServerServices(loaded.configPath, serverServices)
    const binServices = environment.services.filter((service) => service.type === "bin")
    const hookEnv = yield* loadHookEnv(environment, workspacePath, envLoader)
    const projectPreStart = hookCommand(loaded.config.hooks, "preStart")

    if (projectPreStart && projectPreStart.trim().length > 0) {
      yield* logger.info("Running preStart hook...", { scope: "project" })
    }

    yield* runHook(
      projectPreStart,
      "preStart",
      `project:${args.name}`,
      workspacePath,
      hookEnv,
    )

    for (const service of orderedServerServices) {
      const envVars = yield* loadServiceEnv(service, environment, workspacePath, envLoader)
      const servicePreStart = hookCommand(service.hooks, "preStart")

      yield* runHook(
        servicePreStart,
        "preStart",
        `service:${service.name}`,
        workspacePath,
        envVars,
      )

      yield* logger.info("Starting service...", {
        service: service.name,
        port: service.port,
      })
      const running = yield* serviceRunner.start(service, {
        workdir: workspacePath,
        envVars,
        logDir,
      })
      started.push(running)

      if (service.healthCheck) {
        yield* logger.info("Waiting for health check...", {
          service: service.name,
          target: service.healthCheck,
        })
        yield* healthChecker.poll(
          {
            type: resolveCheckType(service.healthCheck),
            target: service.healthCheck,
            service: service.name,
          },
          HEALTH_POLL_INTERVAL_MS,
          service.readyTimeout * 1000,
        )
      }

      yield* runHook(
        hookCommand(service.hooks, "postStart"),
        "postStart",
        `service:${service.name}`,
        workspacePath,
        envVars,
      )

      yield* logger.info("Service running.", {
        service: running.name,
        pid: running.pid,
        port: running.port,
      })
    }

    const pidsPath = join(workspacePath, ".rig", "pids.json")
    const binsPath = join(workspacePath, ".rig", "bins.json")
    yield* fileSystem.mkdir(join(workspacePath, ".rig")).pipe(
      Effect.mapError((error) =>
        toServiceRunnerError("start", "runtime", error.message, `Unable to create .rig directory.`),
      ),
    )
    const pids: PidMap = {}
    for (const entry of started) {
      pids[entry.name] = { pid: entry.pid, port: entry.port, startedAt: entry.startedAt.toISOString() }
    }
    yield* writePidMap(fileSystem, pidsPath, pids)

    for (const service of binServices) {
      const envVars = yield* loadServiceEnv(service, environment, workspacePath, envLoader)
      const servicePreStart = hookCommand(service.hooks, "preStart")

      yield* runHook(
        servicePreStart,
        "preStart",
        `service:${service.name}`,
        workspacePath,
        envVars,
      )

      yield* logger.info("Installing binary...", { service: service.name })
      const builtPath = yield* binInstaller.build(service, workspacePath)
      const shimPath = yield* binInstaller.install(service.name, args.env, builtPath)
      installedBins.push({ name: service.name, shimPath })

      yield* runHook(
        hookCommand(service.hooks, "postStart"),
        "postStart",
        `service:${service.name}`,
        workspacePath,
        envVars,
      )

      yield* logger.info("Binary installed.", {
        service: service.name,
        shimPath,
      })
    }

    const bins: InstalledBinMap = {}
    for (const installed of installedBins) {
      bins[installed.name] = {
        installedAt: new Date().toISOString(),
        shimPath: installed.shimPath,
      }
    }
    yield* writeInstalledBinMap(fileSystem, binsPath, bins, "start")

    yield* runHook(
      hookCommand(loaded.config.hooks, "postStart"),
      "postStart",
      `project:${args.name}`,
      workspacePath,
      hookEnv,
    )

    const daemonStatus = yield* processManager.status(daemonLabel(args.name, args.env)).pipe(
      Effect.catchAll(() =>
        Effect.succeed({
          label: daemonLabel(args.name, args.env),
          running: false,
          pid: null,
          loaded: false,
        }),
      ),
    )

    yield* logger.success("Services started.", {
      name: args.name,
      env: args.env,
      foreground: args.foreground,
      serverServices: orderedServerServices.length,
      binServices: binServices.length,
      daemonLoaded: daemonStatus.loaded,
    })

    if (args.foreground) {
      yield* monitorForegroundServices(started)
    }

    return 0
  })

  return program.pipe(
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        const logger = yield* Logger
        const serviceRunner = yield* ServiceRunner
        const binInstaller = yield* BinInstaller
        const fileSystem = yield* FileSystem
        const workspace = yield* Workspace

        // Roll back in reverse start order to unwind dependency chains safely.
        for (const running of [...started].reverse()) {
          yield* serviceRunner.stop(running).pipe(
            Effect.catchAll((stopError) =>
              logger.warn("Failed to clean up partially started service.", {
                service: running.name,
                error: stopError instanceof Error ? stopError.message : String(stopError),
              }),
            ),
          )
        }

        if (started.length > 0) {
          const workspacePath = yield* workspace.resolve(args.name, args.env).pipe(
            Effect.catchAll((workspaceError) => {
              const message = workspaceError instanceof Error ? workspaceError.message : String(workspaceError)
              return logger.warn("Failed to resolve workspace for PID cleanup.", {
                name: args.name,
                env: args.env,
                error: message,
              })
            }),
          )

          if (typeof workspacePath === "string" && workspacePath.length > 0) {
            const pidsPath = join(workspacePath, ".rig", "pids.json")
            yield* fileSystem.remove(pidsPath).pipe(
              Effect.catchAll((removeError) =>
                logger.warn("Failed to clean up PID file after start rollback.", {
                  pidsPath,
                  error: removeError.message,
                }),
              ),
            )
          }
        }

        if (installedBins.length > 0) {
          for (const installed of [...installedBins].reverse()) {
            yield* binInstaller.uninstall(installed.name, args.env).pipe(
              Effect.catchAll((uninstallError) =>
                logger.warn("Failed to clean up partially installed binary after start rollback.", {
                  service: installed.name,
                  error:
                    uninstallError instanceof Error ? uninstallError.message : String(uninstallError),
                }),
              ),
            )
          }
        }

        return yield* Effect.fail(error)
      }),
    ),
  )
}

// Stops services for an environment, runs stop hooks, and cleans persisted
// runtime tracking while preserving the first failure after best-effort cleanup.
export const runStopCommand = (args: StopArgs) =>
  Effect.gen(function* () {
    const logger = yield* Logger
    const workspace = yield* Workspace
    const serviceRunner = yield* ServiceRunner
    const processManager = yield* ProcessManager
    const envLoader = yield* EnvLoader
    const binInstaller = yield* BinInstaller
    const fileSystem = yield* FileSystem

    const loaded = yield* loadProjectConfig(args.name)
    const environment = yield* resolveEnvironment(loaded.configPath, loaded.config, args.env)
    const workspacePath = yield* workspace.resolve(args.name, args.env)
    const pidsPath = join(workspacePath, ".rig", "pids.json")
    const binsPath = join(workspacePath, ".rig", "bins.json")
    const serverServices = environment.services.filter((service) => service.type === "server")
    const orderedServerServices = yield* orderServerServices(loaded.configPath, serverServices)
    // Stop in reverse dependency order so dependents exit before dependencies.
    const reverseServerServices = [...orderedServerServices].reverse()
    const hookEnv = yield* loadHookEnv(environment, workspacePath, envLoader)
    const projectPreStop = hookCommand(loaded.config.hooks, "preStop")

    // Keep the first failure but continue cleanup to leave the system consistent.
    let firstFailure: unknown | null = null
    const recordFailure = (error: unknown) => {
      if (!firstFailure) {
        firstFailure = error
      }
    }

    const label = daemonLabel(args.name, args.env)
    const daemon = yield* processManager.status(label).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    )

    // Uninstall daemon first so it does not immediately respawn processes being stopped.
    if (daemon?.loaded) {
      yield* processManager.uninstall(label).pipe(
        Effect.catchAll((error) =>
          logger.warn("Unable to uninstall daemon before shutdown.", {
            label,
            error: error.message,
          }),
        ),
      )
    }

    if (projectPreStop && projectPreStop.trim().length > 0) {
      yield* logger.info("Running preStop hook...", { scope: "project" })
    }

    yield* runHook(projectPreStop, "preStop", `project:${args.name}`, workspacePath, hookEnv)

    const pids = yield* readPidMap(fileSystem, pidsPath)
    const installedBins = yield* readInstalledBinMap(fileSystem, binsPath)
    const knownServiceNames = new Set(serverServices.map((service) => service.name))

    for (const service of reverseServerServices) {
      const pidEntry = pids[service.name]
      if (!pidEntry) {
        continue
      }

      const envVars = yield* loadServiceEnv(service, environment, workspacePath, envLoader)
      const servicePreStop = hookCommand(service.hooks, "preStop")

      if (servicePreStop && servicePreStop.trim().length > 0) {
        yield* logger.info("Running preStop hook...", { scope: `service:${service.name}` })
      }

      yield* runHook(
        servicePreStop,
        "preStop",
        `service:${service.name}`,
        workspacePath,
        envVars,
      ).pipe(
        Effect.catchAll((error) => {
          recordFailure(error)
          return logger.warn("Service preStop hook failed.", {
            service: service.name,
            error: error.message,
          })
        }),
      )

      yield* logger.info("Stopping service...", { service: service.name })
      let stopped = true
      yield* serviceRunner.stop(buildRunningService(service, pidEntry)).pipe(
        Effect.catchAll((error) => {
          stopped = false
          recordFailure(error)
          return logger.warn("Service stop failed.", {
            service: service.name,
            error: error.message,
          })
        }),
      )

      yield* runHook(
        hookCommand(service.hooks, "postStop"),
        "postStop",
        `service:${service.name}`,
        workspacePath,
        envVars,
      ).pipe(
        Effect.catchAll((error) => {
          recordFailure(error)
          return logger.warn("Service postStop hook failed.", {
            service: service.name,
            error: error.message,
          })
        }),
      )

      if (stopped) {
        delete pids[service.name]
      }
    }

    // Also stop stale PID entries that are no longer present in the current config.
    for (const [serviceName, pidEntry] of Object.entries(pids)) {
      if (knownServiceNames.has(serviceName)) {
        continue
      }

      yield* logger.info("Stopping service...", { service: serviceName })
      let stopped = true

      const orphanCleanup = serviceRunner.stop(buildOrphanRunningService(serviceName, pidEntry)).pipe(
        Effect.catchAll((error) => {
          stopped = false
          recordFailure(error)
          return logger.warn("Failed to stop orphaned process referenced in PID tracking.", {
            service: serviceName,
            pid: pidEntry.pid,
            error: error.message,
          })
        }),
      )

      yield* orphanCleanup

      if (stopped) {
        delete pids[serviceName]
        yield* logger.warn("Cleaned up orphaned PID entry not present in current config.", {
          service: serviceName,
          pid: pidEntry.pid,
        })
      }
    }

    const binServices = environment.services.filter((service) => service.type === "bin")
    for (const service of binServices) {
      if (!installedBins[service.name]) {
        continue
      }

      yield* binInstaller.uninstall(service.name, args.env).pipe(
        Effect.catchAll((error) => {
          recordFailure(error)
          return logger.warn("Binary uninstall failed.", {
            service: service.name,
            error: error.message,
          })
        }),
      )
      delete installedBins[service.name]
    }

    for (const serviceName of Object.keys(installedBins)) {
      yield* binInstaller.uninstall(serviceName, args.env).pipe(
        Effect.catchAll((error) => {
          recordFailure(error)
          return logger.warn("Binary uninstall failed for orphaned bin tracking entry.", {
            service: serviceName,
            error: error.message,
          })
        }),
      )
      delete installedBins[serviceName]
    }

    yield* writePidMap(fileSystem, pidsPath, pids).pipe(
      Effect.catchAll((error) => {
        recordFailure(error)
        return logger.warn("Failed to update PID tracking file.", { pidsPath, error: error.message })
      }),
    )
    yield* writeInstalledBinMap(fileSystem, binsPath, installedBins, "stop").pipe(
      Effect.catchAll((error) => {
        recordFailure(error)
        return logger.warn("Failed to update bin tracking file.", { binsPath, error: error.message })
      }),
    )

    yield* runHook(
      hookCommand(loaded.config.hooks, "postStop"),
      "postStop",
      `project:${args.name}`,
      workspacePath,
      hookEnv,
    ).pipe(
      Effect.catchAll((error) => {
        recordFailure(error)
        return logger.warn("Project postStop hook failed.", { name: args.name, error: error.message })
      }),
    )

    // Report one failure after all cleanup attempts have completed.
    if (firstFailure) {
      return yield* Effect.fail(firstFailure)
    }

    yield* logger.success("Services stopped.", {
      name: args.name,
      env: args.env,
      serviceCount: serverServices.length,
    })

    return 0
  })

// Restarts an environment by running stop followed by start in foreground mode off.
export const runRestartCommand = (args: RestartArgs) =>
  Effect.gen(function* () {
    yield* runStopCommand(args)
    yield* runStartCommand({
      ...args,
      foreground: false,
    })

    return 0
  })
