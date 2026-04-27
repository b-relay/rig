import { randomUUID } from "node:crypto"
import { Effect } from "effect-v3"
import { type ZodIssue } from "zod"

import { FileSystem } from "../interfaces/file-system.js"
import { Logger } from "../interfaces/logger.js"
import { RigConfigSchema } from "../schema/config.js"
import { ConfigValidationError, type ConfigIssue } from "../schema/errors.js"
import { loadProjectConfig } from "./config.js"
import { CONFIG_FIELD_MAP, SETTABLE_CONFIG_FIELD_MAP } from "./config-fields.js"

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

const parseInputValue = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

const isPrimitiveValue = (value: unknown): value is string | number | boolean | null =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"

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

const assignPathValue = (target: Record<string, unknown>, key: string, value: unknown): void => {
  const segments = key.split(".")
  let cursor = target

  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment]

    if (existing === undefined) {
      const created: Record<string, unknown> = {}
      cursor[segment] = created
      cursor = created
      continue
    }

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

export const runConfigSetCommand = (name: string, key: string, value: string) =>
  Effect.gen(function* () {
    const logger = yield* Logger
    const fileSystem = yield* FileSystem
    const loaded = yield* loadProjectConfig(name)
    const field = SETTABLE_CONFIG_FIELD_MAP.get(key)

    if (!field) {
      const documentedField = CONFIG_FIELD_MAP.get(key)
      const hint = documentedField
        ? documentedField.manualEditWarning
          ? `${documentedField.manualEditWarning} Run \`rig docs config ${key}\` for details.`
          : `Key '${key}' is documented but not directly settable. Edit rig.json manually if appropriate, and run \`rig docs config ${key}\` first.`
        : "Run `rig docs config` to see supported keys, value types, and descriptions."

      return yield* Effect.fail(
        configError(
          loaded.configPath,
          `Unsupported config key path '${key}'.`,
          hint,
          [
            {
              path: ["key"],
              message: `Key path '${key}' is not supported by 'rig config set'.`,
              code: "invalid_key_path",
            },
          ],
        ),
      )
    }

    const parsedValue = parseInputValue(value)
    if (!isPrimitiveValue(parsedValue)) {
      return yield* Effect.fail(
        configError(
          loaded.configPath,
          `Cannot set '${key}' with a non-primitive value.`,
          "Pass a string, number, boolean, or null. Arrays and objects are not supported by `rig config set`.",
          [
            {
              path: ["value"],
              message: "Only primitive values are supported by 'rig config set'.",
              code: "invalid_value_type",
            },
          ],
        ),
      )
    }

    const nextConfig = structuredClone(loaded.config) as Record<string, unknown>
    const oldValue = readPathValue(nextConfig, key)

    assignPathValue(nextConfig, key, parsedValue)

    const validated = RigConfigSchema.safeParse(nextConfig)
    if (!validated.success) {
      return yield* Effect.fail(
        configError(
          loaded.configPath,
          `Cannot set '${key}' because the updated config is invalid.`,
          `Use a value compatible with '${field.valueType}' and retry. Run \`rig docs config\` for field docs.`,
          validated.error.issues.map(mapZodIssue),
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

    yield* logger.success(`Updated ${key}.`, {
      project: loaded.name,
      configPath: loaded.configPath,
      valueType: field.valueType,
    })
    yield* logger.info(`Old value: ${formatValue(oldValue)}`)
    yield* logger.info(`New value: ${formatValue(newValue)}`)

    return 0
  })
