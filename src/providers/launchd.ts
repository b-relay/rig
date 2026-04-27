import { join } from "node:path"
import { homedir } from "node:os"
import { getuid } from "node:process"
import { copyFile, mkdir, unlink } from "node:fs/promises"
import { Effect, Layer } from "effect-v3"

import { rigLaunchdBackupRoot } from "../core/rig-paths.js"
import {
  ProcessManager,
  type DaemonConfig,
  type DaemonStatus,
  type ProcessManager as ProcessManagerService,
} from "../interfaces/process-manager.js"
import { ProcessError } from "../schema/errors.js"

// ── launchd domain helpers ──────────────────────────────────────────────────

// Returns the launchctl GUI domain target for the current user (e.g. "gui/502").
const guiDomain = (): string => `gui/${getuid!()}`

// Validates a launchd label only contains safe filesystem and identifier characters.
const validateLabel = (label: string): void => {
  if (!/^[a-zA-Z0-9._-]+$/.test(label)) {
    throw new Error(
      `Invalid launchd label "${label}": must contain only alphanumeric, dot, hyphen, or underscore characters.`,
    )
  }
}

// ── Plist XML generation ────────────────────────────────────────────────────

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// Generates launchd plist XML from a DaemonConfig.
export const generatePlist = (config: DaemonConfig): string => {
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `\t<key>Label</key>`,
    `\t<string>${escapeXml(config.label)}</string>`,
    `\t<key>ProgramArguments</key>`,
    `\t<array>`,
    `\t\t<string>${escapeXml(config.command)}</string>`,
  ]

  for (const arg of config.args) {
    lines.push(`\t\t<string>${escapeXml(arg)}</string>`)
  }

  lines.push(`\t</array>`)
  lines.push(`\t<key>WorkingDirectory</key>`)
  lines.push(`\t<string>${escapeXml(config.workdir)}</string>`)

  // Environment variables
  const envKeys = Object.keys(config.envVars)
  if (envKeys.length > 0) {
    lines.push(`\t<key>EnvironmentVariables</key>`)
    lines.push(`\t<dict>`)
    for (const key of envKeys) {
      lines.push(`\t\t<key>${escapeXml(key)}</key>`)
      lines.push(`\t\t<string>${escapeXml(config.envVars[key])}</string>`)
    }
    lines.push(`\t</dict>`)
  }

  lines.push(`\t<key>KeepAlive</key>`)
  lines.push(`\t<${config.keepAlive}/>`)

  // Logging — stdout and stderr to the same log file
  lines.push(`\t<key>StandardOutPath</key>`)
  lines.push(`\t<string>${escapeXml(config.logPath)}</string>`)
  lines.push(`\t<key>StandardErrorPath</key>`)
  lines.push(`\t<string>${escapeXml(config.logPath)}</string>`)

  lines.push(`</dict>`)
  lines.push(`</plist>`)

  return lines.join("\n") + "\n"
}

// ── Helper types ────────────────────────────────────────────────────────────

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

type CommandRunner = (args: readonly string[]) => Promise<CommandResult>

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

// ── Default command runner using Bun.spawn ──────────────────────────────────

const defaultRunner: CommandRunner = async (args) => {
  const child = Bun.spawn([...args], {
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  return { stdout, stderr, exitCode }
}

// ── Plist path derivation ───────────────────────────────────────────────────

// Derives the launchd plist file path for a service label.
export const plistPath = (label: string, home?: string): string =>
  join(home ?? homedir(), "Library", "LaunchAgents", `com.b-relay.rig.${label}.plist`)

// ── LaunchdManager implementation ───────────────────────────────────────────

export class LaunchdManager implements ProcessManagerService {
  private readonly runCommand: CommandRunner
  private readonly home: string

  constructor(opts?: { runCommand?: CommandRunner; home?: string }) {
    this.runCommand = opts?.runCommand ?? defaultRunner
    this.home = opts?.home ?? homedir()
  }

  install(config: DaemonConfig): Effect.Effect<void, ProcessError> {
    return Effect.tryPromise({
      try: async () => {
        validateLabel(config.label)
        const path = plistPath(config.label, this.home)
        const dir = join(this.home, "Library", "LaunchAgents")
        await mkdir(dir, { recursive: true })

        const xml = generatePlist(config)
        await Bun.write(path, xml)

        // Bootout first in case it's already loaded (DESIGN.md: unload old, load new)
        // Ignore errors — may not be loaded yet
        const domain = guiDomain()
        await this.runCommand(["launchctl", "bootout", `${domain}/${config.label}`])

        // Bootstrap the plist into the GUI domain
        const result = await this.runCommand(["launchctl", "bootstrap", domain, path])
        if (result.exitCode !== 0) {
          throw new Error(`launchctl bootstrap failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
        }
      },
      catch: (cause) =>
        new ProcessError(
          "install",
          config.label,
          `Failed to install launchd plist for ${config.label}: ${causeMessage(cause)}`,
          `Check that ~/Library/LaunchAgents is writable and the plist is valid.`,
        ),
    })
  }

  uninstall(label: string): Effect.Effect<void, ProcessError> {
    return Effect.tryPromise({
      try: async () => {
        validateLabel(label)

        // Bootout the service from the GUI domain
        const bootoutResult = await this.runCommand([
          "launchctl",
          "bootout",
          `${guiDomain()}/${label}`,
        ])
        if (bootoutResult.exitCode !== 0) {
          const stderr = bootoutResult.stderr.toLowerCase()
          const isNotLoaded =
            stderr.includes("no such process") ||
            stderr.includes("could not find service") ||
            stderr.includes("not loaded") ||
            bootoutResult.exitCode === 3
          if (!isNotLoaded) {
            throw new Error(
              `launchctl bootout failed (exit ${bootoutResult.exitCode}): ${bootoutResult.stderr.trim()}`,
            )
          }
        }

        // Delete the plist file (idempotent — ignore if already gone)
        const path = plistPath(label, this.home)
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        })
      },
      catch: (cause) =>
        new ProcessError(
          "uninstall",
          label,
          `Failed to uninstall launchd plist for ${label}: ${causeMessage(cause)}`,
          `Ensure the plist exists at ${plistPath(label, this.home)} and is not locked.`,
        ),
    })
  }

  start(label: string): Effect.Effect<void, ProcessError> {
    return Effect.tryPromise({
      try: async () => {
        const result = await this.runCommand(["launchctl", "start", label])
        if (result.exitCode !== 0) {
          throw new Error(`launchctl start failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
        }
      },
      catch: (cause) =>
        new ProcessError(
          "spawn",
          label,
          `Failed to start ${label}: ${causeMessage(cause)}`,
          `Ensure the service is loaded first with 'rig deploy'.`,
        ),
    })
  }

  stop(label: string): Effect.Effect<void, ProcessError> {
    return Effect.tryPromise({
      try: async () => {
        const result = await this.runCommand(["launchctl", "stop", label])
        if (result.exitCode !== 0) {
          throw new Error(`launchctl stop failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
        }
      },
      catch: (cause) =>
        new ProcessError(
          "kill",
          label,
          `Failed to stop ${label}: ${causeMessage(cause)}`,
          `Check if the service is currently running with 'rig status'.`,
        ),
    })
  }

  status(label: string): Effect.Effect<DaemonStatus, ProcessError> {
    return Effect.tryPromise({
      try: async () => {
        // launchctl list <label> exits 0 if loaded, non-zero if not
        const result = await this.runCommand(["launchctl", "list", label])

        if (result.exitCode !== 0) {
          return { label, loaded: false, running: false, pid: null }
        }

        // Parse output — launchctl list <label> outputs key-value pairs:
        //   "PID" = <number>;
        //   or just a tabular line: <pid>\t<status>\t<label>
        // We try both formats.
        const pidMatch =
          result.stdout.match(/"PID"\s*=\s*(\d+)/) ??
          result.stdout.match(/^(\d+)\t/)

        const pid = pidMatch ? Number.parseInt(pidMatch[1], 10) : null
        const running = pid !== null

        return { label, loaded: true, running, pid }
      },
      catch: (cause) =>
        new ProcessError(
          "status",
          label,
          `Failed to get status for ${label}: ${causeMessage(cause)}`,
          `Try running 'launchctl list ${label}' manually to check.`,
        ),
    })
  }

  backup(label: string): Effect.Effect<string, ProcessError> {
    return Effect.tryPromise({
      try: async () => {
        const src = plistPath(label, this.home)
        const backupDir = rigLaunchdBackupRoot()
        await mkdir(backupDir, { recursive: true })

        const ts = new Date().toISOString().replace(/[:.]/g, "-")
        const dest = join(backupDir, `${label}-backup-${ts}.plist`)
        await copyFile(src, dest)
        return dest
      },
      catch: (cause) =>
        new ProcessError(
          "install", // backup is a variant of install/maintenance
          label,
          `Failed to backup plist for ${label}: ${causeMessage(cause)}`,
          `Ensure the plist exists at ${plistPath(label, this.home)}.`,
        ),
    })
  }
}

export const LaunchdManagerLive = Layer.succeed(ProcessManager, new LaunchdManager())
