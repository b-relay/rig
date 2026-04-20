import { join } from "node:path"
import { Context, Effect, Layer } from "effect-v4"

import type { V2TaggedError } from "./errors.js"
import {
  RIG_V2_LAUNCHD_LABEL_PREFIX,
  RIG_V2_NAMESPACE,
  RIG_V2_PROXY_NAMESPACE,
  rigV2LogsRoot,
  rigV2ProjectNamespace,
  rigV2ProxyRoot,
  rigV2Root,
  rigV2RuntimeRoot,
  rigV2WorkspacesRoot,
} from "./paths.js"

export interface V2FoundationState {
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

export interface V2RuntimeService {
  readonly describeFoundation: (input: {
    readonly project: string
    readonly stateRoot: string
  }) => Effect.Effect<V2FoundationState>
}

export const V2Runtime = Context.Service<V2RuntimeService>("rig/v2/V2Runtime")

export const V2RuntimeLive = Layer.succeed(V2Runtime, {
  describeFoundation: ({ project, stateRoot }) =>
    Effect.succeed({
      project,
      namespace: rigV2ProjectNamespace(project),
      stateRoot,
      registryPath: join(stateRoot, "registry.json"),
      workspacesRoot: join(stateRoot, "workspaces"),
      projectWorkspaceRoot: join(stateRoot, "workspaces", project),
      logsRoot: join(stateRoot, "logs"),
      projectLogRoot: join(stateRoot, "logs", project),
      runtimeRoot: join(stateRoot, "runtime"),
      runtimeStatePath: join(stateRoot, "runtime", "runtime.json"),
      proxyRoot: join(stateRoot, "proxy"),
      proxyNamespace: RIG_V2_PROXY_NAMESPACE,
      launchdLabelPrefix: RIG_V2_LAUNCHD_LABEL_PREFIX,
      launchdBackupRoot: join(stateRoot, "launchd"),
    } satisfies V2FoundationState),
})

export interface V2LoggerService {
  readonly info: (message: string, details?: unknown) => Effect.Effect<void>
  readonly error: (error: V2TaggedError) => Effect.Effect<void>
}

export const V2Logger = Context.Service<V2LoggerService>("rig/v2/V2Logger")

const writeLine = (writer: typeof Bun.stdout, value: string) =>
  Effect.promise(() => Bun.write(writer, `${value}\n`).then(() => undefined))

const renderDetails = (details: unknown): string =>
  details === undefined ? "" : ` ${JSON.stringify(details)}`

export const V2LoggerLive = Layer.succeed(V2Logger, {
  info: (message, details) => writeLine(Bun.stdout, `[INFO] ${message}${renderDetails(details)}`),
  error: (error) =>
    writeLine(
      Bun.stderr,
      `[ERROR] ${error.message} ${JSON.stringify({
        type: error._tag,
        hint: error.hint,
        ...(error.details ? { details: error.details } : {}),
      })}`,
    ),
})

export const Rig2Live = Layer.mergeAll(V2RuntimeLive, V2LoggerLive)

export const v2NamespaceSummary = () => ({
  namespace: RIG_V2_NAMESPACE,
  stateRoot: rigV2Root(),
  workspacesRoot: rigV2WorkspacesRoot(),
  logsRoot: rigV2LogsRoot(),
  runtimeRoot: rigV2RuntimeRoot(),
  proxyRoot: rigV2ProxyRoot(),
  launchdLabelPrefix: RIG_V2_LAUNCHD_LABEL_PREFIX,
})
