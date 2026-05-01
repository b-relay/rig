import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Context, Effect, Exit, Layer, Scope, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { BunChildProcessSpawner, BunFileSystem, BunPath } from "@effect/platform-bun"

import type { V2DeploymentRecord } from "./deployments.js"
import {
  isPlatformNotFound,
  platformAppendFileString,
  platformChmod,
  platformCopyFile,
  platformExists,
  platformMakeDirectory,
  platformReadFileBytes,
  platformReadFileString,
  platformRemove,
  platformWriteFileString,
} from "./effect-platform.js"
import { V2RuntimeError } from "./errors.js"
import { rigV2BinRoot, rigV2ProxyRoot } from "./paths.js"
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
  plugin("caddy", "proxy-router", "Caddy", ["local-reverse-proxy", "tls-termination"]),
  plugin("local-git", "scm", "Local Git", ["ref-resolution", "rollback-anchor"]),
  plugin("git-worktree", "workspace-materializer", "Git Worktree", ["branch-workspace", "generated-deployment"]),
  plugin("structured-log-file", "event-transport", "Structured Log File", ["append-only-events", "doctor-readable"]),
  plugin("localhost-http", "control-plane-transport", "Localhost HTTP", ["127.0.0.1-bind", "rig-b-relay-com"]),
  plugin("native-health", "health-checker", "Native Health Checks", ["http-health", "command-health", "ownership-check"]),
  plugin("shell-hook", "lifecycle-hook", "Shell Lifecycle Hooks", ["project-hooks", "component-hooks"]),
  plugin("package-json-scripts", "package-manager", "package.json Scripts", ["npm-compatible", "bun-compatible"]),
  plugin("manual-tailscale", "tunnel", "Manual Tailscale DNS", ["private-dns-route", "no-app-auth"]),
]

const stubProviders: readonly V2ProviderPlugin[] = [
  rigdProcessSupervisorProvider,
  stubProcessSupervisorProvider,
  plugin("stub-proxy-router", "proxy-router", "Stub Proxy Router", ["proxy-router-contract-test"]),
  plugin("stub-scm", "scm", "Stub SCM", ["scm-contract-test"]),
  plugin("stub-workspace-materializer", "workspace-materializer", "Stub Workspace Materializer", [
    "workspace-materializer-contract-test",
  ]),
  plugin("stub-event-transport", "event-transport", "Stub Event Transport", ["event-transport-contract-test"]),
  plugin("stub-control-plane", "control-plane-transport", "Stub Control Plane", ["localhost-contract-test"]),
  plugin("stub-health-checker", "health-checker", "Stub Health Checker", ["health-checker-contract-test"]),
  plugin("stub-lifecycle-hook", "lifecycle-hook", "Stub Lifecycle Hook", ["lifecycle-hook-contract-test"]),
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
  plugin("shell-hook", "lifecycle-hook", "Shell Lifecycle Hooks", ["project-hooks", "component-hooks"]),
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

const sourceRepoPath = (
  deployment: V2DeploymentRecord,
  provider: V2ProviderPlugin,
  configured?: string,
): Effect.Effect<string, V2RuntimeError> => {
  if (configured && configured.trim().length > 0) {
    return Effect.succeed(configured)
  }

  const maybeResolvedRepoPath = (deployment.resolved as { readonly sourceRepoPath?: unknown }).sourceRepoPath
  if (typeof maybeResolvedRepoPath === "string" && maybeResolvedRepoPath.trim().length > 0) {
    return Effect.succeed(maybeResolvedRepoPath)
  }

  const maybeRepoPath = (deployment.resolved.v1Config as { readonly repoPath?: unknown } | undefined)?.repoPath
  if (typeof maybeRepoPath === "string" && maybeRepoPath.trim().length > 0) {
    return Effect.succeed(maybeRepoPath)
  }

  return Effect.fail(
    new V2RuntimeError(
      `Unable to resolve source repo for deployment '${deployment.name}'.`,
      "Run from a managed repo or pass a config path that preserves the source repository before deploying.",
      {
        providerId: provider.id,
        deployment: deployment.name,
        workspacePath: deployment.workspacePath,
      },
    ),
  )
}

const workspaceMaterializerService = (
  report: V2ProviderRegistryReport,
  reportForDeployment: V2ProviderReportForDeployment,
  options: V2ProviderContractsOptions,
): V2WorkspaceMaterializerProviderService => {
  const base = familyService(report, "workspace-materializer")

  const runGit = options.workspaceMaterializer?.runCommand ?? defaultCommandRunner

  const materializeGitWorktree = (input: {
    readonly deployment: V2DeploymentRecord
    readonly ref: string
  }, selected: V2ProviderPluginForFamily<"workspace-materializer">): Effect.Effect<string, V2RuntimeError> =>
    Effect.gen(function* () {
      const repoPath = yield* sourceRepoPath(input.deployment, selected, options.workspaceMaterializer?.sourceRepoPath)
      const workspacePath = input.deployment.workspacePath
      yield* Effect.tryPromise({
        try: async () => {
          await Effect.runPromise(platformMakeDirectory(dirname(workspacePath)))
          const removeResult = await runGit(["git", "-C", repoPath, "worktree", "remove", "--force", workspacePath])
          if (removeResult.exitCode !== 0) {
            const stderr = removeResult.stderr.toLowerCase()
            const missing =
              stderr.includes("is not a working tree") ||
              stderr.includes("not a working tree") ||
              stderr.includes("no such file") ||
              stderr.includes("does not exist")
            if (!missing) {
              throw new V2RuntimeError(
                `Unable to remove existing workspace '${input.deployment.name}'.`,
                "Inspect the generated deployment workspace and retry the deploy.",
                {
                  providerId: selected.id,
                  repoPath,
                  workspacePath,
                  stderr: removeResult.stderr,
                },
              )
            }
          }

          const addResult = await runGit([
            "git",
            "-C",
            repoPath,
            "worktree",
            "add",
            "--force",
            "--detach",
            workspacePath,
            input.ref,
          ])
          if (addResult.exitCode !== 0) {
            throw new V2RuntimeError(
              `Unable to materialize workspace '${input.deployment.name}' at ref '${input.ref}'.`,
              "Ensure the ref exists in the source repository and retry the deploy.",
              {
                providerId: selected.id,
                repoPath,
                workspacePath,
                ref: input.ref,
                stderr: addResult.stderr,
              },
            )
          }
        },
        catch: (cause) =>
          cause instanceof V2RuntimeError
            ? cause
            : new V2RuntimeError(
              `Unable to materialize workspace '${input.deployment.name}'.`,
              "Ensure the source repository and v2 workspace directory are writable.",
              {
                providerId: selected.id,
                repoPath,
                workspacePath,
                ref: input.ref,
                cause: cause instanceof Error ? cause.message : String(cause),
              },
            ),
      })

      return `${selected.family}:${selected.id}:materialize:${workspacePath}:${input.ref}`
    })

  const removeGitWorktree = (input: {
    readonly deployment: V2DeploymentRecord
  }, selected: V2ProviderPluginForFamily<"workspace-materializer">): Effect.Effect<string, V2RuntimeError> =>
    Effect.gen(function* () {
      const repoPath = yield* sourceRepoPath(input.deployment, selected, options.workspaceMaterializer?.sourceRepoPath)
      const workspacePath = input.deployment.workspacePath
      yield* Effect.tryPromise({
        try: async () => {
          const result = await runGit(["git", "-C", repoPath, "worktree", "remove", "--force", workspacePath])
          if (result.exitCode !== 0) {
            const stderr = result.stderr.toLowerCase()
            const missing =
              stderr.includes("is not a working tree") ||
              stderr.includes("not a working tree") ||
              stderr.includes("no such file") ||
              stderr.includes("does not exist")
            if (!missing) {
              throw new V2RuntimeError(
                `Unable to remove workspace '${input.deployment.name}'.`,
                "Inspect the generated deployment workspace and retry teardown.",
                {
                  providerId: selected.id,
                  repoPath,
                  workspacePath,
                  stderr: result.stderr,
                },
              )
            }
          }
          await Effect.runPromise(platformRemove(workspacePath, { recursive: true, force: true }))
        },
        catch: (cause) =>
          cause instanceof V2RuntimeError
            ? cause
            : new V2RuntimeError(
              `Unable to remove workspace '${input.deployment.name}'.`,
              "Ensure the v2 workspace path is writable and retry teardown.",
              {
                providerId: selected.id,
                repoPath,
                workspacePath,
                cause: cause instanceof Error ? cause.message : String(cause),
              },
            ),
      })

      return `${selected.family}:${selected.id}:remove:${workspacePath}`
    })

  return {
    ...base,
    resolve: (input) =>
      providerForDeploymentFamily(reportForDeployment, input.deployment, "workspace-materializer").pipe(
        Effect.flatMap((selected) => providerOperation(selected, `resolve:${input.deployment.workspacePath}`)),
      ),
    materialize: (input) =>
      providerForDeploymentFamily(reportForDeployment, input.deployment, "workspace-materializer").pipe(
        Effect.flatMap((selected) =>
          selected.id === "git-worktree"
            ? materializeGitWorktree(input, selected)
            : providerOperation(selected, `materialize:${input.deployment.workspacePath}`),
        ),
      ),
    remove: (input) =>
      providerForDeploymentFamily(reportForDeployment, input.deployment, "workspace-materializer").pipe(
        Effect.flatMap((selected) =>
          selected.id === "git-worktree"
            ? removeGitWorktree(input, selected)
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

  const checkNativeHealth = (input: {
    readonly deployment: V2DeploymentRecord
    readonly service: V2RuntimeServiceConfig
    readonly timeoutSeconds?: number
  }, selected: V2ProviderPluginForFamily<"health-checker">): Effect.Effect<string, V2RuntimeError> => {
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

    const timeoutSeconds = input.timeoutSeconds
      ?? ("readyTimeout" in input.service ? input.service.readyTimeout : undefined)
      ?? 30

    const check = !target.startsWith("http://") && !target.startsWith("https://")
      ? Effect.gen(function* () {
        const { exitCode, stdout, stderr } = yield* runPlatformCommand(
          ["sh", "-lc", target],
          { cwd: input.deployment.workspacePath },
        )

        if (exitCode !== 0) {
          return yield* Effect.fail(new V2RuntimeError(
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
          ))
        }

        return `${selected.family}:${selected.id}:check:${input.service.name}:command:healthy:${exitCode}`
      })
      : Effect.tryPromise({
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

    return check.pipe(
      Effect.timeoutOrElse({
        duration: `${timeoutSeconds} seconds`,
        orElse: () =>
          Effect.fail(new V2RuntimeError(
            `Health check timed out for '${input.service.name}' after ${timeoutSeconds} seconds.`,
            "Increase readyTimeout or fix the component so its health check completes in time.",
            {
              providerId: selected.id,
              component: input.service.name,
              deployment: input.deployment.name,
              target,
              timeoutSeconds,
            },
          )),
      }),
      Effect.mapError((cause) => {
        if (cause instanceof V2RuntimeError) {
          return cause
        }
        return new V2RuntimeError(
          `Unable to run health check for '${input.service.name}'.`,
          "Ensure the health endpoint is reachable from localhost and retry.",
          {
            providerId: selected.id,
            component: input.service.name,
            deployment: input.deployment.name,
            target,
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        )
      }),
    )
  }

  return {
    ...base,
    check: (input) =>
      providerForDeploymentFamily(reportForDeployment, input.deployment, "health-checker").pipe(
        Effect.flatMap((selected) =>
          selected.id === "native-health"
            ? checkNativeHealth(input, selected)
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

  const shellHook = (input: {
    readonly deployment: V2DeploymentRecord
    readonly hook: "preStart" | "postStart" | "preStop" | "postStop"
    readonly command: string
    readonly service?: V2RuntimeServiceConfig
  }, selected: V2ProviderPluginForFamily<"lifecycle-hook">): Effect.Effect<string, V2RuntimeError> =>
    Effect.gen(function* () {
      const { exitCode, stdout, stderr } = yield* runPlatformCommand(
        ["sh", "-lc", input.command],
        { cwd: input.deployment.workspacePath },
      )

      if (exitCode !== 0) {
        return yield* Effect.fail(new V2RuntimeError(
          `Lifecycle hook '${input.hook}' failed${input.service ? ` for '${input.service.name}'` : ""} with exit code ${exitCode}.`,
          "Fix the hook command before retrying the runtime action.",
          {
            providerId: selected.id,
            hook: input.hook,
            command: input.command,
            project: input.deployment.project,
            deployment: input.deployment.name,
            ...(input.service ? { component: input.service.name } : {}),
            exitCode,
            stdout,
            stderr,
          },
        ))
      }

      return `${selected.family}:${selected.id}:run:${input.hook}:${input.service?.name ?? "project"}:${exitCode}`
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof V2RuntimeError
          ? cause
          : new V2RuntimeError(
            `Unable to run lifecycle hook '${input.hook}'${input.service ? ` for '${input.service.name}'` : ""}.`,
            "Ensure the hook command can run from the deployment workspace and retry.",
            {
              providerId: selected.id,
              hook: input.hook,
              command: input.command,
              project: input.deployment.project,
              deployment: input.deployment.name,
              ...(input.service ? { component: input.service.name } : {}),
              cause: cause instanceof Error ? cause.message : String(cause),
            },
          )),
    )

  return {
    ...base,
    run: (input) =>
      providerForDeploymentFamily(reportForDeployment, input.deployment, "lifecycle-hook").pipe(
        Effect.flatMap((selected) =>
          selected.id === "shell-hook"
            ? shellHook(input, selected)
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

  const appendStructuredLogFile = (input: {
    readonly deployment: V2DeploymentRecord
    readonly event: string
    readonly component?: string
    readonly details?: Readonly<Record<string, unknown>>
  }, selected: V2ProviderPluginForFamily<"event-transport">): Effect.Effect<string, V2RuntimeError> => {
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

    return Effect.gen(function* () {
        yield* platformMakeDirectory(input.deployment.logRoot)
        yield* platformAppendFileString(logPath, `${JSON.stringify(entry)}\n`)
        return `${selected.family}:${selected.id}:append:${input.event}${input.component ? `:${input.component}` : ""}`
      }).pipe(
        Effect.mapError(runtimeError(
        "Unable to append v2 runtime event.",
        "Ensure the deployment log root is writable before retrying the runtime action.",
        {
          providerId: selected.id,
          logPath,
          event: input.event,
          ...(input.component ? { component: input.component } : {}),
        },
        )),
      )
  }

  return {
    ...base,
    append: (input) =>
      providerForDeploymentFamily(reportForDeployment, input.deployment, "event-transport").pipe(
        Effect.flatMap((selected) =>
          selected.id === "structured-log-file"
            ? appendStructuredLogFile(input, selected)
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
  const runGit = options.scm?.runCommand ?? defaultCommandRunner

  const checkoutLocalGit = (input: {
    readonly deployment: V2DeploymentRecord
    readonly ref: string
  }, selected: V2ProviderPluginForFamily<"scm">): Effect.Effect<string, V2RuntimeError> =>
    Effect.gen(function* () {
      const repoPath = yield* sourceRepoPath(input.deployment, selected, options.scm?.sourceRepoPath)
      const commit = yield* Effect.tryPromise({
        try: async () => {
          const fetchResult = await runGit(["git", "-C", repoPath, "fetch", "--prune", "origin"])
          if (fetchResult.exitCode !== 0) {
            throw new V2RuntimeError(
              `Unable to fetch refs for '${input.deployment.name}'.`,
              "Ensure the source repository has an origin remote and network access before retrying deploy.",
              {
                providerId: selected.id,
                repoPath,
                ref: input.ref,
                stderr: fetchResult.stderr,
              },
            )
          }

          const verifyResult = await runGit([
            "git",
            "-C",
            repoPath,
            "rev-parse",
            "--verify",
            `${input.ref}^{commit}`,
          ])
          if (verifyResult.exitCode !== 0) {
            throw new V2RuntimeError(
              `Unable to resolve deploy ref '${input.ref}'.`,
              "Push or fetch the ref into the source repository before retrying deploy.",
              {
                providerId: selected.id,
                repoPath,
                ref: input.ref,
                stderr: verifyResult.stderr,
              },
            )
          }

          return verifyResult.stdout.trim()
        },
        catch: (cause) =>
          cause instanceof V2RuntimeError
            ? cause
            : new V2RuntimeError(
              `Unable to prepare local git checkout for '${input.deployment.name}'.`,
              "Ensure git is installed and the source repository path is valid.",
              {
                providerId: selected.id,
                repoPath,
                ref: input.ref,
                cause: cause instanceof Error ? cause.message : String(cause),
              },
            ),
      })

      return `${selected.family}:${selected.id}:checkout:${input.ref}:${commit}`
    })

  return {
    ...base,
    checkout: (input) =>
      providerForDeploymentFamily(reportForDeployment, input.deployment, "scm").pipe(
        Effect.flatMap((selected) =>
          selected.id === "local-git"
            ? checkoutLocalGit(input, selected)
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

  const binRoot = options.packageManager?.binRoot ?? rigV2BinRoot()

  const installName = (deployment: V2DeploymentRecord, serviceName: string): string => {
    if (deployment.kind === "live") return serviceName
    if (deployment.kind === "local") return `${serviceName}-dev`
    return `${serviceName}-${deployment.name}`
  }

  const installPath = (deployment: V2DeploymentRecord, serviceName: string): string =>
    join(binRoot, installName(deployment, serviceName))

  const isWithinWorkspace = (path: string, workspacePath: string): boolean => {
    const workspace = resolve(workspacePath)
    const candidate = resolve(path)
    const rel = relative(workspace, candidate)
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
  }

  const resolveEntrypoint = (entrypoint: string, workspacePath: string): string =>
    isAbsolute(entrypoint) ? entrypoint : resolve(workspacePath, entrypoint)

  const isBinaryContent = (content: Uint8Array): boolean => {
    const sample = content.subarray(0, 8192)
    return sample.includes(0)
  }

  const commandShim = (workspacePath: string, command: string): string =>
    `#!/bin/sh\ncd ${JSON.stringify(workspacePath)} && exec ${command} "$@"\n`

  const scriptShim = (workspacePath: string, entrypoint: string): string =>
    `#!/bin/sh\ncd ${JSON.stringify(workspacePath)} && exec ./${entrypoint} "$@"\n`

  const installEntrypoint = (
    deployment: V2DeploymentRecord,
    service: Extract<V2RuntimeServiceConfig, { readonly type: "bin" }>,
    selected: V2ProviderPluginForFamily<"package-manager">,
  ): Effect.Effect<string, V2RuntimeError> => Effect.gen(function* () {
    const destination = installPath(deployment, service.name)
    yield* platformMakeDirectory(dirname(destination))

    if (service.entrypoint.includes(" ") && !service.build) {
      yield* platformWriteFileString(destination, commandShim(deployment.workspacePath, service.entrypoint))
      yield* platformChmod(destination, 0o755)
      return destination
    }

    if (service.entrypoint.includes(" ") && service.build) {
      return yield* Effect.fail(new V2RuntimeError(
        `Installed component '${service.name}' cannot use a command entrypoint with a build command.`,
        "Use a file entrypoint for built CLI artifacts.",
        {
          providerId: selected.id,
          component: service.name,
          deployment: deployment.name,
          entrypoint: service.entrypoint,
          build: service.build,
        },
      ))
    }

    const entrypoint = resolveEntrypoint(service.entrypoint, deployment.workspacePath)
    if (!isWithinWorkspace(entrypoint, deployment.workspacePath)) {
      return yield* Effect.fail(new V2RuntimeError(
        `Installed component '${service.name}' resolves outside the deployment workspace.`,
        "Use an entrypoint path inside the deployment workspace.",
        {
          providerId: selected.id,
          component: service.name,
          deployment: deployment.name,
          entrypoint: service.entrypoint,
          workspacePath: deployment.workspacePath,
        },
      ))
    }

    const content = yield* platformReadFileBytes(entrypoint)
    if (isBinaryContent(content)) {
      yield* platformCopyFile(entrypoint, destination)
    } else if (service.build) {
      yield* platformCopyFile(entrypoint, destination)
    } else {
      yield* platformWriteFileString(destination, scriptShim(deployment.workspacePath, service.entrypoint))
    }
    yield* platformChmod(destination, 0o755)
    return destination
  })

  const installPackageJsonScript = (input: {
    readonly deployment: V2DeploymentRecord
    readonly service: V2RuntimeServiceConfig
  }, selected: V2ProviderPluginForFamily<"package-manager">): Effect.Effect<string, V2RuntimeError> => {
    if (input.service.type !== "bin") {
      return providerOperation(selected, `install:${input.service.name}`)
    }

    return Effect.gen(function* () {
        if ("build" in input.service && input.service.build) {
          const { exitCode, stdout, stderr } = yield* runPlatformCommand(
            ["sh", "-lc", input.service.build],
            { cwd: input.deployment.workspacePath },
          )

          if (exitCode !== 0) {
            return yield* Effect.fail(new V2RuntimeError(
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
            ))
          }
        }

        const destination = yield* installEntrypoint(input.deployment, input.service, selected)
        return `${selected.family}:${selected.id}:install:${input.service.name}:installed:${destination}`
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof V2RuntimeError
          ? cause
          : new V2RuntimeError(
            `Unable to install package component '${input.service.name}'.`,
            "Ensure the deployment workspace, entrypoint, build command, and v2 bin root are available.",
            {
              providerId: selected.id,
              component: input.service.name,
              deployment: input.deployment.name,
              ...("build" in input.service && input.service.build ? { build: input.service.build } : {}),
              entrypoint: input.service.entrypoint,
              binRoot,
              cause: cause instanceof Error ? cause.message : String(cause),
            },
          ),
      ),
    )
  }

  return {
    ...base,
    install: (input) =>
      providerForDeploymentFamily(reportForDeployment, input.deployment, "package-manager").pipe(
        Effect.flatMap((selected) =>
          selected.id === "package-json-scripts"
            ? installPackageJsonScript(input, selected)
            : providerOperation(selected, `install:${input.service.name}`),
        ),
      ),
  }
}

interface V2CaddyRoute {
  readonly project: string
  readonly deployment: string
  readonly upstream: string
  readonly domain: string
  readonly port: number
}

interface V2ParsedCaddyBlock {
  readonly route: V2CaddyRoute
  readonly startLine: number
  readonly endLine: number
}

interface V2CaddySiteBlock {
  readonly route?: V2CaddyRoute
  readonly domain: string
  readonly port: number
  readonly startLine: number
  readonly endLine: number
}

const V2_CADDY_MARKER_RE = /^# \[rig2:([^:]+):([^:]+):([^\]]+)\]\s*$/
const V1_CADDY_MARKER_RE = /^# \[rig:([^:]+):(dev|prod)(?::([^\]]+))?\]\s*$/

const routeKey = (route: Pick<V2CaddyRoute, "project" | "deployment" | "upstream">): string =>
  `${route.project}:${route.deployment}:${route.upstream}`

const parseCaddySiteBlocks = (text: string): readonly V2CaddySiteBlock[] => {
  const lines = text.split("\n")
  const blocks: V2CaddySiteBlock[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const marker = line.match(V2_CADDY_MARKER_RE)
    const v1Marker = line.match(V1_CADDY_MARKER_RE)
    const markerLine = marker || v1Marker ? index : undefined
    const domainLine = markerLine === undefined
      ? index
      : (() => {
        let candidate = markerLine + 1
        while (candidate < lines.length && lines[candidate]?.trim() === "") {
          candidate += 1
        }
        return candidate
      })()

    const domainMatch = lines[domainLine]?.match(/^\s*(\S+)\s*\{/)
    if (!domainMatch || domainMatch[1].startsWith("(")) {
      continue
    }

    const domain = domainMatch[1]
    let port = 0
    let braceDepth = 1
    let endLine = domainLine

    for (let scan = domainLine + 1; scan < lines.length && braceDepth > 0; scan += 1) {
      const trimmed = lines[scan]?.trim() ?? ""
      if (trimmed.endsWith("{")) {
        braceDepth += 1
      }
      if (trimmed === "}") {
        braceDepth -= 1
      }

      const proxyMatch = trimmed.match(/^reverse_proxy\s+https?:\/\/127\.0\.0\.1:(\d+)/)
      if (proxyMatch) {
        port = Number.parseInt(proxyMatch[1], 10)
      }

      if (braceDepth === 0) {
        endLine = scan
      }
    }

    if (port === 0) {
      continue
    }

    let startLine = markerLine ?? domainLine
    if (markerLine === undefined && domainLine > 0 && lines[domainLine - 1]?.trim().startsWith("#")) {
      startLine = domainLine - 1
    }

    const route = marker
      ? {
        project: marker[1],
        deployment: marker[2],
        upstream: marker[3],
        domain,
        port,
      }
      : v1Marker
        ? {
          project: v1Marker[1],
          deployment: v1Marker[2] === "prod" ? "live" : "local",
          upstream: v1Marker[3] ?? "web",
          domain,
          port,
        }
        : undefined

    blocks.push({
      ...(route ? { route } : {}),
      domain,
      port,
      startLine,
      endLine,
    })
    index = Math.max(index, endLine)
  }

  return blocks
}

const parseV2CaddyBlocks = (text: string): readonly V2ParsedCaddyBlock[] =>
  parseCaddySiteBlocks(text).flatMap((block) =>
    block.route && block.startLine >= 0
      ? [{ route: block.route, startLine: block.startLine, endLine: block.endLine }]
      : [],
  )

const renderV2CaddyBlock = (
  route: V2CaddyRoute,
  extraConfig: readonly string[] = [],
): string =>
  [
    `# [rig2:${route.project}:${route.deployment}:${route.upstream}]`,
    `${route.domain} {`,
    `\treverse_proxy http://127.0.0.1:${route.port}`,
    ...extraConfig.map((line) => `\t${line}`),
    `}`,
  ].join("\n")

const readTextIfExists = (path: string): Effect.Effect<string, unknown> =>
  platformReadFileString(path).pipe(
    Effect.catch((cause) => isPlatformNotFound(cause) ? Effect.succeed("") : Effect.fail(cause)),
  )

const backupIfExists = (path: string): Effect.Effect<void, unknown> =>
  platformExists(path).pipe(
    Effect.flatMap((exists) =>
      exists
        ? platformCopyFile(path, `${path}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`)
        : Effect.void
    ),
  )

const writeText = (path: string, text: string): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    yield* platformMakeDirectory(dirname(path))
    yield* platformWriteFileString(path, text)
  })

const deploymentDomain = (
  deployment: V2DeploymentRecord,
  provider: V2ProviderPlugin,
): Effect.Effect<string, V2RuntimeError> => {
  const domain = deployment.resolved.v1Config.domain
  if (typeof domain === "string" && domain.trim().length > 0) {
    return Effect.succeed(domain)
  }

  return Effect.fail(
    new V2RuntimeError(
      `Unable to route deployment '${deployment.name}' without a domain.`,
      "Set a project domain or lane domain before enabling proxy routing.",
      {
        providerId: provider.id,
        project: deployment.project,
        deployment: deployment.name,
      },
    ),
  )
}

const upstreamPort = (
  deployment: V2DeploymentRecord,
  upstream: string,
  provider: V2ProviderPlugin,
): Effect.Effect<number, V2RuntimeError> => {
  const service = deployment.resolved.environment.services.find((candidate) => candidate.name === upstream)
  if (service && service.type === "server" && "port" in service && typeof service.port === "number") {
    return Effect.succeed(service.port)
  }

  return Effect.fail(
    new V2RuntimeError(
      `Unable to route upstream '${upstream}' for deployment '${deployment.name}'.`,
      "Proxy upstream must reference a managed component with a concrete port.",
      {
        providerId: provider.id,
        project: deployment.project,
        deployment: deployment.name,
        upstream,
      },
    ),
  )
}

const proxyRouterService = (
  report: V2ProviderRegistryReport,
  reportForDeployment: V2ProviderReportForDeployment,
  options: V2ProviderContractsOptions,
): V2ProxyRouterProviderService => {
  const base = familyService(report, "proxy-router")
  const caddyfilePath = options.proxyRouter?.caddyfilePath ?? options.proxyRouter?.caddyfile ?? join(rigV2ProxyRoot(), "Caddyfile")
  const extraConfig = options.proxyRouter?.extraConfig ?? []
  const reloadConfig = options.proxyRouter?.reload ?? { mode: "manual" as const }
  const runReload = options.proxyRouter?.runCommand ?? defaultCommandRunner

  const reloadCaddyAfterWrite = (
    selected: V2ProviderPluginForFamily<"proxy-router">,
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    if (reloadConfig.mode !== "command") {
      return Promise.resolve()
    }
    const command = reloadConfig.command?.trim()
    if (!command) {
      return Promise.reject(new V2RuntimeError(
        "Unable to reload Caddy because no reload command is configured.",
        "Set providers.caddy.reload.command or use manual reload mode.",
        {
          providerId: selected.id,
          caddyfilePath,
          ...details,
        },
      ))
    }

    return runReload(["sh", "-lc", command]).then((result) => {
      if (result.exitCode !== 0) {
        throw new V2RuntimeError(
          "Caddy reload command failed.",
          "Inspect the configured Caddy reload command and retry after fixing Caddy.",
          {
            providerId: selected.id,
            caddyfilePath,
            command,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            ...details,
          },
        )
      }
    })
  }

  const upsertCaddyRoute = (input: {
    readonly deployment: V2DeploymentRecord
    readonly proxy: V2RuntimeProxyConfig
  }, selected: V2ProviderPluginForFamily<"proxy-router">): Effect.Effect<string, V2RuntimeError> =>
    Effect.gen(function* () {
      const domain = yield* deploymentDomain(input.deployment, selected)
      const port = yield* upstreamPort(input.deployment, input.proxy.upstream, selected)
      const route: V2CaddyRoute = {
        project: input.deployment.project,
        deployment: input.deployment.name,
        upstream: input.proxy.upstream,
        domain,
        port,
      }

      yield* Effect.gen(function* () {
        const text = yield* readTextIfExists(caddyfilePath)
        const lines = text.split("\n")
        const existing = parseCaddySiteBlocks(text)
        const target =
          existing.find((block) => block.route && routeKey(block.route) === routeKey(route)) ??
          existing.find((block) => block.domain === route.domain)
        const block = renderV2CaddyBlock(route, extraConfig)
        const next = target
          ? [
            ...lines.slice(0, target.startLine),
            block,
            ...lines.slice(target.endLine + 1),
          ].join("\n")
          : text.trimEnd() === ""
            ? `${block}\n`
            : `${text.trimEnd()}\n\n${block}\n`

        yield* backupIfExists(caddyfilePath)
        yield* writeText(caddyfilePath, next)
        yield* Effect.tryPromise({
          try: () => reloadCaddyAfterWrite(selected, {
            project: input.deployment.project,
            deployment: input.deployment.name,
            upstream: input.proxy.upstream,
            domain,
            port,
          }),
          catch: (cause) => cause,
        })
      }).pipe(
        Effect.mapError(runtimeError(
          `Unable to upsert Caddy route for deployment '${input.deployment.name}'.`,
          "Ensure the v2 Caddyfile path is writable and retry proxy routing.",
          {
            providerId: selected.id,
            caddyfilePath,
            project: input.deployment.project,
            deployment: input.deployment.name,
            upstream: input.proxy.upstream,
            domain,
            port,
          },
        )),
      )

      return `${selected.family}:${selected.id}:upsert:${domain}:${input.proxy.upstream}:${port}`
    })

  const removeCaddyRoute = (input: {
    readonly deployment: V2DeploymentRecord
    readonly proxy: V2RuntimeProxyConfig
  }, selected: V2ProviderPluginForFamily<"proxy-router">): Effect.Effect<string, V2RuntimeError> =>
    Effect.gen(function* () {
        const text = yield* readTextIfExists(caddyfilePath)
        const lines = text.split("\n")
        const key = routeKey({
          project: input.deployment.project,
          deployment: input.deployment.name,
          upstream: input.proxy.upstream,
        })
        const target = parseV2CaddyBlocks(text).find((block) => routeKey(block.route) === key)
        if (target) {
          let endLine = target.endLine + 1
          if (endLine < lines.length && lines[endLine]?.trim() === "") {
            endLine += 1
          }
          const next = [
            ...lines.slice(0, target.startLine),
            ...lines.slice(endLine),
          ].join("\n")
          yield* backupIfExists(caddyfilePath)
          yield* writeText(caddyfilePath, next)
          yield* Effect.tryPromise({
            try: () => reloadCaddyAfterWrite(selected, {
              project: input.deployment.project,
              deployment: input.deployment.name,
              upstream: input.proxy.upstream,
            }),
            catch: (cause) => cause,
          })
        }
        return `${selected.family}:${selected.id}:remove:${input.deployment.project}:${input.deployment.name}:${input.proxy.upstream}`
      }).pipe(
        Effect.mapError(runtimeError(
        `Unable to remove Caddy route for deployment '${input.deployment.name}'.`,
        "Ensure the v2 Caddyfile path is writable and retry proxy teardown.",
        {
          providerId: selected.id,
          caddyfilePath,
          project: input.deployment.project,
          deployment: input.deployment.name,
          upstream: input.proxy.upstream,
        },
        )),
      )

  return {
    ...base,
    upsert: (input) =>
      providerForDeploymentFamily(reportForDeployment, input.deployment, "proxy-router").pipe(
        Effect.flatMap((selected) =>
          selected.id === "caddy"
            ? upsertCaddyRoute(input, selected)
            : providerOperation(selected, `upsert:${input.proxy.upstream}`),
        ),
      ),
    remove: (input) =>
      providerForDeploymentFamily(reportForDeployment, input.deployment, "proxy-router").pipe(
        Effect.flatMap((selected) =>
          selected.id === "caddy"
            ? removeCaddyRoute(input, selected)
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
