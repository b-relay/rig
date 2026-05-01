import { Context, Effect } from "effect"

import type { RigDeploymentRecord } from "./deployments.js"
import type { RigRuntimeError } from "./errors.js"
import type { RigProviderCommandRunner } from "./provider-command-runner.js"
import {
  RigProcessSupervisorProvider,
  type RigProcessSupervisorExitResult,
  type RigProcessSupervisorOperationResult,
  type RigProcessSupervisorProviderService,
} from "./providers/process-supervisor.js"

export {
  RigProviderContractsLive,
  RigProviderRegistryLive,
} from "./provider-composition.js"

export type {
  RigProviderCommandResult,
  RigProviderCommandRunner,
} from "./provider-command-runner.js"

export {
  RigProcessSupervisorProvider,
  type RigProcessSupervisorExitResult,
  type RigProcessSupervisorOperationResult,
  type RigProcessSupervisorProviderService,
} from "./providers/process-supervisor.js"

export type RigProviderProfileName = "default" | "stub" | "isolated-e2e"

export type RigProviderFamily =
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

export type RigProviderPluginSource = "core" | "first-party" | "external"

export interface RigProviderPlugin {
  readonly id: string
  readonly family: RigProviderFamily
  readonly source: RigProviderPluginSource
  readonly displayName: string
  readonly capabilities: readonly string[]
  readonly packageName?: string
}

export interface RigProviderRegistryReport {
  readonly profile: RigProviderProfileName
  readonly families: readonly RigProviderFamily[]
  readonly providers: readonly RigProviderPlugin[]
}

export interface RigProviderRegistryService {
  readonly current: Effect.Effect<RigProviderRegistryReport>
  readonly forProfile: (profile: RigProviderProfileName) => Effect.Effect<RigProviderRegistryReport>
}

export interface RigProviderContractsOptions {
  readonly launchd?: {
    readonly home?: string
    readonly runCommand?: RigProviderCommandRunner
  }
  readonly workspaceMaterializer?: {
    readonly sourceRepoPath?: string
    readonly runCommand?: RigProviderCommandRunner
  }
  readonly scm?: {
    readonly sourceRepoPath?: string
    readonly runCommand?: RigProviderCommandRunner
  }
  readonly proxyRouter?: {
    readonly caddyfile?: string
    readonly caddyfilePath?: string
    readonly extraConfig?: readonly string[]
    readonly runCommand?: RigProviderCommandRunner
    readonly reload?: {
      readonly mode: "manual" | "command" | "disabled"
      readonly command?: string
    }
  }
  readonly packageManager?: {
    readonly binRoot?: string
  }
}

export type RigProviderPluginForFamily<Family extends RigProviderFamily> =
  RigProviderPlugin & { readonly family: Family }

export interface RigProviderFamilyService<Family extends RigProviderFamily> {
  readonly family: Family
  readonly plugin: Effect.Effect<RigProviderPluginForFamily<Family>>
}

export type RigRuntimeServiceConfig =
  RigDeploymentRecord["resolved"]["environment"]["services"][number]

export type RigRuntimeProxyConfig =
  NonNullable<RigDeploymentRecord["resolved"]["environment"]["proxy"]>

export interface RigProviderOutputLine {
  readonly stream: "stdout" | "stderr"
  readonly line: string
}

export interface RigWorkspaceMaterializerProviderService
  extends RigProviderFamilyService<"workspace-materializer"> {
  readonly resolve: (input: {
    readonly deployment: RigDeploymentRecord
  }) => Effect.Effect<string, RigRuntimeError>
  readonly materialize: (input: {
    readonly deployment: RigDeploymentRecord
    readonly ref: string
  }) => Effect.Effect<string, RigRuntimeError>
  readonly remove: (input: {
    readonly deployment: RigDeploymentRecord
  }) => Effect.Effect<string, RigRuntimeError>
}

export interface RigHealthCheckerProviderService
  extends RigProviderFamilyService<"health-checker"> {
  readonly check: (input: {
    readonly deployment: RigDeploymentRecord
    readonly service: RigRuntimeServiceConfig
    readonly timeoutSeconds?: number
  }) => Effect.Effect<string, RigRuntimeError>
}

export interface RigLifecycleHookProviderService
  extends RigProviderFamilyService<"lifecycle-hook"> {
  readonly run: (input: {
    readonly deployment: RigDeploymentRecord
    readonly hook: "preStart" | "postStart" | "preStop" | "postStop"
    readonly command: string
    readonly service?: RigRuntimeServiceConfig
  }) => Effect.Effect<string, RigRuntimeError>
}

export interface RigEventTransportProviderService
  extends RigProviderFamilyService<"event-transport"> {
  readonly append: (input: {
    readonly deployment: RigDeploymentRecord
    readonly event: string
    readonly component?: string
    readonly details?: Readonly<Record<string, unknown>>
  }) => Effect.Effect<string, RigRuntimeError>
}

export interface RigScmProviderService
  extends RigProviderFamilyService<"scm"> {
  readonly checkout: (input: {
    readonly deployment: RigDeploymentRecord
    readonly ref: string
  }) => Effect.Effect<string, RigRuntimeError>
}

export interface RigPackageManagerProviderService
  extends RigProviderFamilyService<"package-manager"> {
  readonly install: (input: {
    readonly deployment: RigDeploymentRecord
    readonly service: RigRuntimeServiceConfig
  }) => Effect.Effect<string, RigRuntimeError>
}

export interface RigProxyRouterProviderService
  extends RigProviderFamilyService<"proxy-router"> {
  readonly upsert: (input: {
    readonly deployment: RigDeploymentRecord
    readonly proxy: RigRuntimeProxyConfig
  }) => Effect.Effect<string, RigRuntimeError>
  readonly remove: (input: {
    readonly deployment: RigDeploymentRecord
    readonly proxy: RigRuntimeProxyConfig
  }) => Effect.Effect<string, RigRuntimeError>
}

export const RigProviderRegistry =
  Context.Service<RigProviderRegistryService>("rig/rig/RigProviderRegistry")

export const RigProxyRouterProvider =
  Context.Service<RigProxyRouterProviderService>("rig/rig/RigProxyRouterProvider")

export const RigScmProvider =
  Context.Service<RigScmProviderService>("rig/rig/RigScmProvider")

export const RigWorkspaceMaterializerProvider =
  Context.Service<RigWorkspaceMaterializerProviderService>("rig/rig/RigWorkspaceMaterializerProvider")

export const RigEventTransportProvider =
  Context.Service<RigEventTransportProviderService>("rig/rig/RigEventTransportProvider")

export const RigControlPlaneTransportProvider =
  Context.Service<RigProviderFamilyService<"control-plane-transport">>("rig/rig/RigControlPlaneTransportProvider")

export const RigHealthCheckerProvider =
  Context.Service<RigHealthCheckerProviderService>("rig/rig/RigHealthCheckerProvider")

export const RigLifecycleHookProvider =
  Context.Service<RigLifecycleHookProviderService>("rig/rig/RigLifecycleHookProvider")

export const RigPackageManagerProvider =
  Context.Service<RigPackageManagerProviderService>("rig/rig/RigPackageManagerProvider")

export const RigTunnelProvider =
  Context.Service<RigProviderFamilyService<"tunnel">>("rig/rig/RigTunnelProvider")

export const rigProviderFamilies: readonly RigProviderFamily[] = [
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
