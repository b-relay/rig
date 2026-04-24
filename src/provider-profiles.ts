import { Effect, Layer } from "effect"

import { BinInstaller } from "./interfaces/bin-installer.js"
import { EnvLoader } from "./interfaces/env-loader.js"
import { Git } from "./interfaces/git.js"
import { HealthChecker } from "./interfaces/health-checker.js"
import { Logger } from "./interfaces/logger.js"
import { ProcessManager } from "./interfaces/process-manager.js"
import { ReverseProxy } from "./interfaces/reverse-proxy.js"
import { ServiceRunner } from "./interfaces/service-runner.js"
import { Workspace } from "./interfaces/workspace.js"
import { BunBinInstallerLive } from "./providers/bun-bin"
import { BunGitLive } from "./providers/bun-git"
import { BunHookRunnerLive } from "./providers/bun-hook-runner"
import { BunPortCheckerLive } from "./providers/bun-port-checker"
import { CaddyProxyLive } from "./providers/caddy"
import { CompositeLoggerLive } from "./providers/composite-logger"
import { DotenvLoaderLive } from "./providers/dotenv-loader"
import { FileLoggerLive } from "./providers/file-logger"
import { DispatchHealthCheckerLive } from "./providers/health-checker-dispatch"
import { JsonLoggerLive } from "./providers/json-logger"
import { JSONRegistryLive } from "./providers/json-registry"
import { LaunchdManagerLive } from "./providers/launchd"
import { NodeFileSystemLive } from "./providers/node-fs"
import { SmokeProcessManagerLive } from "./providers/smoke-process-manager"
import { StubBinInstaller } from "./providers/stub-bin-installer"
import { StubGit } from "./providers/stub-git"
import { StubHealthChecker } from "./providers/stub-health-checker"
import { StubHookRunnerLive } from "./providers/stub-hook-runner"
import { StubPortCheckerLive } from "./providers/stub-port-checker"
import { StubProcessManager } from "./providers/stub-process-manager"
import { StubReverseProxy } from "./providers/stub-reverse-proxy"
import { StubServiceRunner } from "./providers/stub-service-runner"
import { StubWorkspace } from "./providers/stub-workspace"
import { TerminalLogger, TerminalLoggerLive } from "./providers/terminal-logger"
import { BunServiceRunnerLive } from "./providers/bun-service-runner"
import { GitWorktreeWorkspaceLive } from "./providers/worktree"

export type RigProviderProfile = "default" | "stub" | "smoke"

export const normalizeRigProviderProfile = (value: string | undefined): RigProviderProfile =>
  value === "stub" || value === "smoke" ? value : "default"

export const buildLoggerLayer = (verbose = false, json = false): Layer.Layer<Logger> => {
  const primaryLayer =
    json || process.env.RIG_LOG_FORMAT === "json"
      ? JsonLoggerLive
      : verbose
        ? Layer.succeed(Logger, new TerminalLogger(true))
        : TerminalLoggerLive
  const logFilePath = process.env.RIG_LOG_FILE

  if (!logFilePath) {
    return primaryLayer
  }

  return CompositeLoggerLive(
    primaryLayer,
    Layer.provide(FileLoggerLive(logFilePath), NodeFileSystemLive),
  )
}

const DotenvWithFileSystemLive = Layer.provide(DotenvLoaderLive, NodeFileSystemLive)
const RegistryWithFileSystemLive = Layer.provide(JSONRegistryLive, NodeFileSystemLive)
const BinInstallerWithFileSystemLive = Layer.provide(BunBinInstallerLive, NodeFileSystemLive)
const WorkspaceWithDependenciesLive = Layer.provide(
  GitWorktreeWorkspaceLive,
  Layer.mergeAll(BunGitLive, NodeFileSystemLive, RegistryWithFileSystemLive),
)

const StubEnvLoaderLive = Layer.succeed(EnvLoader, {
  load: () => Effect.succeed({}),
})

const buildDefaultRigLayer = (loggerLayer: Layer.Layer<Logger>) => {
  const serviceRunnerWithFileSystemLive = Layer.provide(
    BunServiceRunnerLive,
    Layer.mergeAll(NodeFileSystemLive, loggerLayer),
  )

  return Layer.mergeAll(
    NodeFileSystemLive,
    DotenvWithFileSystemLive,
    RegistryWithFileSystemLive,
    BunGitLive,
    BunHookRunnerLive,
    BunPortCheckerLive,
    CaddyProxyLive,
    LaunchdManagerLive,
    WorkspaceWithDependenciesLive,
    DispatchHealthCheckerLive,
    serviceRunnerWithFileSystemLive,
    BinInstallerWithFileSystemLive,
    loggerLayer,
  )
}

const buildStubRigLayer = (loggerLayer: Layer.Layer<Logger>) =>
  Layer.mergeAll(
    NodeFileSystemLive,
    RegistryWithFileSystemLive,
    StubHookRunnerLive,
    StubPortCheckerLive,
    Layer.succeed(Git, new StubGit()),
    Layer.succeed(ReverseProxy, new StubReverseProxy()),
    Layer.succeed(ProcessManager, new StubProcessManager()),
    Layer.succeed(Workspace, new StubWorkspace()),
    Layer.succeed(ServiceRunner, new StubServiceRunner()),
    Layer.succeed(HealthChecker, new StubHealthChecker()),
    Layer.succeed(BinInstaller, new StubBinInstaller()),
    StubEnvLoaderLive,
    loggerLayer,
  )

const buildSmokeRigLayer = (loggerLayer: Layer.Layer<Logger>) => {
  const serviceRunnerWithFileSystemLive = Layer.provide(
    BunServiceRunnerLive,
    Layer.mergeAll(NodeFileSystemLive, loggerLayer),
  )

  return Layer.mergeAll(
    NodeFileSystemLive,
    DotenvWithFileSystemLive,
    RegistryWithFileSystemLive,
    BunGitLive,
    BunHookRunnerLive,
    BunPortCheckerLive,
    CaddyProxyLive,
    SmokeProcessManagerLive,
    WorkspaceWithDependenciesLive,
    DispatchHealthCheckerLive,
    serviceRunnerWithFileSystemLive,
    BinInstallerWithFileSystemLive,
    loggerLayer,
  )
}

export const buildRigLayer = (
  verbose = false,
  json = false,
  profile: RigProviderProfile = normalizeRigProviderProfile(process.env.RIG_PROVIDER_PROFILE),
) => {
  const loggerLayer = buildLoggerLayer(verbose, json)

  if (profile === "stub") {
    return buildStubRigLayer(loggerLayer)
  }

  if (profile === "smoke") {
    return buildSmokeRigLayer(loggerLayer)
  }

  return buildDefaultRigLayer(loggerLayer)
}
