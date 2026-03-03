import { Effect } from "effect"

import { Logger } from "../interfaces/logger.js"
import { ProcessManager } from "../interfaces/process-manager.js"
import { Registry } from "../interfaces/registry.js"
import type { StatusArgs } from "../schema/args.js"
import { loadProjectConfig, resolveEnvironment } from "./config.js"

const daemonLabel = (name: string, env: "dev" | "prod") => `rig.${name}.${env}`

export const runStatusCommand = (args: StatusArgs) =>
  Effect.gen(function* () {
    const logger = yield* Logger
    const processManager = yield* ProcessManager
    const registry = yield* Registry

    if (!args.name) {
      const entries = yield* registry.list()
      const rows = yield* Effect.forEach(entries, (entry) =>
        Effect.gen(function* () {
          const dev = yield* processManager.status(daemonLabel(entry.name, "dev"))
          const prod = yield* processManager.status(daemonLabel(entry.name, "prod"))

          return {
            name: entry.name,
            devRunning: dev.running,
            prodRunning: prod.running,
            repoPath: entry.repoPath,
          }
        }),
      )

      yield* logger.table(rows)
      return 0
    }

    const name = args.name
    const loaded = yield* loadProjectConfig(name)
    const envs = args.env ? [args.env] : (["dev", "prod"] as const)

    const rows = yield* Effect.forEach(envs, (env) =>
      Effect.gen(function* () {
        const environment = yield* resolveEnvironment(loaded.configPath, loaded.config, env)
        const daemon = yield* processManager.status(daemonLabel(name, env))

        return {
          name,
          env,
          services: environment.services.length,
          daemonLoaded: daemon.loaded,
          daemonRunning: daemon.running,
          pid: daemon.pid,
        }
      }),
    )

    yield* logger.table(rows)
    return 0
  })
