import { join } from "node:path"
import { Effect } from "effect"

import { Logger } from "../interfaces/logger.js"
import { ProcessManager } from "../interfaces/process-manager.js"
import { ReverseProxy, type ProxyEntry } from "../interfaces/reverse-proxy.js"
import { Workspace } from "../interfaces/workspace.js"
import type { DeployArgs } from "../schema/args.js"
import type { Environment, RigConfig, ServerService } from "../schema/config.js"
import { ConfigValidationError, ProcessError, WorkspaceError } from "../schema/errors.js"
import { loadProjectConfig, resolveEnvironment } from "./config.js"
import { configError, daemonLabel } from "./shared.js"

const envFlag = (env: "dev" | "prod") => (env === "dev" ? "--dev" : "--prod")

const hasChanged = (current: ProxyEntry, next: ProxyEntry): boolean =>
  current.domain !== next.domain ||
  current.port !== next.port ||
  current.upstream !== next.upstream

const computeProxyEntry = (
  configPath: string,
  config: RigConfig,
  env: "dev" | "prod",
  environment: Environment,
  name: string,
): Effect.Effect<ProxyEntry | null, ConfigValidationError> => {
  if (!config.domain || !environment.proxy) {
    return Effect.succeed(null)
  }

  const upstreamName = environment.proxy.upstream
  const upstream = environment.services.find(
    (service): service is ServerService =>
      service.name === upstreamName && service.type === "server",
  )

  if (!upstream) {
    return Effect.fail(
      configError(
        configPath,
        `Proxy upstream '${upstreamName}' must reference a server service.`,
        "Set environments.<env>.proxy.upstream to a server service name.",
        { code: "deploy", path: ["environments", env, "proxy", "upstream"] },
      ),
    )
  }

  const domain = env === "dev" ? `dev.${config.domain}` : config.domain

  return Effect.succeed({
    name,
    env,
    domain,
    upstream: upstream.name,
    port: upstream.port,
  })
}

const isWorkspaceAlreadyCreated = (error: unknown): boolean =>
  error instanceof WorkspaceError &&
  error.operation === "create" &&
  error.message.includes("already exists")

const isMissingDaemonInstall = (error: unknown): boolean =>
  error instanceof ProcessError &&
  error.operation === "uninstall" &&
  (error.message.includes("ENOENT") || error.message.toLowerCase().includes("no such file"))

export const runDeployCommand = (args: DeployArgs) =>
  Effect.gen(function* () {
    const logger = yield* Logger
    const workspace = yield* Workspace
    const reverseProxy = yield* ReverseProxy
    const processManager = yield* ProcessManager

    const loaded = yield* loadProjectConfig(args.name)
    const environment = yield* resolveEnvironment(loaded.configPath, loaded.config, args.env)

    if (args.env === "dev") {
      yield* workspace.create(args.name, "dev", loaded.config.version, loaded.repoPath)
      yield* workspace.sync(args.name, "dev")
    } else {
      yield* workspace
        .create(args.name, "prod", loaded.config.version, `v${loaded.config.version}`)
        .pipe(
          Effect.catchAll((error) =>
            isWorkspaceAlreadyCreated(error) ? Effect.void : Effect.fail(error),
          ),
        )
    }

    const workspacePath = yield* workspace.resolve(args.name, args.env)

    const desiredProxyEntry = yield* computeProxyEntry(
      loaded.configPath,
      loaded.config,
      args.env,
      environment,
      args.name,
    )

    const existingEntries = yield* reverseProxy.read()
    const existingProxyEntry = existingEntries.find(
      (entry) => entry.name === args.name && entry.env === args.env,
    )

    if (desiredProxyEntry) {
      if (!existingProxyEntry) {
        yield* reverseProxy.add(desiredProxyEntry)
      } else if (hasChanged(existingProxyEntry, desiredProxyEntry)) {
        yield* reverseProxy.update(desiredProxyEntry)
      }
    } else if (existingProxyEntry) {
      yield* reverseProxy.remove(args.name, args.env)
    }

    const label = daemonLabel(args.name, args.env)
    const daemonEnabled = loaded.config.daemon?.enabled === true

    if (daemonEnabled) {
      yield* processManager.install({
        label,
        command: "rig",
        args: ["start", args.name, envFlag(args.env), "--foreground"],
        keepAlive: loaded.config.daemon?.keepAlive ?? false,
        envVars: {},
        workdir: workspacePath,
        logPath: join(workspacePath, ".rig", "logs", "daemon.log"),
      })
    } else {
      yield* processManager.uninstall(label).pipe(
        Effect.catchAll((error) =>
          isMissingDaemonInstall(error) ? Effect.void : Effect.fail(error),
        ),
      )
    }

    yield* logger.success("Deploy applied.", {
      name: args.name,
      env: args.env,
      repoPath: loaded.repoPath,
      workspacePath,
      serviceCount: environment.services.length,
      proxyConfigured: desiredProxyEntry !== null,
      daemonEnabled,
    })

    return 0
  })
