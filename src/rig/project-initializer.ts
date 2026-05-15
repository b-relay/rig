import { basename, join, resolve } from "node:path"
import { Context, Effect, Layer } from "effect"

import { decodeRigStatusInput } from "./config.js"
import {
  platformExists,
  platformMakeDirectory,
  platformReadFileString,
  platformWriteFileString,
} from "./effect-platform.js"
import { RigRuntimeError } from "./errors.js"
import { runPlatformCommand } from "./provider-command-runner.js"
import { RigdStateStore } from "./rigd-state.js"
import type { RigComponentPluginId } from "./component-plugins.js"
import { branchSlug } from "./deployments.js"

export type RigInitComponentPluginId = Extract<RigComponentPluginId, "sqlite" | "postgres" | "convex">

export interface RigInitManagedComponent {
  readonly name: string
  readonly command: string
  readonly port?: number
  readonly health?: string
}

export interface RigInitInstalledComponent {
  readonly name: string
  readonly entrypoint: string
  readonly build?: string
  readonly installName?: string
}

export interface RigProjectInitInput {
  readonly project: string
  readonly path: string
  readonly stateRoot: string
  readonly providerProfile: "default" | "stub"
  readonly domain?: string
  readonly proxy?: string
  readonly packageScripts?: boolean
  readonly componentPlugins?: readonly RigInitComponentPluginId[]
  readonly managedComponent?: RigInitManagedComponent
  readonly installedComponent?: RigInitInstalledComponent
}

export interface RigProjectInitResult {
  readonly project: string
  readonly repoPath: string
  readonly configPath: string
  readonly providerProfile: "default" | "stub"
  readonly productionBranch: string
  readonly domain?: string
  readonly proxy?: string
  readonly remoteConfigured: boolean
  readonly remoteUrl?: string
  readonly registered: boolean
  readonly packageScripts: {
    readonly requested: boolean
    readonly packageJsonPath?: string
    readonly addedScripts: readonly string[]
    readonly skippedReason?: "package-json-missing"
  }
  readonly scaffoldedComponents: readonly string[]
}

export interface RigProjectInitializerService {
  readonly init: (input: RigProjectInitInput) => Effect.Effect<RigProjectInitResult, RigRuntimeError>
}

export const RigProjectInitializer =
  Context.Service<RigProjectInitializerService>("rig/rig/RigProjectInitializer")

const rigPackageScripts = {
  "rig:up": "rig up",
  "rig:down": "rig down",
  "rig:restart": "rig restart",
  "rig:status": "rig status",
  "rig:logs": "rig logs",
  "rig:list": "rig list",
} as const

const scaffoldPluginComponents = (
  plugins: readonly RigInitComponentPluginId[],
): Record<string, unknown> => {
  const selected = new Set(plugins)

  return {
    ...(selected.has("sqlite")
      ? {
        sqlite: {
          uses: "sqlite",
        },
      }
      : {}),
    ...(selected.has("postgres")
      ? {
        postgres: {
          uses: "postgres",
        },
      }
      : {}),
    ...(selected.has("convex")
      ? {
        convex: {
          uses: "convex",
        },
      }
      : {}),
  }
}

const scaffoldAppComponents = (input: {
  readonly managedComponent?: RigInitManagedComponent
  readonly installedComponent?: RigInitInstalledComponent
}): Record<string, unknown> => ({
  ...(input.managedComponent
    ? {
      [input.managedComponent.name]: {
        mode: "managed",
        command: input.managedComponent.command,
        ...(input.managedComponent.port ? { port: input.managedComponent.port } : {}),
        ...(input.managedComponent.health ? { health: input.managedComponent.health } : {}),
      },
    }
    : {}),
  ...(input.installedComponent
    ? {
      [input.installedComponent.name]: {
        mode: "installed",
        entrypoint: input.installedComponent.entrypoint,
        ...(input.installedComponent.build ? { build: input.installedComponent.build } : {}),
        ...(input.installedComponent.installName ? { installName: input.installedComponent.installName } : {}),
      },
    }
    : {}),
})

const projectConfig = (
  project: string,
  providerProfile: "default" | "stub",
  components: Record<string, unknown>,
  routing: {
    readonly domain?: string
    readonly proxy?: string
    readonly productionBranch: string
  },
) => {
  const proxyConfig = routing.proxy ? { proxy: { upstream: routing.proxy } } : {}

  return {
    name: project,
    ...(routing.domain ? { domain: routing.domain } : {}),
    description: `Rig project for ${project}.`,
    components,
    local: {
      providerProfile,
      ...proxyConfig,
    },
    live: {
      providerProfile,
      deployBranch: routing.productionBranch,
      ...proxyConfig,
    },
    deployments: {
      subdomain: "${branchSlug}",
      providerProfile,
      ...proxyConfig,
    },
  }
}

const duplicateComponentName = (
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): string | undefined =>
  Object.keys(left).find((name) => Object.prototype.hasOwnProperty.call(right, name))

const runtimeError = (
  message: string,
  hint: string,
  details?: Readonly<Record<string, unknown>>,
) => (cause: unknown) =>
  new RigRuntimeError(message, hint, {
    cause: cause instanceof Error ? cause.message : String(cause),
    ...(details ?? {}),
  })

const parsePackageJson = (
  raw: string,
  packageJsonPath: string,
): Effect.Effect<Record<string, unknown>, RigRuntimeError> =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: runtimeError(
      "Unable to parse package.json.",
      "Fix package.json syntax before adding rig package scripts.",
      { packageJsonPath },
    ),
  }).pipe(
    Effect.flatMap((value) =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? Effect.succeed(value as Record<string, unknown>)
        : Effect.fail(
          new RigRuntimeError(
            "package.json must contain a JSON object.",
            "Replace package.json with an object-shaped file before adding rig package scripts.",
            { packageJsonPath },
          ),
        )
    ),
  )

const parseJsonObject = (
  raw: string,
  errorContext: {
    readonly path: string
    readonly message: string
    readonly hint: string
  },
): Effect.Effect<Record<string, unknown>, RigRuntimeError> =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: runtimeError(errorContext.message, errorContext.hint, { path: errorContext.path }),
  }).pipe(
    Effect.flatMap((value) =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? Effect.succeed(value as Record<string, unknown>)
        : Effect.fail(
          new RigRuntimeError(
            errorContext.message,
            errorContext.hint,
            { path: errorContext.path },
          ),
        )
    ),
  )

const addPackageScripts = (repoPath: string) =>
  Effect.gen(function* () {
    const packageJsonPath = join(repoPath, "package.json")
    const exists = yield* platformExists(packageJsonPath).pipe(
      Effect.mapError(runtimeError(
        "Unable to inspect package.json.",
        "Ensure the project directory is readable and retry.",
        { packageJsonPath },
      )),
    )
    if (!exists) {
      return {
        requested: true,
        addedScripts: [],
        skippedReason: "package-json-missing" as const,
      }
    }

    const raw = yield* platformReadFileString(packageJsonPath).pipe(
      Effect.mapError(runtimeError(
        "Unable to read package.json.",
        "Ensure package.json is readable and retry.",
        { packageJsonPath },
      )),
    )
    const packageJson = yield* parsePackageJson(raw, packageJsonPath)
    const rawScripts = packageJson.scripts
    const scripts =
      typeof rawScripts === "object" && rawScripts !== null && !Array.isArray(rawScripts)
        ? { ...(rawScripts as Record<string, unknown>) }
        : {}

    const addedScripts: string[] = []
    for (const [name, command] of Object.entries(rigPackageScripts)) {
      if (!(name in scripts)) {
        scripts[name] = command
        addedScripts.push(name)
      }
    }

    yield* platformWriteFileString(
      packageJsonPath,
      `${JSON.stringify({ ...packageJson, scripts }, null, 2)}\n`,
    ).pipe(
      Effect.mapError(runtimeError(
        "Unable to update package.json.",
        "Ensure package.json is writable and retry.",
        { packageJsonPath },
      )),
    )

    return {
      requested: true,
      packageJsonPath,
      addedScripts,
    }
  })

const gitCommand = (repoPath: string, args: readonly string[]) =>
  runPlatformCommand(["git", "-C", repoPath, ...args])

const discoverRepoPath = (startPath: string): Effect.Effect<string, RigRuntimeError> =>
  Effect.gen(function* () {
    const resolvedPath = resolve(startPath)
    const result = yield* gitCommand(resolvedPath, ["rev-parse", "--show-toplevel"]).pipe(
      Effect.catch(() => Effect.succeed({ stdout: "", stderr: "", exitCode: 1 })),
    )
    return result.exitCode === 0 && result.stdout.trim().length > 0
      ? result.stdout.trim()
      : resolvedPath
  })

const detectProductionBranch = (repoPath: string): Effect.Effect<string, RigRuntimeError> =>
  Effect.gen(function* () {
    const remoteHead = yield* gitCommand(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).pipe(
      Effect.catch(() => Effect.succeed({ stdout: "", stderr: "", exitCode: 1 })),
    )
    const remoteBranch = remoteHead.stdout.trim().replace(/^origin\//, "")
    if (remoteHead.exitCode === 0 && remoteBranch.length > 0) {
      return remoteBranch
    }

    const current = yield* gitCommand(repoPath, ["branch", "--show-current"]).pipe(
      Effect.catch(() => Effect.succeed({ stdout: "", stderr: "", exitCode: 1 })),
    )
    const currentBranch = current.stdout.trim()
    return current.exitCode === 0 && currentBranch.length > 0 ? currentBranch : "main"
  })

const expectedRigRemoteUrl = (project: string): string =>
  `rig://localhost/${project}`

const configureRigRemote = (
  repoPath: string,
  project: string,
): Effect.Effect<{ readonly remoteConfigured: boolean; readonly remoteUrl?: string }, RigRuntimeError> =>
  Effect.gen(function* () {
    const remoteUrl = expectedRigRemoteUrl(project)
    const isGitRepo = yield* gitCommand(repoPath, ["rev-parse", "--is-inside-work-tree"]).pipe(
      Effect.catch(() => Effect.succeed({ stdout: "", stderr: "", exitCode: 1 })),
    )
    if (isGitRepo.exitCode !== 0 || isGitRepo.stdout.trim() !== "true") {
      return { remoteConfigured: false }
    }

    const existing = yield* gitCommand(repoPath, ["remote", "get-url", "rig"]).pipe(
      Effect.catch(() => Effect.succeed({ stdout: "", stderr: "", exitCode: 1 })),
    )
    if (existing.exitCode === 0) {
      const existingUrl = existing.stdout.trim()
      if (existingUrl === remoteUrl) {
        return { remoteConfigured: false, remoteUrl }
      }
      return yield* Effect.fail(
        new RigRuntimeError(
          "Cannot configure rig remote because it already points somewhere else.",
          "Remove or rename the existing 'rig' remote, then rerun rig init.",
          { project, repoPath, expectedRemoteUrl: remoteUrl, existingRemoteUrl: existingUrl },
        ),
      )
    }

    const added = yield* gitCommand(repoPath, ["remote", "add", "rig", remoteUrl]).pipe(
      Effect.catch((cause) =>
        Effect.fail(
          new RigRuntimeError(
            "Unable to configure rig Git remote.",
            "Ensure this is a writable Git repository, then rerun rig init.",
            { project, repoPath, remoteUrl, cause: cause instanceof Error ? cause.message : String(cause) },
          ),
        )
      ),
    )
    if (added.exitCode !== 0) {
      return yield* Effect.fail(
        new RigRuntimeError(
          "Unable to configure rig Git remote.",
          "Ensure this is a writable Git repository, then rerun rig init.",
          { project, repoPath, remoteUrl, stderr: added.stderr },
        ),
      )
    }

    return { remoteConfigured: true, remoteUrl }
  })

const projectNameFromInput = (inputProject: string, repoPath: string): string => {
  const explicit = inputProject.trim()
  return explicit.length > 0 ? explicit : branchSlug(basename(repoPath))
}

const stringDetail = (details: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined => {
  const value = details?.[key]
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

export const RigProjectInitializerLive = Layer.effect(
  RigProjectInitializer,
  Effect.gen(function* () {
    const stateStore = yield* RigdStateStore

    return {
      init: (input) =>
        Effect.gen(function* () {
          const repoPath = yield* discoverRepoPath(input.path)
          const detectedProject = projectNameFromInput(input.project, repoPath)
          const decoded = yield* decodeRigStatusInput({
            project: detectedProject,
            stateRoot: input.stateRoot,
          }).pipe(
            Effect.mapError((cause) =>
              new RigRuntimeError(
                `Invalid Project identity '${detectedProject}'.`,
                "Use letters, numbers, underscores, or hyphens, and start with a letter or number.",
                {
                  project: detectedProject,
                  cause: cause.message,
                },
              )
            ),
          )
          const project = decoded.project
          const configPath = join(repoPath, "rig.json")
          const productionBranch = yield* detectProductionBranch(repoPath)

          yield* platformMakeDirectory(repoPath).pipe(
            Effect.mapError(runtimeError(
              `Unable to create project directory for '${project}'.`,
              "Ensure the parent directory is writable and retry.",
              { project, repoPath },
            )),
          )
          const rigJsonExists = yield* platformExists(configPath).pipe(
            Effect.mapError(runtimeError(
              "Unable to inspect project rig.json.",
              "Ensure the project directory is readable and retry.",
              { project, configPath },
            )),
          )
          if (rigJsonExists) {
            const rawConfig = yield* platformReadFileString(configPath).pipe(
              Effect.mapError(runtimeError(
                "Unable to read existing rig.json.",
                "Ensure rig.json is readable before rerunning rig init.",
                { project, configPath },
              )),
            )
            const existingConfig = yield* parseJsonObject(rawConfig, {
              path: configPath,
              message: "Existing rig.json is not a valid project config object.",
              hint: "Fix or remove rig.json before rerunning rig init.",
            })
            if (existingConfig.name !== project) {
              return yield* Effect.fail(
                new RigRuntimeError(
                  "Cannot initialize over a different Project identity.",
                  "Use the existing Project identity or move the conflicting rig.json before rerunning rig init.",
                  { project, existingProject: existingConfig.name, configPath },
                ),
              )
            }
          }

          const state = yield* stateStore.load({ stateRoot: input.stateRoot })
          for (const event of state.events) {
            if (event.event !== "rigd.project.registered" && event.event !== "rigd.project.initialized") {
              continue
            }
            const registeredPath = stringDetail(event.details, "repoPath")
            if (event.project === project && registeredPath && registeredPath !== repoPath) {
              return yield* Effect.fail(
                new RigRuntimeError(
                  `Project '${project}' is already registered for another path.`,
                  "Choose a different Project identity or remove the old registration before rerunning rig init.",
                  { project, repoPath, registeredPath },
                ),
              )
            }
            if (event.project && event.project !== project && registeredPath === repoPath) {
              return yield* Effect.fail(
                new RigRuntimeError(
                  `Repository is already registered as Project '${event.project}'.`,
                  "Use the existing Project identity or remove the old registration before rerunning rig init.",
                  { project, existingProject: event.project, repoPath },
                ),
              )
            }
          }

          const remote = yield* configureRigRemote(repoPath, project)

          const selectedPlugins = input.componentPlugins ?? []
          const pluginComponents = scaffoldPluginComponents(selectedPlugins)
          const appComponents = scaffoldAppComponents({
            ...(input.managedComponent ? { managedComponent: input.managedComponent } : {}),
            ...(input.installedComponent ? { installedComponent: input.installedComponent } : {}),
          })
          const duplicateName = duplicateComponentName(pluginComponents, appComponents)
          if (duplicateName) {
            return yield* Effect.fail(
              new RigRuntimeError(
                `Cannot scaffold duplicate component '${duplicateName}'.`,
                "Use distinct component names for --uses, --managed, and --installed scaffolding.",
                { project, component: duplicateName },
              ),
            )
          }
          const components = {
            ...pluginComponents,
            ...appComponents,
          }
          const scaffoldedComponents = Object.keys(components)

          if (!rigJsonExists) {
            yield* platformWriteFileString(
              configPath,
              `${
                JSON.stringify(
                  projectConfig(project, input.providerProfile, components, {
                    productionBranch,
                    ...(input.domain ? { domain: input.domain } : {}),
                    ...(input.proxy ? { proxy: input.proxy } : {}),
                  }),
                  null,
                  2,
                )
              }\n`,
            ).pipe(
              Effect.mapError(runtimeError(
                `Unable to write rig.json for '${project}'.`,
                "Ensure the project directory is writable and retry.",
                { project, configPath },
              )),
            )
          }

          const packageScripts = input.packageScripts
            ? yield* addPackageScripts(repoPath)
            : { requested: false, addedScripts: [] }

          yield* stateStore.appendEvent({
            stateRoot: input.stateRoot,
            event: {
              timestamp: new Date().toISOString(),
              event: "rigd.project.registered",
              project,
              details: {
                repoPath,
                configPath,
                productionBranch,
                remoteUrl: remote.remoteUrl,
                providerProfile: input.providerProfile,
                ...(input.domain ? { domain: input.domain } : {}),
                ...(input.proxy ? { proxy: input.proxy } : {}),
              },
            },
          }).pipe(
            Effect.mapError((cause) =>
              new RigRuntimeError(
                "rig init wrote project config but could not register with rigd.",
                "Run 'rigd status' to repair daemon state, then rerun 'rig init' from this repo.",
                {
                  project,
                  repoPath,
                  configPath,
                  stateRoot: input.stateRoot,
                  cause: cause.message,
                },
              )
            ),
          )

          return {
            project,
            repoPath,
            configPath,
            providerProfile: input.providerProfile,
            productionBranch,
            ...(input.domain ? { domain: input.domain } : {}),
            ...(input.proxy ? { proxy: input.proxy } : {}),
            remoteConfigured: remote.remoteConfigured,
            ...(remote.remoteUrl ? { remoteUrl: remote.remoteUrl } : {}),
            registered: true,
            packageScripts,
            scaffoldedComponents,
          }
        }),
    } satisfies RigProjectInitializerService
  }),
)
