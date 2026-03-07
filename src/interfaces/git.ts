import { Context, Effect } from "effect"
import type { GitError, MainBranchDetectionError } from "../schema/errors.js"

export interface Git {
  readonly detectMainBranch: (
    repoPath: string
  ) => Effect.Effect<string, MainBranchDetectionError | GitError>

  readonly isDirty: (repoPath: string) => Effect.Effect<boolean, GitError>
  readonly currentBranch: (repoPath: string) => Effect.Effect<string, GitError>
  readonly commitHash: (repoPath: string, ref?: string) => Effect.Effect<string, GitError>
  readonly changedFiles: (repoPath: string) => Effect.Effect<readonly string[], GitError>
  readonly commit: (
    repoPath: string,
    message: string,
    paths?: readonly string[]
  ) => Effect.Effect<void, GitError>

  readonly createTag: (repoPath: string, tag: string) => Effect.Effect<void, GitError>
  readonly deleteTag: (repoPath: string, tag: string) => Effect.Effect<void, GitError>
  readonly tagExists: (repoPath: string, tag: string) => Effect.Effect<boolean, GitError>
  readonly commitHasTag: (
    repoPath: string,
    commit: string
  ) => Effect.Effect<string | null, GitError>

  readonly createWorktree: (
    repoPath: string,
    dest: string,
    ref: string
  ) => Effect.Effect<void, GitError>
  readonly removeWorktree: (
    repoPath: string,
    dest: string
  ) => Effect.Effect<void, GitError>
}

export const Git = Context.GenericTag<Git>("Git")
