import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { Context, Effect, Layer } from "effect-v4"

import type { V2DeploymentRecord } from "./deployments.js"
import { V2RuntimeError } from "./errors.js"

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

export interface V2ProcessSupervisorOperationResult {
  readonly operation: string
  readonly output?: readonly V2ProviderOutputLine[]
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

export interface V2ProcessSupervisorProviderService
  extends V2ProviderFamilyService<"process-supervisor"> {
  readonly up: (input: {
    readonly deployment: V2DeploymentRecord
    readonly service: V2RuntimeServiceConfig
  }) => Effect.Effect<V2ProcessSupervisorOperationResult, V2RuntimeError>
  readonly down: (input: {
    readonly deployment: V2DeploymentRecord
    readonly service: V2RuntimeServiceConfig
  }) => Effect.Effect<V2ProcessSupervisorOperationResult, V2RuntimeError>
  readonly restart: (input: {
    readonly deployment: V2DeploymentRecord
    readonly service: V2RuntimeServiceConfig
  }) => Effect.Effect<V2ProcessSupervisorOperationResult, V2RuntimeError>
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
  source: V2ProviderPluginSource = "first-party",
): V2ProviderPlugin => ({
  id,
  family,
  source,
  displayName,
  capabilities,
})

const rigdProcessSupervisorProvider = plugin(
  "rigd",
  "process-supervisor",
  "rigd Core Supervisor",
  ["core-supervisor", "session-processes", "same-provider-interface"],
  "core",
)

const defaultProviders: readonly V2ProviderPlugin[] = [
  rigdProcessSupervisorProvider,
  plugin("launchd", "process-supervisor", "launchd", ["user-agent", "restart-policy", "v1-compatible"]),
  plugin("caddy", "proxy-router", "Caddy", ["local-reverse-proxy", "tls-termination"]),
  plugin("local-git", "scm", "Local Git", ["ref-resolution", "rollback-anchor"]),
  plugin("git-worktree", "workspace-materializer", "Git Worktree", ["branch-workspace", "generated-deployment"]),
  plugin("structured-log-file", "event-transport", "Structured Log File", ["append-only-events", "doctor-readable"]),
  plugin("localhost-http", "control-plane-transport", "Localhost HTTP", ["127.0.0.1-bind", "rig-b-relay-com"]),
  plugin("native-health", "health-checker", "Native Health Checks", ["http-health", "command-health", "ownership-check"]),
  plugin("package-json-scripts", "package-manager", "package.json Scripts", ["npm-compatible", "bun-compatible"]),
  plugin("manual-tailscale", "tunnel", "Manual Tailscale DNS", ["private-dns-route", "no-app-auth"]),
]

const stubProviders: readonly V2ProviderPlugin[] = [
  rigdProcessSupervisorProvider,
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
  rigdProcessSupervisorProvider,
  plugin("isolated-e2e-process-supervisor", "process-supervisor", "Isolated E2E Process Supervisor", [
    "fake-launchd",
    "real-subprocess",
  ]),
  plugin("caddy", "proxy-router", "Caddy", ["local-reverse-proxy", "tls-termination"]),
  plugin("local-git", "scm", "Local Git", ["ref-resolution", "rollback-anchor"]),
  plugin("git-worktree", "workspace-materializer", "Git Worktree", ["branch-workspace", "generated-deployment"]),
  plugin("structured-log-file", "event-transport", "Structured Log File", ["append-only-events", "doctor-readable"]),
  plugin("localhost-http", "control-plane-transport", "Localhost HTTP", ["127.0.0.1-bind", "rig-b-relay-com"]),
  plugin("native-health", "health-checker", "Native Health Checks", ["http-health", "command-health", "ownership-check"]),
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

const missingProviderError = (
  family: V2ProviderFamily,
  providerId: string | undefined,
): V2RuntimeError =>
  new V2RuntimeError(
    providerId
      ? `Provider '${providerId}' is not registered for '${family}'.`
      : `No provider is registered for '${family}'.`,
    "Select a registered provider id in rig.json or install the provider before running the command.",
    {
      family,
      ...(providerId ? { providerId } : {}),
    },
  )

const providerForFamily = <Family extends V2ProviderFamily>(
  report: V2ProviderRegistryReport,
  family: Family,
  providerId?: string,
): Effect.Effect<V2ProviderPluginForFamily<Family>, V2RuntimeError> => {
  const selected = report.providers.find(
    (provider): provider is V2ProviderPluginForFamily<Family> =>
      provider.family === family && (providerId === undefined || provider.id === providerId),
  )

  return selected ? Effect.succeed(selected) : Effect.fail(missingProviderError(family, providerId))
}

const providerOperation = (provider: V2ProviderPlugin, operation: string): Effect.Effect<string, V2RuntimeError> =>
  Effect.succeed(`${provider.family}:${provider.id}:${operation}`)

const processProviderOperation = (
  provider: V2ProviderPlugin,
  operation: string,
): Effect.Effect<V2ProcessSupervisorOperationResult, V2RuntimeError> =>
  providerOperation(provider, operation).pipe(Effect.map((operation) => ({ operation })))

const runtimeError = (
  message: string,
  hint: string,
  details?: Readonly<Record<string, unknown>>,
) => (cause: unknown) =>
  new V2RuntimeError(
    message,
    hint,
    {
      cause: cause instanceof Error ? cause.message : String(cause),
      ...(details ?? {}),
    },
  )

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
  const selectedForDeployment = (deployment: V2DeploymentRecord) =>
    providerForFamily(report, "process-supervisor", deployment.resolved.providers.processSupervisor)

  return {
    ...base,
    up: (input) =>
      Effect.gen(function* () {
        const selected = yield* selectedForDeployment(input.deployment)
        return yield* processProviderOperation(selected, `up:${input.service.name}`)
      }),
    down: (input) =>
      Effect.gen(function* () {
        const selected = yield* selectedForDeployment(input.deployment)
        return yield* processProviderOperation(selected, `down:${input.service.name}`)
      }),
    restart: (input) =>
      Effect.gen(function* () {
        const selected = yield* selectedForDeployment(input.deployment)
        return yield* processProviderOperation(selected, `restart:${input.service.name}`)
      }),
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

  const checkNativeHealth = (input: {
    readonly deployment: V2DeploymentRecord
    readonly service: V2RuntimeServiceConfig
  }): Effect.Effect<string, V2RuntimeError> => {
    const target = "healthCheck" in input.service ? input.service.healthCheck : undefined
    if (!target) {
      return Effect.fail(
        new V2RuntimeError(
          `Component '${input.service.name}' does not define a health check.`,
          "Add a health check to the managed component before asking native-health to verify it.",
          {
            providerId: selected.id,
            component: input.service.name,
            deployment: input.deployment.name,
          },
        ),
      )
    }

    if (!target.startsWith("http://") && !target.startsWith("https://")) {
      return Effect.tryPromise({
        try: async () => {
          const subprocess = Bun.spawn(["sh", "-lc", target], {
            cwd: input.deployment.workspacePath,
            stdout: "pipe",
            stderr: "pipe",
          })
          const [exitCode, stdout, stderr] = await Promise.all([
            subprocess.exited,
            new Response(subprocess.stdout).text(),
            new Response(subprocess.stderr).text(),
          ])

          if (exitCode !== 0) {
            throw new V2RuntimeError(
              `Command health check failed for '${input.service.name}' with exit code ${exitCode}.`,
              "Fix the component health command before retrying the runtime action.",
              {
                providerId: selected.id,
                component: input.service.name,
                deployment: input.deployment.name,
                target,
                exitCode,
                stdout,
                stderr,
              },
            )
          }

          return `${selected.family}:${selected.id}:check:${input.service.name}:command:healthy:${exitCode}`
        },
        catch: (cause) =>
          cause instanceof V2RuntimeError
            ? cause
            : new V2RuntimeError(
              `Unable to run command health check for '${input.service.name}'.`,
              "Ensure the health command can run from the deployment workspace and retry.",
              {
                providerId: selected.id,
                component: input.service.name,
                deployment: input.deployment.name,
                target,
                cause: cause instanceof Error ? cause.message : String(cause),
              },
            ),
      })
    }

    return Effect.tryPromise({
      try: async () => {
        const response = await fetch(target)
        if (response.status < 200 || response.status >= 300) {
          throw new V2RuntimeError(
            `Health check failed for '${input.service.name}' with HTTP ${response.status}.`,
            "Fix the component startup or health endpoint before retrying the runtime action.",
            {
              providerId: selected.id,
              component: input.service.name,
              deployment: input.deployment.name,
              target,
              statusCode: response.status,
            },
          )
        }

        return `${selected.family}:${selected.id}:check:${input.service.name}:healthy:${response.status}`
      },
      catch: (cause) =>
        cause instanceof V2RuntimeError
          ? cause
          : new V2RuntimeError(
            `Unable to run health check for '${input.service.name}'.`,
            "Ensure the health endpoint is reachable from localhost and retry.",
            {
              providerId: selected.id,
              component: input.service.name,
              deployment: input.deployment.name,
              target,
              cause: cause instanceof Error ? cause.message : String(cause),
            },
          ),
    })
  }

  return {
    ...base,
    check: (input) =>
      selected.id === "native-health"
        ? checkNativeHealth(input)
        : providerOperation(selected, `check:${input.service.name}`),
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

  const appendStructuredLogFile = (input: {
    readonly deployment: V2DeploymentRecord
    readonly event: string
    readonly component?: string
    readonly details?: Readonly<Record<string, unknown>>
  }): Effect.Effect<string, V2RuntimeError> => {
    const logPath = join(input.deployment.logRoot, "events.jsonl")
    const entry = {
      timestamp: new Date().toISOString(),
      event: input.event,
      project: input.deployment.project,
      kind: input.deployment.kind,
      deployment: input.deployment.name,
      ...(input.component ? { component: input.component } : {}),
      ...(input.details ? { details: input.details } : {}),
    }

    return Effect.tryPromise({
      try: async () => {
        await mkdir(input.deployment.logRoot, { recursive: true })
        await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8")
        return `${selected.family}:${selected.id}:append:${input.event}${input.component ? `:${input.component}` : ""}`
      },
      catch: runtimeError(
        "Unable to append v2 runtime event.",
        "Ensure the deployment log root is writable before retrying the runtime action.",
        {
          providerId: selected.id,
          logPath,
          event: input.event,
          ...(input.component ? { component: input.component } : {}),
        },
      ),
    })
  }

  return {
    ...base,
    append: (input) =>
      selected.id === "structured-log-file"
        ? appendStructuredLogFile(input)
        : providerOperation(selected, `append:${input.event}${input.component ? `:${input.component}` : ""}`),
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

  const installPackageJsonScript = (input: {
    readonly deployment: V2DeploymentRecord
    readonly service: V2RuntimeServiceConfig
  }): Effect.Effect<string, V2RuntimeError> => {
    if (input.service.type !== "bin") {
      return providerOperation(selected, `install:${input.service.name}`)
    }

    if (!("build" in input.service) || !input.service.build) {
      return providerOperation(selected, `install:${input.service.name}:ready`)
    }

    return Effect.tryPromise({
      try: async () => {
        const subprocess = Bun.spawn(["sh", "-lc", input.service.build as string], {
          cwd: input.deployment.workspacePath,
          stdout: "pipe",
          stderr: "pipe",
        })
        const [exitCode, stdout, stderr] = await Promise.all([
          subprocess.exited,
          new Response(subprocess.stdout).text(),
          new Response(subprocess.stderr).text(),
        ])

        if (exitCode !== 0) {
          throw new V2RuntimeError(
            `Package build failed for '${input.service.name}' with exit code ${exitCode}.`,
            "Fix the installed component build command before retrying the deploy action.",
            {
              providerId: selected.id,
              component: input.service.name,
              deployment: input.deployment.name,
              build: input.service.build,
              exitCode,
              stdout,
              stderr,
            },
          )
        }

        return `${selected.family}:${selected.id}:install:${input.service.name}:built:${exitCode}`
      },
      catch: (cause) =>
        cause instanceof V2RuntimeError
          ? cause
          : new V2RuntimeError(
            `Unable to run package build for '${input.service.name}'.`,
            "Ensure the deployment workspace exists and the build command is available.",
            {
              providerId: selected.id,
              component: input.service.name,
              deployment: input.deployment.name,
              build: input.service.build,
              cause: cause instanceof Error ? cause.message : String(cause),
            },
          ),
    })
  }

  return {
    ...base,
    install: (input) =>
      selected.id === "package-json-scripts"
        ? installPackageJsonScript(input)
        : providerOperation(selected, `install:${input.service.name}`),
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
