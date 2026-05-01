import { join, resolve } from "node:path"
import { Context, Effect, Layer } from "effect"

import {
  platformExists,
  platformMakeDirectory,
  platformReadFileString,
  platformWriteFileString,
} from "./effect-platform.js"
import { V2RuntimeError } from "./errors.js"
import { V2RigdStateStore } from "./rigd-state.js"

export interface V2ProjectInitInput {
  readonly project: string
  readonly path: string
  readonly stateRoot: string
  readonly providerProfile: "default" | "stub"
  readonly packageScripts?: boolean
}

export interface V2ProjectInitResult {
  readonly project: string
  readonly repoPath: string
  readonly configPath: string
  readonly providerProfile: "default" | "stub"
  readonly packageScripts: {
    readonly requested: boolean
    readonly packageJsonPath?: string
    readonly addedScripts: readonly string[]
    readonly skippedReason?: "package-json-missing"
  }
}

export interface V2ProjectInitializerService {
  readonly init: (input: V2ProjectInitInput) => Effect.Effect<V2ProjectInitResult, V2RuntimeError>
}

export const V2ProjectInitializer =
  Context.Service<V2ProjectInitializerService>("rig/v2/V2ProjectInitializer")

const rigPackageScripts = {
  "rig:up": "rig2 up",
  "rig:down": "rig2 down",
  "rig:restart": "rig2 restart",
  "rig:status": "rig2 status",
  "rig:logs": "rig2 logs",
  "rig:list": "rig2 list",
} as const

const projectConfig = (project: string, providerProfile: "default" | "stub") => ({
  name: project,
  description: `Rig v2 project for ${project}.`,
  components: {},
  local: {
    providerProfile,
  },
  live: {
    providerProfile,
  },
  deployments: {
    subdomain: "${branchSlug}",
    providerProfile,
  },
})

const runtimeError = (
  message: string,
  hint: string,
  details?: Readonly<Record<string, unknown>>,
) => (cause: unknown) =>
  new V2RuntimeError(message, hint, {
    cause: cause instanceof Error ? cause.message : String(cause),
    ...(details ?? {}),
  })

const parsePackageJson = (
  raw: string,
  packageJsonPath: string,
): Effect.Effect<Record<string, unknown>, V2RuntimeError> =>
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
          new V2RuntimeError(
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

export const V2ProjectInitializerLive = Layer.effect(
  V2ProjectInitializer,
  Effect.gen(function* () {
    const stateStore = yield* V2RigdStateStore

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
              new V2RuntimeError(
                "Cannot initialize over an existing rig.json.",
                "Move or edit the existing rig.json before running rig2 init.",
                { project: input.project, configPath },
              ),
            )
          }

          yield* platformWriteFileString(
            configPath,
            `${JSON.stringify(projectConfig(input.project, input.providerProfile), null, 2)}\n`,
          ).pipe(
            Effect.mapError(runtimeError(
              `Unable to write v2 rig.json for '${input.project}'.`,
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
              },
            },
          })

          return {
            project: input.project,
            repoPath,
            configPath,
            providerProfile: input.providerProfile,
            packageScripts,
          }
        }),
    } satisfies V2ProjectInitializerService
  }),
)
