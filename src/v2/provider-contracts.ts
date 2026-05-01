import { Context, Effect } from "effect"

import type { V2DeploymentRecord } from "./deployments.js"
import type { V2RuntimeError } from "./errors.js"
import type { V2ProviderCommandRunner } from "./provider-command-runner.js"
import {
  V2ProcessSupervisorProvider,
  type V2ProcessSupervisorExitResult,
  type V2ProcessSupervisorOperationResult,
  type V2ProcessSupervisorProviderService,
} from "./providers/process-supervisor.js"

export {
  V2ProviderContractsLive,
  V2ProviderRegistryLive,
} from "./provider-composition.js"

export type {
  V2ProviderCommandResult,
  V2ProviderCommandRunner,
} from "./provider-command-runner.js"

export {
  V2ProcessSupervisorProvider,
  type V2ProcessSupervisorExitResult,
  type V2ProcessSupervisorOperationResult,
  type V2ProcessSupervisorProviderService,
} from "./providers/process-supervisor.js"

export type V2ProviderProfileName = "default" | "stub" | "isolated-e2e"

export type V2ProviderFamily =
  | "process-supervisor"
  | "proxy-router"
  | "scm"
  | "workspace-materializer"
  | "event-transport"
  | "control-plane-transport"
  | "health-checker"
  | "lifecycle-hook"
  | "package-manager"
  | "tunnel"

export type V2ProviderPluginSource = "core" | "first-party" | "external"

export interface V2ProviderPlugin {
  readonly id: string
  readonly family: V2ProviderFamily
  readonly source: V2ProviderPluginSource
  readonly displayName: string
  readonly capabilities: readonly string[]
  readonly packageName?: string
}

export interface V2ProviderRegistryReport {
  readonly profile: V2ProviderProfileName
  readonly families: readonly V2ProviderFamily[]
  readonly providers: readonly V2ProviderPlugin[]
}

export interface V2ProviderRegistryService {
  readonly current: Effect.Effect<V2ProviderRegistryReport>
  readonly forProfile: (profile: V2ProviderProfileName) => Effect.Effect<V2ProviderRegistryReport>
}

export interface V2ProviderContractsOptions {
  readonly launchd?: {
    readonly home?: string
    readonly runCommand?: V2ProviderCommandRunner
  }
  readonly workspaceMaterializer?: {
    readonly sourceRepoPath?: string
    readonly runCommand?: V2ProviderCommandRunner
  }
  readonly scm?: {
    readonly sourceRepoPath?: string
    readonly runCommand?: V2ProviderCommandRunner
  }
  readonly proxyRouter?: {
    readonly caddyfile?: string
    readonly caddyfilePath?: string
    readonly extraConfig?: readonly string[]
    readonly runCommand?: V2ProviderCommandRunner
    readonly reload?: {
      readonly mode: "manual" | "command" | "disabled"
      readonly command?: string
    }
  }
  readonly packageManager?: {
    readonly binRoot?: string
  }
}

export type V2ProviderPluginForFamily<Family extends V2ProviderFamily> =
  V2ProviderPlugin & { readonly family: Family }

export interface V2ProviderFamilyService<Family extends V2ProviderFamily> {
  readonly family: Family
  readonly plugin: Effect.Effect<V2ProviderPluginForFamily<Family>>
}

export type V2RuntimeServiceConfig =
  V2DeploymentRecord["resolved"]["environment"]["services"][number]

export type V2RuntimeProxyConfig =
  NonNullable<V2DeploymentRecord["resolved"]["environment"]["proxy"]>

export interface V2ProviderOutputLine {
  readonly stream: "stdout" | "stderr"
  readonly line: string
}

export interface V2WorkspaceMaterializerProviderService
  extends V2ProviderFamilyService<"workspace-materializer"> {
  readonly resolve: (input: {
    readonly deployment: V2DeploymentRecord
  }) => Effect.Effect<string, V2RuntimeError>
  readonly materialize: (input: {
    readonly deployment: V2DeploymentRecord
    readonly ref: string
  }) => Effect.Effect<string, V2RuntimeError>
  readonly remove: (input: {
    readonly deployment: V2DeploymentRecord
  }) => Effect.Effect<string, V2RuntimeError>
}

export interface V2HealthCheckerProviderService
  extends V2ProviderFamilyService<"health-checker"> {
  readonly check: (input: {
    readonly deployment: V2DeploymentRecord
    readonly service: V2RuntimeServiceConfig
    readonly timeoutSeconds?: number
  }) => Effect.Effect<string, V2RuntimeError>
}

export interface V2LifecycleHookProviderService
  extends V2ProviderFamilyService<"lifecycle-hook"> {
  readonly run: (input: {
    readonly deployment: V2DeploymentRecord
    readonly hook: "preStart" | "postStart" | "preStop" | "postStop"
    readonly command: string
    readonly service?: V2RuntimeServiceConfig
  }) => Effect.Effect<string, V2RuntimeError>
}

export interface V2EventTransportProviderService
  extends V2ProviderFamilyService<"event-transport"> {
  readonly append: (input: {
    readonly deployment: V2DeploymentRecord
    readonly event: string
    readonly component?: string
    readonly details?: Readonly<Record<string, unknown>>
  }) => Effect.Effect<string, V2RuntimeError>
}

export interface V2ScmProviderService
  extends V2ProviderFamilyService<"scm"> {
  readonly checkout: (input: {
    readonly deployment: V2DeploymentRecord
    readonly ref: string
  }) => Effect.Effect<string, V2RuntimeError>
}

export interface V2PackageManagerProviderService
  extends V2ProviderFamilyService<"package-manager"> {
  readonly install: (input: {
    readonly deployment: V2DeploymentRecord
    readonly service: V2RuntimeServiceConfig
  }) => Effect.Effect<string, V2RuntimeError>
}

export interface V2ProxyRouterProviderService
  extends V2ProviderFamilyService<"proxy-router"> {
  readonly upsert: (input: {
    readonly deployment: V2DeploymentRecord
    readonly proxy: V2RuntimeProxyConfig
  }) => Effect.Effect<string, V2RuntimeError>
  readonly remove: (input: {
    readonly deployment: V2DeploymentRecord
    readonly proxy: V2RuntimeProxyConfig
  }) => Effect.Effect<string, V2RuntimeError>
}

export const V2ProviderRegistry =
  Context.Service<V2ProviderRegistryService>("rig/v2/V2ProviderRegistry")

export const V2ProxyRouterProvider =
  Context.Service<V2ProxyRouterProviderService>("rig/v2/V2ProxyRouterProvider")

export const V2ScmProvider =
  Context.Service<V2ScmProviderService>("rig/v2/V2ScmProvider")

export const V2WorkspaceMaterializerProvider =
  Context.Service<V2WorkspaceMaterializerProviderService>("rig/v2/V2WorkspaceMaterializerProvider")

export const V2EventTransportProvider =
  Context.Service<V2EventTransportProviderService>("rig/v2/V2EventTransportProvider")

export const V2ControlPlaneTransportProvider =
  Context.Service<V2ProviderFamilyService<"control-plane-transport">>("rig/v2/V2ControlPlaneTransportProvider")

export const V2HealthCheckerProvider =
  Context.Service<V2HealthCheckerProviderService>("rig/v2/V2HealthCheckerProvider")

export const V2LifecycleHookProvider =
  Context.Service<V2LifecycleHookProviderService>("rig/v2/V2LifecycleHookProvider")

export const V2PackageManagerProvider =
  Context.Service<V2PackageManagerProviderService>("rig/v2/V2PackageManagerProvider")

export const V2TunnelProvider =
  Context.Service<V2ProviderFamilyService<"tunnel">>("rig/v2/V2TunnelProvider")

export const v2ProviderFamilies: readonly V2ProviderFamily[] = [
  "process-supervisor",
  "proxy-router",
  "scm",
  "workspace-materializer",
  "event-transport",
  "control-plane-transport",
  "health-checker",
  "lifecycle-hook",
  "package-manager",
  "tunnel",
]
