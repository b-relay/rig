import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect-v3"

import { FileSystem, type FileSystem as FileSystemService } from "../interfaces/file-system.js"
import { Logger } from "../interfaces/logger.js"
import { FileSystemError } from "../schema/errors.js"
import { FileLogger, FileLoggerLive } from "./file-logger.js"

const LOG_PATH = "/tmp/rig.log"
const LINE_REGEX = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\] \[([A-Z]+)\] (.*)$/

class InMemoryFileSystem implements FileSystemService {
  readonly files = new Map<string, string>()
  readonly dirs = new Set<string>()
  readonly symlinks = new Map<string, string>()

  read(path: string) {
    const content = this.files.get(path)
    if (content === undefined) {
      return Effect.fail(new FileSystemError("read", path, "ENOENT", "File not found."))
    }
    return Effect.succeed(content)
  }

  write(path: string, content: string) {
    this.files.set(path, content)
    return Effect.void
  }

  rename(src: string, dest: string) {
    const content = this.files.get(src)
    if (content === undefined) {
      return Effect.fail(new FileSystemError("rename", src, "ENOENT", "Source not found."))
    }
    this.files.set(dest, content)
    this.files.delete(src)
    return Effect.void
  }

  append(path: string, content: string) {
    this.files.set(path, `${this.files.get(path) ?? ""}${content}`)
    return Effect.void
  }

  copy(src: string, dest: string) {
    const content = this.files.get(src)
    if (content === undefined) {
      return Effect.fail(new FileSystemError("copy", src, "ENOENT", "Source not found."))
    }
    this.files.set(dest, content)
    return Effect.void
  }

  symlink(target: string, link: string) {
    this.symlinks.set(link, target)
    return Effect.void
  }

  exists(path: string) {
    return Effect.succeed(this.files.has(path) || this.dirs.has(path) || this.symlinks.has(path))
  }

  remove(path: string) {
    return Effect.sync(() => {
      this.files.delete(path)
      this.dirs.delete(path)
      this.symlinks.delete(path)
    })
  }

  mkdir(path: string) {
    return Effect.sync(() => {
      this.dirs.add(path)
    })
  }

  list(path: string) {
    const entries = new Set<string>()
    const roots = [...this.files.keys(), ...this.dirs.values(), ...this.symlinks.keys()]

    for (const candidate of roots) {
      if (!candidate.startsWith(path + "/")) {
        continue
      }
      const relative = candidate.slice(path.length + 1)
      if (!relative || relative.includes("/")) {
        continue
      }
      entries.add(relative)
    }

    return Effect.succeed([...entries])
  }

  chmod(_path: string, _mode: number) {
    return Effect.void
  }
}

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

const readLines = (fileSystem: InMemoryFileSystem): string[] => {
  const raw = fileSystem.files.get(LOG_PATH) ?? ""
  return raw
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
}

const expectTimestampedLine = (
  line: string,
  expectedLevel: "INFO" | "WARN" | "ERROR" | "SUCCESS" | "TABLE",
  expectedMessage: string,
): void => {
  const match = line.match(LINE_REGEX)
  expect(match).toBeTruthy()
  if (!match) {
    return
  }

  const timestamp = match[1]
  const level = match[2]
  const message = match[3]

  expect(level).toBe(expectedLevel)
  expect(message).toBe(expectedMessage)
  expect(new Date(timestamp).toISOString()).toBe(timestamp)
}

describe("GIVEN suite context WHEN FileLogger THEN behavior is covered", () => {
  test("GIVEN test setup WHEN info is called without details THEN expected behavior is observed", async () => {
    const fileSystem = new InMemoryFileSystem()
    const logger = new FileLogger(fileSystem, LOG_PATH)

    await run(logger.info("starting services"))

    const lines = readLines(fileSystem)
    expect(lines).toHaveLength(1)
    expectTimestampedLine(lines[0], "INFO", "starting services")
  })

  test("GIVEN test setup WHEN info is called with details THEN expected behavior is observed", async () => {
    const fileSystem = new InMemoryFileSystem()
    const logger = new FileLogger(fileSystem, LOG_PATH)

    await run(logger.info("startup details", { env: "dev", services: 2 }))

    const lines = readLines(fileSystem)
    expect(lines).toHaveLength(3)
    expectTimestampedLine(lines[0], "INFO", "startup details")
    expect(lines[1]).toBe("  env: dev")
    expect(lines[2]).toBe("  services: 2")
  })

  test("GIVEN test setup WHEN warn is called without details THEN expected behavior is observed", async () => {
    const fileSystem = new InMemoryFileSystem()
    const logger = new FileLogger(fileSystem, LOG_PATH)

    await run(logger.warn("slow startup"))

    const lines = readLines(fileSystem)
    expect(lines).toHaveLength(1)
    expectTimestampedLine(lines[0], "WARN", "slow startup")
  })

  test("GIVEN test setup WHEN warn is called with details THEN expected behavior is observed", async () => {
    const fileSystem = new InMemoryFileSystem()
    const logger = new FileLogger(fileSystem, LOG_PATH)

    await run(logger.warn("port conflict", { port: 5173, service: "web" }))

    const lines = readLines(fileSystem)
    expect(lines).toHaveLength(3)
    expectTimestampedLine(lines[0], "WARN", "port conflict")
    expect(lines[1]).toBe("  port: 5173")
    expect(lines[2]).toBe("  service: web")
  })

  test("GIVEN test setup WHEN success is called without details THEN expected behavior is observed", async () => {
    const fileSystem = new InMemoryFileSystem()
    const logger = new FileLogger(fileSystem, LOG_PATH)

    await run(logger.success("deploy complete"))

    const lines = readLines(fileSystem)
    expect(lines).toHaveLength(1)
    expectTimestampedLine(lines[0], "SUCCESS", "deploy complete")
  })

  test("GIVEN test setup WHEN success is called with details THEN expected behavior is observed", async () => {
    const fileSystem = new InMemoryFileSystem()
    const logger = new FileLogger(fileSystem, LOG_PATH)

    await run(logger.success("deployment metadata", { env: "prod", meta: { release: "v1.2.3" } }))

    const lines = readLines(fileSystem)
    expect(lines).toHaveLength(3)
    expectTimestampedLine(lines[0], "SUCCESS", "deployment metadata")
    expect(lines[1]).toBe("  env: prod")
    expect(lines[2]).toBe('  meta: {"release":"v1.2.3"}')
  })

  test("GIVEN test setup WHEN error is called with structured RigError THEN expected behavior is observed", async () => {
    const fileSystem = new InMemoryFileSystem()
    const logger = new FileLogger(fileSystem, LOG_PATH)
    const structured = new FileSystemError("append", "/tmp/rig.log", "Disk full", "Free disk space.")

    await run(logger.error(structured))

    const lines = readLines(fileSystem)
    expect(lines).toHaveLength(4)
    expectTimestampedLine(lines[0], "ERROR", "FileSystemError: Disk full")
    expect(lines[1]).toBe("  hint: Free disk space.")
    expect(lines[2]).toBe("  operation: append")
    expect(lines[3]).toBe("  path: /tmp/rig.log")
  })

  test("GIVEN test setup WHEN table is called with empty rows THEN expected behavior is observed", async () => {
    const fileSystem = new InMemoryFileSystem()
    const logger = new FileLogger(fileSystem, LOG_PATH)

    await run(logger.table([]))

    const lines = readLines(fileSystem)
    expect(lines).toHaveLength(1)
    expectTimestampedLine(lines[0], "TABLE", "[]")
  })

  test("GIVEN test setup WHEN table is called with rows THEN expected behavior is observed", async () => {
    const fileSystem = new InMemoryFileSystem()
    const logger = new FileLogger(fileSystem, LOG_PATH)
    const rows = [
      { service: "web", status: "healthy", port: 5173 },
      { service: "api", status: "healthy", port: 4000 },
    ] satisfies readonly Record<string, unknown>[]

    await run(logger.table(rows))

    const lines = readLines(fileSystem)
    expect(lines).toHaveLength(1)
    expectTimestampedLine(lines[0], "TABLE", JSON.stringify(rows))
  })

  test("GIVEN test setup WHEN multiple log methods are called THEN expected append behavior is observed", async () => {
    const fileSystem = new InMemoryFileSystem()
    const logger = new FileLogger(fileSystem, LOG_PATH)

    await run(
      Effect.gen(function* () {
        yield* logger.info("first")
        yield* logger.warn("second")
        yield* logger.success("third")
      }),
    )

    const lines = readLines(fileSystem)
    expect(lines).toHaveLength(3)
    expectTimestampedLine(lines[0], "INFO", "first")
    expectTimestampedLine(lines[1], "WARN", "second")
    expectTimestampedLine(lines[2], "SUCCESS", "third")
  })

  test("GIVEN FileLoggerLive path WHEN layer is provided with FileSystem THEN expected behavior is observed", async () => {
    const fileSystem = new InMemoryFileSystem()
    const layer = Layer.provide(
      FileLoggerLive(LOG_PATH),
      Layer.succeed(FileSystem, fileSystem),
    )

    await run(
      Effect.gen(function* () {
        const logger = yield* Logger
        yield* logger.info("from layer")
      }).pipe(Effect.provide(layer)),
    )

    const lines = readLines(fileSystem)
    expect(lines).toHaveLength(1)
    expectTimestampedLine(lines[0], "INFO", "from layer")
  })
})
