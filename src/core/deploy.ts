import { join } from "node:path"
import { Effect } from "effect"

import { Logger } from "../interfaces/logger.js"
import { ProcessManager } from "../interfaces/process-manager.js"
import { ReverseProxy, type ProxyEntry } from "../interfaces/reverse-proxy.js"
import { Workspace } from "../interfaces/workspace.js"
import type { DeployArgs } from "../schema/args.js"
import type { Environment, RigConfig, ServerService } from "../schema/config.js"
import { ConfigValidationError } from "../schema/errors.js"
import { loadProjectConfig, resolveEnvironment } from "./config.js"

const daemonLabel = (name: string, env: "dev" | "prod") => `rig.${name}.${env}`

const envFlag = (env: "dev" | "prod") => (env === "dev" ? "--dev" : "--prod")

const configError = (
  configPath: string,
  message: string,
  hint: string,
  path: readonly (string | number)[] = [],
) =>
  new ConfigValidationError(configPath, [{ path, message, code: "deploy" }], message, hint)

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
        ["environments", env, "proxy", "upstream"],
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
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  "operation" in error &&
  "message" in error &&
  (error as { _tag: unknown })._tag === "WorkspaceError" &&
  (error as { operation: unknown }).operation === "create" &&
  typeof (error as { message: unknown }).message === "string" &&
  (error as { message: string }).message.includes("already exists")

const isMissingDaemonInstall = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  "operation" in error &&
  "message" in error &&
  (error as { _tag: unknown })._tag === "ProcessError" &&
  (error as { operation: unknown }).operation === "uninstall" &&
  typeof (error as { message: unknown }).message === "string" &&
  ((error as { message: string }).message.includes("ENOENT") ||
    (error as { message: string }).message.toLowerCase().includes("no such file"))

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

    if (desiredProxyEntry) {
      const existingEntries = yield* reverseProxy.read()
      const existing = existingEntries.find(
        (entry) => entry.name === args.name && entry.env === args.env,
      )

      if (!existing) {
        yield* reverseProxy.add(desiredProxyEntry)
      } else if (hasChanged(existing, desiredProxyEntry)) {
        yield* reverseProxy.update(desiredProxyEntry)
      }
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
