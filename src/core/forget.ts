import { join } from "node:path"
import { Effect } from "effect"

import { rigBinPath, rigLaunchdBackupRoot, rigVersionHistoryPath, rigWorkspacesRoot } from "./rig-paths.js"
import { loadProjectConfigAtPath } from "./config.js"
import { runStopCommand } from "./lifecycle.js"
import { daemonLabel } from "./shared.js"
import { FileSystem } from "../interfaces/file-system.js"
import { Logger } from "../interfaces/logger.js"
import { ProcessManager } from "../interfaces/process-manager.js"
import { Registry } from "../interfaces/registry.js"
import { ReverseProxy } from "../interfaces/reverse-proxy.js"
import { Workspace } from "../interfaces/workspace.js"
import type { ForgetArgs } from "../schema/args.js"
import { CliArgumentError } from "../schema/errors.js"

interface InstalledBinEntry {
  readonly shimPath: string
}

const readTrackedBinPaths = (rootPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem
    const binsPath = join(rootPath, ".rig", "bins.json")
    const exists = yield* fileSystem.exists(binsPath).pipe(
      Effect.catchAll(() => Effect.succeed(false)),
    )
    if (!exists) {
      return [] as readonly string[]
    }

    const raw = yield* fileSystem.read(binsPath).pipe(
      Effect.catchAll(() => Effect.succeed("{}")),
    )

    return yield* Effect.try({
      try: () => {
        const parsed = JSON.parse(raw) as unknown
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return [] as readonly string[]
        }

        return Object.values(parsed as Record<string, InstalledBinEntry>)
          .flatMap((entry) => (typeof entry?.shimPath === "string" ? [entry.shimPath] : []))
      },
      catch: () => [] as readonly string[],
    })
  })

const readConfiguredBinPaths = (name: string, rootPath: string) =>
  Effect.gen(function* () {
    const loaded = yield* loadProjectConfigAtPath(name, rootPath).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    )
    if (!loaded) {
      return [] as readonly string[]
    }

    const paths: string[] = []
    for (const envName of ["dev", "prod"] as const) {
      const environment = loaded.config.environments[envName]
      if (!environment) {
        continue
      }

      for (const service of environment.services) {
        if (service.type === "bin") {
          paths.push(rigBinPath(service.name, envName))
        }
      }
    }

    return paths
  })

const removeLaunchdBackups = (name: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem
    const backupDir = rigLaunchdBackupRoot()
    const entries = yield* fileSystem.list(backupDir).pipe(
      Effect.catchAll(() => Effect.succeed([] as readonly string[])),
    )

    for (const entry of entries) {
      if (
        entry.startsWith(`${daemonLabel(name, "dev")}-backup-`) ||
        entry.startsWith(`${daemonLabel(name, "prod")}-backup-`)
      ) {
        yield* fileSystem.remove(join(backupDir, entry)).pipe(
          Effect.catchAll(() => Effect.void),
        )
      }
    }
  })

const stopKnownRuntimes = (name: string) =>
  Effect.gen(function* () {
    const logger = yield* Logger
    const processManager = yield* ProcessManager
    const workspace = yield* Workspace

    const workspaces = yield* workspace.list(name).pipe(
      Effect.catchAll(() => Effect.succeed([])),
    )

    const hasDevWorkspace = workspaces.some((entry) => entry.env === "dev")
    const activeProdVersion = workspaces.find((entry) => entry.env === "prod" && entry.active)?.version

    if (hasDevWorkspace) {
      yield* runStopCommand({ name, env: "dev" }).pipe(
        Effect.catchAll((error: { readonly message?: string }) =>
          logger.warn("Unable to stop dev runtime before purge.", {
            name,
            env: "dev",
            error: error.message ?? "Unknown error",
          }),
        ),
      )
    }

    if (activeProdVersion !== undefined) {
      yield* runStopCommand({
        name,
        env: "prod",
        ...(activeProdVersion ? { version: activeProdVersion } : {}),
      }).pipe(
        Effect.catchAll((error: { readonly message?: string }) =>
          logger.warn("Unable to stop prod runtime before purge.", {
            name,
            env: "prod",
            error: error.message ?? "Unknown error",
          }),
        ),
      )
    }

    for (const envName of ["dev", "prod"] as const) {
      const label = daemonLabel(name, envName)
      yield* processManager.uninstall(label).pipe(
        Effect.catchAll(() => Effect.void),
      )
    }

    if (workspaces.length > 0) {
      yield* logger.info("Stopped rig-managed runtime before purge.", {
        name,
        workspaceCount: workspaces.length,
      })
    }
  })

export const runForgetCommand = (args: ForgetArgs) =>
  Effect.gen(function* () {
    const logger = yield* Logger
    const registry = yield* Registry
    const reverseProxy = yield* ReverseProxy
    const fileSystem = yield* FileSystem
    const workspace = yield* Workspace

    const repoPath = yield* registry.resolve(args.name).pipe(
      Effect.mapError(
        () =>
          new CliArgumentError(
            "forget",
            `Project '${args.name}' is not registered.`,
            `Run 'rig list' to see registered projects.`,
            { name: args.name },
          ),
      ),
    )

    if (!args.purge) {
      yield* registry.unregister(args.name)
      yield* logger.success("Project forgotten.", {
        name: args.name,
        repoPath,
        purged: false,
      })
      return 0
    }

    const knownWorkspaces = yield* workspace.list(args.name).pipe(
      Effect.catchAll(() => Effect.succeed([])),
    )

    yield* stopKnownRuntimes(args.name)

    for (const envName of ["dev", "prod"] as const) {
      yield* reverseProxy.remove(args.name, envName).pipe(
        Effect.catchAll(() => Effect.void),
      )
    }

    const binRoots = new Set<string>([repoPath, ...knownWorkspaces.map((entry) => entry.path)])
    const installedBinPaths = new Set<string>()
    for (const rootPath of binRoots) {
      for (const shimPath of yield* readTrackedBinPaths(rootPath)) {
        installedBinPaths.add(shimPath)
      }
      for (const configuredPath of yield* readConfiguredBinPaths(args.name, rootPath)) {
        installedBinPaths.add(configuredPath)
      }
    }

    for (const shimPath of installedBinPaths) {
      yield* fileSystem.remove(shimPath).pipe(
        Effect.catchAll(() => Effect.void),
      )
    }

    yield* fileSystem.remove(join(rigWorkspacesRoot(), args.name)).pipe(
      Effect.catchAll(() => Effect.void),
    )
    yield* fileSystem.remove(rigVersionHistoryPath(args.name)).pipe(
      Effect.catchAll(() => Effect.void),
    )
    yield* removeLaunchdBackups(args.name)
    yield* registry.unregister(args.name)

    yield* logger.success("Project forgotten and rig state purged.", {
      name: args.name,
      repoPath,
      purged: true,
      removedBinCount: installedBinPaths.size,
    })

    return 0
  })
