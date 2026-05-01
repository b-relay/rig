import { join } from "node:path"
import { Context, Effect, Layer, Stdio, Stream } from "effect"
import { BunStdio } from "@effect/platform-bun"

import { RigDefaultControlPlaneLive } from "./control-plane.js"
import { RigConfigEditorLive, RigConfigFileStoreLive } from "./config-editor.js"
import type { RigTaggedError } from "./errors.js"
import { RigFileHomeConfigStoreLive, RigHomeConfigStore, type RigHomeConfig } from "./home-config.js"
import { RigProviderContractsLive, type RigProviderContractsOptions } from "./provider-contracts.js"
import { RigProviderProfileLive } from "./provider-profiles.js"
import { RigProjectConfigLoaderLive } from "./project-config-loader.js"
import { RigProjectInitializerLive } from "./project-initializer.js"
import { RigProjectLocatorLive } from "./project-locator.js"
import { RigdActionPreflightLive } from "./rigd-actions.js"
import { RigFileRigdStateStoreLive } from "./rigd-state.js"
import { RigRuntimeExecutorLive } from "./runtime-executor.js"
import {
  RIG_LAUNCHD_LABEL_PREFIX,
  RIG_NAMESPACE,
  RIG_PROXY_NAMESPACE,
  rigLogsRoot,
  rigProjectNamespace,
  rigProxyRoot,
  rigRoot,
  rigRuntimeRoot,
  rigWorkspacesRoot,
} from "./paths.js"

export interface RigFoundationState {
  readonly project: string
  readonly namespace: string
  readonly stateRoot: string
  readonly registryPath: string
  readonly workspacesRoot: string
  readonly projectWorkspaceRoot: string
  readonly logsRoot: string
  readonly projectLogRoot: string
  readonly runtimeRoot: string
  readonly runtimeStatePath: string
  readonly proxyRoot: string
  readonly proxyNamespace: string
  readonly launchdLabelPrefix: string
  readonly launchdBackupRoot: string
}

export interface RigRuntimeService {
  readonly describeFoundation: (input: {
    readonly project: string
    readonly stateRoot: string
  }) => Effect.Effect<RigFoundationState>
}

export const RigRuntime = Context.Service<RigRuntimeService>("rig/rig/RigRuntime")

export const RigRuntimeLive = Layer.succeed(RigRuntime, {
  describeFoundation: ({ project, stateRoot }) =>
    Effect.succeed({
      project,
      namespace: rigProjectNamespace(project),
      stateRoot,
      registryPath: join(stateRoot, "registry.json"),
      workspacesRoot: join(stateRoot, "workspaces"),
      projectWorkspaceRoot: join(stateRoot, "workspaces", project),
      logsRoot: join(stateRoot, "logs"),
      projectLogRoot: join(stateRoot, "logs", project),
      runtimeRoot: join(stateRoot, "runtime"),
      runtimeStatePath: join(stateRoot, "runtime", "runtime.json"),
      proxyRoot: join(stateRoot, "proxy"),
      proxyNamespace: RIG_PROXY_NAMESPACE,
      launchdLabelPrefix: RIG_LAUNCHD_LABEL_PREFIX,
      launchdBackupRoot: join(stateRoot, "launchd"),
    } satisfies RigFoundationState),
})

export interface RigLoggerService {
  readonly info: (message: string, details?: unknown) => Effect.Effect<void>
  readonly error: (error: RigTaggedError) => Effect.Effect<void>
}

export const RigLogger = Context.Service<RigLoggerService>("rig/rig/RigLogger")

const writeLine = (stream: "stdout" | "stderr", value: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    const sink = stream === "stdout" ? stdio.stdout({ endOnDone: false }) : stdio.stderr({ endOnDone: false })
    yield* Stream.run(Stream.make(`${value}\n`), sink)
  }).pipe(
    Effect.provide(BunStdio.layer),
    Effect.orDie,
  )

const renderDetails = (details: unknown): string =>
  details === undefined ? "" : ` ${JSON.stringify(details)}`

export const RigLoggerLive = Layer.succeed(RigLogger, {
  info: (message, details) => writeLine("stdout", `[INFO] ${message}${renderDetails(details)}`),
  error: (error) =>
    writeLine(
      "stderr",
      `[ERROR] ${error.message} ${JSON.stringify({
        type: error._tag,
        hint: error.hint,
        ...(error.details ? { details: error.details } : {}),
      })}`,
    ),
})

const rigProviderOptionsFromHomeConfig = (config: RigHomeConfig): RigProviderContractsOptions => ({
  proxyRouter: {
    ...(config.providers.caddy.caddyfile ? { caddyfile: config.providers.caddy.caddyfile } : {}),
    extraConfig: config.providers.caddy.extraConfig,
    reload: config.providers.caddy.reload,
  },
})

export const RigProviderContractsFromHomeConfigLive = Layer.unwrap(Effect.gen(function* () {
  const homeConfigStore = yield* RigHomeConfigStore
  const homeConfig = yield* homeConfigStore.read({ stateRoot: rigRoot() })
  return RigProviderContractsLive(
    homeConfig.providers.defaultProfile,
    [],
    rigProviderOptionsFromHomeConfig(homeConfig),
  )
}))

const RigConfiguredProviderContractsLive = Layer.provide(
  RigProviderContractsFromHomeConfigLive,
  RigFileHomeConfigStoreLive,
)

export const RigLive = Layer.mergeAll(
  RigRuntimeLive,
  RigLoggerLive,
  RigProviderProfileLive(),
  RigFileRigdStateStoreLive,
  RigFileHomeConfigStoreLive,
  RigConfiguredProviderContractsLive,
  RigDefaultControlPlaneLive,
  RigdActionPreflightLive,
  Layer.provide(RigRuntimeExecutorLive, RigConfiguredProviderContractsLive),
  Layer.provide(RigConfigEditorLive, RigConfigFileStoreLive),
  Layer.provide(RigProjectConfigLoaderLive, Layer.provide(RigConfigEditorLive, RigConfigFileStoreLive)),
  Layer.provide(RigProjectInitializerLive, RigFileRigdStateStoreLive),
  RigProjectLocatorLive,
)

export const rigNamespaceSummary = () => ({
  namespace: RIG_NAMESPACE,
  stateRoot: rigRoot(),
  workspacesRoot: rigWorkspacesRoot(),
  logsRoot: rigLogsRoot(),
  runtimeRoot: rigRuntimeRoot(),
  proxyRoot: rigProxyRoot(),
  launchdLabelPrefix: RIG_LAUNCHD_LABEL_PREFIX,
})
