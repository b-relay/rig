import { randomUUID } from "node:crypto"
import { Effect } from "effect-v3"

import { FileSystem } from "../interfaces/file-system.js"
import { Logger } from "../interfaces/logger.js"
import { RigConfigSchema } from "../schema/config.js"
import { ConfigValidationError, type ConfigIssue } from "../schema/errors.js"
import { loadProjectConfig } from "./config.js"
import { CONFIG_FIELD_MAP, UNSETTABLE_CONFIG_FIELD_MAP } from "./config-fields.js"

const configError = (
  path: string,
  message: string,
  hint: string,
  issues: readonly ConfigIssue[] = [],
): ConfigValidationError => new ConfigValidationError(path, issues, message, hint)

const formatValue = (value: unknown): string =>
  value === undefined ? "(unset)" : JSON.stringify(value)

const readPathValue = (source: Record<string, unknown>, key: string): unknown => {
  const segments = key.split(".")
  let cursor: unknown = source

  for (const segment of segments) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      return undefined
    }
    cursor = (cursor as Record<string, unknown>)[segment]
  }

  return cursor
}

const removePathValue = (target: Record<string, unknown>, key: string): void => {
  const segments = key.split(".")
  const prune = (cursor: Record<string, unknown>, index: number): boolean => {
    const segment = segments[index]
    const value = cursor[segment]

    if (index === segments.length - 1) {
      delete cursor[segment]
      return Object.keys(cursor).length === 0
    }

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false
    }

    const shouldDeleteChild = prune(value as Record<string, unknown>, index + 1)
    if (shouldDeleteChild) {
      delete cursor[segment]
    }

    return Object.keys(cursor).length === 0
  }

  prune(target, 0)
}

const assignPathValue = (target: Record<string, unknown>, key: string, value: unknown): void => {
  const segments = key.split(".")
  let cursor = target

  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment]

    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
      const created: Record<string, unknown> = {}
      cursor[segment] = created
      cursor = created
      continue
    }

    cursor = existing as Record<string, unknown>
  }

  cursor[segments[segments.length - 1]] = value
}

const unsupportedUnsetHint = (key: string): string => {
  const field = CONFIG_FIELD_MAP.get(key)
  if (!field) {
    return "Run `rig docs config` to see supported keys, value types, and descriptions."
  }

  if (field.manualEditWarning) {
    return `${field.manualEditWarning} Run \`rig docs config ${key}\` for details.`
  }

  return `Key '${key}' cannot be unset through the CLI. Run \`rig docs config ${key}\` to see its rules.`
}

export const runConfigUnsetCommand = (name: string, key: string) =>
  Effect.gen(function* () {
    const logger = yield* Logger
    const fileSystem = yield* FileSystem
    const loaded = yield* loadProjectConfig(name)
    const field = UNSETTABLE_CONFIG_FIELD_MAP.get(key)

    if (!field) {
      return yield* Effect.fail(
        configError(
          loaded.configPath,
          `Unsupported config key path '${key}' for unset.`,
          unsupportedUnsetHint(key),
          [
            {
              path: ["key"],
              message: `Key path '${key}' is not supported by 'rig config unset'.`,
              code: "invalid_key_path",
            },
          ],
        ),
      )
    }

    const nextConfig = structuredClone(loaded.config) as Record<string, unknown>
    const oldValue = readPathValue(nextConfig, key)

    if (field.optional) {
      removePathValue(nextConfig, key)
    } else {
      assignPathValue(nextConfig, key, null)
    }

    const validated = RigConfigSchema.safeParse(nextConfig)
    if (!validated.success) {
      return yield* Effect.fail(
        configError(
          loaded.configPath,
          `Cannot unset '${key}' because the updated config is invalid.`,
          `Run \`rig docs config ${key}\` to review this key before retrying.`,
          validated.error.issues.map((issue) => ({
            path: issue.path.filter(
              (value): value is string | number => typeof value === "string" || typeof value === "number",
            ),
            message: issue.message,
            code: issue.code,
          })),
        ),
      )
    }

    const newValue = readPathValue(validated.data as Record<string, unknown>, key)
    const serialized = `${JSON.stringify(validated.data, null, 2)}\n`
    const tempPath = `${loaded.configPath}.tmp-${randomUUID()}`

    yield* fileSystem.write(tempPath, serialized)
    yield* fileSystem.rename(tempPath, loaded.configPath).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* fileSystem.remove(tempPath).pipe(Effect.catchAll(() => Effect.void))
          return yield* Effect.fail(error)
        }),
      ),
    )

    yield* logger.success(`Unset ${key}.`, {
      project: loaded.name,
      configPath: loaded.configPath,
      valueType: field.valueType,
    })
    yield* logger.info(`Old value: ${formatValue(oldValue)}`)
    yield* logger.info(`New value: ${formatValue(newValue)}`)

    return 0
  })
