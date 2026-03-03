import { join } from "node:path"
import { Effect } from "effect"
import { type ZodIssue } from "zod"

import { FileSystem } from "../interfaces/file-system.js"
import { Registry } from "../interfaces/registry.js"
import { RigConfigSchema, type Environment, type RigConfig } from "../schema/config.js"
import { ConfigValidationError, type ConfigIssue } from "../schema/errors.js"

export interface LoadedProjectConfig {
  readonly name: string
  readonly repoPath: string
  readonly configPath: string
  readonly config: RigConfig
}

const configError = (
  path: string,
  message: string,
  hint: string,
  issues: readonly ConfigIssue[] = [],
): ConfigValidationError => new ConfigValidationError(path, issues, message, hint)

const mapZodIssue = (issue: ZodIssue): ConfigIssue => ({
  path: issue.path.filter((value): value is string | number => typeof value === "string" || typeof value === "number"),
  message: issue.message,
  code: issue.code,
})

export const parseRigConfig = (
  configPath: string,
  raw: string,
): Effect.Effect<RigConfig, ConfigValidationError> =>
  Effect.gen(function* () {
    const json = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        configError(
          configPath,
          "rig.json is not valid JSON.",
          "Fix JSON syntax errors in rig.json and retry.",
          [
            {
              path: [],
              message: cause instanceof Error ? cause.message : String(cause),
              code: "invalid_json",
            },
          ],
        ),
    })

    const parsed = RigConfigSchema.safeParse(json)
    if (!parsed.success) {
      return yield* Effect.fail(
        configError(
          configPath,
          "rig.json failed schema validation.",
          "Run `rig config --help` and fix the reported fields.",
          parsed.error.issues.map(mapZodIssue),
        ),
      )
    }

    return parsed.data
  })

export const loadRigConfig = (repoPath: string): Effect.Effect<RigConfig, ConfigValidationError, FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem
    const configPath = join(repoPath, "rig.json")
    const raw = yield* fileSystem.read(configPath).pipe(
      Effect.mapError((error) =>
        configError(
          configPath,
          "Unable to read rig.json.",
          "Ensure rig.json exists in the project root and is readable.",
          [
            {
              path: [],
              message: error.message,
              code: error._tag,
            },
          ],
        ),
      ),
    )

    return yield* parseRigConfig(configPath, raw)
  })

export const loadProjectConfig = (
  name: string,
): Effect.Effect<LoadedProjectConfig, ConfigValidationError, Registry | FileSystem> =>
  Effect.gen(function* () {
    const registry = yield* Registry
    const repoPath = yield* registry.resolve(name).pipe(
      Effect.mapError((error) =>
        configError(
          `${name}/rig.json`,
          `Unable to resolve project '${name}' in registry.`,
          "Run `rig init <name> --path <project-path>` first.",
          [
            {
              path: ["name"],
              message: error.message,
              code: error._tag,
            },
          ],
        ),
      ),
    )

    const config = yield* loadRigConfig(repoPath)

    return {
      name,
      repoPath,
      configPath: join(repoPath, "rig.json"),
      config,
    }
  })

export const resolveEnvironment = (
  configPath: string,
  config: RigConfig,
  env: "dev" | "prod",
): Effect.Effect<Environment, ConfigValidationError> => {
  const envConfig = config.environments[env]

  if (!envConfig) {
    return Effect.fail(
      configError(
        configPath,
        `Environment '${env}' is not defined in rig.json.`,
        `Define environments.${env} in rig.json or choose a configured environment.`,
        [
          {
            path: ["environments", env],
            message: `Missing environment '${env}'.`,
            code: "missing_environment",
          },
        ],
      ),
    )
  }

  return Effect.succeed(envConfig)
}
