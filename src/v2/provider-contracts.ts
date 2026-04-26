import { Context, Effect, Layer } from "effect-v4"

import type { V2DeploymentRecord } from "./deployments.js"
import type { V2RuntimeError } from "./errors.js"

export type V2ProviderProfileName = "default" | "stub" | "isolated-e2e"

export type V2ProviderFamily =
  | "process-supervisor"
  | "proxy-router"
  | "scm"
  | "workspace-materializer"
  | "event-transport"
  | "control-plane-transport"
  | "health-checker"
  | "package-manager"
  | "tunnel"

export type V2ProviderPluginSource = "first-party" | "external"

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

export interface V2ProcessSupervisorProviderService
  extends V2ProviderFamilyService<"process-supervisor"> {
  readonly up: (input: {
    readonly deployment: V2DeploymentRecord
    readonly service: V2RuntimeServiceConfig
  }) => Effect.Effect<string, V2RuntimeError>
  readonly down: (input: {
    readonly deployment: V2DeploymentRecord
    readonly service: V2RuntimeServiceConfig
  }) => Effect.Effect<string, V2RuntimeError>
  readonly restart: (input: {
    readonly deployment: V2DeploymentRecord
    readonly service: V2RuntimeServiceConfig
  }) => Effect.Effect<string, V2RuntimeError>
}

export interface V2HealthCheckerProviderService
  extends V2ProviderFamilyService<"health-checker"> {
  readonly check: (input: {
    readonly deployment: V2DeploymentRecord
    readonly service: V2RuntimeServiceConfig
  }) => Effect.Effect<string, V2RuntimeError>
}

export interface V2EventTransportProviderService
  extends V2ProviderFamilyService<"event-transport"> {
  readonly append: (input: {
    readonly deployment: V2DeploymentRecord
    readonly event: string
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

export const V2ProcessSupervisorProvider =
  Context.Service<V2ProcessSupervisorProviderService>("rig/v2/V2ProcessSupervisorProvider")

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
  "package-manager",
  "tunnel",
]

const plugin = (
  id: string,
  family: V2ProviderFamily,
  displayName: string,
  capabilities: readonly string[],
): V2ProviderPlugin => ({
  id,
  family,
  source: "first-party",
  displayName,
  capabilities,
})

const defaultProviders: readonly V2ProviderPlugin[] = [
  plugin("launchd", "process-supervisor", "launchd", ["user-agent", "restart-policy", "v1-compatible"]),
  plugin("caddy", "proxy-router", "Caddy", ["local-reverse-proxy", "tls-termination"]),
  plugin("local-git", "scm", "Local Git", ["ref-resolution", "rollback-anchor"]),
  plugin("git-worktree", "workspace-materializer", "Git Worktree", ["branch-workspace", "generated-deployment"]),
  plugin("structured-log-file", "event-transport", "Structured Log File", ["append-only-events", "doctor-readable"]),
  plugin("localhost-http", "control-plane-transport", "Localhost HTTP", ["127.0.0.1-bind", "rig-b-relay-com"]),
  plugin("native-health", "health-checker", "Native Health Checks", ["http-health", "ownership-check"]),
  plugin("package-json-scripts", "package-manager", "package.json Scripts", ["npm-compatible", "bun-compatible"]),
  plugin("manual-tailscale", "tunnel", "Manual Tailscale DNS", ["private-dns-route", "no-app-auth"]),
]

const stubProviders: readonly V2ProviderPlugin[] = [
  plugin("stub-process-supervisor", "process-supervisor", "Stub Process Supervisor", ["process-supervisor-contract-test"]),
  plugin("stub-proxy-router", "proxy-router", "Stub Proxy Router", ["proxy-router-contract-test"]),
  plugin("stub-scm", "scm", "Stub SCM", ["scm-contract-test"]),
  plugin("stub-workspace-materializer", "workspace-materializer", "Stub Workspace Materializer", [
    "workspace-materializer-contract-test",
  ]),
  plugin("stub-event-transport", "event-transport", "Stub Event Transport", ["event-transport-contract-test"]),
  plugin("stub-control-plane", "control-plane-transport", "Stub Control Plane", ["localhost-contract-test"]),
  plugin("stub-health-checker", "health-checker", "Stub Health Checker", ["health-checker-contract-test"]),
  plugin("stub-package-manager", "package-manager", "Stub Package Manager", ["package-manager-contract-test"]),
  plugin("stub-tunnel", "tunnel", "Stub Tunnel", ["tunnel-contract-test"]),
]

const isolatedE2EProviders: readonly V2ProviderPlugin[] = [
  plugin("isolated-e2e-process-supervisor", "process-supervisor", "Isolated E2E Process Supervisor", [
    "fake-launchd",
    "real-subprocess",
  ]),
  plugin("caddy", "proxy-router", "Caddy", ["local-reverse-proxy", "tls-termination"]),
  plugin("local-git", "scm", "Local Git", ["ref-resolution", "rollback-anchor"]),
  plugin("git-worktree", "workspace-materializer", "Git Worktree", ["branch-workspace", "generated-deployment"]),
  plugin("structured-log-file", "event-transport", "Structured Log File", ["append-only-events", "doctor-readable"]),
  plugin("localhost-http", "control-plane-transport", "Localhost HTTP", ["127.0.0.1-bind", "rig-b-relay-com"]),
  plugin("native-health", "health-checker", "Native Health Checks", ["http-health", "ownership-check"]),
  plugin("package-json-scripts", "package-manager", "package.json Scripts", ["npm-compatible", "bun-compatible"]),
  plugin("manual-tailscale", "tunnel", "Manual Tailscale DNS", ["private-dns-route", "no-app-auth"]),
]

const providersForProfile = (profile: V2ProviderProfileName): readonly V2ProviderPlugin[] => {
  switch (profile) {
    case "stub":
      return stubProviders
    case "isolated-e2e":
      return isolatedE2EProviders
    case "default":
      return defaultProviders
  }
}

const reportForProfile = (
  profile: V2ProviderProfileName,
  externalProviders: readonly V2ProviderPlugin[],
): V2ProviderRegistryReport => ({
  profile,
  families: v2ProviderFamilies,
  providers: [...providersForProfile(profile), ...externalProviders],
})

const familyService = <Family extends V2ProviderFamily>(
  report: V2ProviderRegistryReport,
  family: Family,
): V2ProviderFamilyService<Family> => {
  const selected = report.providers.find(
    (provider): provider is V2ProviderPluginForFamily<Family> => provider.family === family,
  ) as V2ProviderPluginForFamily<Family>

  return {
    family,
    plugin: Effect.succeed(selected),
  }
}

const providerOperation = (provider: V2ProviderPlugin, operation: string): Effect.Effect<string, V2RuntimeError> =>
  Effect.succeed(`${provider.family}:${provider.id}:${operation}`)

const workspaceMaterializerService = (
  report: V2ProviderRegistryReport,
): V2WorkspaceMaterializerProviderService => {
  const base = familyService(report, "workspace-materializer")
  const selected = report.providers.find(
    (provider): provider is V2ProviderPluginForFamily<"workspace-materializer"> =>
      provider.family === "workspace-materializer",
  ) as V2ProviderPluginForFamily<"workspace-materializer">

  return {
    ...base,
    resolve: (input) => providerOperation(selected, `resolve:${input.deployment.workspacePath}`),
    materialize: (input) => providerOperation(selected, `materialize:${input.deployment.workspacePath}`),
    remove: (input) => providerOperation(selected, `remove:${input.deployment.workspacePath}`),
  }
}

const processSupervisorService = (
  report: V2ProviderRegistryReport,
): V2ProcessSupervisorProviderService => {
  const base = familyService(report, "process-supervisor")
  const selected = report.providers.find(
    (provider): provider is V2ProviderPluginForFamily<"process-supervisor"> =>
      provider.family === "process-supervisor",
  ) as V2ProviderPluginForFamily<"process-supervisor">

  return {
    ...base,
    up: (input) => providerOperation(selected, `up:${input.service.name}`),
    down: (input) => providerOperation(selected, `down:${input.service.name}`),
    restart: (input) => providerOperation(selected, `restart:${input.service.name}`),
  }
}

const healthCheckerService = (
  report: V2ProviderRegistryReport,
): V2HealthCheckerProviderService => {
  const base = familyService(report, "health-checker")
  const selected = report.providers.find(
    (provider): provider is V2ProviderPluginForFamily<"health-checker"> =>
      provider.family === "health-checker",
  ) as V2ProviderPluginForFamily<"health-checker">

  return {
    ...base,
    check: (input) => providerOperation(selected, `check:${input.service.name}`),
  }
}

const eventTransportService = (
  report: V2ProviderRegistryReport,
): V2EventTransportProviderService => {
  const base = familyService(report, "event-transport")
  const selected = report.providers.find(
    (provider): provider is V2ProviderPluginForFamily<"event-transport"> =>
      provider.family === "event-transport",
  ) as V2ProviderPluginForFamily<"event-transport">

  return {
    ...base,
    append: (input) => providerOperation(selected, `append:${input.event}`),
  }
}

const scmService = (report: V2ProviderRegistryReport): V2ScmProviderService => {
  const base = familyService(report, "scm")
  const selected = report.providers.find(
    (provider): provider is V2ProviderPluginForFamily<"scm"> => provider.family === "scm",
  ) as V2ProviderPluginForFamily<"scm">

  return {
    ...base,
    checkout: (input) => providerOperation(selected, `checkout:${input.ref}`),
  }
}

const packageManagerService = (
  report: V2ProviderRegistryReport,
): V2PackageManagerProviderService => {
  const base = familyService(report, "package-manager")
  const selected = report.providers.find(
    (provider): provider is V2ProviderPluginForFamily<"package-manager"> =>
      provider.family === "package-manager",
  ) as V2ProviderPluginForFamily<"package-manager">

  return {
    ...base,
    install: (input) => providerOperation(selected, `install:${input.service.name}`),
  }
}

const proxyRouterService = (
  report: V2ProviderRegistryReport,
): V2ProxyRouterProviderService => {
  const base = familyService(report, "proxy-router")
  const selected = report.providers.find(
    (provider): provider is V2ProviderPluginForFamily<"proxy-router"> =>
      provider.family === "proxy-router",
  ) as V2ProviderPluginForFamily<"proxy-router">

  return {
    ...base,
    upsert: (input) => providerOperation(selected, `upsert:${input.proxy.upstream}`),
    remove: (input) => providerOperation(selected, `remove:${input.proxy.upstream}`),
  }
}

export const V2ProviderRegistryLive = (
  profile: V2ProviderProfileName = "default",
  externalProviders: readonly V2ProviderPlugin[] = [],
) =>
  Layer.succeed(V2ProviderRegistry, {
    current: Effect.succeed(reportForProfile(profile, externalProviders)),
    forProfile: (selectedProfile) => Effect.succeed(reportForProfile(selectedProfile, externalProviders)),
  })

export const V2ProviderContractsLive = (
  profile: V2ProviderProfileName = "default",
  externalProviders: readonly V2ProviderPlugin[] = [],
) => {
  const report = reportForProfile(profile, externalProviders)

  return Layer.mergeAll(
    V2ProviderRegistryLive(profile, externalProviders),
    Layer.succeed(V2ProcessSupervisorProvider, processSupervisorService(report)),
    Layer.succeed(V2ProxyRouterProvider, proxyRouterService(report)),
    Layer.succeed(V2ScmProvider, scmService(report)),
    Layer.succeed(V2WorkspaceMaterializerProvider, workspaceMaterializerService(report)),
    Layer.succeed(V2EventTransportProvider, eventTransportService(report)),
    Layer.succeed(V2ControlPlaneTransportProvider, familyService(report, "control-plane-transport")),
    Layer.succeed(V2HealthCheckerProvider, healthCheckerService(report)),
    Layer.succeed(V2PackageManagerProvider, packageManagerService(report)),
    Layer.succeed(V2TunnelProvider, familyService(report, "tunnel")),
  )
}
