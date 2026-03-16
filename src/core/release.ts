import { Effect } from "effect"

import { FileSystem } from "../interfaces/file-system.js"
import { Git } from "../interfaces/git.js"
import { CliArgumentError, GitError } from "../schema/errors.js"
import { versionHistoryPath } from "./state-paths.js"

const SEMVER_RE = /^\d+\.\d+\.\d+$/

export type BumpAction = "patch" | "minor" | "major"
export type ReleaseAction = BumpAction | "edit" | "reconstructed"

export interface VersionHistoryEntry {
  readonly action: ReleaseAction
  readonly oldVersion: string
  readonly newVersion: string
  readonly changedAt: string | null
}

export interface VersionHistory {
  readonly name: string
  readonly entries: readonly VersionHistoryEntry[]
}

export const versionTag = (version: string): string => `v${version}`

export const isBumpAction = (value: unknown): value is BumpAction =>
  value === "patch" || value === "minor" || value === "major"

const isReleaseAction = (value: unknown): value is ReleaseAction =>
  value === "edit" || value === "reconstructed" || isBumpAction(value)

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

export const readVersionHistoryFile = (historyPath: string, name: string) =>
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
        !(typeof changedAt === "string" || changedAt === null)
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

const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+$/

const listReleaseVersions = (repoPath: string) =>
  Effect.gen(function* () {
    const git = yield* Git
    const tags = yield* git.listTags(repoPath)
    const versions = tags
      .filter((tag) => RELEASE_TAG_RE.test(tag))
      .map((tag) => tag.slice(1))

    const sorted = [...versions]
    for (let index = 0; index < sorted.length; index += 1) {
      for (let inner = index + 1; inner < sorted.length; inner += 1) {
        const comparison = yield* compareVersions(sorted[index], sorted[inner])
        if (comparison > 0) {
          ;[sorted[index], sorted[inner]] = [sorted[inner], sorted[index]]
        }
      }
    }

    return sorted
  })

const rebuildVersionHistory = (repoPath: string, name: string) =>
  Effect.gen(function* () {
    const versions = yield* listReleaseVersions(repoPath)

    return {
      name,
      entries: versions.map((version, index) => ({
        action: "reconstructed" as const,
        oldVersion: index === 0 ? "0.0.0" : versions[index - 1],
        newVersion: version,
        changedAt: null,
      })),
    } satisfies VersionHistory
  })

const isMissingGitRepo = (error: GitError): boolean =>
  error.operation === "listTags" && error.stderr.includes("not a git repository")

export const loadVersionHistory = (repoPath: string, name: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem
    const preferredPath = versionHistoryPath(name)
    const preferredExists = yield* fileSystem.exists(preferredPath)

    if (preferredExists) {
      return yield* readVersionHistoryFile(preferredPath, name)
    }

    const rebuilt = yield* rebuildVersionHistory(repoPath, name).pipe(
      Effect.catchIf(
        (error): error is GitError => error instanceof GitError && isMissingGitRepo(error),
        () =>
          Effect.succeed({
            name,
            entries: [],
          } satisfies VersionHistory),
      ),
    )
    if (rebuilt.entries.length > 0) {
      yield* writeVersionHistory(preferredPath, rebuilt)
    }

    return rebuilt
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
