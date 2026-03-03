import { join } from "node:path"
import { Effect } from "effect"

import { BinInstaller } from "../interfaces/bin-installer.js"
import { HealthChecker } from "../interfaces/health-checker.js"
import { Logger } from "../interfaces/logger.js"
import { ProcessManager } from "../interfaces/process-manager.js"
import { ServiceRunner } from "../interfaces/service-runner.js"
import { Workspace } from "../interfaces/workspace.js"
import type { RestartArgs, StartArgs, StopArgs } from "../schema/args.js"
import { loadProjectConfig, resolveEnvironment } from "./config.js"

const resolveCheckType = (target: string): "http" | "command" =>
  target.startsWith("http://") || target.startsWith("https://") ? "http" : "command"

export const runStartCommand = (args: StartArgs) =>
  Effect.gen(function* () {
    const logger = yield* Logger
    const workspace = yield* Workspace
    const serviceRunner = yield* ServiceRunner
    const healthChecker = yield* HealthChecker
    const processManager = yield* ProcessManager
    const binInstaller = yield* BinInstaller

    const loaded = yield* loadProjectConfig(args.name)
    const environment = yield* resolveEnvironment(loaded.configPath, loaded.config, args.env)
    const workspacePath = yield* workspace.resolve(args.name, args.env)
    const logDir = join(workspacePath, ".rig", "logs")

    const serverServices = environment.services.filter((service) => service.type === "server")
    const binServices = environment.services.filter((service) => service.type === "bin")

    for (const service of serverServices) {
      const started = yield* serviceRunner.start(service, {
        workdir: workspacePath,
        envVars: {},
        logDir,
      })

      if (service.healthCheck) {
        yield* healthChecker.check({
          type: resolveCheckType(service.healthCheck),
          target: service.healthCheck,
          service: service.name,
        })
      }

      yield* logger.info("Service running.", {
        service: started.name,
        pid: started.pid,
        port: started.port,
      })
    }

    for (const service of binServices) {
      const builtPath = yield* binInstaller.build(service, workspacePath)
      const shimPath = yield* binInstaller.install(service.name, args.env, builtPath)

      yield* logger.info("Binary installed.", {
        service: service.name,
        shimPath,
      })
    }

    const daemonStatus = yield* processManager.status(`rig.${args.name}.${args.env}`)

    yield* logger.success("Services started.", {
      name: args.name,
      env: args.env,
      foreground: args.foreground,
      serverServices: serverServices.length,
      binServices: binServices.length,
      daemonLoaded: daemonStatus.loaded,
    })

    return 0
  })

export const runStopCommand = (args: StopArgs) =>
  Effect.gen(function* () {
    const logger = yield* Logger
    const processManager = yield* ProcessManager
    const binInstaller = yield* BinInstaller

    const loaded = yield* loadProjectConfig(args.name)
    const environment = yield* resolveEnvironment(loaded.configPath, loaded.config, args.env)

    for (const service of environment.services) {
      if (service.type === "bin") {
        yield* binInstaller.uninstall(service.name, args.env)
      }
    }

    yield* processManager.stop(`rig.${args.name}.${args.env}`)

    yield* logger.success("Services stopped.", {
      name: args.name,
      env: args.env,
      serviceCount: environment.services.length,
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
