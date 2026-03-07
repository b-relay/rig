import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, mock, test } from "bun:test"
import { Effect, Layer } from "effect"

import { runVersionCommand } from "./version.js"
import { Git, type Git as GitService } from "../interfaces/git.js"
import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
import { Registry, type Registry as RegistryService } from "../interfaces/registry.js"
import { NodeFileSystemLive } from "../providers/node-fs.js"
import { CliArgumentError, GitError, MainBranchDetectionError, type RigError } from "../schema/errors.js"

class CaptureLogger implements LoggerService {
  readonly infos: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []
  readonly successes: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []
  readonly errors: RigError[] = []

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

  table(_rows: readonly Record<string, unknown>[]) {
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
  readonly commits: Array<{ readonly repoPath: string; readonly message: string; readonly paths: readonly string[] }> = []

  constructor(
    private readonly branch = "main",
    private readonly commitValue = "abc1234",
    private readonly dirty = false,
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

  commit(repoPath: string, message: string, paths: readonly string[] = []): Effect.Effect<void, GitError> {
    this.commits.push({ repoPath, message, paths })
    return Effect.void
  }

  createTag(_repoPath: string, _tag: string): Effect.Effect<void, GitError> {
    return Effect.void
  }

  deleteTag(_repoPath: string, _tag: string): Effect.Effect<void, GitError> {
    return Effect.void
  }

  tagExists(_repoPath: string, _tag: string): Effect.Effect<boolean, GitError> {
    return Effect.succeed(false)
  }

  commitHasTag(_repoPath: string, _commit: string): Effect.Effect<string | null, GitError> {
    return Effect.succeed(null)
  }

  createWorktree(_repoPath: string, _dest: string, _ref: string): Effect.Effect<void, GitError> {
    return Effect.void
  }

  removeWorktree(_repoPath: string, _dest: string): Effect.Effect<void, GitError> {
    return Effect.void
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

const readVersion = async (repoPath: string): Promise<string> => {
  const raw = await readFile(join(repoPath, "rig.json"), "utf8")
  const parsed = JSON.parse(raw) as { version: string }
  return parsed.version
}

const createLayer = (repoPath: string, logger: CaptureLogger, git = new StaticGit()) =>
  Layer.mergeAll(
    NodeFileSystemLive,
    Layer.succeed(Logger, logger),
    Layer.succeed(Registry, new StaticRegistry(repoPath)),
    Layer.succeed(Git, git),
  )

describe("GIVEN suite context WHEN version command executes THEN behavior is covered", () => {
  test("GIVEN a valid project WHEN show action runs THEN it displays current version and git state", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-version-show-"))
    await writeRigConfig(repoPath, "1.2.3")

    const logger = new CaptureLogger()
    const layer = createLayer(repoPath, logger, new StaticGit("main", "cafebabe", true))

    const exitCode = await Effect.runPromise(
      runVersionCommand({ name: "pantry", action: "show" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(logger.infos).toContainEqual({
      message: "Version command resolved state.",
      details: {
        name: "pantry",
        action: "show",
        version: "1.2.3",
        branch: "main",
        commit: "cafebabe",
        dirty: true,
      },
    })

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN version 1.2.3 WHEN patch action runs THEN it bumps to 1.2.4", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-version-patch-"))
    await writeRigConfig(repoPath, "1.2.3")

    const logger = new CaptureLogger()
    const layer = createLayer(repoPath, logger)

    const exitCode = await Effect.runPromise(
      runVersionCommand({ name: "pantry", action: "patch" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(await readVersion(repoPath)).toBe("1.2.4")
    expect(logger.successes.at(-1)).toMatchObject({
      message: "Version bumped.",
      details: {
        action: "patch",
        oldVersion: "1.2.3",
        newVersion: "1.2.4",
      },
    })

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN version 1.2.3 WHEN minor action runs THEN it bumps to 1.3.0", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-version-minor-"))
    await writeRigConfig(repoPath, "1.2.3")

    const logger = new CaptureLogger()
    const layer = createLayer(repoPath, logger)

    const exitCode = await Effect.runPromise(
      runVersionCommand({ name: "pantry", action: "minor" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(await readVersion(repoPath)).toBe("1.3.0")
    expect(logger.successes.at(-1)).toMatchObject({
      message: "Version bumped.",
      details: {
        action: "minor",
        oldVersion: "1.2.3",
        newVersion: "1.3.0",
      },
    })

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN version 1.2.3 WHEN major action runs THEN it bumps to 2.0.0", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-version-major-"))
    await writeRigConfig(repoPath, "1.2.3")

    const logger = new CaptureLogger()
    const layer = createLayer(repoPath, logger)

    const exitCode = await Effect.runPromise(
      runVersionCommand({ name: "pantry", action: "major" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(await readVersion(repoPath)).toBe("2.0.0")
    expect(logger.successes.at(-1)).toMatchObject({
      message: "Version bumped.",
      details: {
        action: "major",
        oldVersion: "1.2.3",
        newVersion: "2.0.0",
      },
    })

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN a valid project WHEN list action runs THEN it shows version and git commit info", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-version-list-"))
    await writeRigConfig(repoPath, "1.2.3")

    const logger = new CaptureLogger()
    const layer = createLayer(repoPath, logger, new StaticGit("release", "deadbeef", false))

    const exitCode = await Effect.runPromise(
      runVersionCommand({ name: "pantry", action: "list" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(logger.infos).toContainEqual({
      message: "Version list.",
      details: {
        name: "pantry",
        version: "1.2.3",
        branch: "release",
        commit: "deadbeef",
        dirty: false,
      },
    })

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN a bumped version WHEN undo action runs THEN it restores previous version and commits rig.json", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-version-undo-"))
    await writeRigConfig(repoPath, "1.2.3")

    const logger = new CaptureLogger()
    const git = new StaticGit()
    const layer = createLayer(repoPath, logger, git)

    const bumpExitCode = await Effect.runPromise(
      runVersionCommand({ name: "pantry", action: "patch" }).pipe(Effect.provide(layer)),
    )
    expect(bumpExitCode).toBe(0)
    expect(await readVersion(repoPath)).toBe("1.2.4")

    const undoExitCode = await Effect.runPromise(
      runVersionCommand({ name: "pantry", action: "undo" }).pipe(Effect.provide(layer)),
    )

    expect(undoExitCode).toBe(0)
    expect(await readVersion(repoPath)).toBe("1.2.3")
    expect(logger.successes.some((entry) => entry.message === "Version bump undone.")).toBe(true)
    expect(git.commits.at(-1)).toEqual({
      repoPath,
      message: "chore: undo version bump for pantry (1.2.4 -> 1.2.3)",
      paths: ["rig.json"],
    })

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN project with invalid semver WHEN patch bump is requested THEN CliArgumentError includes MAJOR.MINOR.PATCH hint", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-version-invalid-semver-"))
    await writeRigConfig(repoPath, "1.2.3")

    const logger = new CaptureLogger()
    const layer = createLayer(repoPath, logger)

    const originalConfigModule = await import("./config.js")
    const actualLoadProjectConfig = originalConfigModule.loadProjectConfig
    let result: { _tag: "Left"; left: unknown } | { _tag: "Right"; right: number } = {
      _tag: "Right",
      right: 0,
    }
    try {
      mock.module("./config.js", () => ({
        ...originalConfigModule,
        loadProjectConfig: (name: string) =>
          Effect.succeed({
            name,
            repoPath,
            configPath: join(repoPath, "rig.json"),
            config: {
              name,
              version: "not-a-version",
              environments: {
                dev: {
                  services: [
                    { name: "web", type: "server", command: "echo web", port: 5173 },
                  ],
                },
              },
            },
          }),
      }))

      const { runVersionCommand: runVersionCommandWithInvalidVersion } = await import(
        `./version.js?invalid-semver-${Date.now()}`
      )
      result = await Effect.runPromise(
        runVersionCommandWithInvalidVersion({ name: "pantry", action: "patch" }).pipe(
          Effect.provide(layer),
          Effect.either,
        ),
      )
    } finally {
      mock.module("./config.js", () => ({
        ...originalConfigModule,
        loadProjectConfig: actualLoadProjectConfig,
      }))
      mock.restore()
    }

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(CliArgumentError)
      const error = result.left as CliArgumentError
      expect(error.message).toContain("Cannot bump invalid version")
      expect(error.hint).toContain("MAJOR.MINOR.PATCH")
    }

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN project semver 0.0.0 WHEN patch bump runs THEN version becomes 0.0.1", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-version-zero-patch-"))
    await writeRigConfig(repoPath, "0.0.0")

    const logger = new CaptureLogger()
    const layer = createLayer(repoPath, logger)

    const exitCode = await Effect.runPromise(
      runVersionCommand({ name: "pantry", action: "patch" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(await readVersion(repoPath)).toBe("0.0.1")

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN project semver 99.99.99 WHEN major bump runs THEN version becomes 100.0.0", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-version-large-major-"))
    await writeRigConfig(repoPath, "99.99.99")

    const logger = new CaptureLogger()
    const layer = createLayer(repoPath, logger)

    const exitCode = await Effect.runPromise(
      runVersionCommand({ name: "pantry", action: "major" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(await readVersion(repoPath)).toBe("100.0.0")

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN project version 1.2.3 WHEN show action runs THEN it returns 0 and queries branch commit and dirty git state", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-version-show-git-calls-"))
    await writeRigConfig(repoPath, "1.2.3")

    class TrackingGit extends StaticGit {
      branchCalls = 0
      commitCalls = 0
      dirtyCalls = 0

      override currentBranch(repoPath: string): Effect.Effect<string, GitError> {
        this.branchCalls += 1
        return super.currentBranch(repoPath)
      }

      override commitHash(repoPath: string, ref?: string): Effect.Effect<string, GitError> {
        this.commitCalls += 1
        return super.commitHash(repoPath, ref)
      }

      override isDirty(repoPath: string): Effect.Effect<boolean, GitError> {
        this.dirtyCalls += 1
        return super.isDirty(repoPath)
      }
    }

    const logger = new CaptureLogger()
    const git = new TrackingGit("release", "feedface", true)
    const layer = createLayer(repoPath, logger, git)

    const exitCode = await Effect.runPromise(
      runVersionCommand({ name: "pantry", action: "show" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(git.branchCalls).toBe(1)
    expect(git.commitCalls).toBe(1)
    expect(git.dirtyCalls).toBe(1)
    expect(logger.infos).toContainEqual({
      message: "Version command resolved state.",
      details: {
        name: "pantry",
        action: "show",
        version: "1.2.3",
        branch: "release",
        commit: "feedface",
        dirty: true,
      },
    })

    await rm(repoPath, { recursive: true, force: true })
  })

  test("GIVEN project version 1.2.3 WHEN list action runs THEN it returns 0 and logs version details with git metadata", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-version-list-logging-"))
    await writeRigConfig(repoPath, "1.2.3")

    const logger = new CaptureLogger()
    const layer = createLayer(repoPath, logger, new StaticGit("hotfix", "bead1234", true))

    const exitCode = await Effect.runPromise(
      runVersionCommand({ name: "pantry", action: "list" }).pipe(Effect.provide(layer)),
    )

    expect(exitCode).toBe(0)
    expect(logger.infos).toContainEqual({
      message: "Version list.",
      details: {
        name: "pantry",
        version: "1.2.3",
        branch: "hotfix",
        commit: "bead1234",
        dirty: true,
      },
    })

    await rm(repoPath, { recursive: true, force: true })
  })
})
