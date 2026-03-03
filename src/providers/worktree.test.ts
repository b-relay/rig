import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { FileSystem } from "../interfaces/file-system.js"
import { Git } from "../interfaces/git.js"
import { Registry } from "../interfaces/registry.js"
import { Workspace } from "../interfaces/workspace.js"
import { GitWorktreeWorkspace, GitWorktreeWorkspaceLive } from "./worktree.js"
import { FileSystemError, GitError, RegistryError, WorkspaceError } from "../schema/errors.js"
import type { FileSystem as FileSystemService } from "../interfaces/file-system.js"
import type { Git as GitService } from "../interfaces/git.js"
import type { Registry as RegistryService } from "../interfaces/registry.js"

// ── In-memory mocks ──────────────────────────────────────────────────────────

class MockFileSystem implements FileSystemService {
  readonly dirs = new Set<string>()
  readonly files = new Map<string, string>()
  readonly symlinks = new Map<string, string>()

  read(path: string) {
    const content = this.files.get(path)
    if (content === undefined) {
      return Effect.fail(new FileSystemError("read", path, "Not found", "Check path."))
    }
    return Effect.succeed(content)
  }

  write(path: string, content: string) {
    this.files.set(path, content)
    return Effect.void
  }

  copy(_src: string, _dest: string) {
    return Effect.void
  }

  symlink(target: string, link: string) {
    this.symlinks.set(link, target)
    return Effect.void
  }

  exists(path: string) {
    return Effect.succeed(this.dirs.has(path) || this.files.has(path))
  }

  remove(_path: string) {
    return Effect.void
  }

  mkdir(path: string) {
    this.dirs.add(path)
    return Effect.void
  }

  list(path: string) {
    // Return entries that are direct children of this path
    const entries = new Set<string>()
    for (const dir of this.dirs) {
      if (dir.startsWith(path + "/") && !dir.slice(path.length + 1).includes("/")) {
        entries.add(dir.slice(path.length + 1))
      }
    }
    for (const file of this.files.keys()) {
      if (file.startsWith(path + "/") && !file.slice(path.length + 1).includes("/")) {
        entries.add(file.slice(path.length + 1))
      }
    }
    return Effect.succeed([...entries])
  }

  chmod(_path: string, _mode: number) {
    return Effect.void
  }
}

class MockGit implements GitService {
  readonly worktrees = new Map<string, string>() // dest -> ref

  detectMainBranch(_repoPath: string) {
    return Effect.succeed("main")
  }

  isDirty(_repoPath: string) {
    return Effect.succeed(false)
  }

  currentBranch(_repoPath: string) {
    return Effect.succeed("main")
  }

  commitHash(_repoPath: string, ref?: string) {
    return Effect.succeed(ref ?? "abc1234")
  }

  changedFiles(_repoPath: string) {
    return Effect.succeed([] as readonly string[])
  }

  createTag(_repoPath: string, _tag: string) {
    return Effect.void
  }

  deleteTag(_repoPath: string, _tag: string) {
    return Effect.void
  }

  tagExists(_repoPath: string, _tag: string) {
    return Effect.succeed(false)
  }

  commitHasTag(_repoPath: string, _commit: string) {
    return Effect.succeed(null as string | null)
  }

  createWorktree(_repoPath: string, dest: string, ref: string) {
    this.worktrees.set(dest, ref)
    return Effect.void
  }

  removeWorktree(_repoPath: string, dest: string) {
    this.worktrees.delete(dest)
    return Effect.void
  }
}

class MockRegistry implements RegistryService {
  readonly projects = new Map<string, string>()

  register(name: string, repoPath: string) {
    this.projects.set(name, repoPath)
    return Effect.void
  }

  unregister(name: string) {
    this.projects.delete(name)
    return Effect.void
  }

  resolve(name: string) {
    const path = this.projects.get(name)
    if (!path) {
      return Effect.fail(
        new RegistryError("resolve", name, `Project '${name}' not registered.`, "Run rig init first."),
      )
    }
    return Effect.succeed(path)
  }

  list() {
    return Effect.succeed(
      [...this.projects.entries()].map(([name, repoPath]) => ({
        name,
        repoPath,
        registeredAt: new Date(),
      })),
    )
  }
}

// ── Test helpers ─────────────────────────────────────────────────────────────

const setup = () => {
  const mockFs = new MockFileSystem()
  const mockGit = new MockGit()
  const mockRegistry = new MockRegistry()
  mockRegistry.projects.set("pantry", "/Users/clay/Projects/pantry")

  const workspace = new GitWorktreeWorkspace(mockGit, mockFs, mockRegistry)

  return { mockFs, mockGit, mockRegistry, workspace }
}

const homedir = () => require("node:os").homedir()
const join = (...parts: string[]) => require("node:path").join(...parts)

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GitWorktreeWorkspace", () => {
  describe("create", () => {
    test("dev: returns repo path and creates workspace dir", async () => {
      const { workspace, mockFs } = setup()

      const result = await Effect.runPromise(workspace.create("pantry", "dev", "", ""))

      expect(result).toBe("/Users/clay/Projects/pantry")

      const devDir = join(homedir(), ".rig", "workspaces", "pantry", "dev")
      expect(mockFs.dirs.has(devDir)).toBe(true)
    })

    test("prod: creates worktree and symlink", async () => {
      const { workspace, mockGit, mockFs } = setup()

      const result = await Effect.runPromise(
        workspace.create("pantry", "prod", "v1.0.0", "abc1234"),
      )

      const expectedDest = join(homedir(), ".rig", "workspaces", "pantry", "prod", "v1.0.0")
      expect(result).toBe(expectedDest)
      expect(mockGit.worktrees.get(expectedDest)).toBe("abc1234")

      const symlinkPath = join(homedir(), ".rig", "workspaces", "pantry", "prod", "current")
      expect(mockFs.symlinks.get(symlinkPath)).toBe(expectedDest)
    })

    test("prod: fails if workspace already exists", async () => {
      const { workspace, mockFs } = setup()
      const dest = join(homedir(), ".rig", "workspaces", "pantry", "prod", "v1.0.0")
      mockFs.dirs.add(dest)

      const result = await Effect.runPromise(
        workspace.create("pantry", "prod", "v1.0.0", "abc1234").pipe(Effect.either),
      )

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left._tag).toBe("WorkspaceError")
        expect(result.left.message).toContain("already exists")
      }
    })

    test("fails if project not registered", async () => {
      const { workspace } = setup()

      const result = await Effect.runPromise(
        workspace.create("unknown", "dev", "", "").pipe(Effect.either),
      )

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left._tag).toBe("WorkspaceError")
        expect(result.left.hint).toContain("rig init")
      }
    })
  })

  describe("resolve", () => {
    test("dev: returns repo path from registry", async () => {
      const { workspace } = setup()

      const result = await Effect.runPromise(workspace.resolve("pantry", "dev"))

      expect(result).toBe("/Users/clay/Projects/pantry")
    })

    test("dev: fails if not registered", async () => {
      const { workspace } = setup()

      const result = await Effect.runPromise(
        workspace.resolve("unknown", "dev").pipe(Effect.either),
      )

      expect(result._tag).toBe("Left")
    })
  })

  describe("sync", () => {
    test("is a no-op for both envs", async () => {
      const { workspace } = setup()

      await Effect.runPromise(workspace.sync("pantry", "dev"))
      await Effect.runPromise(workspace.sync("pantry", "prod"))
      // No errors = success
    })
  })

  describe("list", () => {
    test("returns dev entry when workspace exists", async () => {
      const { workspace, mockFs } = setup()
      const devDir = join(homedir(), ".rig", "workspaces", "pantry", "dev")
      mockFs.dirs.add(devDir)

      const result = await Effect.runPromise(workspace.list("pantry"))

      const devEntry = result.find((r) => r.env === "dev")
      expect(devEntry).toBeDefined()
      expect(devEntry!.path).toBe("/Users/clay/Projects/pantry")
      expect(devEntry!.version).toBeNull()
      expect(devEntry!.active).toBe(true)
    })

    test("returns prod entries with version info", async () => {
      const { workspace, mockFs } = setup()
      const prodBase = join(homedir(), ".rig", "workspaces", "pantry", "prod")
      const v1Dir = join(prodBase, "v1.0.0")
      const v2Dir = join(prodBase, "v2.0.0")
      mockFs.dirs.add(prodBase)
      mockFs.dirs.add(v1Dir)
      mockFs.dirs.add(v2Dir)

      const result = await Effect.runPromise(workspace.list("pantry"))

      const prodEntries = result.filter((r) => r.env === "prod")
      expect(prodEntries.length).toBe(2)

      const versions = prodEntries.map((e) => e.version).sort()
      expect(versions).toEqual(["v1.0.0", "v2.0.0"])
    })

    test("returns empty when no workspaces exist", async () => {
      const { workspace } = setup()

      const result = await Effect.runPromise(workspace.list("pantry"))

      expect(result.length).toBe(0)
    })
  })

  describe("Layer", () => {
    test("GitWorktreeWorkspaceLive wires correctly", async () => {
      const mockFs = new MockFileSystem()
      const mockGit = new MockGit()
      const mockRegistry = new MockRegistry()
      mockRegistry.projects.set("test", "/tmp/test-repo")

      const layer = Layer.mergeAll(
        Layer.succeed(Git, mockGit),
        Layer.succeed(FileSystem, mockFs),
        Layer.succeed(Registry, mockRegistry),
      )

      const program = Effect.gen(function* () {
        const workspace = yield* Workspace
        return yield* workspace.resolve("test", "dev")
      })

      const result = await Effect.runPromise(
        program.pipe(Effect.provide(Layer.provide(GitWorktreeWorkspaceLive, layer))),
      )

      expect(result).toBe("/tmp/test-repo")
    })
  })
})
