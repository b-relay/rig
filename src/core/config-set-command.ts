import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { type ZodIssue } from "zod"

import { FileSystem } from "../interfaces/file-system.js"
import { Logger } from "../interfaces/logger.js"
import { RigConfigSchema } from "../schema/config.js"
import { ConfigValidationError, type ConfigIssue } from "../schema/errors.js"
import { loadProjectConfig } from "./config.js"

const SUPPORTED_KEYS = [
  "version",
  "description",
  "domain",
  "mainBranch",
  "daemon.enabled",
  "daemon.keepAlive",
  "hooks.preStart",
  "hooks.postStart",
  "hooks.preStop",
  "hooks.postStop",
] as const

const SupportedKeySet = new Set<string>(SUPPORTED_KEYS)

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

    if (!SupportedKeySet.has(key)) {
      return yield* Effect.fail(
        configError(
          loaded.configPath,
          `Unsupported config key path '${key}'.`,
          `Supported keys: ${SUPPORTED_KEYS.join(", ")}`,
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
    const nextConfig = structuredClone(loaded.config) as Record<string, unknown>
    const oldValue = readPathValue(nextConfig, key)

    assignPathValue(nextConfig, key, parsedValue)

    const validated = RigConfigSchema.safeParse(nextConfig)
    if (!validated.success) {
      return yield* Effect.fail(
        configError(
          loaded.configPath,
          `Cannot set '${key}' because the updated config is invalid.`,
          "Use a value compatible with rig.json schema and retry.",
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
    })
    yield* logger.info(`Old value: ${formatValue(oldValue)}`)
    yield* logger.info(`New value: ${formatValue(newValue)}`)

    return 0
  })
