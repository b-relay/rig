import { Context, Effect, Exit, Layer, Scope, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { BunChildProcessSpawner, BunFileSystem, BunPath } from "@effect/platform-bun"

import type { V2DeploymentRecord } from "./deployments.js"
import { V2RuntimeError } from "./errors.js"
import {
  V2ProcessSupervisorProvider,
  type V2ProcessSupervisorExitResult,
  type V2ProcessSupervisorOperationResult,
  type V2ProcessSupervisorProviderService,
} from "./providers/process-supervisor.js"
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

interface V2ProviderCommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

type V2ProviderCommandRunner = (args: readonly string[]) => Promise<V2ProviderCommandResult>

const V2PlatformProcessLayer = Layer.provide(
  BunChildProcessSpawner.layer,
  Layer.merge(BunFileSystem.layer, BunPath.layer),
)

const streamText = (stream: Stream.Stream<Uint8Array, unknown, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runCollect,
    Effect.map((chunks) => chunks.join("")),
  )

const childProcessCommand = (
  args: readonly string[],
  options: {
    readonly cwd?: string
  } = {},
) => {
  const command = args[0]
  if (!command) {
    return Effect.fail(
      new V2RuntimeError(
        "Unable to run an empty command.",
        "Pass a command with at least one argument before invoking the v2 process runner.",
      ),
    )
  }

  return Effect.succeed(
    ChildProcess.make(command, args.slice(1), {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdout: "pipe",
      stderr: "pipe",
    }),
  )
}

const spawnPlatformProcess = (
  args: readonly string[],
  options: {
    readonly cwd?: string
    readonly scope: Scope.Scope
  },
): Effect.Effect<ChildProcessHandle, V2RuntimeError> =>
  Effect.gen(function* () {
    const command = yield* childProcessCommand(args, options)
    return yield* command
  }).pipe(
    Scope.provide(options.scope),
    Effect.provide(V2PlatformProcessLayer),
    Effect.mapError((cause) =>
      cause instanceof V2RuntimeError
        ? cause
        : new V2RuntimeError(
          "Unable to spawn v2 platform process.",
          "Ensure the command exists and the working directory is accessible.",
          {
            command: args.join(" "),
            ...(options.cwd ? { cwd: options.cwd } : {}),
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        ),
    ),
  )

const runPlatformCommand = (
  args: readonly string[],
  options: {
    readonly cwd?: string
  } = {},
): Effect.Effect<V2ProviderCommandResult, V2RuntimeError> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const handle = yield* spawnPlatformProcess(args, { ...options, scope })
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        streamText(handle.stdout),
        streamText(handle.stderr),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    )
    yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
    return { stdout, stderr, exitCode: Number(exitCode) }
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) =>
      cause instanceof V2RuntimeError
        ? cause
        : new V2RuntimeError(
          "Unable to run v2 platform command.",
          "Ensure the command exists and the working directory is accessible.",
          {
            command: args.join(" "),
            ...(options.cwd ? { cwd: options.cwd } : {}),
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        ),
    ),
  )

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

const defaultCommandRunner: V2ProviderCommandRunner = (args) =>
  Effect.runPromise(runPlatformCommand(args))

const processSupervisorService = (
  report: V2ProviderRegistryReport,
  reportForDeployment: V2ProviderReportForDeployment,
  options: V2ProviderContractsOptions,
): V2ProcessSupervisorProviderService => {
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
