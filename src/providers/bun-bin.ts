import { homedir } from "node:os"
import { join, resolve, isAbsolute, relative } from "node:path"
import { Effect, Layer } from "effect"

import { BinInstaller, type BinInstaller as BinInstallerService } from "../interfaces/bin-installer.js"
import { FileSystem } from "../interfaces/file-system.js"
import type { BinService } from "../schema/config.js"
import { BinInstallerError } from "../schema/errors.js"

// ── Constants ────────────────────────────────────────────────────────────────

const BIN_DIR = () => join(homedir(), ".local", "bin")

/** Marker prefixes for non-binary install strategies */
const CMD_PREFIX = "cmd:"
const SHIM_PREFIX = "shim:"

// ── Helpers ──────────────────────────────────────────────────────────────────

const binName = (name: string, env: string): string =>
  env === "dev" ? `${name}-dev` : name

const binPath = (name: string, env: string): string =>
  join(BIN_DIR(), binName(name, env))

// Detects whether file content should be treated as a native binary.
const isBinaryContent = (content: string): boolean => {
  const sample = content.slice(0, 8192)
  return sample.includes("\0")
}

/**
 * Resolve entrypoint to an absolute path relative to workdir.
 */
const resolveEntrypoint = (entrypoint: string, workdir: string): string =>
  isAbsolute(entrypoint) ? entrypoint : resolve(workdir, entrypoint)

const isWithinWorkspace = (entryPath: string, workdir: string): boolean => {
  const resolvedWorkdir = resolve(workdir)
  const resolvedEntrypoint = resolve(entryPath)
  const rel = relative(resolvedWorkdir, resolvedEntrypoint)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

// ── Command Runner ───────────────────────────────────────────────────────────

export type CommandRunner = (
  command: string,
  workdir: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>

const defaultCommandRunner: CommandRunner = async (command, workdir) => {
  const proc = Bun.spawn(["/bin/sh", "-c", command], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  return { stdout, stderr, exitCode }
}

// ── Marker encoding/decoding ─────────────────────────────────────────────────

const encodeCmd = (workdir: string, command: string): string =>
  `${CMD_PREFIX}${workdir}:${command}`

const encodeShim = (workdir: string, entrypoint: string): string =>
  `${SHIM_PREFIX}${workdir}:${entrypoint}`

const decodeMarker = (
  marker: string,
): { type: "cmd"; workdir: string; value: string } | { type: "shim"; workdir: string; value: string } | null => {
  if (marker.startsWith(CMD_PREFIX)) {
    const rest = marker.slice(CMD_PREFIX.length)
    const colonIdx = rest.indexOf(":")
    if (colonIdx === -1) return null
    return { type: "cmd", workdir: rest.slice(0, colonIdx), value: rest.slice(colonIdx + 1) }
  }
  if (marker.startsWith(SHIM_PREFIX)) {
    const rest = marker.slice(SHIM_PREFIX.length)
    const colonIdx = rest.indexOf(":")
    if (colonIdx === -1) return null
    return { type: "shim", workdir: rest.slice(0, colonIdx), value: rest.slice(colonIdx + 1) }
  }
  return null
}

// ── Shim generation ──────────────────────────────────────────────────────────

const commandShim = (workdir: string, command: string): string =>
  `#!/bin/sh\ncd ${JSON.stringify(workdir)} && exec ${command} "$@"\n`

const scriptShim = (workdir: string, entrypoint: string): string =>
  `#!/bin/sh\ncd ${JSON.stringify(workdir)} && exec ./${entrypoint} "$@"\n`

// ── Provider ─────────────────────────────────────────────────────────────────

export class BunBinInstaller implements BinInstallerService {
  private readonly runCommand: CommandRunner

  constructor(
    private readonly fs: FileSystem,
    commandRunner?: CommandRunner,
  ) {
    this.runCommand = commandRunner ?? defaultCommandRunner
  }

  build(config: BinService, workdir: string): Effect.Effect<string, BinInstallerError> {
    const fs = this.fs
    const name = config.name

    if (config.build) {
      // Has build command: run it, then verify entrypoint is a native binary
      const entryPath = resolveEntrypoint(config.entrypoint, workdir)
      const buildCmd = config.build
      const runCmd = this.runCommand

      return Effect.gen(function* () {
        if (!isWithinWorkspace(entryPath, workdir)) {
          return yield* Effect.fail(
            new BinInstallerError(
              "build",
              name,
              `Entrypoint "${config.entrypoint}" resolves outside workspace "${workdir}".`,
              "Use an entrypoint path inside the workspace directory.",
            ),
          )
        }

        // Run the build command
        yield* Effect.tryPromise({
          try: async () => {
            const result = await runCmd(buildCmd, workdir)
            if (result.exitCode !== 0) {
              throw new Error(
                `Build command exited with code ${result.exitCode}.\nstderr: ${result.stderr.trim()}\nstdout: ${result.stdout.trim()}`
              )
            }
            return result.stdout
          },
          catch: (cause) =>
            new BinInstallerError(
              "build",
              name,
              cause instanceof Error ? cause.message : String(cause),
              `Check that the build command "${buildCmd}" is valid and all dependencies are installed.`,
            ),
        })

        // Verify the built file exists
        const exists = yield* fs.exists(entryPath).pipe(
          Effect.mapError(
            (e) => new BinInstallerError("build", name, e.message, `Could not check built file at ${entryPath}.`),
          ),
        )
        if (!exists) {
          return yield* Effect.fail(
            new BinInstallerError(
              "build",
              name,
              `Build command succeeded but entrypoint "${config.entrypoint}" was not found at ${entryPath}.`,
              `Verify the build command outputs to the expected path.`,
            ),
          )
        }

        // Check if it's actually a binary
        const content = yield* fs.read(entryPath).pipe(
          Effect.mapError(
            (e) => new BinInstallerError("build", name, e.message, `Could not read built file at ${entryPath}.`),
          ),
        )
        if (!isBinaryContent(content)) {
          return yield* Effect.fail(
            new BinInstallerError(
              "build",
              name,
              `build produced a non-binary file at ${config.entrypoint}. Remove the build key and use hooks if you need a pre-step.`,
              `The entrypoint must be a compiled binary (Mach-O or ELF) when using a build command.`,
            ),
          )
        }

        return entryPath
      })
    }

    // No build command — resolve entrypoint
    const entrypoint = config.entrypoint

    // Command string (contains spaces) → return marker for shim creation
    if (entrypoint.includes(" ")) {
      return Effect.succeed(encodeCmd(workdir, entrypoint))
    }

    // File path — check existence and type
    const entryPath = resolveEntrypoint(entrypoint, workdir)
    return Effect.gen(function* () {
      if (!isWithinWorkspace(entryPath, workdir)) {
        return yield* Effect.fail(
          new BinInstallerError(
            "build",
            name,
            `Entrypoint "${config.entrypoint}" resolves outside workspace "${workdir}".`,
            "Use an entrypoint path inside the workspace directory.",
          ),
        )
      }

      const exists = yield* fs.exists(entryPath).pipe(
        Effect.mapError(
          (e) => new BinInstallerError("build", name, e.message, `Could not check entrypoint at ${entryPath}.`),
        ),
      )
      if (!exists) {
        return yield* Effect.fail(
          new BinInstallerError(
            "build",
            name,
            `Entrypoint ${config.entrypoint} not found. Need to compile first? Add a build key.`,
            `Verify the entrypoint path is correct relative to the workspace.`,
          ),
        )
      }

      const content = yield* fs.read(entryPath).pipe(
        Effect.mapError(
          (e) => new BinInstallerError("build", name, e.message, `Could not read entrypoint at ${entryPath}.`),
        ),
      )

      if (isBinaryContent(content)) {
        // Native binary → return path for direct copy
        return entryPath
      }

      // Script or text file → return shim marker
      return encodeShim(workdir, entrypoint)
    })
  }

  install(name: string, env: string, binaryPath: string): Effect.Effect<string, BinInstallerError> {
    const fs = this.fs
    const dest = binPath(name, env)

    return Effect.gen(function* () {
      // Ensure bin directory exists
      yield* fs.mkdir(BIN_DIR()).pipe(
        Effect.mapError(
          (e) => new BinInstallerError("install", name, e.message, `Could not create bin directory at ${BIN_DIR()}.`),
        ),
      )

      const marker = decodeMarker(binaryPath)
      if (marker) {
        // Create a shim script
        const shimContent =
          marker.type === "cmd"
            ? commandShim(marker.workdir, marker.value)
            : scriptShim(marker.workdir, marker.value)

        yield* fs.write(dest, shimContent).pipe(
          Effect.mapError(
            (e) => new BinInstallerError("install", name, e.message, `Could not write shim to ${dest}.`),
          ),
        )
      } else {
        // Real binary file → copy
        yield* fs.copy(binaryPath, dest).pipe(
          Effect.mapError(
            (e) =>
              new BinInstallerError(
                "install",
                name,
                e.message,
                `Could not copy binary from ${binaryPath} to ${dest}.`,
              ),
          ),
        )
      }

      // Make executable
      yield* fs.chmod(dest, 0o755).pipe(
        Effect.mapError(
          (e) => new BinInstallerError("install", name, e.message, `Could not make ${dest} executable.`),
        ),
      )

      return dest
    })
  }

  uninstall(name: string, env: string): Effect.Effect<void, BinInstallerError> {
    const fs = this.fs
    const dest = binPath(name, env)

    return fs.remove(dest).pipe(
      Effect.mapError(
        (e) =>
          new BinInstallerError(
            "uninstall",
            name,
            e.message,
            `Could not remove ${dest}. It may already be gone.`,
          ),
      ),
    )
  }
}

// ── Layer ────────────────────────────────────────────────────────────────────

export const BunBinInstallerLive = Layer.effect(
  BinInstaller,
  Effect.gen(function* () {
    const fs = yield* FileSystem
    return new BunBinInstaller(fs)
  }),
)
