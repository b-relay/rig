import { Context, Effect } from "effect-v3"
import type { FileSystemError } from "../schema/errors.js"

export interface FileSystem {
  readonly read: (path: string) => Effect.Effect<string, FileSystemError>
  readonly write: (path: string, content: string) => Effect.Effect<void, FileSystemError>
  readonly rename: (src: string, dest: string) => Effect.Effect<void, FileSystemError>
  readonly append: (path: string, content: string) => Effect.Effect<void, FileSystemError>
  readonly copy: (src: string, dest: string) => Effect.Effect<void, FileSystemError>
  readonly symlink: (target: string, link: string) => Effect.Effect<void, FileSystemError>
  readonly exists: (path: string) => Effect.Effect<boolean, FileSystemError>
  readonly remove: (path: string) => Effect.Effect<void, FileSystemError>
  readonly mkdir: (path: string) => Effect.Effect<void, FileSystemError>
  readonly list: (path: string) => Effect.Effect<readonly string[], FileSystemError>
  readonly chmod: (path: string, mode: number) => Effect.Effect<void, FileSystemError>
}

export const FileSystem = Context.GenericTag<FileSystem>("FileSystem")
