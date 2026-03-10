import { join } from "node:path"
import { Effect } from "effect"

import { FileSystem } from "../interfaces/file-system.js"
import { Git } from "../interfaces/git.js"
import { Logger } from "../interfaces/logger.js"
import { Workspace } from "../interfaces/workspace.js"
import type { VersionArgs } from "../schema/args.js"
import { CliArgumentError } from "../schema/errors.js"
import { loadProjectConfig } from "./config.js"
import { resolveProdReleaseState } from "./release-state.js"
import {
  bumpVersion,
  compareVersions,
  isBumpAction,
  readVersionHistory,
  versionHistoryPath,
  versionTag,
  writeRigJsonVersion,
  writeVersionHistory,
} from "./release.js"

const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+$/
const SHORT_COMMIT_LENGTH = 7

const releaseNotFoundError = (name: string, version: string) =>
  new CliArgumentError(
    "version",
    `Release '${version}' was not found for '${name}'.`,
    "Choose a version shown by `rig version <name>`.",
    { name, version },
  )

const duplicateVersionError = (name: string, version: string) =>
  new CliArgumentError(
    "version",
    `Release '${version}' already exists for '${name}'.`,
    "Choose a different replacement version.",
    { name, version },
  )

const orderingError = (name: string, version: string, previous: string, next: string | null) =>
  new CliArgumentError(
    "version",
    `Release '${version}' would break version ordering for '${name}'.`,
    next
      ? `Choose a version strictly between '${previous}' and '${next}'.`
      : `Choose a version strictly greater than '${previous}'.`,
    { name, version, previous, next },
  )

const editNoTargetError = (name: string) =>
  new CliArgumentError(
    "version",
    `Cannot edit release history for '${name}' without a target version.`,
    "Pass a release version before --edit.",
    { name },
  )

const duplicateCommitReleaseError = (name: string, tag: string, targetVersion: string) =>
  new CliArgumentError(
    "version",
    `Cannot edit release '${targetVersion}' for '${name}' because commit already has release tag '${tag}'.`,
    "Remove the other release tag first so each commit has only one prod release version.",
    { name, targetVersion, tag },
  )

const highestReleaseTag = (tags: readonly string[]) =>
  Effect.gen(function* () {
    let highest: string | null = null

    for (const tag of tags) {
      if (!RELEASE_TAG_RE.test(tag)) {
        continue
      }

      if (!highest) {
        highest = tag
        continue
      }

      const comparison = yield* compareVersions(tag.slice(1), highest.slice(1))
      if (comparison > 0) {
        highest = tag
      }
    }

    return highest
  })

const shortCommit = (commit: string): string =>
  commit === "N/A" ? commit : commit.slice(0, SHORT_COMMIT_LENGTH)

export const runVersionCommand = (args: VersionArgs) =>
  Effect.gen(function* () {
    const logger = yield* Logger
    const git = yield* Git
    const workspace = yield* Workspace
    const fileSystem = yield* FileSystem
    const loaded = yield* loadProjectConfig(args.name)
    const historyPath = versionHistoryPath(loaded.repoPath, args.name)
    const history = yield* readVersionHistory(historyPath, args.name)
    const releaseState = yield* resolveProdReleaseState(args.name, loaded.repoPath)

    if (!args.targetVersion) {
      const rows = yield* Effect.forEach([...history.entries].reverse(), (entry) =>
        Effect.gen(function* () {
          const markers = [
            releaseState.latestProdVersion === entry.newVersion ? "latest" : null,
            releaseState.currentProdVersion === entry.newVersion ? "current" : null,
          ].filter((marker): marker is string => marker !== null)

          return {
            version: entry.newVersion,
            commit: shortCommit(
              yield* git.commitHash(loaded.repoPath, versionTag(entry.newVersion)).pipe(
                Effect.catchAll(() => Effect.succeed("N/A")),
              ),
            ),
            changedAt: entry.changedAt,
            markers: markers.length > 0 ? markers.join(", ") : null,
          }
        }),
      )

      yield* logger.table(rows)

      return 0
    }

    const entryIndex = history.entries.findIndex((entry) => entry.newVersion === args.targetVersion)
    if (entryIndex === -1) {
      return yield* Effect.fail(releaseNotFoundError(args.name, args.targetVersion))
    }

    const entry = history.entries[entryIndex]
    const targetVersion = args.targetVersion

    if (!args.edit) {
      const rows = yield* workspace.list(args.name)
      const prodWorkspace = rows.find(
        (row) => row.env === "prod" && row.version === args.targetVersion,
      )
      const tag = versionTag(args.targetVersion)
      const tagged = yield* git.tagExists(loaded.repoPath, tag)
      const commit = tagged
        ? yield* git.commitHash(loaded.repoPath, tag)
        : null

      yield* logger.info("Version command resolved release.", {
        name: args.name,
        version: args.targetVersion,
        action: entry.action,
        oldVersion: entry.oldVersion,
        changedAt: entry.changedAt,
        tagged,
        commit,
        deployed: prodWorkspace !== undefined,
        active: prodWorkspace?.active ?? false,
        latest: releaseState.latestProdVersion === args.targetVersion,
        workspacePath: prodWorkspace?.path ?? null,
      })
      return 0
    }

    const replacementVersion = isBumpAction(args.edit)
      ? yield* bumpVersion(entry.oldVersion, args.edit)
      : args.edit

    if (replacementVersion === targetVersion) {
      yield* logger.info("Release version unchanged.", {
        name: args.name,
        version: targetVersion,
      })
      return 0
    }

    const duplicateEntry = history.entries.find(
      (candidate, index) => candidate.newVersion === replacementVersion && index !== entryIndex,
    )
    if (duplicateEntry) {
      return yield* Effect.fail(duplicateVersionError(args.name, replacementVersion))
    }

    const nextVersion = history.entries[entryIndex + 1]?.newVersion ?? null
    const comparedPrevious = yield* compareVersions(replacementVersion, entry.oldVersion)
    const comparedNext = nextVersion ? yield* compareVersions(replacementVersion, nextVersion) : null
    if (comparedPrevious <= 0 || (comparedNext !== null && comparedNext >= 0)) {
      return yield* Effect.fail(orderingError(args.name, replacementVersion, entry.oldVersion, nextVersion))
    }

    const oldTag = versionTag(targetVersion)
    const newTag = versionTag(replacementVersion)
    const newTagExists = yield* git.tagExists(loaded.repoPath, newTag)
    if (newTagExists) {
      return yield* Effect.fail(duplicateVersionError(args.name, replacementVersion))
    }

    const targetCommit = yield* git.commitHash(loaded.repoPath, oldTag)
    const otherReleaseTag = yield* highestReleaseTag(
      (yield* git.commitTags(loaded.repoPath, targetCommit)).filter((tag) => tag !== oldTag),
    )
    if (otherReleaseTag) {
      return yield* Effect.fail(duplicateCommitReleaseError(args.name, otherReleaseTag, targetVersion))
    }

    const originalConfig = yield* fileSystem.read(join(loaded.repoPath, "rig.json"))
    const originalHistory = history
    const updatedHistory = {
      name: history.name,
      entries: history.entries.map((candidate, index) =>
        index === entryIndex
          ? {
              ...candidate,
              action: "edit" as const,
              newVersion: replacementVersion,
              changedAt: new Date().toISOString(),
            }
          : candidate,
      ),
    }

    const rows = yield* workspace.list(args.name)
    const prodWorkspace = rows.find(
      (row) => row.env === "prod" && row.version === args.targetVersion,
    )

    let renamedWorkspacePath: string | null = null
    let originalWorkspacePath: string | null = null

    const rollback = Effect.gen(function* () {
      yield* writeVersionHistory(historyPath, originalHistory).pipe(Effect.catchAll(() => Effect.void))
      yield* fileSystem.write(join(loaded.repoPath, "rig.json"), originalConfig).pipe(
        Effect.catchAll(() => Effect.void),
      )
      yield* git.deleteTag(loaded.repoPath, newTag).pipe(Effect.catchAll(() => Effect.void))
      yield* git.createTagAtRef(loaded.repoPath, oldTag, targetCommit).pipe(
        Effect.catchAll(() => Effect.void),
      )
      if (renamedWorkspacePath && originalWorkspacePath) {
        yield* workspace.renameVersion(args.name, "prod", replacementVersion, targetVersion).pipe(
          Effect.catchAll(() => Effect.void),
        )
        yield* writeRigJsonVersion(join(originalWorkspacePath, "rig.json"), targetVersion).pipe(
          Effect.catchAll(() => Effect.void),
        )
      }
    })

    try {
      yield* writeVersionHistory(historyPath, updatedHistory)
      if (loaded.config.version === targetVersion) {
        yield* writeRigJsonVersion(join(loaded.repoPath, "rig.json"), replacementVersion)
      }
      yield* git.deleteTag(loaded.repoPath, oldTag)
      yield* git.createTagAtRef(loaded.repoPath, newTag, targetCommit)

      if (prodWorkspace) {
        originalWorkspacePath = prodWorkspace.path
        renamedWorkspacePath = yield* workspace.renameVersion(
          args.name,
          "prod",
          targetVersion,
          replacementVersion,
        )
        yield* writeRigJsonVersion(join(renamedWorkspacePath, "rig.json"), replacementVersion)
      }
    } catch (error) {
      yield* rollback
      return yield* Effect.fail(error)
    }

    yield* logger.success("Release version updated.", {
      name: args.name,
      oldVersion: targetVersion,
      newVersion: replacementVersion,
      active: prodWorkspace?.active ?? false,
      deployed: prodWorkspace !== undefined,
    })

    return 0
  })
