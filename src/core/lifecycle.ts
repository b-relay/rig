import { join } from "node:path"
import { Effect } from "effect"

import { BinInstaller } from "../interfaces/bin-installer.js"
import { EnvLoader } from "../interfaces/env-loader.js"
import { FileSystem } from "../interfaces/file-system.js"
import { HealthChecker } from "../interfaces/health-checker.js"
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

type HookPhase = "preStart" | "postStart" | "preStop" | "postStop"

interface PidEntry {
  readonly pid: number
  readonly port: number
  readonly startedAt: string
}

type PidMap = Record<string, PidEntry>

const HEALTH_POLL_INTERVAL_MS = 500

const resolveCheckType = (target: string): "http" | "command" =>
  target.startsWith("http://") || target.startsWith("https://") ? "http" : "command"

const daemonLabel = (name: string, env: "dev" | "prod") => `rig.${name}.${env}`

const configError = (
  configPath: string,
  message: string,
  hint: string,
  path: readonly (string | number)[] = [],
) =>
  new ConfigValidationError(configPath, [{ path, message, code: "lifecycle" }], message, hint)

const toServiceRunnerError = (
  operation: "start" | "stop",
  service: string,
  message: string,
  hint: string,
) => new ServiceRunnerError(operation, service, message, hint)

const mergeRuntimeEnv = (
  envVars: Readonly<Record<string, string>>,
): Record<string, string> => {
  const merged: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      merged[key] = value
    }
  }

  for (const [key, value] of Object.entries(envVars)) {
    merged[key] = value
  }

  return merged
}

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
) => {
  if (!command || command.trim().length === 0) {
    return Effect.void
  }

  const operation = phase === "preStop" || phase === "postStop" ? "stop" : "start"

  return Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn(["sh", "-c", command], {
        cwd: workdir,
        env: mergeRuntimeEnv(envVars),
        stdout: "pipe",
        stderr: "pipe",
      })

      const [stdout, stderr, exitCode] = await Promise.all([
        child.stdout ? new Response(child.stdout).text() : Promise.resolve(""),
        child.stderr ? new Response(child.stderr).text() : Promise.resolve(""),
        child.exited,
      ])

      if (exitCode !== 0) {
        const output = [stderr.trim(), stdout.trim()].filter((chunk) => chunk.length > 0).join(" | ")
        throw new Error(
          `Hook '${phase}' for ${scope} exited ${exitCode}${output.length > 0 ? `: ${output}` : ""}`,
        )
      }
    },
    catch: (cause) =>
      toServiceRunnerError(
        operation,
        scope,
        cause instanceof Error ? cause.message : String(cause),
        `Fix hook '${phase}' for ${scope} and retry.`,
      ),
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
              ["environments", "services", service.name, "dependsOn"],
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
                ["environments", "services", service.name, "dependsOn"],
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

const buildRunningService = (service: ServerService, pidEntry: PidEntry): RunningService => {
  const parsed = new Date(pidEntry.startedAt)
  const startedAt = Number.isNaN(parsed.getTime()) ? new Date(0) : parsed

  return {
    name: service.name,
    pid: pidEntry.pid,
    port: pidEntry.port,
    startedAt,
  }
}

export const runStartCommand = (args: StartArgs) => {
  const started: RunningService[] = []

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
    const workspacePath = yield* workspace.resolve(args.name, args.env)
    const logDir = join(workspacePath, ".rig", "logs")

    const serverServices = environment.services.filter((service) => service.type === "server")

    for (const service of serverServices) {
      yield* portChecker.check(service.port, service.name)
    }

    const orderedServerServices = yield* orderServerServices(loaded.configPath, serverServices)
    const binServices = environment.services.filter((service) => service.type === "bin")
    const hookEnv = yield* loadHookEnv(environment, workspacePath, envLoader)

    yield* runHook(
      hookCommand(loaded.config.hooks, "preStart"),
      "preStart",
      `project:${args.name}`,
      workspacePath,
      hookEnv,
    )

    for (const service of orderedServerServices) {
      const envVars = yield* loadServiceEnv(service, environment, workspacePath, envLoader)

      yield* runHook(
        hookCommand(service.hooks, "preStart"),
        "preStart",
        `service:${service.name}`,
        workspacePath,
        envVars,
      )

      const running = yield* serviceRunner.start(service, {
        workdir: workspacePath,
        envVars,
        logDir,
      })
      started.push(running)

      if (service.healthCheck) {
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

      yield* runHook(
        hookCommand(service.hooks, "preStart"),
        "preStart",
        `service:${service.name}`,
        workspacePath,
        envVars,
      )

      const builtPath = yield* binInstaller.build(service, workspacePath)
      const shimPath = yield* binInstaller.install(service.name, args.env, builtPath)

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

    return 0
  })

  return program.pipe(
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        const logger = yield* Logger
        const serviceRunner = yield* ServiceRunner
        const fileSystem = yield* FileSystem
        const workspace = yield* Workspace

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

        return yield* Effect.fail(error)
      }),
    ),
  )
}

export const runStopCommand = (args: StopArgs) =>
  Effect.gen(function* () {
    const logger = yield* Logger
    const workspace = yield* Workspace
    const serviceRunner = yield* ServiceRunner
    const processManager = yield* ProcessManager
    const envLoader = yield* EnvLoader
    const fileSystem = yield* FileSystem

    const loaded = yield* loadProjectConfig(args.name)
    const environment = yield* resolveEnvironment(loaded.configPath, loaded.config, args.env)
    const workspacePath = yield* workspace.resolve(args.name, args.env)
    const pidsPath = join(workspacePath, ".rig", "pids.json")
    const serverServices = environment.services.filter((service) => service.type === "server")
    const orderedServerServices = yield* orderServerServices(loaded.configPath, serverServices)
    const reverseServerServices = [...orderedServerServices].reverse()
    const hookEnv = yield* loadHookEnv(environment, workspacePath, envLoader)

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

    if (daemon?.running) {
      yield* processManager.stop(label).pipe(
        Effect.catchAll((error) =>
          logger.warn("Unable to stop daemon before shutdown.", {
            label,
            error: error.message,
          }),
        ),
      )
    }

    yield* runHook(
      hookCommand(loaded.config.hooks, "preStop"),
      "preStop",
      `project:${args.name}`,
      workspacePath,
      hookEnv,
    )

    const pids = yield* readPidMap(fileSystem, pidsPath)
    const knownServiceNames = new Set(serverServices.map((service) => service.name))

    for (const service of reverseServerServices) {
      const pidEntry = pids[service.name]
      if (!pidEntry) {
        continue
      }

      const envVars = yield* loadServiceEnv(service, environment, workspacePath, envLoader)

      yield* runHook(
        hookCommand(service.hooks, "preStop"),
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

      yield* serviceRunner.stop(buildRunningService(service, pidEntry)).pipe(
        Effect.catchAll((error) => {
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

      delete pids[service.name]
    }

    for (const [serviceName, pidEntry] of Object.entries(pids)) {
      if (knownServiceNames.has(serviceName)) {
        continue
      }

      delete pids[serviceName]

      const orphanCleanup = Effect.try({
        try: () => {
          process.kill(pidEntry.pid, "SIGTERM")
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catchAll((cause) => {
          const code =
            typeof cause === "object" && cause !== null && "code" in cause
              ? String((cause as { code?: unknown }).code)
              : ""
          const message = cause instanceof Error ? cause.message : String(cause)

          if (code !== "ESRCH") {
            recordFailure(
              toServiceRunnerError(
                "stop",
                serviceName,
                message,
                "Unable to stop orphaned process referenced in PID tracking.",
              ),
            )
          }

          return Effect.void
        }),
      )

      yield* orphanCleanup

      yield* logger.warn("Cleaned up orphaned PID entry not present in current config.", {
        service: serviceName,
        pid: pidEntry.pid,
      })
    }

    yield* writePidMap(fileSystem, pidsPath, pids).pipe(
      Effect.catchAll((error) => {
        recordFailure(error)
        return logger.warn("Failed to update PID tracking file.", { pidsPath, error: error.message })
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

export const runRestartCommand = (args: RestartArgs) =>
  Effect.gen(function* () {
    yield* runStopCommand(args)
    yield* runStartCommand({
      ...args,
      foreground: false,
    })

    return 0
  })
