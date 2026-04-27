import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect-v3"

import { runListCommand } from "./list.js"
import { versionHistoryPath } from "./state-paths.js"
import { Git, type Git as GitService } from "../interfaces/git.js"
import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
import {
  Registry,
  type Registry as RegistryService,
  type RegistryEntry,
} from "../interfaces/registry.js"
import {
  Workspace,
  type Workspace as WorkspaceService,
  type WorkspaceInfo,
} from "../interfaces/workspace.js"
import { NodeFileSystemLive } from "../providers/node-fs.js"
import { StubGit } from "../providers/stub-git.js"
import { GitError, type RigError } from "../schema/errors.js"

class CaptureLogger implements LoggerService {
  readonly tables: Array<readonly Record<string, unknown>[]> = []

  info(_message: string, _details?: Record<string, unknown>) {
    return Effect.void
  }

  warn(_message: string, _details?: Record<string, unknown>) {
    return Effect.void
  }

  error(_structured: RigError) {
    return Effect.void
  }

  success(_message: string, _details?: Record<string, unknown>) {
    return Effect.void
  }

  table(rows: readonly Record<string, unknown>[]) {
    this.tables.push(rows)
    return Effect.void
  }
}

const PREVIOUS_RIG_ROOT = process.env.RIG_ROOT

afterEach(() => {
  if (PREVIOUS_RIG_ROOT === undefined) {
    delete process.env.RIG_ROOT
  } else {
    process.env.RIG_ROOT = PREVIOUS_RIG_ROOT
  }
})

class StaticRegistry implements RegistryService {
  constructor(private readonly entries: readonly RegistryEntry[]) {}

  register(_name: string, _repoPath: string) {
    return Effect.void
  }

  unregister(_name: string) {
    return Effect.void
  }

  resolve(name: string) {
    const entry = this.entries.find((candidate) => candidate.name === name)
    return Effect.succeed(entry?.repoPath ?? "/tmp/missing")
  }

  list() {
    return Effect.succeed(this.entries)
  }
}

class StaticWorkspace implements WorkspaceService {
  constructor(private readonly rows: readonly WorkspaceInfo[]) {}

  create(_name: string, _env: "dev" | "prod", _version: string, _commitRef: string) {
    return Effect.succeed("/tmp/workspace")
  }

  resolve(_name: string, _env: "dev" | "prod", _version?: string) {
    return Effect.succeed("/tmp/workspace")
  }

  activate(_name: string, _env: "dev" | "prod", _version: string) {
    return Effect.succeed("/tmp/workspace")
  }

  removeVersion(_name: string, _env: "dev" | "prod", _version: string) {
    return Effect.void
  }

  renameVersion(_name: string, _env: "dev" | "prod", _fromVersion: string, _toVersion: string) {
    return Effect.succeed("/tmp/workspace")
  }

  sync(_name: string, _env: "dev" | "prod") {
    return Effect.void
  }

  list(name: string) {
    return Effect.succeed(this.rows.filter((row) => row.name === name))
  }
}

describe("GIVEN suite context WHEN list command executes THEN behavior is covered", () => {
  test("GIVEN registered projects WHEN list runs THEN it includes the current prod version or N/A", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-list-command-"))
    const pantryRepo = join(root, "pantry")
    const docsRepo = join(root, "docs")
    process.env.RIG_ROOT = join(root, ".rig-state")
    await mkdir(dirname(versionHistoryPath("pantry")), { recursive: true })
    await writeFile(
      versionHistoryPath("pantry"),
      `${JSON.stringify({
        name: "pantry",
        entries: [
          {
            action: "minor",
            oldVersion: "0.1.0",
            newVersion: "0.2.0",
            changedAt: "2026-03-09T00:00:00.000Z",
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    )

    const logger = new CaptureLogger()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Git, new StubGit()),
      Layer.succeed(Logger, logger),
      Layer.succeed(
        Registry,
        new StaticRegistry([
          {
            name: "pantry",
            repoPath: pantryRepo,
            registeredAt: new Date("2026-01-01T00:00:00.000Z"),
          },
          {
            name: "docs",
            repoPath: docsRepo,
            registeredAt: new Date("2026-01-02T00:00:00.000Z"),
          },
        ]),
      ),
      Layer.succeed(
        Workspace,
        new StaticWorkspace([
          {
            name: "pantry",
            env: "prod",
            version: "0.2.0",
            path: "/tmp/pantry-prod",
            active: true,
          },
        ]),
      ),
    )

    const exitCode = await Effect.runPromise(runListCommand().pipe(Effect.provide(layer)))

    expect(exitCode).toBe(0)
    expect(logger.tables).toEqual([
      [
        {
          name: "pantry",
          repoPath: pantryRepo,
          currentProdVersion: "0.2.0",
          registeredAt: "2026-01-01T00:00:00.000Z",
        },
        {
          name: "docs",
          repoPath: docsRepo,
          currentProdVersion: "N/A",
          registeredAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    ])

    await rm(root, { recursive: true, force: true })
  })

  test("GIVEN a registered project that is not a git repo WHEN list runs THEN it still returns rows with N/A release history", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig-list-non-git-"))
    process.env.RIG_ROOT = join(root, ".rig-state")

    class NonGitStub implements GitService {
      private readonly base = new StubGit()

      detectMainBranch(repoPath: string) {
        return this.base.detectMainBranch(repoPath)
      }

      isDirty(repoPath: string) {
        return this.base.isDirty(repoPath)
      }

      currentBranch(repoPath: string) {
        return this.base.currentBranch(repoPath)
      }

      commitHash(repoPath: string, ref?: string) {
        return this.base.commitHash(repoPath, ref)
      }

      changedFiles(repoPath: string) {
        return this.base.changedFiles(repoPath)
      }

      commit(repoPath: string, message: string, paths?: readonly string[]) {
        return this.base.commit(repoPath, message, paths)
      }

      createTag(repoPath: string, tag: string) {
        return this.base.createTag(repoPath, tag)
      }

      createTagAtRef(repoPath: string, tag: string, ref: string) {
        return this.base.createTagAtRef(repoPath, tag, ref)
      }

      deleteTag(repoPath: string, tag: string) {
        return this.base.deleteTag(repoPath, tag)
      }

      tagExists(repoPath: string, tag: string) {
        return this.base.tagExists(repoPath, tag)
      }

      listTags(repoPath: string) {
        return Effect.fail(
          new GitError(
            "listTags",
            repoPath,
            128,
            "fatal: not a git repository (or any of the parent directories): .git",
            "Git listTags failed.",
            "Ensure the repository path is valid and readable.",
          ),
        )
      }

      commitHasTag(repoPath: string, commit: string) {
        return this.base.commitHasTag(repoPath, commit)
      }

      commitTags(repoPath: string, commit: string) {
        return this.base.commitTags(repoPath, commit)
      }

      isAncestor(repoPath: string, ancestorRef: string, descendantRef: string) {
        return this.base.isAncestor(repoPath, ancestorRef, descendantRef)
      }

      createWorktree(repoPath: string, dest: string, ref: string) {
        return this.base.createWorktree(repoPath, dest, ref)
      }

      removeWorktree(repoPath: string, dest: string) {
        return this.base.removeWorktree(repoPath, dest)
      }

      moveWorktree(repoPath: string, src: string, dest: string) {
        return this.base.moveWorktree(repoPath, src, dest)
      }
    }

    const logger = new CaptureLogger()
    const layer = Layer.mergeAll(
      NodeFileSystemLive,
      Layer.succeed(Git, new NonGitStub()),
      Layer.succeed(Logger, logger),
      Layer.succeed(
        Registry,
        new StaticRegistry([
          {
            name: "tmp-app",
            repoPath: "/tmp/not-a-git-repo",
            registeredAt: new Date("2026-01-03T00:00:00.000Z"),
          },
        ]),
      ),
      Layer.succeed(Workspace, new StaticWorkspace([])),
    )

    const exitCode = await Effect.runPromise(runListCommand().pipe(Effect.provide(layer)))

    expect(exitCode).toBe(0)
    expect(logger.tables).toEqual([
      [
        {
          name: "tmp-app",
          repoPath: "/tmp/not-a-git-repo",
          currentProdVersion: "N/A",
          registeredAt: "2026-01-03T00:00:00.000Z",
        },
      ],
    ])

    await rm(root, { recursive: true, force: true })
  })
})
