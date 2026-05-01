import { join, resolve } from "node:path"
import { Context, Effect, Layer } from "effect"

import {
  platformExists,
  platformMakeDirectory,
  platformReadFileString,
  platformWriteFileString,
} from "./effect-platform.js"
import { RigRuntimeError } from "./errors.js"
import { RigdStateStore } from "./rigd-state.js"
import type { RigComponentPluginId } from "./component-plugins.js"

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
  readonly domain?: string
  readonly proxy?: string
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

export const RigProjectInitializerLive = Layer.effect(
  RigProjectInitializer,
  Effect.gen(function* () {
    const stateStore = yield* RigdStateStore

    return {
      init: (input) =>
        Effect.gen(function* () {
          const repoPath = resolve(input.path)
          const configPath = join(repoPath, "rig.json")

          yield* platformMakeDirectory(repoPath).pipe(
            Effect.mapError(runtimeError(
              `Unable to create project directory for '${input.project}'.`,
              "Ensure the parent directory is writable and retry.",
              { project: input.project, repoPath },
            )),
          )
          const rigJsonExists = yield* platformExists(configPath).pipe(
            Effect.mapError(runtimeError(
              "Unable to inspect project rig.json.",
              "Ensure the project directory is readable and retry.",
              { project: input.project, configPath },
            )),
          )
          if (rigJsonExists) {
            return yield* Effect.fail(
              new RigRuntimeError(
                "Cannot initialize over an existing rig.json.",
                "Move or edit the existing rig.json before running rig init.",
                { project: input.project, configPath },
              ),
            )
          }

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
                { project: input.project, component: duplicateName },
              ),
            )
          }
          const components = {
            ...pluginComponents,
            ...appComponents,
          }
          const scaffoldedComponents = Object.keys(components)

          yield* platformWriteFileString(
            configPath,
            `${
              JSON.stringify(
                projectConfig(input.project, input.providerProfile, components, {
                  ...(input.domain ? { domain: input.domain } : {}),
                  ...(input.proxy ? { proxy: input.proxy } : {}),
                }),
                null,
                2,
              )
            }\n`,
          ).pipe(
            Effect.mapError(runtimeError(
              `Unable to write rig.json for '${input.project}'.`,
              "Ensure the project directory is writable and retry.",
              { project: input.project, configPath },
            )),
          )

          const packageScripts = input.packageScripts
            ? yield* addPackageScripts(repoPath)
            : { requested: false, addedScripts: [] }

          yield* stateStore.appendEvent({
            stateRoot: input.stateRoot,
            event: {
              timestamp: new Date().toISOString(),
              event: "rigd.project.initialized",
              project: input.project,
              details: {
                repoPath,
                configPath,
                providerProfile: input.providerProfile,
                ...(input.domain ? { domain: input.domain } : {}),
                ...(input.proxy ? { proxy: input.proxy } : {}),
              },
            },
          })

          return {
            project: input.project,
            repoPath,
            configPath,
            providerProfile: input.providerProfile,
            ...(input.domain ? { domain: input.domain } : {}),
            ...(input.proxy ? { proxy: input.proxy } : {}),
            packageScripts,
            scaffoldedComponents,
          }
        }),
    } satisfies RigProjectInitializerService
  }),
)
