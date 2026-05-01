import { Effect, Layer } from "effect"

import type { V2DeploymentRecord } from "./deployments.js"
import { V2RuntimeError } from "./errors.js"
import {
  defaultCommandRunner,
  runPlatformCommand,
} from "./provider-command-runner.js"
import {
  V2ControlPlaneTransportProvider,
  V2EventTransportProvider,
  V2HealthCheckerProvider,
  V2LifecycleHookProvider,
  V2PackageManagerProvider,
  V2ProcessSupervisorProvider,
  V2ProviderRegistry,
  V2ProxyRouterProvider,
  V2ScmProvider,
  V2TunnelProvider,
  V2WorkspaceMaterializerProvider,
  v2ProviderFamilies,
  type V2EventTransportProviderService,
  type V2HealthCheckerProviderService,
  type V2LifecycleHookProviderService,
  type V2PackageManagerProviderService,
  type V2ProviderContractsOptions,
  type V2ProviderFamily,
  type V2ProviderFamilyService,
  type V2ProviderOutputLine,
  type V2ProviderPlugin,
  type V2ProviderPluginForFamily,
  type V2ProviderPluginSource,
  type V2ProviderProfileName,
  type V2ProviderRegistryReport,
  type V2ProxyRouterProviderService,
  type V2ScmProviderService,
  type V2WorkspaceMaterializerProviderService,
} from "./provider-contracts.js"
import type { V2ProcessSupervisorOperationResult } from "./providers/process-supervisor.js"
import {
  stubProcessSupervisorOperation,
  stubProcessSupervisorProvider,
} from "./providers/stub-process-supervisor.js"
import {
  createRigdProcessSupervisorAdapter,
  rigdProcessSupervisorProvider,
} from "./providers/rigd-process-supervisor.js"
import {
  createLaunchdProcessSupervisorAdapter,
  launchdProcessSupervisorProvider,
} from "./providers/launchd-process-supervisor.js"
import {
  caddyProxyRouterProvider,
  createCaddyProxyRouterAdapter,
} from "./providers/caddy-proxy-router.js"
import {
  createGitWorktreeMaterializerAdapter,
  gitWorktreeMaterializerProvider,
} from "./providers/git-worktree-materializer.js"
import {
  createLocalGitScmAdapter,
  localGitScmProvider,
} from "./providers/local-git-scm.js"
import {
  createNativeHealthCheckerAdapter,
  nativeHealthCheckerProvider,
} from "./providers/native-health-checker.js"
import {
  createShellLifecycleHookAdapter,
  shellLifecycleHookProvider,
} from "./providers/shell-lifecycle-hook.js"
import {
  createPackageJsonScriptsAdapter,
  packageJsonScriptsProvider,
} from "./providers/package-json-scripts.js"
import {
  createStructuredLogEventTransportAdapter,
  structuredLogEventTransportProvider,
} from "./providers/structured-log-event-transport.js"
import {
  createStubProxyRouterAdapter,
  stubProxyRouterProvider,
} from "./providers/stub-proxy-router.js"
import {
  createStubScmAdapter,
  stubScmProvider,
} from "./providers/stub-scm.js"
import {
  createStubWorkspaceMaterializerAdapter,
  stubWorkspaceMaterializerProvider,
} from "./providers/stub-workspace-materializer.js"
import {
  createStubEventTransportAdapter,
  stubEventTransportProvider,
} from "./providers/stub-event-transport.js"
import {
  createStubHealthCheckerAdapter,
  stubHealthCheckerProvider,
} from "./providers/stub-health-checker.js"
import {
  createStubLifecycleHookAdapter,
  stubLifecycleHookProvider,
} from "./providers/stub-lifecycle-hook.js"
import {
  createStubPackageManagerAdapter,
  stubPackageManagerProvider,
} from "./providers/stub-package-manager.js"
import { stubControlPlaneProvider } from "./providers/stub-control-plane.js"
import { stubTunnelProvider } from "./providers/stub-tunnel.js"

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

const defaultProviders: readonly V2ProviderPlugin[] = [
  rigdProcessSupervisorProvider,
  launchdProcessSupervisorProvider,
  caddyProxyRouterProvider,
  localGitScmProvider,
  gitWorktreeMaterializerProvider,
  structuredLogEventTransportProvider,
  plugin("localhost-http", "control-plane-transport", "Localhost HTTP", ["127.0.0.1-bind", "rig-b-relay-com"]),
  nativeHealthCheckerProvider,
  shellLifecycleHookProvider,
  packageJsonScriptsProvider,
  plugin("manual-tailscale", "tunnel", "Manual Tailscale DNS", ["private-dns-route", "no-app-auth"]),
]

const stubProviders: readonly V2ProviderPlugin[] = [
  rigdProcessSupervisorProvider,
  stubProcessSupervisorProvider,
  stubProxyRouterProvider,
  stubScmProvider,
  stubWorkspaceMaterializerProvider,
  stubEventTransportProvider,
  stubControlPlaneProvider,
  stubHealthCheckerProvider,
  stubLifecycleHookProvider,
  stubPackageManagerProvider,
  stubTunnelProvider,
]

const isolatedE2EProviders: readonly V2ProviderPlugin[] = [
  rigdProcessSupervisorProvider,
  plugin("isolated-e2e-process-supervisor", "process-supervisor", "Isolated E2E Process Supervisor", [
    "fake-launchd",
    "real-subprocess",
  ]),
  caddyProxyRouterProvider,
  localGitScmProvider,
  gitWorktreeMaterializerProvider,
  structuredLogEventTransportProvider,
  plugin("localhost-http", "control-plane-transport", "Localhost HTTP", ["127.0.0.1-bind", "rig-b-relay-com"]),
  nativeHealthCheckerProvider,
  shellLifecycleHookProvider,
  packageJsonScriptsProvider,
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

type V2ProviderReportForDeployment = (deployment: V2DeploymentRecord) => V2ProviderRegistryReport

const providerForDeploymentFamily = <Family extends V2ProviderFamily>(
  reportForDeployment: V2ProviderReportForDeployment,
  deployment: V2DeploymentRecord,
  family: Family,
  providerId?: string,
): Effect.Effect<V2ProviderPluginForFamily<Family>, V2RuntimeError> =>
  providerForFamily(reportForDeployment(deployment), family, providerId)

const providerOperation = (provider: V2ProviderPlugin, operation: string): Effect.Effect<string, V2RuntimeError> =>
  Effect.succeed(`${provider.family}:${provider.id}:${operation}`)

const processProviderOperation = (
  provider: V2ProviderPlugin,
  operation: string,
): Effect.Effect<V2ProcessSupervisorOperationResult, V2RuntimeError> =>
  providerOperation(provider, operation).pipe(Effect.map((operation) => ({ operation })))

const outputLines = (
  stream: V2ProviderOutputLine["stream"],
  text: string,
): readonly V2ProviderOutputLine[] =>
  text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => ({ stream, line }))

const workspaceMaterializerService = (
  report: V2ProviderRegistryReport,
  reportForDeployment: V2ProviderReportForDeployment,
  options: V2ProviderContractsOptions,
): V2WorkspaceMaterializerProviderService => {
  const base = familyService(report, "workspace-materializer")
  const gitWorktreeMaterializer = createGitWorktreeMaterializerAdapter(
    options.workspaceMaterializer,
    defaultCommandRunner,
  )
  const stubWorkspaceMaterializer = createStubWorkspaceMaterializerAdapter()

  return {
    ...base,
    resolve: (input) =>
      providerForDeploymentFamily(reportForDeployment, input.deployment, "workspace-materializer").pipe(
        Effect.flatMap((selected) =>
          selected.id === "stub-workspace-materializer"
            ? stubWorkspaceMaterializer.resolve(input, selected)
            : providerOperation(selected, `resolve:${input.deployment.workspacePath}`),
        ),
      ),
    materialize: (input) =>
      providerForDeploymentFamily(reportForDeployment, input.deployment, "workspace-materializer").pipe(
        Effect.flatMap((selected) =>
          selected.id === "git-worktree"
            ? gitWorktreeMaterializer.materialize(input, selected)
            : selected.id === "stub-workspace-materializer"
              ? stubWorkspaceMaterializer.materialize(input, selected)
              : providerOperation(selected, `materialize:${input.deployment.workspacePath}`),
        ),
      ),
    remove: (input) =>
      providerForDeploymentFamily(reportForDeployment, input.deployment, "workspace-materializer").pipe(
        Effect.flatMap((selected) =>
          selected.id === "git-worktree"
            ? gitWorktreeMaterializer.remove(input, selected)
            : selected.id === "stub-workspace-materializer"
              ? stubWorkspaceMaterializer.remove(input, selected)
              : providerOperation(selected, `remove:${input.deployment.workspacePath}`),
        ),
      ),
  }
}

const processSupervisorService = (
  report: V2ProviderRegistryReport,
  reportForDeployment: V2ProviderReportForDeployment,
  options: V2ProviderContractsOptions,
) => {
  const base = familyService(report, "process-supervisor")
  const selectedForDeployment = (deployment: V2DeploymentRecord) =>
    providerForDeploymentFamily(
      reportForDeployment,
      deployment,
      "process-supervisor",
      deployment.resolved.providers.processSupervisor,
    )
  const rigdProcessSupervisor = createRigdProcessSupervisorAdapter()
  const launchdProcessSupervisor = createLaunchdProcessSupervisorAdapter(options.launchd, defaultCommandRunner)

  return {
    ...base,
    up: (input) =>
      Effect.gen(function* () {
        const selected = yield* selectedForDeployment(input.deployment)
        if (selected.id === "rigd") {
          return yield* rigdProcessSupervisor.up(selected, input)
        }
        if (selected.id === "launchd") {
          return yield* launchdProcessSupervisor.up(selected, input)
        }
        if (selected.id === "stub-process-supervisor") {
          return yield* stubProcessSupervisorOperation(selected, "up", input.service)
        }
        return yield* processProviderOperation(selected, `up:${input.service.name}`)
      }),
    down: (input) =>
      Effect.gen(function* () {
        const selected = yield* selectedForDeployment(input.deployment)
        if (selected.id === "rigd") {
          return yield* rigdProcessSupervisor.down(selected, input)
        }
        if (selected.id === "launchd") {
          return yield* launchdProcessSupervisor.down(selected, input)
        }
        if (selected.id === "stub-process-supervisor") {
          return yield* stubProcessSupervisorOperation(selected, "down", input.service)
        }
        return yield* processProviderOperation(selected, `down:${input.service.name}`)
      }),
    restart: (input) =>
      Effect.gen(function* () {
        const selected = yield* selectedForDeployment(input.deployment)
        if (selected.id === "rigd") {
          return yield* rigdProcessSupervisor.restart(selected, input)
        }
        if (selected.id === "launchd") {
          return yield* launchdProcessSupervisor.restart(selected, input)
        }
        if (selected.id === "stub-process-supervisor") {
          return yield* stubProcessSupervisorOperation(selected, "restart", input.service)
        }
        return yield* processProviderOperation(selected, `restart:${input.service.name}`)
      }),
  }
}

const healthCheckerService = (
  report: V2ProviderRegistryReport,
  reportForDeployment: V2ProviderReportForDeployment,
): V2HealthCheckerProviderService => {
  const base = familyService(report, "health-checker")
  const nativeHealth = createNativeHealthCheckerAdapter(runPlatformCommand)
  const stubHealthChecker = createStubHealthCheckerAdapter()

  return {
    ...base,
    check: (input) =>
      providerForDeploymentFamily(reportForDeployment, input.deployment, "health-checker").pipe(
        Effect.flatMap((selected) =>
          selected.id === "native-health"
            ? nativeHealth.check(input, selected)
            : selected.id === "stub-health-checker"
              ? stubHealthChecker.check(input, selected)
              : providerOperation(selected, `check:${input.service.name}`),
        ),
      ),
  }
}

const lifecycleHookService = (
  report: V2ProviderRegistryReport,
  reportForDeployment: V2ProviderReportForDeployment,
): V2LifecycleHookProviderService => {
  const base = familyService(report, "lifecycle-hook")
  const shellHook = createShellLifecycleHookAdapter(runPlatformCommand)
  const stubLifecycleHook = createStubLifecycleHookAdapter()

  return {
    ...base,
    run: (input) =>
      providerForDeploymentFamily(reportForDeployment, input.deployment, "lifecycle-hook").pipe(
        Effect.flatMap((selected) =>
          selected.id === "shell-hook"
            ? shellHook.run(input, selected)
            : selected.id === "stub-lifecycle-hook"
              ? stubLifecycleHook.run(input, selected)
              : providerOperation(selected, `run:${input.hook}:${input.service?.name ?? "project"}`),
        ),
      ),
  }
}

const eventTransportService = (
  report: V2ProviderRegistryReport,
  reportForDeployment: V2ProviderReportForDeployment,
): V2EventTransportProviderService => {
  const base = familyService(report, "event-transport")
  const structuredLogFile = createStructuredLogEventTransportAdapter()
  const stubEventTransport = createStubEventTransportAdapter()

  return {
    ...base,
    append: (input) =>
      providerForDeploymentFamily(reportForDeployment, input.deployment, "event-transport").pipe(
        Effect.flatMap((selected) =>
          selected.id === "structured-log-file"
            ? structuredLogFile.append(input, selected)
            : selected.id === "stub-event-transport"
              ? stubEventTransport.append(input, selected)
              : providerOperation(selected, `append:${input.event}${input.component ? `:${input.component}` : ""}`),
        ),
      ),
  }
}

const scmService = (
  report: V2ProviderRegistryReport,
  reportForDeployment: V2ProviderReportForDeployment,
  options: V2ProviderContractsOptions,
): V2ScmProviderService => {
  const base = familyService(report, "scm")
  const localGitScm = createLocalGitScmAdapter(options.scm, defaultCommandRunner)
  const stubScm = createStubScmAdapter()

  return {
    ...base,
    checkout: (input) =>
      providerForDeploymentFamily(reportForDeployment, input.deployment, "scm").pipe(
        Effect.flatMap((selected) =>
          selected.id === "local-git"
            ? localGitScm.checkout(input, selected)
            : selected.id === "stub-scm"
              ? stubScm.checkout(input, selected)
              : providerOperation(selected, `checkout:${input.ref}`),
        ),
      ),
  }
}

const packageManagerService = (
  report: V2ProviderRegistryReport,
  reportForDeployment: V2ProviderReportForDeployment,
  options: V2ProviderContractsOptions = {},
): V2PackageManagerProviderService => {
  const base = familyService(report, "package-manager")
  const packageJsonScripts = createPackageJsonScriptsAdapter(options.packageManager, runPlatformCommand)
  const stubPackageManager = createStubPackageManagerAdapter()

  return {
    ...base,
    install: (input) =>
      providerForDeploymentFamily(reportForDeployment, input.deployment, "package-manager").pipe(
        Effect.flatMap((selected) =>
          selected.id === "package-json-scripts"
            ? packageJsonScripts.install(input, selected)
            : selected.id === "stub-package-manager"
              ? stubPackageManager.install(input, selected)
              : providerOperation(selected, `install:${input.service.name}`),
        ),
      ),
  }
}

const proxyRouterService = (
  report: V2ProviderRegistryReport,
  reportForDeployment: V2ProviderReportForDeployment,
  options: V2ProviderContractsOptions,
): V2ProxyRouterProviderService => {
  const base = familyService(report, "proxy-router")
  const caddyProxyRouter = createCaddyProxyRouterAdapter(options.proxyRouter, defaultCommandRunner)
  const stubProxyRouter = createStubProxyRouterAdapter()

  return {
    ...base,
    upsert: (input) =>
      providerForDeploymentFamily(reportForDeployment, input.deployment, "proxy-router").pipe(
        Effect.flatMap((selected) =>
          selected.id === "caddy"
            ? caddyProxyRouter.upsert(input, selected)
            : selected.id === "stub-proxy-router"
              ? stubProxyRouter.upsert(input, selected)
              : providerOperation(selected, `upsert:${input.proxy.upstream}`),
        ),
      ),
    remove: (input) =>
      providerForDeploymentFamily(reportForDeployment, input.deployment, "proxy-router").pipe(
        Effect.flatMap((selected) =>
          selected.id === "caddy"
            ? caddyProxyRouter.remove(input, selected)
            : selected.id === "stub-proxy-router"
              ? stubProxyRouter.remove(input, selected)
              : providerOperation(selected, `remove:${input.proxy.upstream}`),
        ),
      ),
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
  options: V2ProviderContractsOptions = {},
) => {
  const report = reportForProfile(profile, externalProviders)
  const reportForDeployment = (deployment: V2DeploymentRecord) =>
    reportForProfile(deployment.providerProfile ?? profile, externalProviders)

  return Layer.mergeAll(
    V2ProviderRegistryLive(profile, externalProviders),
    Layer.succeed(V2ProcessSupervisorProvider, processSupervisorService(report, reportForDeployment, options)),
    Layer.succeed(V2ProxyRouterProvider, proxyRouterService(report, reportForDeployment, options)),
    Layer.succeed(V2ScmProvider, scmService(report, reportForDeployment, options)),
    Layer.succeed(V2WorkspaceMaterializerProvider, workspaceMaterializerService(report, reportForDeployment, options)),
    Layer.succeed(V2EventTransportProvider, eventTransportService(report, reportForDeployment)),
    Layer.succeed(V2ControlPlaneTransportProvider, familyService(report, "control-plane-transport")),
    Layer.succeed(V2HealthCheckerProvider, healthCheckerService(report, reportForDeployment)),
    Layer.succeed(V2LifecycleHookProvider, lifecycleHookService(report, reportForDeployment)),
    Layer.succeed(V2PackageManagerProvider, packageManagerService(report, reportForDeployment, options)),
    Layer.succeed(V2TunnelProvider, familyService(report, "tunnel")),
  )
}
