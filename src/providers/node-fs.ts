import { access, chmod, cp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Effect, Layer } from "effect"

import { FileSystem, type FileSystem as FileSystemService } from "../interfaces/file-system.js"
import { FileSystemError } from "../schema/errors.js"

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const toError = (
  operation: FileSystemError["operation"],
  path: string,
  hint: string,
) =>
  (cause: unknown) =>
    new FileSystemError(operation, path, causeMessage(cause), hint)

export class NodeFileSystem implements FileSystemService {
  read(path: string): Effect.Effect<string, FileSystemError> {
    return Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: toError("read", path, `Ensure ${path} exists and is readable.`),
    })
  }

  write(path: string, content: string): Effect.Effect<void, FileSystemError> {
    return Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, content, "utf8")
      },
      catch: toError("write", path, `Ensure ${dirname(path)} is writable.`),
    })
  }

  copy(src: string, dest: string): Effect.Effect<void, FileSystemError> {
    return Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(dest), { recursive: true })
        await cp(src, dest, { recursive: true, force: true })
      },
      catch: toError("copy", `${src} -> ${dest}`, "Check source path and destination permissions."),
    })
  }

  symlink(target: string, link: string): Effect.Effect<void, FileSystemError> {
    return Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(link), { recursive: true })
        await rm(link, { recursive: true, force: true })
        await symlink(target, link)
      },
      catch: toError("symlink", `${target} -> ${link}`, "Check target path and parent directory permissions."),
    })
  }

  exists(path: string): Effect.Effect<boolean, FileSystemError> {
    return Effect.tryPromise({
      try: async () => {
        await access(path)
        return true
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.catchAll((cause) => {
        const code =
          typeof cause === "object" && cause !== null && "code" in cause
            ? String((cause as { code?: unknown }).code)
            : ""

        if (code === "ENOENT") {
          return Effect.succeed(false)
        }

        return Effect.fail(
          new FileSystemError(
            "exists",
            path,
            causeMessage(cause),
            `Unable to check if ${path} exists. Verify permissions.`,
          ),
        )
      }),
    )
  }

  remove(path: string): Effect.Effect<void, FileSystemError> {
    return Effect.tryPromise({
      try: () => rm(path, { recursive: true, force: true }),
      catch: toError("remove", path, `Ensure ${path} is writable or already removed.`),
    })
  }

  mkdir(path: string): Effect.Effect<void, FileSystemError> {
    return Effect.tryPromise({
      try: () => mkdir(path, { recursive: true }),
      catch: toError("mkdir", path, `Ensure parent directories for ${path} are writable.`),
    })
  }

  list(path: string): Effect.Effect<readonly string[], FileSystemError> {
    return Effect.tryPromise({
      try: () => readdir(path),
      catch: toError("list", path, `Ensure ${path} exists and is readable.`),
    })
  }

  chmod(path: string, mode: number): Effect.Effect<void, FileSystemError> {
    return Effect.tryPromise({
      try: () => chmod(path, mode),
      catch: toError("chmod", path, `Ensure ${path} exists and you have permission to change mode.`),
    })
  }
}

export const NodeFileSystemLive = Layer.succeed(FileSystem, new NodeFileSystem())
