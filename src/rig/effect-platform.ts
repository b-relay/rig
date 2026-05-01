import { Effect, FileSystem } from "effect"
import { BunFileSystem } from "@effect/platform-bun"

const withBunFileSystem = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E> =>
  effect.pipe(Effect.provide(BunFileSystem.layer))

export const isPlatformNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === "PlatformError" &&
  "reason" in cause &&
  typeof cause.reason === "object" &&
  cause.reason !== null &&
  "_tag" in cause.reason &&
  cause.reason._tag === "NotFound"

export const platformReadFileString = (path: string) =>
  withBunFileSystem(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(path)
  }))

export const platformReadFileBytes = (path: string) =>
  withBunFileSystem(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFile(path)
  }))

export const platformWriteFileString = (path: string, data: string) =>
  withBunFileSystem(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(path, data)
  }))

export const platformAppendFileString = (path: string, data: string) =>
  withBunFileSystem(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(path, data, { flag: "a" })
  }))

export const platformMakeDirectory = (path: string) =>
  withBunFileSystem(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path, { recursive: true })
  }))

export const platformMakeDirectoryExclusive = (path: string) =>
  withBunFileSystem(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path)
  }))

export const platformRemove = (
  path: string,
  options: {
    readonly recursive?: boolean
    readonly force?: boolean
  } = {},
) =>
  withBunFileSystem(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(path, options)
  }))

export const platformCopyFile = (fromPath: string, toPath: string) =>
  withBunFileSystem(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.copyFile(fromPath, toPath)
  }))

export const platformChmod = (path: string, mode: number) =>
  withBunFileSystem(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.chmod(path, mode)
  }))

export const platformRename = (oldPath: string, newPath: string) =>
  withBunFileSystem(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.rename(oldPath, newPath)
  }))

export const platformExists = (path: string) =>
  withBunFileSystem(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.exists(path)
  }))
