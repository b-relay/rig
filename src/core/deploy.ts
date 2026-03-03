import { Effect } from "effect"

import { Logger } from "../interfaces/logger.js"
import { ProcessManager } from "../interfaces/process-manager.js"
import { ReverseProxy } from "../interfaces/reverse-proxy.js"
import { Workspace } from "../interfaces/workspace.js"
import type { DeployArgs } from "../schema/args.js"
import { loadProjectConfig, resolveEnvironment } from "./config.js"

export const runDeployCommand = (args: DeployArgs) =>
  Effect.gen(function* () {
    const logger = yield* Logger
    const workspace = yield* Workspace
    const reverseProxy = yield* ReverseProxy
    const processManager = yield* ProcessManager

    const loaded = yield* loadProjectConfig(args.name)
    const environment = yield* resolveEnvironment(loaded.configPath, loaded.config, args.env)
    const workspacePath = yield* workspace.resolve(args.name, args.env)
    const proxyEntries = yield* reverseProxy.read()
    const daemonStatus = yield* processManager.status(`rig.${args.name}.${args.env}`)

    yield* logger.success("Deploy plan resolved.", {
      name: args.name,
      env: args.env,
      repoPath: loaded.repoPath,
      workspacePath,
      serviceCount: environment.services.length,
      proxyEntries: proxyEntries.length,
      daemonLoaded: daemonStatus.loaded,
    })

    return 0
  })
