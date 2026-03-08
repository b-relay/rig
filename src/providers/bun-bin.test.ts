import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { FileSystem } from "../interfaces/file-system.js"
import { BinInstaller } from "../interfaces/bin-installer.js"
import { BunBinInstaller, BunBinInstallerLive, type CommandRunner } from "./bun-bin.js"
import { BinInstallerError, FileSystemError } from "../schema/errors.js"
import type { FileSystem as FileSystemService } from "../interfaces/file-system.js"
import type { BinService } from "../schema/config.js"

// ── Mock FileSystem ──────────────────────────────────────────────────────────

class MockFileSystem implements FileSystemService {
  readonly files = new Map<string, string>()
  readonly dirs = new Set<string>()
  readonly modes = new Map<string, number>()

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

  symlink(_target: string, _link: string) {
    return Effect.void
  }

  exists(path: string) {
    return Effect.succeed(this.files.has(path) || this.dirs.has(path))
  }

  remove(path: string) {
    return Effect.sync(() => {
      this.files.delete(path)
      this.modes.delete(path)
    })
  }

  mkdir(path: string) {
    return Effect.sync(() => {
      this.dirs.add(path)
    })
  }

  list(path: string) {
    return Effect.succeed(
      [...this.files.keys()].filter((f) => f.startsWith(path + "/")).map((f) => f.slice(path.length + 1)) as readonly string[],
    )
  }

  chmod(path: string, mode: number) {
    return Effect.sync(() => {
      this.modes.set(path, mode)
    })
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Simulated binary content — contains null bytes (like any real Mach-O/ELF) */
const binaryContent = (): string => "BINARY\0\0\0EXECUTABLE\0"

const shimConfig = (overrides?: Partial<BinService>): BinService => ({
  name: "pantry",
  type: "bin" as const,
  entrypoint: "cli/index.ts",
  ...overrides,
})

/** Mock command runner that always succeeds */
const successRunner: CommandRunner = async () => ({ stdout: "ok", stderr: "", exitCode: 0 })

/** Mock command runner that always fails */
const failRunner: CommandRunner = async () => ({ stdout: "", stderr: "build failed", exitCode: 1 })

const runWithMock = <A, E>(
  mockFs: MockFileSystem,
  effect: Effect.Effect<A, E, FileSystem>,
): Promise<A> => {
  const layer = Layer.succeed(FileSystem, mockFs)
  return Effect.runPromise(Effect.provide(effect, layer))
}

const runWithMockFail = <A, E>(
  mockFs: MockFileSystem,
  effect: Effect.Effect<A, E, FileSystem>,
): Promise<E> => {
  const layer = Layer.succeed(FileSystem, mockFs)
  return Effect.runPromise(Effect.flip(Effect.provide(effect, layer)))
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GIVEN suite context WHEN BunBinInstaller THEN behavior is covered", () => {
  describe("GIVEN suite context WHEN build() THEN behavior is covered", () => {
    test("GIVEN test setup WHEN with build command — produces binary → returns path THEN expected behavior is observed", async () => {
      const mockFs = new MockFileSystem()
      const installer = new BunBinInstaller(mockFs, successRunner)
      const config = shimConfig({
        build: "bun build --compile cli/index.ts --outfile dist/pantry",
        entrypoint: "dist/pantry",
      })
      const workdir = "/tmp/test-project"

      // Pre-populate the built file with Mach-O magic
      mockFs.files.set(`${workdir}/dist/pantry`, binaryContent())

      const result = await runWithMock(mockFs, installer.build(config, workdir))
      expect(result).toBe(`${workdir}/dist/pantry`)
    })

    test("GIVEN test setup WHEN with build command — produces non-binary → errors THEN expected behavior is observed", async () => {
      const mockFs = new MockFileSystem()
      const installer = new BunBinInstaller(mockFs, successRunner)
      const config = shimConfig({
        build: "bun build --compile cli/index.ts --outfile dist/pantry",
        entrypoint: "dist/pantry",
      })
      const workdir = "/tmp/test-project"

      // Pre-populate with text (not a binary)
      mockFs.files.set(`${workdir}/dist/pantry`, "#!/usr/bin/env node\nconsole.log('hi')")

      const err = await runWithMockFail(mockFs, installer.build(config, workdir))
      expect(err).toBeInstanceOf(BinInstallerError)
      expect((err as BinInstallerError).message).toContain("build produced a non-binary file")
    })

    test("GIVEN test setup WHEN with build command — entrypoint missing after build → errors THEN expected behavior is observed", async () => {
      const mockFs = new MockFileSystem()
      const installer = new BunBinInstaller(mockFs, successRunner)
      const config = shimConfig({
        build: "bun build --compile cli/index.ts --outfile dist/pantry",
        entrypoint: "dist/pantry",
      })
      const workdir = "/tmp/test-project"
      // Don't create the file

      const err = await runWithMockFail(mockFs, installer.build(config, workdir))
      expect(err).toBeInstanceOf(BinInstallerError)
      expect((err as BinInstallerError).message).toContain("not found")
    })

    test("GIVEN test setup WHEN with build command — entrypoint resolves outside workspace THEN build fails with security error", async () => {
      const mockFs = new MockFileSystem()
      const installer = new BunBinInstaller(mockFs, successRunner)
      const config = shimConfig({
        build: "bun build --compile cli/index.ts --outfile ../outside/pantry",
        entrypoint: "../outside/pantry",
      })
      const workdir = "/tmp/test-project"

      const err = await runWithMockFail(mockFs, installer.build(config, workdir))
      expect(err).toBeInstanceOf(BinInstallerError)
      expect((err as BinInstallerError).message).toContain("outside workspace")
    })

    test("GIVEN test setup WHEN with build command — build fails → errors THEN expected behavior is observed", async () => {
      const mockFs = new MockFileSystem()
      const installer = new BunBinInstaller(mockFs, failRunner)
      const config = shimConfig({
        build: "bun build --compile cli/index.ts --outfile dist/pantry",
        entrypoint: "dist/pantry",
      })
      const workdir = "/tmp/test-project"

      const err = await runWithMockFail(mockFs, installer.build(config, workdir))
      expect(err).toBeInstanceOf(BinInstallerError)
      expect((err as BinInstallerError).operation).toBe("build")
    })

    test("GIVEN test setup WHEN no build — command string (has spaces) → returns cmd marker THEN expected behavior is observed", async () => {
      const mockFs = new MockFileSystem()
      const installer = new BunBinInstaller(mockFs)
      const config = shimConfig({ entrypoint: "bun cli/index.ts" })
      const workdir = "/tmp/test-project"

      const result = await runWithMock(mockFs, installer.build(config, workdir))
      expect(result).toStartWith("cmd:")
      expect(result).toContain(workdir)
      expect(result).toContain("bun cli/index.ts")
    })

    test("GIVEN test setup WHEN no build — file exists and is binary → returns path THEN expected behavior is observed", async () => {
      const mockFs = new MockFileSystem()
      const installer = new BunBinInstaller(mockFs)
      const config = shimConfig({ entrypoint: "dist/pantry" })
      const workdir = "/tmp/test-project"

      mockFs.files.set(`${workdir}/dist/pantry`, binaryContent())

      const result = await runWithMock(mockFs, installer.build(config, workdir))
      expect(result).toBe(`${workdir}/dist/pantry`)
    })

    test("GIVEN test setup WHEN no build — file exists and is script → returns shim marker THEN expected behavior is observed", async () => {
      const mockFs = new MockFileSystem()
      const installer = new BunBinInstaller(mockFs)
      const config = shimConfig({ entrypoint: "cli/index.ts" })
      const workdir = "/tmp/test-project"

      mockFs.files.set(`${workdir}/cli/index.ts`, "#!/usr/bin/env bun\nconsole.log('hi')")

      const result = await runWithMock(mockFs, installer.build(config, workdir))
      expect(result).toStartWith("shim:")
      expect(result).toContain(workdir)
      expect(result).toContain("cli/index.ts")
    })

    test("GIVEN test setup WHEN no build — file does not exist → errors THEN expected behavior is observed", async () => {
      const mockFs = new MockFileSystem()
      const installer = new BunBinInstaller(mockFs)
      const config = shimConfig({ entrypoint: "missing/binary" })
      const workdir = "/tmp/test-project"

      const err = await runWithMockFail(mockFs, installer.build(config, workdir))
      expect(err).toBeInstanceOf(BinInstallerError)
      expect((err as BinInstallerError).message).toContain("not found")
    })

    test("GIVEN test setup WHEN no build — entrypoint resolves outside workspace THEN build fails with security error", async () => {
      const mockFs = new MockFileSystem()
      const installer = new BunBinInstaller(mockFs)
      const config = shimConfig({ entrypoint: "../outside/script.sh" })
      const workdir = "/tmp/test-project"
      mockFs.files.set("/tmp/outside/script.sh", "#!/bin/sh\necho test")

      const err = await runWithMockFail(mockFs, installer.build(config, workdir))
      expect(err).toBeInstanceOf(BinInstallerError)
      expect((err as BinInstallerError).message).toContain("outside workspace")
    })
  })

  describe("GIVEN suite context WHEN install() THEN behavior is covered", () => {
    test("GIVEN test setup WHEN binary file → copies to ~/.local/bin/<name> THEN expected behavior is observed", async () => {
      const mockFs = new MockFileSystem()
      const installer = new BunBinInstaller(mockFs)
      const binContent = binaryContent()
      const srcPath = "/tmp/test-project/dist/pantry"
      mockFs.files.set(srcPath, binContent)

      const result = await runWithMock(mockFs, installer.install("pantry", "prod", srcPath))
      expect(result).toContain(".local/bin/pantry")
      expect(result).not.toContain("-dev")
      // File was copied
      expect(mockFs.files.has(result)).toBe(true)
      // Made executable
      expect(mockFs.modes.get(result)).toBe(0o755)
    })

    test("GIVEN test setup WHEN dev env → installs with -dev suffix THEN expected behavior is observed", async () => {
      const mockFs = new MockFileSystem()
      const installer = new BunBinInstaller(mockFs)
      const srcPath = "/tmp/test-project/dist/pantry"
      mockFs.files.set(srcPath, binaryContent())

      const result = await runWithMock(mockFs, installer.install("pantry", "dev", srcPath))
      expect(result).toContain("pantry-dev")
    })

    test("GIVEN test setup WHEN cmd marker → creates command shim THEN expected behavior is observed", async () => {
      const mockFs = new MockFileSystem()
      const installer = new BunBinInstaller(mockFs)
      const marker = "cmd:/tmp/test-project:bun cli/index.ts"

      const result = await runWithMock(mockFs, installer.install("pantry", "prod", marker))
      expect(result).toContain(".local/bin/pantry")

      const shimContent = mockFs.files.get(result)
      expect(shimContent).toBeDefined()
      expect(shimContent!).toContain("#!/bin/sh")
      expect(shimContent!).toContain("cd")
      expect(shimContent!).toContain("/tmp/test-project")
      expect(shimContent!).toContain("exec bun cli/index.ts")
      expect(shimContent!).toContain('"$@"')
      expect(mockFs.modes.get(result)).toBe(0o755)
    })

    test("GIVEN test setup WHEN shim marker → creates script shim THEN expected behavior is observed", async () => {
      const mockFs = new MockFileSystem()
      const installer = new BunBinInstaller(mockFs)
      const marker = "shim:/tmp/test-project:cli/index.ts"

      const result = await runWithMock(mockFs, installer.install("pantry", "prod", marker))
      expect(result).toContain(".local/bin/pantry")

      const shimContent = mockFs.files.get(result)
      expect(shimContent).toBeDefined()
      expect(shimContent!).toContain("#!/bin/sh")
      expect(shimContent!).toContain("./cli/index.ts")
      expect(mockFs.modes.get(result)).toBe(0o755)
    })

    test("GIVEN test setup WHEN creates bin directory if missing THEN expected behavior is observed", async () => {
      const mockFs = new MockFileSystem()
      const installer = new BunBinInstaller(mockFs)
      const srcPath = "/tmp/test-project/dist/pantry"
      mockFs.files.set(srcPath, binaryContent())

      await runWithMock(mockFs, installer.install("pantry", "prod", srcPath))
      // bin dir was created
      const hasBinDir = [...mockFs.dirs].some((d) => d.includes(".local/bin"))
      expect(hasBinDir).toBe(true)
    })
  })

  describe("GIVEN suite context WHEN uninstall() THEN behavior is covered", () => {
    test("GIVEN test setup WHEN removes bin from ~/.local/bin/<name> THEN expected behavior is observed", async () => {
      const mockFs = new MockFileSystem()
      const installer = new BunBinInstaller(mockFs)
      const binPath = [...mockFs.files.keys()].find((k) => k.includes(".local/bin")) ?? ""

      // Pre-install a bin
      const srcPath = "/tmp/test-project/dist/pantry"
      mockFs.files.set(srcPath, binaryContent())
      const installed = await runWithMock(mockFs, installer.install("pantry", "prod", srcPath))
      expect(mockFs.files.has(installed)).toBe(true)

      // Uninstall
      await runWithMock(mockFs, installer.uninstall("pantry", "prod"))
      expect(mockFs.files.has(installed)).toBe(false)
    })

    test("GIVEN test setup WHEN dev env → removes <name>-dev THEN expected behavior is observed", async () => {
      const mockFs = new MockFileSystem()
      const installer = new BunBinInstaller(mockFs)
      const srcPath = "/tmp/test-project/dist/pantry"
      mockFs.files.set(srcPath, binaryContent())

      const installed = await runWithMock(mockFs, installer.install("pantry", "dev", srcPath))
      expect(installed).toContain("pantry-dev")
      expect(mockFs.files.has(installed)).toBe(true)

      await runWithMock(mockFs, installer.uninstall("pantry", "dev"))
      expect(mockFs.files.has(installed)).toBe(false)
    })
  })

  describe("GIVEN suite context WHEN BunBinInstallerLive layer THEN behavior is covered", () => {
    test("GIVEN test setup WHEN provides BinInstaller from FileSystem THEN expected behavior is observed", async () => {
      const mockFs = new MockFileSystem()
      const fsLayer = Layer.succeed(FileSystem, mockFs)
      const layer = Layer.provide(BunBinInstallerLive, fsLayer)

      // Use the layer to run a simple build
      mockFs.files.set("/project/cli/index.ts", "#!/usr/bin/env bun\nconsole.log('hi')")

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const installer = yield* BinInstaller
          return yield* installer.build(
            { name: "test", type: "bin" as const, entrypoint: "cli/index.ts" },
            "/project",
          )
        }).pipe(Effect.provide(layer)),
      )

      expect(result).toStartWith("shim:")
    })
  })
})
