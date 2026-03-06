import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
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
  constructor(
    private readonly branch = "main",
    private readonly commit = "abc1234",
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
    return Effect.succeed(this.commit)
  }

  changedFiles(_repoPath: string): Effect.Effect<readonly string[], GitError> {
    return Effect.succeed([])
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

  test("GIVEN a valid project WHEN undo action runs THEN it fails with CliArgumentError not implemented", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "rig-version-undo-"))
    await writeRigConfig(repoPath, "1.2.3")

    const logger = new CaptureLogger()
    const layer = createLayer(repoPath, logger)

    const result = await Effect.runPromise(
      runVersionCommand({ name: "pantry", action: "undo" }).pipe(Effect.provide(layer), Effect.either),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(CliArgumentError)
      expect(result.left.message).toContain("not implemented")
      const err = result.left as CliArgumentError
      expect(err.command).toBe("version")
    }

    await rm(repoPath, { recursive: true, force: true })
  })
})
