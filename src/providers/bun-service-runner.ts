import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Layer } from "effect-v3"

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
import {
  logDirForWorkspace,
  rawServiceLogPath,
  structuredServiceLogPath,
  parseStructuredServiceLogEntries,
} from "../schema/service-log.js"
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
const CURRENT_RIG_ENTRY = fileURLToPath(new URL("../index.ts", import.meta.url))

// ── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const isErrnoCode = (cause: unknown, code: string): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { readonly code?: unknown }).code === code

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

const isProcessGroupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

const parsePidLines = (raw: string): readonly number[] => {
  const result = new Set<number>()

  for (const line of raw.split(/\r?\n/)) {
    const pid = Number.parseInt(line.trim(), 10)
    if (Number.isFinite(pid) && pid > 0) {
      result.add(pid)
    }
  }

  return [...result]
}

const listDirectChildPids = async (pid: number): Promise<readonly number[]> => {
  try {
    const child = Bun.spawn(["/usr/bin/pgrep", "-P", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    })

    const [stdout, exitCode] = await Promise.all([
      child.stdout ? new Response(child.stdout).text() : Promise.resolve(""),
      child.exited,
    ])

    if (exitCode !== 0) {
      return []
    }

    return parsePidLines(stdout)
  } catch {
    return []
  }
}

const listDescendantPids = async (rootPid: number): Promise<readonly number[]> => {
  const descendants = new Set<number>()
  const queue: number[] = [rootPid]

  while (queue.length > 0) {
    const parent = queue.shift()
    if (parent === undefined) {
      continue
    }

    const children = await listDirectChildPids(parent)
    for (const childPid of children) {
      if (descendants.has(childPid)) {
        continue
      }
      descendants.add(childPid)
      queue.push(childPid)
    }
  }

  return [...descendants]
}

const signalProcessGroupOrTree = (
  pid: number,
  descendants: ReadonlySet<number>,
  signal: NodeJS.Signals,
): void => {
  try {
    process.kill(-pid, signal)
    return
  } catch (groupError) {
    let signaledAny = false
    const candidates = new Set<number>([pid, ...descendants])

    for (const candidate of candidates) {
      try {
        process.kill(candidate, signal)
        signaledAny = true
      } catch (candidateError) {
        if (isErrnoCode(candidateError, "ESRCH")) {
          continue
        }
        throw candidateError
      }
    }

    if (!signaledAny && !isErrnoCode(groupError, "ESRCH")) {
      throw groupError
    }
  }
}

const isAnyTrackedDescendantAlive = (descendants: ReadonlySet<number>): boolean => {
  for (const descendant of descendants) {
    if (isProcessAlive(descendant)) {
      return true
    }
  }

  return false
}

const isProcessTreeAlive = async (
  pid: number,
  descendants: ReadonlySet<number>,
): Promise<boolean> => {
  if (isProcessAlive(pid)) {
    return true
  }

  if (isProcessGroupAlive(pid)) {
    return true
  }

  if (isAnyTrackedDescendantAlive(descendants)) {
    return true
  }

  const discoveredDescendants = await listDescendantPids(pid)
  return discoveredDescendants.length > 0
}

const waitForExit = async (
  pid: number,
  timeoutMs: number,
  trackedDescendants: readonly number[] = [],
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  const descendants = new Set<number>(trackedDescendants)

  while (Date.now() < deadline) {
    if (!(await isProcessTreeAlive(pid, descendants))) {
      return true
    }

    await sleep(STOP_POLL_INTERVAL_MS)
  }

  return !(await isProcessTreeAlive(pid, descendants))
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

const tailStructuredMessages = (
  content: string,
  lines: number,
): string => {
  const count = Math.max(0, lines)
  if (count === 0) {
    return ""
  }

  return parseStructuredServiceLogEntries(content)
    .slice(-count)
    .map((entry) => entry.message)
    .join("\n")
}

const captureCommand = (
  serviceName: string,
  rawLogPath: string,
  structuredLogPath: string,
  command: string,
): readonly string[] => {
  const internalArgs = [
    "_capture-logs",
    "--service",
    serviceName,
    "--raw-log-path",
    rawLogPath,
    "--structured-log-path",
    structuredLogPath,
    "--command",
    command,
  ] as const

  return basename(process.execPath) === "bun"
    ? [process.execPath, "run", CURRENT_RIG_ENTRY, ...internalArgs]
    : [process.execPath, ...internalArgs]
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
    const logPath = rawServiceLogPath(opts.logDir, service.name)
    const structuredLogPath = structuredServiceLogPath(opts.logDir, service.name)
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
          Bun.spawn([...captureCommand(service.name, logPath, structuredLogPath, service.command)], {
            cwd: opts.workdir,
            env: mergeEnv(opts.envVars),
            stdout: "ignore",
            stderr: "ignore",
            detached: true,
          }),
        catch: (cause) =>
          toError(
            "start",
            service.name,
            causeMessage(cause),
            `Ensure command '${service.command}' is valid and '${opts.workdir}' exists.`,
          ),
      })
      child.unref()

      const running: RunningService = {
        name: service.name,
        pid: child.pid,
        port: service.port,
        startedAt: new Date(),
      }

      yield* Effect.gen(this, function* () {
        const pids = yield* this.readPidMap(pidsPath, "start", service.name)
        pids[service.name] = {
          pid: running.pid,
          port: running.port,
          startedAt: running.startedAt.toISOString(),
        }
        yield* this.writePidMap(pidsPath, pids, "start", service.name)
      }).pipe(
        Effect.catchAll((error) =>
          this.cleanupSpawnedProcess(running.pid).pipe(
            Effect.zipRight(Effect.fail(error)),
          ),
        ),
      )

      this.logDirByService.set(service.name, opts.logDir)
      this.pidFileByService.set(service.name, pidsPath)

      return running
    })
  }

  stop(service: RunningService): Effect.Effect<void, ServiceRunnerError> {
    return Effect.gen(this, function* () {
      const trackedDescendants = yield* Effect.tryPromise({
        try: () => listDescendantPids(service.pid),
        catch: () => new Error("Failed to inspect child processes."),
      }).pipe(Effect.orElseSucceed(() => [] as readonly number[]))
      const trackedDescendantSet = new Set<number>(trackedDescendants)

      if (
        !isProcessAlive(service.pid) &&
        !isProcessGroupAlive(service.pid) &&
        trackedDescendants.length === 0
      ) {
        // Service already exited — idempotent stop: clean up PID tracking and return success.
        yield* this.removeFromPidTracking(service.name)
        return
      }

      // PID reuse safety guard: verify the process actually owns the expected port
      // before sending signals. If the original service crashed and the OS reassigned
      // the PID to an unrelated process, we must NOT kill it.
      if (
        isProcessAlive(service.pid) &&
        typeof service.port === "number" &&
        service.port > 0
      ) {
        const ownership = yield* this.checkPortOwnership(
          service.pid,
          service.port,
          trackedDescendants,
        )
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
          signalProcessGroupOrTree(service.pid, trackedDescendantSet, "SIGTERM")
        },
        catch: (cause) =>
          toError(
            "stop",
            service.name,
            causeMessage(cause),
            `Could not send SIGTERM to pid/process-group ${service.pid}. Verify process permissions.`,
          ),
      })

      const exitedAfterTerm = yield* Effect.tryPromise({
        try: () => waitForExit(service.pid, STOP_TIMEOUT_MS, trackedDescendants),
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
            signalProcessGroupOrTree(service.pid, trackedDescendantSet, "SIGKILL")
          },
          catch: (cause) =>
            toError(
              "stop",
              service.name,
              causeMessage(cause),
              `Could not send SIGKILL to pid/process-group ${service.pid}. Verify process permissions.`,
            ),
        })

        const exitedAfterKill = yield* Effect.tryPromise({
          try: () => waitForExit(service.pid, 1_000, trackedDescendants),
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
      const logPath = this.resolveLogPath(targetService, opts.workspacePath)
      const structuredPath = this.resolveStructuredLogPath(targetService, opts.workspacePath)

      const structuredExists = yield* this.fs.exists(structuredPath).pipe(
        Effect.mapError((cause) =>
          toError(
            "logs",
            targetService,
            cause.message,
            `Could not check structured log file '${structuredPath}'. Verify permissions.`,
          ),
        ),
      )

      if (structuredExists) {
        const content = yield* this.fs.read(structuredPath).pipe(
          Effect.mapError((cause) =>
            toError(
              "logs",
              targetService,
              cause.message,
              `Could not read structured log file '${structuredPath}'. Ensure it is readable.`,
            ),
          ),
        )

        return tailStructuredMessages(content, opts.lines)
      }

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

  private resolveLogPath(serviceName: string, workspacePath?: string): string {
    const knownLogDir = this.logDirByService.get(serviceName)
    if (knownLogDir) {
      return rawServiceLogPath(knownLogDir, serviceName)
    }

    if (workspacePath) {
      return rawServiceLogPath(logDirForWorkspace(workspacePath), serviceName)
    }

    return rawServiceLogPath(logDirForWorkspace(process.cwd()), serviceName)
  }

  private resolveStructuredLogPath(serviceName: string, workspacePath?: string): string {
    const knownLogDir = this.logDirByService.get(serviceName)
    if (knownLogDir) {
      return structuredServiceLogPath(knownLogDir, serviceName)
    }

    if (workspacePath) {
      return structuredServiceLogPath(logDirForWorkspace(workspacePath), serviceName)
    }

    return structuredServiceLogPath(logDirForWorkspace(process.cwd()), serviceName)
  }

  // Checks whether the expected PID still owns the service port to guard against PID reuse.
  private checkPortOwnership(
    pid: number,
    port: number,
    knownDescendants: readonly number[] = [],
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

        const ownershipCandidates = new Set<number>([pid, ...knownDescendants])
        if (listenerPids.some((listenerPid) => ownershipCandidates.has(listenerPid))) {
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

  private cleanupSpawnedProcess(pid: number): Effect.Effect<void, never> {
    return Effect.gen(function* () {
      const trackedDescendants = yield* Effect.tryPromise({
        try: () => listDescendantPids(pid),
        catch: () => new Error("Failed to inspect child processes."),
      }).pipe(Effect.orElseSucceed(() => [] as readonly number[]))
      const trackedDescendantSet = new Set<number>(trackedDescendants)

      if (
        !isProcessAlive(pid) &&
        !isProcessGroupAlive(pid) &&
        trackedDescendants.length === 0
      ) {
        return
      }

      yield* Effect.try({
        try: () => {
          signalProcessGroupOrTree(pid, trackedDescendantSet, "SIGTERM")
        },
        catch: () => undefined,
      }).pipe(Effect.ignore)

      const exited = yield* Effect.tryPromise({
        try: () => waitForExit(pid, 1_000, trackedDescendants),
        catch: () => false,
      }).pipe(Effect.orElseSucceed(() => false))

      if (exited) {
        return
      }

      yield* Effect.try({
        try: () => {
          signalProcessGroupOrTree(pid, trackedDescendantSet, "SIGKILL")
        },
        catch: () => undefined,
      }).pipe(Effect.ignore)
    }).pipe(Effect.orElseSucceed(() => undefined))
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
