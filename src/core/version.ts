import { join } from "node:path"
import { Effect } from "effect"

import { FileSystem } from "../interfaces/file-system.js"
import { Git } from "../interfaces/git.js"
import { Logger } from "../interfaces/logger.js"
import { Workspace } from "../interfaces/workspace.js"
import type { VersionArgs } from "../schema/args.js"
import { CliArgumentError } from "../schema/errors.js"
import { loadProjectConfig } from "./config.js"

const SEMVER_RE = /^\d+\.\d+\.\d+$/
type BumpAction = "patch" | "minor" | "major"

interface VersionHistoryEntry {
  readonly action: BumpAction
  readonly oldVersion: string
  readonly newVersion: string
  readonly changedAt: string
}

interface VersionHistory {
  readonly name: string
  readonly entries: readonly VersionHistoryEntry[]
}

const versionHistoryPath = (repoPath: string, name: string) =>
  join(repoPath, ".rig", "versions", `${name}.json`)

const versionTag = (version: string): string => `v${version}`

const isBumpAction = (value: unknown): value is BumpAction =>
  value === "patch" || value === "minor" || value === "major"

const readRigJson = (configPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem
    const raw = yield* fileSystem.read(configPath)
    return yield* Effect.try({
      try: () => JSON.parse(raw) as Record<string, unknown>,
      catch: (cause) =>
        new CliArgumentError(
          "version",
          "Unable to parse rig.json while updating version.",
          "Fix JSON syntax in rig.json and retry.",
          {
            path: configPath,
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        ),
    })
  })

const readVersionHistory = (historyPath: string, name: string) =>
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
          "version",
          "Unable to parse version history backup.",
          "Fix the version history JSON or run a new version bump.",
          {
            path: historyPath,
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        ),
    })

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return yield* Effect.fail(
        new CliArgumentError(
          "version",
          "Version history backup is invalid.",
          "Fix the history file shape or run a new version bump.",
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
          "version",
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
        !isBumpAction(action) ||
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
          "version",
          "Version history backup contains invalid entries.",
          "Fix or remove the backup file, then run the command again.",
          { path: historyPath },
        ),
      )
    }

    return {
      name: parsedName,
      entries: entries as readonly VersionHistoryEntry[],
    } as VersionHistory
  })

const writeVersionHistory = (historyPath: string, history: VersionHistory) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem
    yield* fileSystem.write(historyPath, `${JSON.stringify(history, null, 2)}\n`)
  })

const parseVersion = (
  version: string,
): Effect.Effect<readonly [number, number, number], CliArgumentError> =>
  Effect.gen(function* () {
    if (!SEMVER_RE.test(version)) {
      return yield* Effect.fail(
        new CliArgumentError(
          "version",
          `Cannot bump invalid version '${version}'.`,
          "Use semantic versions in the form MAJOR.MINOR.PATCH (for example 1.2.3).",
          { version },
        ),
      )
    }

    const [major, minor, patch] = version.split(".").map((segment) => Number(segment))
    return [major, minor, patch] as const
  })

const bumpVersion = (
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

export const runVersionCommand = (args: VersionArgs) =>
  Effect.gen(function* () {
    const logger = yield* Logger
    const loaded = yield* loadProjectConfig(args.name)
    const fileSystem = yield* FileSystem
    const git = yield* Git
    const version = loaded.config.version
    const configPath = join(loaded.repoPath, "rig.json")
    const historyPath = versionHistoryPath(loaded.repoPath, args.name)

    if (args.action === "undo") {
      const history = yield* readVersionHistory(historyPath, args.name)
      const lastEntry = history.entries.at(-1)

      if (!lastEntry) {
        return yield* Effect.fail(
          new CliArgumentError(
            "version",
            "No version history backup was found to undo.",
            "Run `rig version <name> patch|minor|major` before undo.",
            { name: args.name, historyPath },
          ),
        )
      }

      if (lastEntry.newVersion !== version) {
        return yield* Effect.fail(
          new CliArgumentError(
            "version",
            "Current rig.json version does not match the latest history entry.",
            "Sync rig.json with history or run a new bump before undo.",
            {
              name: args.name,
              currentVersion: version,
              historyLatestVersion: lastEntry.newVersion,
              historyPath,
            },
          ),
        )
      }

      const workspace = yield* Workspace
      const workspaces = yield* workspace.list(args.name)
      const alreadyDeployed = workspaces.some(
        (entry) => entry.env === "prod" && entry.version === lastEntry.newVersion,
      )
      if (alreadyDeployed) {
        return yield* Effect.fail(
          new CliArgumentError(
            "version",
            `Cannot undo version '${lastEntry.newVersion}' because it is already deployed.`,
            "Deploy a newer version instead of undoing an already deployed tag.",
            {
              name: args.name,
              version: lastEntry.newVersion,
              historyPath,
            },
          ),
        )
      }

      const parsed = yield* readRigJson(configPath)
      const updated = {
        ...parsed,
        version: lastEntry.oldVersion,
      }

      yield* fileSystem.write(configPath, `${JSON.stringify(updated, null, 2)}\n`)

      yield* writeVersionHistory(historyPath, {
        name: history.name,
        entries: history.entries.slice(0, -1),
      })

      yield* git.deleteTag(loaded.repoPath, versionTag(lastEntry.newVersion))
      yield* git.commit(
        loaded.repoPath,
        `chore: undo version bump for ${args.name} (${version} -> ${lastEntry.oldVersion})`,
        ["rig.json"],
      )

      yield* logger.success("Version bump undone.", {
        name: args.name,
        oldVersion: version,
        newVersion: lastEntry.oldVersion,
        action: args.action,
        configPath,
      })

      return 0
    }

    if (args.action === "patch" || args.action === "minor" || args.action === "major") {
      const nextVersion = yield* bumpVersion(version, args.action)
      const parsed = yield* readRigJson(configPath)

      const updated = {
        ...parsed,
        version: nextVersion,
      }

      yield* fileSystem.write(configPath, `${JSON.stringify(updated, null, 2)}\n`)

      const history = yield* readVersionHistory(historyPath, args.name)
      yield* writeVersionHistory(historyPath, {
        name: history.name,
        entries: [
          ...history.entries,
          {
            action: args.action,
            oldVersion: version,
            newVersion: nextVersion,
            changedAt: new Date().toISOString(),
          },
        ],
      })

      const tag = versionTag(nextVersion)
      yield* git.createTag(loaded.repoPath, tag).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            const rollback = {
              ...parsed,
              version,
            }
            yield* fileSystem.write(configPath, `${JSON.stringify(rollback, null, 2)}\n`)
            yield* writeVersionHistory(historyPath, history)
            return yield* Effect.fail(error)
          }),
        ),
      )

      yield* logger.success("Version bumped.", {
        name: args.name,
        action: args.action,
        oldVersion: version,
        newVersion: nextVersion,
        tag,
        configPath,
      })
      yield* logger.info("rig.json was updated. Commit this version bump to git.", {
        name: args.name,
        oldVersion: version,
        newVersion: nextVersion,
        historyPath,
      })
      return 0
    }

    const branch = yield* git.currentBranch(loaded.repoPath)
    const commit = yield* git.commitHash(loaded.repoPath)
    const dirty = yield* git.isDirty(loaded.repoPath)
    if (args.action === "list") {
      yield* logger.info("Version list.", {
        name: args.name,
        version,
        branch,
        commit,
        dirty,
      })
      return 0
    }

    yield* logger.info("Version command resolved state.", {
      name: args.name,
      action: args.action,
      version,
      branch,
      commit,
      dirty,
    })

    return 0
  })
