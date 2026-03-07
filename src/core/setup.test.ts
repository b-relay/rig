import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { runSetupCommand } from "./setup.js"
import { BinInstaller } from "../interfaces/bin-installer.js"
import { FileSystem, type FileSystem as FileSystemService } from "../interfaces/file-system.js"
import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
import {
  Registry,
  type Registry as RegistryService,
  type RegistryEntry,
} from "../interfaces/registry.js"
import { StubBinInstaller } from "../providers/stub-bin-installer.js"
import { FileSystemError, RegistryError, type RigError } from "../schema/errors.js"

const rigBinPath = () => join(homedir(), ".rig", "bin")

const rigConfig = () =>
  `${JSON.stringify(
    {
      name: "rig",
      version: "0.1.0",
      environments: {
        prod: {
          services: [
            {
              name: "rig",
              type: "bin",
              entrypoint: "rig",
              build: "bun build --compile src/index.ts --outfile rig",
            },
          ],
        },
      },
    },
    null,
    2,
  )}\n`

class CaptureLogger implements LoggerService {
  readonly infos: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []
  readonly warnings: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []
  readonly errors: RigError[] = []
  readonly successes: Array<{ readonly message: string; readonly details?: Record<string, unknown> }> = []

  info(message: string, details?: Record<string, unknown>) {
    this.infos.push({ message, details })
    return Effect.void
  }

  warn(message: string, details?: Record<string, unknown>) {
    this.warnings.push({ message, details })
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

class StubRegistry implements RegistryService {
  readonly registerCalls: Array<{ readonly name: string; readonly repoPath: string }> = []
  private readonly entries = new Map<string, RegistryEntry>()

  register(name: string, repoPath: string) {
    this.registerCalls.push({ name, repoPath })
    this.entries.set(name, {
      name,
      repoPath,
      registeredAt: new Date(),
    })
    return Effect.void
  }

  unregister(name: string) {
    this.entries.delete(name)
    return Effect.void
  }

  resolve(name: string) {
    const entry = this.entries.get(name)
    if (!entry) {
      return Effect.fail(
        new RegistryError("resolve", name, `Project '${name}' not found`, "Run rig setup first."),
      )
    }
    return Effect.succeed(entry.repoPath)
  }

  list() {
    return Effect.succeed(
      [...this.entries.values()].sort((left, right) => left.name.localeCompare(right.name)),
    )
  }
}

class StubFileSystem implements FileSystemService {
  private readonly files = new Map<string, string>()

  constructor(seed: Record<string, string>) {
    for (const [path, content] of Object.entries(seed)) {
      this.files.set(path, content)
    }
  }

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

  symlink(_target: string, _link: string) {
    return Effect.void
  }

  exists(path: string) {
    return Effect.succeed(this.files.has(path))
  }

  remove(path: string) {
    this.files.delete(path)
    return Effect.void
  }

  mkdir(_path: string) {
    return Effect.void
  }

  list(_path: string) {
    return Effect.succeed([])
  }

  chmod(_path: string, _mode: number) {
    return Effect.void
  }
}

const withPath = async <T>(pathValue: string, run: () => Promise<T>): Promise<T> => {
  const previousPath = process.env.PATH
  process.env.PATH = pathValue
  try {
    return await run()
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = previousPath
    }
  }
}

const runWithLayer = async (
  logger: CaptureLogger,
  registry: StubRegistry,
  fileSystem: StubFileSystem,
  binInstaller: StubBinInstaller,
) =>
  Effect.runPromise(
    runSetupCommand().pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Logger, logger),
          Layer.succeed(Registry, registry),
          Layer.succeed(FileSystem, fileSystem),
          Layer.succeed(BinInstaller, binInstaller),
        ),
      ),
    ),
  )

describe("GIVEN suite context WHEN setup command executes THEN behavior is covered", () => {
  test("GIVEN valid rig.json and PATH configured WHEN setup runs THEN binary is built and installed successfully", async () => {
    const logger = new CaptureLogger()
    const registry = new StubRegistry()
    const binInstaller = new StubBinInstaller()
    const repoPath = resolve(process.cwd())
    const fileSystem = new StubFileSystem({
      [join(repoPath, "rig.json")]: rigConfig(),
    })

    const exitCode = await withPath(`${rigBinPath()}:/usr/bin`, () =>
      runWithLayer(logger, registry, fileSystem, binInstaller),
    )

    expect(exitCode).toBe(0)
    expect(binInstaller.buildCalls).toEqual([
      {
        service: "rig",
        workdir: repoPath,
        entrypoint: "rig",
      },
    ])
    expect(binInstaller.installCalls).toEqual([
      {
        name: "rig",
        env: "prod",
        binaryPath: join(repoPath, "rig"),
      },
    ])
    expect(logger.warnings).toHaveLength(0)
    expect(logger.successes.at(-1)?.message).toBe("Rig setup complete.")
  })

  test("GIVEN valid setup with missing PATH entry WHEN setup runs THEN PATH instructions are printed", async () => {
    const logger = new CaptureLogger()
    const registry = new StubRegistry()
    const binInstaller = new StubBinInstaller()
    const repoPath = resolve(process.cwd())
    const fileSystem = new StubFileSystem({
      [join(repoPath, "rig.json")]: rigConfig(),
    })

    const exitCode = await withPath("/usr/bin:/bin", () =>
      runWithLayer(logger, registry, fileSystem, binInstaller),
    )

    expect(exitCode).toBe(0)
    expect(logger.warnings.some((entry) => entry.message === "~/.rig/bin is not on PATH.")).toBe(true)
    const pathHint = logger.infos.find((entry) => entry.message === "Add rig binaries to PATH and restart your shell.")
    expect(pathHint?.details?.exportCommand).toBe('export PATH="$HOME/.rig/bin:$PATH"')
  })

  test("GIVEN valid setup WHEN setup runs THEN registry registers rig at current repo path", async () => {
    const logger = new CaptureLogger()
    const registry = new StubRegistry()
    const binInstaller = new StubBinInstaller()
    const repoPath = resolve(process.cwd())
    const fileSystem = new StubFileSystem({
      [join(repoPath, "rig.json")]: rigConfig(),
    })

    const exitCode = await withPath(`${rigBinPath()}:/usr/bin`, () =>
      runWithLayer(logger, registry, fileSystem, binInstaller),
    )

    expect(exitCode).toBe(0)
    expect(registry.registerCalls).toEqual([
      {
        name: "rig",
        repoPath,
      },
    ])
    const registeredPath = await Effect.runPromise(registry.resolve("rig"))
    expect(registeredPath).toBe(repoPath)
  })
})
