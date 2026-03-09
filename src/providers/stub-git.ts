import { Effect, Layer } from "effect"

import { Git, type Git as GitService } from "../interfaces/git.js"

export class StubGit implements GitService {
  detectMainBranch(_repoPath: string): Effect.Effect<string> {
    return Effect.succeed("main")
  }

  isDirty(_repoPath: string): Effect.Effect<boolean> {
    return Effect.succeed(false)
  }

  currentBranch(_repoPath: string): Effect.Effect<string> {
    return Effect.succeed("main")
  }

  commitHash(_repoPath: string, ref?: string): Effect.Effect<string> {
    if (!ref || ref === "HEAD" || ref.startsWith("v") || ref.startsWith("refs/tags/")) {
      return Effect.succeed("HEAD")
    }
    return Effect.succeed(ref)
  }

  changedFiles(_repoPath: string): Effect.Effect<readonly string[]> {
    return Effect.succeed([])
  }

  commit(_repoPath: string, _message: string, _paths?: readonly string[]): Effect.Effect<void> {
    return Effect.void
  }

  createTag(_repoPath: string, _tag: string): Effect.Effect<void> {
    return Effect.void
  }

  createTagAtRef(_repoPath: string, _tag: string, _ref: string): Effect.Effect<void> {
    return Effect.void
  }

  deleteTag(_repoPath: string, _tag: string): Effect.Effect<void> {
    return Effect.void
  }

  tagExists(_repoPath: string, _tag: string): Effect.Effect<boolean> {
    return Effect.succeed(false)
  }

  commitHasTag(_repoPath: string, _commit: string): Effect.Effect<string | null> {
    return Effect.succeed(null)
  }

  commitTags(_repoPath: string, _commit: string): Effect.Effect<readonly string[]> {
    return Effect.succeed([])
  }

  isAncestor(_repoPath: string, _ancestorRef: string, _descendantRef: string): Effect.Effect<boolean> {
    return Effect.succeed(true)
  }

  createWorktree(_repoPath: string, _dest: string, _ref: string): Effect.Effect<void> {
    return Effect.void
  }

  removeWorktree(_repoPath: string, _dest: string): Effect.Effect<void> {
    return Effect.void
  }

  moveWorktree(_repoPath: string, _src: string, _dest: string): Effect.Effect<void> {
    return Effect.void
  }
}

export const StubGitLive = Layer.succeed(Git, new StubGit())
