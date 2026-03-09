import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { runVersionCommand } from "./version.js"
import { Git, type Git as GitService } from "../interfaces/git.js"
import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
import { Registry, type Registry as RegistryService } from "../interfaces/registry.js"
import { Workspace, type Workspace as WorkspaceService } from "../interfaces/workspace.js"
import { NodeFileSystemLive } from "../providers/node-fs.js"
import { GitError, MainBranchDetectionError, type RigError } from "../schema/errors.js"

class CaptureLogger implements LoggerService {
  readonly infos: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []
  readonly successes: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []
  readonly errors: RigError[] = []
  readonly tables: Array<readonly Record<string, unknown>[]> = []

  info(message: string, details?: Record<string, unknown>) {
    this.infos.push({ message, details })
    return Effect.void
  }

  warn(_message: string, _details?: Record<string, unknown>) {
    return Effect.void
  }

  error(structured: RigError) {
    this.errors.push(structured)
    return Effect.void
  }

  success(message: string, details?: Record<string, unknown>) {
    this.successes.push({ message, details })
    return Effect.void
  }

  table(rows: readonly Record<string, unknown>[]) {
    this.tables.push(rows)
    return Effect.void
  }
}

class StaticRegistry implements RegistryService {
  constructor(private readonly repoPath: string) {}

  register(_name: string, _repoPath: string) {
    return Effect.void
  }

  unregister(_name: string) {
    return Effect.void
  }

  resolve(_name: string) {
    return Effect.succeed(this.repoPath)
  }

  list() {
    return Effect.succeed([])
  }
}

class StaticGit implements GitService {
  readonly createdTags: string[] = []
  readonly deletedTags: string[] = []
  constructor(
    private readonly branch = "main",
    private readonly commitValue = "abc1234",
    private readonly dirty = false,
    private readonly tagsAtCommit: readonly string[] = [],
  ) {}

  detectMainBranch(_repoPath: string): Effect.Effect<string, MainBranchDetectionError | GitError> {
    return Effect.succeed("main")
  }

  isDirty(_repoPath: string): Effect.Effect<boolean, GitError> {
    return Effect.succeed(this.dirty)
  }

  currentBranch(_repoPath: string): Effect.Effect<string, GitError> {
    return Effect.succeed(this.branch)
  }

  commitHash(_repoPath: string, _ref?: string): Effect.Effect<string, GitError> {
    return Effect.succeed(this.commitValue)
  }

  changedFiles(_repoPath: string): Effect.Effect<readonly string[], GitError> {
    return Effect.succeed([])
  }

  commit(_repoPath: string, _message: string, _paths?: readonly string[]): Effect.Effect<void, GitError> {
    return Effect.void
  }

  createTag(_repoPath: string, _tag: string): Effect.Effect<void, GitError> {
    return Effect.void
  }

  createTagAtRef(_repoPath: string, tag: string, _ref: string): Effect.Effect<void, GitError> {
    this.createdTags.push(tag)
    return Effect.void
  }

  deleteTag(_repoPath: string, tag: string): Effect.Effect<void, GitError> {
    this.deletedTags.push(tag)
    return Effect.void
  }

  tagExists(_repoPath: string, _tag: string): Effect.Effect<boolean, GitError> {
    return Effect.succeed(false)
  }

  commitHasTag(_repoPath: string, _commit: string): Effect.Effect<string | null, GitError> {
    return Effect.succeed(this.tagsAtCommit[0] ?? null)
  }

  commitTags(_repoPath: string, _commit: string): Effect.Effect<readonly string[], GitError> {
    return Effect.succeed(this.tagsAtCommit)
  }

  isAncestor(_repoPath: string, _ancestorRef: string, _descendantRef: string): Effect.Effect<boolean, GitError> {
    return Effect.succeed(true)
  }

  createWorktree(_repoPath: string, _dest: string, _ref: string): Effect.Effect<void, GitError> {
    return Effect.void
  }

  removeWorktree(_repoPath: string, _dest: string): Effect.Effect<void, GitError> {
    return Effect.void
  }

  moveWorktree(_repoPath: string, _src: string, _dest: string): Effect.Effect<void, GitError> {
    return Effect.void
  }
}

class StaticWorkspace implements WorkspaceService {
  readonly renamed: Array<{ readonly fromVersion: string; readonly toVersion: string }> = []

  constructor(private readonly rows: readonly {
    readonly name: string
    readonly env: "dev" | "prod"
    readonly version: string | null
    readonly path: string
    readonly active: boolean
  }[] = []) {}

  create(_name: string, _env: "dev" | "prod", _version: string, _commitRef: string) {
    return Effect.succeed("/tmp/unused-workspace")
  }

  resolve(_name: string, _env: "dev" | "prod", _version?: string) {
    return Effect.succeed("/tmp/unused-workspace")
  }

  activate(_name: string, _env: "dev" | "prod", _version: string) {
    return Effect.succeed("/tmp/unused-workspace")
  }

  removeVersion(_name: string, _env: "dev" | "prod", _version: string) {
    return Effect.void
  }

  renameVersion(_name: string, _env: "dev" | "prod", _fromVersion: string, _toVersion: string) {
    this.renamed.push({ fromVersion: _fromVersion, toVersion: _toVersion })
    return Effect.succeed("/tmp/unused-workspace")
  }

  sync(_name: string, _env: "dev" | "prod") {
    return Effect.void
  }

  list(_name: string) {
    return Effect.succeed(this.rows)
  }
}

const writeRigConfig = async (repoPath: string, version: string) => {
  await writeFile(
    join(repoPath, "rig.json"),
    `${JSON.stringify(
      {
        name: "pantry",
        version,
        environments: {
          dev: {
            services: [
              { name: "web", type: "server", command: "echo web", port: 5173 },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
}

const writeVersionHistory = async (repoPath: string, entries: readonly Record<string, string>[]) => {
  await mkdir(join(repoPath, ".rig", "versions"), { recursive: true })
  await writeFile(
    join(repoPath, ".rig", "versions", "pantry.json"),
    `${JSON.stringify({ name: "pantry", entries }, null, 2)}\n`,
    "utf8",
  )
}

const createLayer = (
  repoPath: string,
  logger: CaptureLogger,
  git = new StaticGit(),
  workspace: WorkspaceService = new StaticWorkspace(),
) =>
  Layer.mergeAll(
    NodeFileSystemLive,
    Layer.succeed(Logger, logger),
    Layer.succeed(Registry, new StaticRegistry(repoPath)),
    Layer.succeed(Git, git),
    Layer.succeed(Workspace, workspace),
  )

describe("GIVEN suite context WHEN version command executes THEN behavior is covered", () => {
  test("GIVEN release history WHEN version runs without a target THEN it shows release rows with latest/current markers", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-version-show-"))
    await writeRigConfig(repoPath, "1.3.0")
    await writeVersionHistory(repoPath, [
      {
        action: "patch",
        oldVersion: "1.2.2",
        newVersion: "1.2.3",
        changedAt: "2026-03-09T00:00:00.000Z",
      },
      {
        action: "minor",
        oldVersion: "1.2.3",
        newVersion: "1.3.0",
        changedAt: "2026-03-09T01:00:00.000Z",
      },
    ])

    const logger = new CaptureLogger()
    const layer = createLayer(
      repoPath,
      logger,
      new StaticGit("main", "cafebabe", true),
      new StaticWorkspace([
        {
          name: "pantry",
          env: "prod",
          version: "1.2.3",
          path: "/tmp/pantry/prod/1.2.3",
          active: true,
        },
      ]),
    )

    const exitCode = await Effect.runPromise(
      runVersionCommand({ name: "pantry" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(logger.tables).toEqual([
      [
        {
          version: "1.2.3",
          commit: "cafebabe",
          changedAt: "2026-03-09T00:00:00.000Z",
          markers: "current",
        },
        {
          version: "1.3.0",
          commit: "cafebabe",
          changedAt: "2026-03-09T01:00:00.000Z",
          markers: "latest",
        },
      ],
    ])

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN release history with no active prod deployment WHEN version runs THEN no row is marked current", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-version-history-no-current-"))
    await writeRigConfig(repoPath, "1.2.3")
    await writeVersionHistory(repoPath, [
      {
        action: "patch",
        oldVersion: "1.2.2",
        newVersion: "1.2.3",
        changedAt: "2026-03-09T00:00:00.000Z",
      },
      {
        action: "minor",
        oldVersion: "1.2.3",
        newVersion: "1.3.0",
        changedAt: "2026-03-09T01:00:00.000Z",
      },
    ])

    const logger = new CaptureLogger()
    const layer = createLayer(repoPath, logger)

    const exitCode = await Effect.runPromise(
      runVersionCommand({ name: "pantry" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(logger.tables).toEqual([
      [
        {
          version: "1.2.3",
          commit: "abc1234",
          changedAt: "2026-03-09T00:00:00.000Z",
          markers: null,
        },
        {
          version: "1.3.0",
          commit: "abc1234",
          changedAt: "2026-03-09T01:00:00.000Z",
          markers: "latest",
        },
      ],
    ])

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN a targeted release edit WHEN edit uses a bump keyword THEN tag history and workspace version are rewritten", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-version-edit-"))
    await writeRigConfig(repoPath, "1.4.0")
    const workspacePath = join(repoPath, ".workspaces", "prod", "1.2.3")
    await mkdir(workspacePath, { recursive: true })
    await writeRigConfig(workspacePath, "1.2.3")
    await writeVersionHistory(repoPath, [
      {
        action: "patch",
        oldVersion: "1.2.2",
        newVersion: "1.2.3",
        changedAt: "2026-03-09T00:00:00.000Z",
      },
      {
        action: "minor",
        oldVersion: "1.2.3",
        newVersion: "1.4.0",
        changedAt: "2026-03-09T01:00:00.000Z",
      },
    ])

    const logger = new CaptureLogger()
    const git = new StaticGit()
    class EditingWorkspace extends StaticWorkspace {
      override list(_name: string) {
        return Effect.succeed([
          {
            name: "pantry",
            env: "prod" as const,
            version: "1.2.3",
            path: workspacePath,
            active: false,
          },
        ])
      }

      override renameVersion(_name: string, _env: "dev" | "prod", fromVersion: string, toVersion: string) {
        const nextPath = join(repoPath, ".workspaces", "prod", toVersion)
        this.renamed.push({ fromVersion, toVersion })
        return Effect.tryPromise({
          try: async () => {
            await mkdir(nextPath, { recursive: true })
            await writeRigConfig(nextPath, toVersion)
            return nextPath
          },
          catch: (cause) => cause as never,
        })
      }
    }
    const workspace = new EditingWorkspace()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Git, git),
      Layer.succeed(Workspace, workspace),
    )

    const exitCode = await Effect.runPromise(
      runVersionCommand({
        name: "pantry",
        targetVersion: "1.2.3",
        edit: "minor",
      }).pipe(Effect.provide(layer)),
    )

    const updatedHistory = JSON.parse(
      await Bun.file(join(repoPath, ".rig", "versions", "pantry.json")).text(),
    ) as { entries: Array<{ action: string; newVersion: string }> }

    expect(exitCode).toBe(0)
    expect(git.deletedTags).toEqual(["v1.2.3"])
    expect(git.createdTags).toEqual(["v1.3.0"])
    expect(workspace.renamed).toEqual([{ fromVersion: "1.2.3", toVersion: "1.3.0" }])
    expect(updatedHistory.entries[0]).toMatchObject({
      action: "edit",
      newVersion: "1.3.0",
    })

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN a targeted release commit already has another release tag WHEN edit runs THEN it fails", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-version-edit-duplicate-tag-"))
    await writeRigConfig(repoPath, "1.4.0")
    await writeVersionHistory(repoPath, [
      {
        action: "patch",
        oldVersion: "1.2.2",
        newVersion: "1.2.3",
        changedAt: "2026-03-09T00:00:00.000Z",
      },
      {
        action: "minor",
        oldVersion: "1.2.3",
        newVersion: "1.4.0",
        changedAt: "2026-03-09T01:00:00.000Z",
      },
    ])

    const logger = new CaptureLogger()
    const git = new StaticGit("main", "abc1234", false, ["v1.2.3", "v1.3.0"])
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Logger, logger),
      Layer.succeed(Registry, new StaticRegistry(repoPath)),
      Layer.succeed(Git, git),
      Layer.succeed(Workspace, new StaticWorkspace()),
    )

    const result = await Effect.runPromise(
      runVersionCommand({
        name: "pantry",
        targetVersion: "1.2.3",
        edit: "1.2.4",
      }).pipe(
        Effect.provide(layer),
        Effect.either,
      ),
    )

    expect(result._tag).toBe("Left")
    expect(git.deletedTags).toEqual([])
    expect(git.createdTags).toEqual([])

    await rm(repoPath, { recursive: true, force: true })
  })
})
