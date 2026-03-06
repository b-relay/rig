import { join } from "node:path"
import { Effect } from "effect"

import { FileSystem } from "../interfaces/file-system.js"
import { Git } from "../interfaces/git.js"
import { Logger } from "../interfaces/logger.js"
import type { VersionArgs } from "../schema/args.js"
import { CliArgumentError } from "../schema/errors.js"
import { loadProjectConfig } from "./config.js"

const SEMVER_RE = /^\d+\.\d+\.\d+$/

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
  action: "patch" | "minor" | "major",
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
    const version = loaded.config.version

    if (args.action === "undo") {
      return yield* Effect.fail(
        new CliArgumentError(
          "version",
          "Undo is not implemented yet.",
          "Revert rig.json manually or bump to a new version with patch|minor|major.",
          { name: args.name, action: args.action },
        ),
      )
    }

    if (args.action === "patch" || args.action === "minor" || args.action === "major") {
      const fileSystem = yield* FileSystem
      const nextVersion = yield* bumpVersion(version, args.action)
      const configPath = join(loaded.repoPath, "rig.json")
      const raw = yield* fileSystem.read(configPath)
      const parsed = yield* Effect.try({
        try: () => JSON.parse(raw) as Record<string, unknown>,
        catch: (cause) =>
          new CliArgumentError(
            "version",
            "Unable to parse rig.json while bumping version.",
            "Fix JSON syntax in rig.json and retry.",
            {
              path: configPath,
              cause: cause instanceof Error ? cause.message : String(cause),
            },
          ),
      })

      const updated = {
        ...parsed,
        version: nextVersion,
      }

      yield* fileSystem.write(configPath, `${JSON.stringify(updated, null, 2)}\n`)
      yield* logger.success("Version bumped.", {
        name: args.name,
        action: args.action,
        oldVersion: version,
        newVersion: nextVersion,
        configPath,
      })
      yield* logger.info("rig.json was updated. Commit this version bump to git.", {
        name: args.name,
        oldVersion: version,
        newVersion: nextVersion,
      })
      return 0
    }

    const git = yield* Git
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
