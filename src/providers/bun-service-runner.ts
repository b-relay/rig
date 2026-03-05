import { join } from "node:path"
import { Effect, Layer } from "effect"

import { FileSystem, type FileSystem as FileSystemService } from "../interfaces/file-system.js"
import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
import {
  ServiceRunner,
  type HealthStatus,
  type LogOpts,
  type RunOpts,
  type RunningService,
  type ServiceRunner as ServiceRunnerService,
} from "../interfaces/service-runner.js"
import type { ServerService } from "../schema/config.js"
import { ServiceRunnerError } from "../schema/errors.js"

// ── Types ───────────────────────────────────────────────────────────────────

type PidEntry = {
  readonly pid: number
  readonly port: number
  readonly startedAt: string
}

type PidMap = Record<string, PidEntry>

// ── Constants ───────────────────────────────────────────────────────────────

const STOP_TIMEOUT_MS = 5_000
const STOP_POLL_INTERVAL_MS = 100

// ── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const toError = (
  operation: ServiceRunnerError["operation"],
  service: string,
  message: string,
  hint: string,
): ServiceRunnerError => new ServiceRunnerError(operation, service, message, hint)

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitForExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true
    }

    await sleep(STOP_POLL_INTERVAL_MS)
  }

  return !isProcessAlive(pid)
}

const mergeEnv = (envVars: Readonly<Record<string, string>>): Record<string, string> => {
  const base: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      base[key] = value
    }
  }

  return {
    ...base,
    ...envVars,
  }
}

const tailLines = (content: string, lines: number): string => {
  const normalized = content.replace(/\r\n/g, "\n")
  const allLines = normalized.split("\n")

  if (allLines.at(-1) === "") {
    allLines.pop()
  }

  const count = Math.max(0, lines)
  if (count === 0) {
    return ""
  }

  return allLines.slice(-count).join("\n")
}

// ── BunServiceRunner ────────────────────────────────────────────────────────

export class BunServiceRunner implements ServiceRunnerService {
  private readonly logDirByService = new Map<string, string>()
  private readonly pidFileByService = new Map<string, string>()

  constructor(
    private readonly fs: FileSystemService,
    private readonly logger: LoggerService,
  ) {}

  start(service: ServerService, opts: RunOpts): Effect.Effect<RunningService, ServiceRunnerError> {
    const logPath = join(opts.logDir, `${service.name}.log`)
    const pidsPath = join(opts.logDir, "..", "pids.json")

    return Effect.gen(this, function* () {
      yield* this.fs.mkdir(opts.logDir).pipe(
        Effect.mapError((cause) =>
          toError(
            "start",
            service.name,
            cause.message,
            `Could not create log directory '${opts.logDir}'. Ensure parent path is writable.`,
          ),
        ),
      )

      const child = yield* Effect.tryPromise({
        try: async () =>
          Bun.spawn(["sh", "-c", service.command], {
            cwd: opts.workdir,
            env: mergeEnv(opts.envVars),
            stdout: Bun.file(logPath),
            stderr: Bun.file(logPath),
          }),
        catch: (cause) =>
          toError(
            "start",
            service.name,
            causeMessage(cause),
            `Ensure command '${service.command}' is valid and '${opts.workdir}' exists.`,
          ),
      })

      const running: RunningService = {
        name: service.name,
        pid: child.pid,
        port: service.port,
        startedAt: new Date(),
      }

      const pids = yield* this.readPidMap(pidsPath, "start", service.name)
      pids[service.name] = {
        pid: running.pid,
        port: running.port,
        startedAt: running.startedAt.toISOString(),
      }
      yield* this.writePidMap(pidsPath, pids, "start", service.name)

      this.logDirByService.set(service.name, opts.logDir)
      this.pidFileByService.set(service.name, pidsPath)

      return running
    })
  }

  stop(service: RunningService): Effect.Effect<void, ServiceRunnerError> {
    return Effect.gen(this, function* () {
      if (!isProcessAlive(service.pid)) {
        // Service already exited — idempotent stop: clean up PID tracking and return success.
        yield* this.removeFromPidTracking(service.name)
        return
      }

      // PID reuse safety guard: verify the process actually owns the expected port
      // before sending signals. If the original service crashed and the OS reassigned
      // the PID to an unrelated process, we must NOT kill it.
      if (typeof service.port === "number" && service.port > 0) {
        const ownership = yield* this.checkPortOwnership(service.pid, service.port)
        if (ownership === "pid-reuse") {
          yield* this.logger.warn("Skipping stop for service due to possible PID reuse.", {
            service: service.name,
            pid: service.pid,
            port: service.port,
            reason: "Port is owned by a different process. Removing stale PID tracking.",
          })
          yield* this.removeFromPidTracking(service.name)
          return
        }
        // "owns-port", "port-free", "unknown" → proceed with stop
      }

      yield* Effect.try({
        try: () => {
          process.kill(service.pid, "SIGTERM")
        },
        catch: (cause) =>
          toError(
            "stop",
            service.name,
            causeMessage(cause),
            `Could not send SIGTERM to pid ${service.pid}. Verify process permissions.`,
          ),
      })

      const exitedAfterTerm = yield* Effect.tryPromise({
        try: () => waitForExit(service.pid, STOP_TIMEOUT_MS),
        catch: (cause) =>
          toError(
            "stop",
            service.name,
            causeMessage(cause),
            `Failed while waiting for pid ${service.pid} to exit.`,
          ),
      })

      if (!exitedAfterTerm) {
        yield* Effect.try({
          try: () => {
            process.kill(service.pid, "SIGKILL")
          },
          catch: (cause) =>
            toError(
              "stop",
              service.name,
              causeMessage(cause),
              `Could not send SIGKILL to pid ${service.pid}. Verify process permissions.`,
            ),
        })

        const exitedAfterKill = yield* Effect.tryPromise({
          try: () => waitForExit(service.pid, 1_000),
          catch: (cause) =>
            toError(
              "stop",
              service.name,
              causeMessage(cause),
              `Failed while confirming pid ${service.pid} exit after SIGKILL.`,
            ),
        })

        if (!exitedAfterKill) {
          return yield* Effect.fail(
            toError(
              "stop",
              service.name,
              `Process '${service.name}' (pid ${service.pid}) did not exit after SIGKILL.`,
              "Inspect the process manually and verify signal permissions.",
            ),
          )
        }
      }

      yield* this.removeFromPidTracking(service.name)
    })
  }

  health(service: RunningService): Effect.Effect<HealthStatus, ServiceRunnerError> {
    return Effect.try({
      try: () => (isProcessAlive(service.pid) ? "healthy" : "unhealthy"),
      catch: (cause) =>
        toError(
          "health",
          service.name,
          causeMessage(cause),
          `Unable to check pid ${service.pid}. Verify process permissions.`,
        ),
    })
  }

  logs(service: string, opts: LogOpts): Effect.Effect<string, ServiceRunnerError> {
    return Effect.gen(this, function* () {
      const targetService = opts.service ?? service
      const logPath = this.resolveLogPath(targetService)

      const exists = yield* this.fs.exists(logPath).pipe(
        Effect.mapError((cause) =>
          toError(
            "logs",
            targetService,
            cause.message,
            `Could not check log file '${logPath}'. Verify permissions.`,
          ),
        ),
      )

      if (!exists) {
        return yield* Effect.fail(
          toError(
            "logs",
            targetService,
            `Log file not found for service '${targetService}'.`,
            `Start '${targetService}' first or verify log path '${logPath}'.`,
          ),
        )
      }

      const content = yield* this.fs.read(logPath).pipe(
        Effect.mapError((cause) =>
          toError(
            "logs",
            targetService,
            cause.message,
            `Could not read log file '${logPath}'. Ensure it is readable.`,
          ),
        ),
      )

      // follow=true still returns a static snapshot due to interface limitations.
      return tailLines(content, opts.lines)
    })
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private resolveLogPath(serviceName: string): string {
    const knownLogDir = this.logDirByService.get(serviceName)
    if (knownLogDir) {
      return join(knownLogDir, `${serviceName}.log`)
    }

    return join(process.cwd(), ".rig", "logs", `${serviceName}.log`)
  }

  /**
   * Check whether a different process has taken over the expected port (PID reuse detection).
   *
   * Returns:
   * - `"owns-port"` → PID is listening on the port. Safe to stop.
   * - `"port-free"` → No one is listening on the port. Original service may have crashed
   *    but PID is still alive (zombie, or non-TCP service). Safe to stop.
   * - `"pid-reuse"` → Port is in use by a DIFFERENT PID. Do NOT kill — PID was reused.
   * - `"unknown"` → lsof unavailable or errored. Proceed cautiously (assume safe to stop).
   */
  private checkPortOwnership(
    pid: number,
    port: number,
  ): Effect.Effect<"owns-port" | "port-free" | "pid-reuse" | "unknown", never> {
    return Effect.tryPromise({
      try: async () => {
        const child = Bun.spawn(["/usr/sbin/lsof", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
          stdout: "pipe",
          stderr: "pipe",
        })

        const [stdout, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          child.exited,
        ])

        if (exitCode !== 0) {
          // No process listening on this port at all
          return "port-free" as const
        }

        const listenerPids = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => Number.parseInt(line, 10))
          .filter((candidate) => Number.isFinite(candidate))

        if (listenerPids.includes(pid)) {
          return "owns-port" as const
        }

        // Port is in use by a different PID — this is PID reuse
        return "pid-reuse" as const
      },
      catch: (cause) => cause as Error,
    }).pipe(
      // lsof unavailable or errored → can't verify, assume safe to proceed
      Effect.catchAll(() => Effect.succeed("unknown" as const)),
    )
  }

  private removeFromPidTracking(serviceName: string): Effect.Effect<void, ServiceRunnerError> {
    return Effect.gen(this, function* () {
      const tracked = this.pidFileByService.get(serviceName)
      const conventional = join(process.cwd(), ".rig", "pids.json")
      const candidatePaths = [...new Set(
        [tracked, conventional].filter((path): path is string => Boolean(path)),
      )]

      for (const pidsPath of candidatePaths) {
        const exists = yield* this.fs.exists(pidsPath).pipe(
          Effect.mapError((cause) =>
            toError(
              "stop",
              serviceName,
              cause.message,
              `Could not check PID tracking file '${pidsPath}'.`,
            ),
          ),
        )

        if (!exists) {
          continue
        }

        const pids = yield* this.readPidMap(pidsPath, "stop", serviceName)
        if (!(serviceName in pids)) {
          continue
        }

        delete pids[serviceName]
        yield* this.writePidMap(pidsPath, pids, "stop", serviceName)

        this.pidFileByService.delete(serviceName)
        this.logDirByService.delete(serviceName)
        return
      }

      this.pidFileByService.delete(serviceName)
      this.logDirByService.delete(serviceName)
    })
  }

  private readPidMap(
    path: string,
    operation: ServiceRunnerError["operation"],
    service: string,
  ): Effect.Effect<PidMap, ServiceRunnerError> {
    return Effect.gen(this, function* () {
      const exists = yield* this.fs.exists(path).pipe(
        Effect.mapError((cause) =>
          toError(
            operation,
            service,
            cause.message,
            `Could not check PID tracking file '${path}'.`,
          ),
        ),
      )

      if (!exists) {
        return {}
      }

      const content = yield* this.fs.read(path).pipe(
        Effect.mapError((cause) =>
          toError(
            operation,
            service,
            cause.message,
            `Could not read PID tracking file '${path}'.`,
          ),
        ),
      )

      return yield* Effect.try({
        try: () => {
          const parsed = JSON.parse(content) as unknown
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("Expected a JSON object keyed by service name.")
          }

          return parsed as PidMap
        },
        catch: (cause) =>
          toError(
            operation,
            service,
            `Failed to parse PID tracking file '${path}': ${causeMessage(cause)}`,
            "Fix or remove pids.json so rig can recreate it.",
          ),
      })
    })
  }

  private writePidMap(
    path: string,
    pids: PidMap,
    operation: ServiceRunnerError["operation"],
    service: string,
  ): Effect.Effect<void, ServiceRunnerError> {
    return this.fs.write(path, `${JSON.stringify(pids, null, 2)}\n`).pipe(
      Effect.mapError((cause) =>
        toError(
          operation,
          service,
          cause.message,
          `Could not write PID tracking file '${path}'. Ensure parent directory is writable.`,
        ),
      ),
    )
  }
}

// ── Layer ────────────────────────────────────────────────────────────────────

export const BunServiceRunnerLive = Layer.effect(
  ServiceRunner,
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const logger = yield* Logger
    return new BunServiceRunner(fs, logger)
  }),
)
