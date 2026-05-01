import { Effect, Layer } from "effect"

import type { RigDeploymentRecord } from "./deployments.js"
import { RigRuntimeError } from "./errors.js"
import {
  defaultCommandRunner,
  runPlatformCommand,
} from "./provider-command-runner.js"
import {
  RigControlPlaneTransportProvider,
  RigEventTransportProvider,
  RigHealthCheckerProvider,
  RigLifecycleHookProvider,
  RigPackageManagerProvider,
  RigProcessSupervisorProvider,
  RigProviderRegistry,
  RigProxyRouterProvider,
  RigScmProvider,
  RigTunnelProvider,
  RigWorkspaceMaterializerProvider,
  rigProviderFamilies,
  type RigEventTransportProviderService,
  type RigHealthCheckerProviderService,
  type RigLifecycleHookProviderService,
  type RigPackageManagerProviderService,
  type RigProviderContractsOptions,
  type RigProviderFamily,
  type RigProviderFamilyService,
  type RigProviderOutputLine,
  type RigProviderPlugin,
  type RigProviderPluginForFamily,
  type RigProviderPluginSource,
  type RigProviderProfileName,
  type RigProviderRegistryReport,
  type RigProxyRouterProviderService,
  type RigScmProviderService,
  type RigWorkspaceMaterializerProviderService,
} from "./provider-contracts.js"
import type { RigProcessSupervisorOperationResult } from "./providers/process-supervisor.js"
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
  family: RigProviderFamily,
  displayName: string,
  capabilities: readonly string[],
  source: RigProviderPluginSource = "first-party",
): RigProviderPlugin => ({
  id,
  family,
  source,
  displayName,
  capabilities,
})

const defaultProviders: readonly RigProviderPlugin[] = [
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

const stubProviders: readonly RigProviderPlugin[] = [
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

const isolatedE2EProviders: readonly RigProviderPlugin[] = [
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

const providersForProfile = (profile: RigProviderProfileName): readonly RigProviderPlugin[] => {
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
  profile: RigProviderProfileName,
  externalProviders: readonly RigProviderPlugin[],
): RigProviderRegistryReport => ({
  profile,
  families: rigProviderFamilies,
  providers: [...providersForProfile(profile), ...externalProviders],
})

const familyService = <Family extends RigProviderFamily>(
  report: RigProviderRegistryReport,
  family: Family,
): RigProviderFamilyService<Family> => {
  const selected = report.providers.find(
    (provider): provider is RigProviderPluginForFamily<Family> => provider.family === family,
  ) as RigProviderPluginForFamily<Family>

  return {
    family,
    plugin: Effect.succeed(selected),
  }
}

const missingProviderError = (
  family: RigProviderFamily,
  providerId: string | undefined,
): RigRuntimeError =>
  new RigRuntimeError(
    providerId
      ? `Provider '${providerId}' is not registered for '${family}'.`
      : `No provider is registered for '${family}'.`,
    "Select a registered provider id in rig.json or install the provider before running the command.",
    {
      family,
      ...(providerId ? { providerId } : {}),
    },
  )

const providerForFamily = <Family extends RigProviderFamily>(
  report: RigProviderRegistryReport,
  family: Family,
  providerId?: string,
): Effect.Effect<RigProviderPluginForFamily<Family>, RigRuntimeError> => {
  const selected = report.providers.find(
    (provider): provider is RigProviderPluginForFamily<Family> =>
      provider.family === family && (providerId === undefined || provider.id === providerId),
  )

  return selected ? Effect.succeed(selected) : Effect.fail(missingProviderError(family, providerId))
}

type RigProviderReportForDeployment = (deployment: RigDeploymentRecord) => RigProviderRegistryReport

const providerForDeploymentFamily = <Family extends RigProviderFamily>(
  reportForDeployment: RigProviderReportForDeployment,
  deployment: RigDeploymentRecord,
  family: Family,
  providerId?: string,
): Effect.Effect<RigProviderPluginForFamily<Family>, RigRuntimeError> =>
  providerForFamily(reportForDeployment(deployment), family, providerId)

const providerOperation = (provider: RigProviderPlugin, operation: string): Effect.Effect<string, RigRuntimeError> =>
  Effect.succeed(`${provider.family}:${provider.id}:${operation}`)

const processProviderOperation = (
  provider: RigProviderPlugin,
  operation: string,
): Effect.Effect<RigProcessSupervisorOperationResult, RigRuntimeError> =>
  providerOperation(provider, operation).pipe(Effect.map((operation) => ({ operation })))

const outputLines = (
  stream: RigProviderOutputLine["stream"],
  text: string,
): readonly RigProviderOutputLine[] =>
  text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => ({ stream, line }))

const workspaceMaterializerService = (
  report: RigProviderRegistryReport,
  reportForDeployment: RigProviderReportForDeployment,
  options: RigProviderContractsOptions,
): RigWorkspaceMaterializerProviderService => {
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
  report: RigProviderRegistryReport,
  reportForDeployment: RigProviderReportForDeployment,
  options: RigProviderContractsOptions,
) => {
  const base = familyService(report, "process-supervisor")
  const selectedForDeployment = (deployment: RigDeploymentRecord) =>
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
  report: RigProviderRegistryReport,
  reportForDeployment: RigProviderReportForDeployment,
): RigHealthCheckerProviderService => {
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
  report: RigProviderRegistryReport,
  reportForDeployment: RigProviderReportForDeployment,
): RigLifecycleHookProviderService => {
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
  report: RigProviderRegistryReport,
  reportForDeployment: RigProviderReportForDeployment,
): RigEventTransportProviderService => {
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
  report: RigProviderRegistryReport,
  reportForDeployment: RigProviderReportForDeployment,
  options: RigProviderContractsOptions,
): RigScmProviderService => {
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
  report: RigProviderRegistryReport,
  reportForDeployment: RigProviderReportForDeployment,
  options: RigProviderContractsOptions = {},
): RigPackageManagerProviderService => {
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
  report: RigProviderRegistryReport,
  reportForDeployment: RigProviderReportForDeployment,
  options: RigProviderContractsOptions,
): RigProxyRouterProviderService => {
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

export const RigProviderRegistryLive = (
  profile: RigProviderProfileName = "default",
  externalProviders: readonly RigProviderPlugin[] = [],
) =>
  Layer.succeed(RigProviderRegistry, {
    current: Effect.succeed(reportForProfile(profile, externalProviders)),
    forProfile: (selectedProfile) => Effect.succeed(reportForProfile(selectedProfile, externalProviders)),
  })

export const RigProviderContractsLive = (
  profile: RigProviderProfileName = "default",
  externalProviders: readonly RigProviderPlugin[] = [],
  options: RigProviderContractsOptions = {},
) => {
  const report = reportForProfile(profile, externalProviders)
  const reportForDeployment = (deployment: RigDeploymentRecord) =>
    reportForProfile(deployment.providerProfile ?? profile, externalProviders)

  return Layer.mergeAll(
    RigProviderRegistryLive(profile, externalProviders),
    Layer.succeed(RigProcessSupervisorProvider, processSupervisorService(report, reportForDeployment, options)),
    Layer.succeed(RigProxyRouterProvider, proxyRouterService(report, reportForDeployment, options)),
    Layer.succeed(RigScmProvider, scmService(report, reportForDeployment, options)),
    Layer.succeed(RigWorkspaceMaterializerProvider, workspaceMaterializerService(report, reportForDeployment, options)),
    Layer.succeed(RigEventTransportProvider, eventTransportService(report, reportForDeployment)),
    Layer.succeed(RigControlPlaneTransportProvider, familyService(report, "control-plane-transport")),
    Layer.succeed(RigHealthCheckerProvider, healthCheckerService(report, reportForDeployment)),
    Layer.succeed(RigLifecycleHookProvider, lifecycleHookService(report, reportForDeployment)),
    Layer.succeed(RigPackageManagerProvider, packageManagerService(report, reportForDeployment, options)),
    Layer.succeed(RigTunnelProvider, familyService(report, "tunnel")),
  )
}
