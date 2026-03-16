import { join } from "node:path"
import { Effect } from "effect"

import { FileSystem, type FileSystem as FileSystemService } from "../interfaces/file-system.js"
import { Git, type Git as GitService } from "../interfaces/git.js"
import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
import { ProcessManager, type ProcessManager as ProcessManagerService } from "../interfaces/process-manager.js"
import { ReverseProxy, type ProxyEntry, type ReverseProxy as ReverseProxyService } from "../interfaces/reverse-proxy.js"
import { Workspace, type Workspace as WorkspaceService } from "../interfaces/workspace.js"
import type { BinInstaller as BinInstallerService } from "../interfaces/bin-installer.js"
import type { EnvLoader as EnvLoaderService } from "../interfaces/env-loader.js"
import type { HealthChecker as HealthCheckerService } from "../interfaces/health-checker.js"
import type { HookRunner as HookRunnerService } from "../interfaces/hook-runner.js"
import type { PortChecker as PortCheckerService } from "../interfaces/port-checker.js"
import type { Registry as RegistryService } from "../interfaces/registry.js"
import type { ServiceRunner as ServiceRunnerService } from "../interfaces/service-runner.js"
import type { DeployArgs } from "../schema/args.js"
import type { Environment, RigConfig, ServerService } from "../schema/config.js"
import { CliArgumentError, ConfigValidationError, ProcessError, WorkspaceError, type RigError } from "../schema/errors.js"
import { loadProjectConfig, loadProjectConfigAtPath, resolveEnvironment, type LoadedProjectConfig } from "./config.js"
import {
  bumpVersion,
  compareVersions,
  loadVersionHistory,
  versionTag,
  writeRigJsonVersion,
  writeVersionHistory,
  type BumpAction,
  type VersionHistory,
} from "./release.js"
import { versionHistoryPath } from "./state-paths.js"
import { configError, daemonLabel } from "./shared.js"
import { runStartCommand, runStopCommand } from "./lifecycle.js"

type ReleaseMutationResult = {
  readonly targetVersion: string
  readonly rollback: Effect.Effect<void, never, FileSystemService | GitService>
}

type DeployCommandEnv =
  | BinInstallerService
  | EnvLoaderService
  | FileSystemService
  | GitService
  | HealthCheckerService
  | HookRunnerService
  | LoggerService
  | PortCheckerService
  | ProcessManagerService
  | RegistryService
  | ReverseProxyService
  | ServiceRunnerService
  | WorkspaceService

const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+$/

const hasChanged = (current: ProxyEntry, next: ProxyEntry): boolean =>
  current.domain !== next.domain ||
  current.port !== next.port ||
  current.upstream !== next.upstream

const computeProxyEntry = (
  configPath: string,
  config: RigConfig,
  env: "dev" | "prod",
  environment: Environment,
  name: string,
): Effect.Effect<ProxyEntry | null, ConfigValidationError> => {
  if (!config.domain || !environment.proxy) {
    return Effect.succeed(null)
  }

  const upstreamName = environment.proxy.upstream
  const upstream = environment.services.find(
    (service): service is ServerService =>
      service.name === upstreamName && service.type === "server",
  )

  if (!upstream) {
    return Effect.fail(
      configError(
        configPath,
        `Proxy upstream '${upstreamName}' must reference a server service.`,
        "Set environments.<env>.proxy.upstream to a server service name.",
        { code: "deploy", path: ["environments", env, "proxy", "upstream"] },
      ),
    )
  }

  const domain = env === "dev" ? `dev.${config.domain}` : config.domain

  return Effect.succeed({
    name,
    env,
    domain,
    upstream: upstream.name,
    port: upstream.port,
  })
}

const isMissingDaemonInstall = (error: unknown): boolean =>
  error instanceof ProcessError &&
  error.operation === "uninstall" &&
  (error.message.includes("ENOENT") || error.message.toLowerCase().includes("no such file"))

const readTrackingKeys = (raw: string): readonly string[] => {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return []
    }

    return Object.keys(parsed)
  } catch {
    return []
  }
}

const hasRuntimeTracking = (workspacePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem
    const trackedFiles = [
      join(workspacePath, ".rig", "pids.json"),
      join(workspacePath, ".rig", "bins.json"),
    ]

    for (const trackedPath of trackedFiles) {
      const exists = yield* fileSystem.exists(trackedPath).pipe(
        Effect.catchAll(() => Effect.succeed(false)),
      )

      if (!exists) {
        continue
      }

      const raw = yield* fileSystem.read(trackedPath).pipe(
        Effect.catchAll(() => Effect.succeed("{}")),
      )

      if (readTrackingKeys(raw).length > 0) {
        return true
      }
    }

    return false
  })

const isEnvironmentActive = (name: string, env: "dev" | "prod", workspacePath: string | null) =>
  Effect.gen(function* () {
    const processManager = yield* ProcessManager
    const daemon = yield* processManager.status(daemonLabel(name, env)).pipe(
      Effect.catchAll(() =>
        Effect.succeed({
          label: daemonLabel(name, env),
          loaded: false,
          running: false,
          pid: null,
        }),
      ),
    )

    if (daemon.loaded || daemon.running) {
      return true
    }

    if (!workspacePath) {
      return false
    }

    return yield* hasRuntimeTracking(workspacePath)
  })

const releaseActionFromArgs = (args: DeployArgs): BumpAction | null => args.bump ?? null

const missingReleaseBranchError = (name: string, configPath: string) =>
  new CliArgumentError(
    "deploy",
    `Prod release deploys for '${name}' require environments.prod.deployBranch.`,
    "Set environments.prod.deployBranch in rig.json before creating or correcting prod releases.",
    { name, configPath, env: "prod" },
  )

const branchMismatchError = (name: string, expectedBranch: string, currentBranch: string) =>
  new CliArgumentError(
    "deploy",
    `Prod release deploys for '${name}' must run from branch '${expectedBranch}'.`,
    `Check out '${expectedBranch}' before running a release-changing prod deploy.`,
    { name, env: "prod", expectedBranch, currentBranch },
  )

const chronologyError = (name: string, latestVersion: string) =>
  new CliArgumentError(
    "deploy",
    `Cannot create a newer prod release for '${name}' from a commit that does not descend from '${latestVersion}'.`,
    "Release-changing prod deploys must move forward in git history from the latest release tag.",
    { name, env: "prod", latestVersion },
  )

const revertTargetError = (name: string, revertVersion: string, latestVersion: string | null) =>
  new CliArgumentError(
    "deploy",
    `Cannot revert prod release '${revertVersion}' for '${name}' because it is not the latest release.`,
    latestVersion
      ? `Only the latest prod release can be reverted. The latest release is '${latestVersion}'.`
      : "There is no prod release history to revert.",
    { name, env: "prod", revertVersion, latestVersion },
  )

const revertPreviousVersionError = (name: string, revertVersion: string) =>
  new CliArgumentError(
    "deploy",
    `Cannot revert prod release '${revertVersion}' for '${name}' because no previous release exists.`,
    "Create at least one earlier prod release before reverting the latest release.",
    { name, env: "prod", revertVersion },
  )

const conflictingReleaseTagError = (name: string, version: string) =>
  new CliArgumentError(
    "deploy",
    `Tag '${versionTag(version)}' already exists for '${name}'.`,
    "Choose a different bump or delete the conflicting tag before retrying.",
    { name, env: "prod", version },
  )

const alreadyReleasedCommitError = (name: string, tag: string) =>
  new CliArgumentError(
    "deploy",
    `Cannot create another prod release for '${name}' from commit already tagged '${tag}'.`,
    "Make a new commit before bumping again, or deploy the existing version with --version.",
    { name, env: "prod", tag },
  )

const highestReleaseTag = (tags: readonly string[]) =>
  Effect.gen(function* () {
    let highest: string | null = null

    for (const tag of tags) {
      if (!RELEASE_TAG_RE.test(tag)) {
        continue
      }

      if (!highest) {
        highest = tag
        continue
      }

      const comparison = yield* compareVersions(tag.slice(1), highest.slice(1))
      if (comparison > 0) {
        highest = tag
      }
    }

    return highest
  })

const ensureReleaseBranchAndHistory = (
  name: string,
  loaded: LoadedProjectConfig,
) =>
  Effect.gen(function* () {
    const git = yield* Git
    const environment = yield* resolveEnvironment(loaded.configPath, loaded.config, "prod")
    const expectedBranch = environment.deployBranch

    if (!expectedBranch) {
      return yield* Effect.fail(missingReleaseBranchError(name, loaded.configPath))
    }

    const currentBranch = yield* git.currentBranch(loaded.repoPath)
    if (currentBranch !== expectedBranch) {
      return yield* Effect.fail(branchMismatchError(name, expectedBranch, currentBranch))
    }

    return environment
  })

const createReleaseMutation = (
  args: DeployArgs,
  loaded: LoadedProjectConfig,
  action: BumpAction,
): Effect.Effect<ReleaseMutationResult, RigError, FileSystemService | GitService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem
    const git = yield* Git
    yield* ensureReleaseBranchAndHistory(args.name, loaded)
    const currentVersion = loaded.config.version
    const configPath = join(loaded.repoPath, "rig.json")
    const historyPath = versionHistoryPath(args.name)
    const originalHistory = yield* loadVersionHistory(loaded.repoPath, args.name)
    const latestEntry = originalHistory.entries.at(-1) ?? null

    if (latestEntry) {
      const isDescendant = yield* git.isAncestor(loaded.repoPath, versionTag(latestEntry.newVersion), "HEAD")
      if (!isDescendant) {
        return yield* Effect.fail(chronologyError(args.name, latestEntry.newVersion))
      }
    }

    const existingReleaseTag = yield* highestReleaseTag(yield* git.commitTags(loaded.repoPath, "HEAD"))
    if (existingReleaseTag) {
      return yield* Effect.fail(alreadyReleasedCommitError(args.name, existingReleaseTag))
    }

    const originalConfig = yield* fileSystem.read(configPath)
    const targetVersion = yield* bumpVersion(currentVersion, action)
    const targetTagExists = yield* git.tagExists(loaded.repoPath, versionTag(targetVersion))
    if (targetTagExists) {
      return yield* Effect.fail(conflictingReleaseTagError(args.name, targetVersion))
    }

    const nextHistory: VersionHistory = {
      name: originalHistory.name,
      entries: [
        ...originalHistory.entries,
        {
          action,
          oldVersion: currentVersion,
          newVersion: targetVersion,
          changedAt: new Date().toISOString(),
        },
      ],
    }

    yield* writeRigJsonVersion(configPath, targetVersion)
    yield* writeVersionHistory(historyPath, nextHistory)
    yield* git.createTag(loaded.repoPath, versionTag(targetVersion))

    return {
      targetVersion,
      rollback: Effect.gen(function* () {
        yield* fileSystem.write(configPath, originalConfig).pipe(Effect.catchAll(() => Effect.void))
        yield* writeVersionHistory(historyPath, originalHistory).pipe(Effect.catchAll(() => Effect.void))
        yield* git.deleteTag(loaded.repoPath, versionTag(targetVersion)).pipe(Effect.catchAll(() => Effect.void))
      }),
    }
  })

const runRevertDeployCommand = (args: DeployArgs): Effect.Effect<number, RigError, DeployCommandEnv> =>
  Effect.gen(function* () {
    const logger = yield* Logger
    const workspace = yield* Workspace
    const git = yield* Git
    const loaded = yield* loadProjectConfig(args.name)
    const configPath = join(loaded.repoPath, "rig.json")
    const historyPath = versionHistoryPath(args.name)
    const history = yield* loadVersionHistory(loaded.repoPath, args.name)
    const latestEntry = history.entries.at(-1) ?? null

    if (!args.revert || !latestEntry || latestEntry.newVersion !== args.revert) {
      return yield* Effect.fail(revertTargetError(args.name, args.revert ?? "<missing>", latestEntry?.newVersion ?? null))
    }

    const previousEntry = history.entries.at(-2) ?? null
    if (!previousEntry) {
      return yield* Effect.fail(revertPreviousVersionError(args.name, latestEntry.newVersion))
    }

    const prodRows = (yield* workspace.list(args.name)).filter((entry) => entry.env === "prod")
    const activeVersion = prodRows.find((entry) => entry.active)?.version ?? null
    const revertedWasActive = activeVersion === latestEntry.newVersion
    const revertedWorkspace = prodRows.find((entry) => entry.version === latestEntry.newVersion) ?? null

    if (revertedWasActive) {
      yield* runStopCommand({ name: args.name, env: "prod" } as never)
    }

    yield* git.deleteTag(loaded.repoPath, versionTag(latestEntry.newVersion))
    if (revertedWorkspace) {
      yield* workspace.removeVersion(args.name, "prod", latestEntry.newVersion)
    }

    yield* writeVersionHistory(historyPath, {
      name: history.name,
      entries: history.entries.slice(0, -1),
    })
    yield* writeRigJsonVersion(configPath, previousEntry.newVersion)

    if (revertedWasActive) {
      const exitCode: number = yield* runDeployCommand({
        name: args.name,
        env: "prod",
        version: previousEntry.newVersion,
      } as DeployArgs)
      yield* logger.warn("Reverted active latest prod release.", {
        name: args.name,
        revertedVersion: latestEntry.newVersion,
        restoredVersion: previousEntry.newVersion,
      })
      return exitCode
    }

    yield* logger.warn("Reverted latest prod release without changing active runtime.", {
      name: args.name,
      revertedVersion: latestEntry.newVersion,
      activeVersion,
      restoredLatestVersion: previousEntry.newVersion,
      hint: "Because you're on a set version, no rollback was performed.",
    })
    yield* logger.success("Latest prod release reverted.", {
      name: args.name,
      revertedVersion: latestEntry.newVersion,
      activeVersion,
      latestVersion: previousEntry.newVersion,
    })

    return 0
  }) as Effect.Effect<number, RigError, DeployCommandEnv>

export const runDeployCommand = (args: DeployArgs): Effect.Effect<number, RigError, DeployCommandEnv> => {
  let rollbackReleaseMutation: Effect.Effect<void, never, FileSystemService | GitService> | null = null

  if (args.env === "prod" && args.revert) {
    return runRevertDeployCommand(args)
  }

  const program = Effect.gen(function* () {
    const logger = yield* Logger
    const workspace = yield* Workspace
    const reverseProxy = yield* ReverseProxy
    const processManager = yield* ProcessManager

    let repoLoaded = yield* loadProjectConfig(args.name)
    const releaseAction = args.env === "prod" ? releaseActionFromArgs(args) : null

    if (releaseAction) {
      const mutation = yield* createReleaseMutation(args, repoLoaded, releaseAction)
      rollbackReleaseMutation = mutation.rollback
      repoLoaded = yield* loadProjectConfig(args.name)
    }

    const targetVersion =
      args.env === "prod"
        ? (args.version ?? repoLoaded.config.version)
        : repoLoaded.config.version

    const currentProdWorkspace =
      args.env === "prod"
        ? (yield* workspace.list(args.name)).find((entry) => entry.env === "prod" && entry.active) ?? null
        : null
    const preDeployWorkspacePath =
      args.env === "dev"
        ? (yield* workspace.resolve(args.name, "dev").pipe(Effect.catchAll(() => Effect.succeed(null))))
        : currentProdWorkspace?.path ?? null
    const wasActive = yield* isEnvironmentActive(args.name, args.env, preDeployWorkspacePath)
    let reusedExistingProdWorkspace = false

    if (wasActive) {
      yield* runStopCommand({ name: args.name, env: args.env } as never)
    }

    if (args.env === "dev") {
      yield* workspace.create(args.name, "dev", repoLoaded.config.version, repoLoaded.repoPath)
      yield* workspace.sync(args.name, "dev")
    } else {
      const targetWorkspace = (yield* workspace.list(args.name)).find(
        (entry) => entry.env === "prod" && entry.version === targetVersion,
      )
      if (!targetWorkspace) {
        yield* workspace.create(args.name, "prod", targetVersion, `v${targetVersion}`).pipe(
          Effect.catchAll((error) =>
            error instanceof WorkspaceError &&
            error.operation === "create" &&
            error.message.includes("already exists")
              ? Effect.void
              : Effect.fail(error),
          ),
        )
      } else {
        reusedExistingProdWorkspace = currentProdWorkspace?.version === targetVersion
      }

      yield* workspace.activate(args.name, "prod", targetVersion)
    }

    const workspacePath =
      args.env === "prod"
        ? yield* workspace.resolve(args.name, "prod", targetVersion)
        : yield* workspace.resolve(args.name, "dev")
    const loaded =
      args.env === "prod"
        ? yield* loadProjectConfigAtPath(args.name, workspacePath)
        : repoLoaded
    const environment = yield* resolveEnvironment(loaded.configPath, loaded.config, args.env)

    if (reusedExistingProdWorkspace) {
      yield* logger.warn("Redeploying existing tagged prod version.", {
        name: args.name,
        env: args.env,
        version: targetVersion,
        tag: versionTag(targetVersion),
        hint: `This redeploy uses the existing tag for version ${targetVersion}.`,
      })
    }

    const desiredProxyEntry = yield* computeProxyEntry(
      loaded.configPath,
      loaded.config,
      args.env,
      environment,
      args.name,
    )

    const existingEntries = yield* reverseProxy.read()
    const existingProxyEntry = existingEntries.find(
      (entry) => entry.name === args.name && entry.env === args.env,
    )

    if (desiredProxyEntry) {
      if (!existingProxyEntry) {
        yield* reverseProxy.add(desiredProxyEntry)
      } else if (hasChanged(existingProxyEntry, desiredProxyEntry)) {
        yield* reverseProxy.update(desiredProxyEntry)
      }
    } else if (existingProxyEntry) {
      yield* reverseProxy.remove(args.name, args.env)
    }

    const label = daemonLabel(args.name, args.env)
    const daemonEnabled = loaded.config.daemon?.enabled === true

    if (daemonEnabled) {
      yield* processManager.install({
        label,
        command: "rig",
        args: ["start", args.name, args.env, "--foreground"],
        keepAlive: loaded.config.daemon?.keepAlive ?? false,
        envVars: {},
        workdir: workspacePath,
        logPath: join(workspacePath, ".rig", "logs", "daemon.log"),
      })
    } else {
      yield* processManager.uninstall(label).pipe(
        Effect.catchAll((error) =>
          isMissingDaemonInstall(error) ? Effect.void : Effect.fail(error),
        ),
      )

      yield* runStartCommand({
        name: args.name,
        env: args.env,
        foreground: false,
      } as never)
    }

    yield* logger.success("Deploy applied.", {
      name: args.name,
      env: args.env,
      repoPath: repoLoaded.repoPath,
      workspacePath,
      serviceCount: environment.services.length,
      proxyConfigured: desiredProxyEntry !== null,
      daemonEnabled,
      ...(args.env === "prod" ? { version: targetVersion } : {}),
    })

    return 0
  })

  return program.pipe(
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        if (rollbackReleaseMutation) {
          yield* rollbackReleaseMutation.pipe(Effect.catchAll(() => Effect.void))
        }
        return yield* Effect.fail(error)
      }),
    ),
  ) as Effect.Effect<number, RigError, DeployCommandEnv>
}
