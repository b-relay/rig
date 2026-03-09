import { join } from "node:path"
import { Effect } from "effect"

import { FileSystem } from "../interfaces/file-system.js"
import { CliArgumentError } from "../schema/errors.js"

const SEMVER_RE = /^\d+\.\d+\.\d+$/

export type BumpAction = "patch" | "minor" | "major"
export type ReleaseAction = BumpAction | "edit"

export interface VersionHistoryEntry {
  readonly action: ReleaseAction
  readonly oldVersion: string
  readonly newVersion: string
  readonly changedAt: string
}

export interface VersionHistory {
  readonly name: string
  readonly entries: readonly VersionHistoryEntry[]
}

export const versionHistoryPath = (repoPath: string, name: string) =>
  join(repoPath, ".rig", "versions", `${name}.json`)

export const versionTag = (version: string): string => `v${version}`

export const isBumpAction = (value: unknown): value is BumpAction =>
  value === "patch" || value === "minor" || value === "major"

const isReleaseAction = (value: unknown): value is ReleaseAction =>
  value === "edit" || isBumpAction(value)

export const readRigJson = (configPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem
    const raw = yield* fileSystem.read(configPath)
    return yield* Effect.try({
      try: () => JSON.parse(raw) as Record<string, unknown>,
      catch: (cause) =>
        new CliArgumentError(
          "deploy",
          "Unable to parse rig.json while updating version.",
          "Fix JSON syntax in rig.json and retry.",
          {
            path: configPath,
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        ),
    })
  })

export const writeRigJsonVersion = (configPath: string, version: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem
    const parsed = yield* readRigJson(configPath)
    yield* fileSystem.write(
      configPath,
      `${JSON.stringify({ ...parsed, version }, null, 2)}\n`,
    )
  })

export const readVersionHistory = (historyPath: string, name: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem
    const exists = yield* fileSystem.exists(historyPath)
    if (!exists) {
      return { name, entries: [] } as VersionHistory
    }

    const raw = yield* fileSystem.read(historyPath)
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        new CliArgumentError(
          "deploy",
          "Unable to parse version history backup.",
          "Fix the version history JSON and retry.",
          {
            path: historyPath,
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        ),
    })

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return yield* Effect.fail(
        new CliArgumentError(
          "deploy",
          "Version history backup is invalid.",
          "Fix the history file shape or remove it before retrying.",
          { path: historyPath },
        ),
      )
    }

    const parsedRecord = parsed as Record<string, unknown>
    const parsedName = parsedRecord["name"]
    const parsedEntries = parsedRecord["entries"]
    if (typeof parsedName !== "string" || !Array.isArray(parsedEntries)) {
      return yield* Effect.fail(
        new CliArgumentError(
          "deploy",
          "Version history backup is missing required fields.",
          "Ensure history includes 'name' and 'entries'.",
          { path: historyPath },
        ),
      )
    }

    const entries = parsedEntries.map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return null
      }

      const action = entry["action"]
      const oldVersion = entry["oldVersion"]
      const newVersion = entry["newVersion"]
      const changedAt = entry["changedAt"]

      if (
        !isReleaseAction(action) ||
        typeof oldVersion !== "string" ||
        typeof newVersion !== "string" ||
        typeof changedAt !== "string"
      ) {
        return null
      }

      return {
        action,
        oldVersion,
        newVersion,
        changedAt,
      } as VersionHistoryEntry
    })

    if (entries.some((entry) => entry === null)) {
      return yield* Effect.fail(
        new CliArgumentError(
          "deploy",
          "Version history backup contains invalid entries.",
          "Fix or remove the history file before retrying.",
          { path: historyPath },
        ),
      )
    }

    return {
      name: parsedName,
      entries: entries as readonly VersionHistoryEntry[],
    } as VersionHistory
  })

export const writeVersionHistory = (historyPath: string, history: VersionHistory) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem
    yield* fileSystem.write(historyPath, `${JSON.stringify(history, null, 2)}\n`)
  })

export const parseVersion = (
  version: string,
): Effect.Effect<readonly [number, number, number], CliArgumentError> =>
  Effect.gen(function* () {
    if (!SEMVER_RE.test(version)) {
      return yield* Effect.fail(
        new CliArgumentError(
          "deploy",
          `Cannot bump invalid version '${version}'.`,
          "Use semantic versions in the form MAJOR.MINOR.PATCH.",
          { version },
        ),
      )
    }

    const [major, minor, patch] = version.split(".").map((segment) => Number(segment))
    return [major, minor, patch] as const
  })

export const bumpVersion = (
  current: string,
  action: BumpAction,
): Effect.Effect<string, CliArgumentError> =>
  Effect.gen(function* () {
    const [major, minor, patch] = yield* parseVersion(current)

    if (action === "patch") {
      return `${major}.${minor}.${patch + 1}`
    }

    if (action === "minor") {
      return `${major}.${minor + 1}.0`
    }

    return `${major + 1}.0.0`
  })

export const compareVersions = (
  left: string,
  right: string,
): Effect.Effect<number, CliArgumentError> =>
  Effect.gen(function* () {
    const leftParts = yield* parseVersion(left)
    const rightParts = yield* parseVersion(right)

    for (let index = 0; index < 3; index += 1) {
      const diff = leftParts[index] - rightParts[index]
      if (diff !== 0) {
        return diff
      }
    }

    return 0
  })
