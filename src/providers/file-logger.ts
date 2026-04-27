import { Effect, Layer } from "effect-v3"

import { FileSystem, type FileSystem as FileSystemService } from "../interfaces/file-system.js"
import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
import type { RigError } from "../schema/errors.js"

type LogLevel = "INFO" | "WARN" | "ERROR" | "SUCCESS" | "TABLE"

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}

const formatValue = (value: unknown): string => {
  if (value === undefined) return "undefined"
  if (value === null) return "null"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

const detailsLines = (details?: Record<string, unknown>): readonly string[] => {
  if (!details || Object.keys(details).length === 0) {
    return []
  }

  return Object.keys(details)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `  ${key}: ${formatValue(details[key])}`)
}

const errorSummary = (error: RigError): string => {
  const record = asRecord(error)

  if (typeof record.message === "string" && record.message.length > 0) {
    return record.message
  }

  if (typeof record.operation === "string" && typeof record.name === "string") {
    return `${record.operation} failed for ${record.name}`
  }

  if (typeof record.operation === "string" && typeof record.path === "string") {
    return `${record.operation} failed for ${record.path}`
  }

  if (typeof record.service === "string") {
    return `Service error: ${record.service}`
  }

  return String(record._tag ?? "RigError")
}

const errorDetails = (error: RigError): Record<string, unknown> => {
  const record = asRecord(error)
  const details: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(record)) {
    if (key === "_tag" || key === "message" || key === "hint") {
      continue
    }
    details[key] = value
  }

  return details
}

export class FileLogger implements LoggerService {
  constructor(
    private readonly fileSystem: FileSystemService,
    private readonly filePath: string,
  ) {}

  info(message: string, details?: Record<string, unknown>): Effect.Effect<void> {
    return this.write("INFO", message, details)
  }

  warn(message: string, details?: Record<string, unknown>): Effect.Effect<void> {
    return this.write("WARN", message, details)
  }

  success(message: string, details?: Record<string, unknown>): Effect.Effect<void> {
    return this.write("SUCCESS", message, details)
  }

  error(structured: RigError): Effect.Effect<void> {
    const record = asRecord(structured)
    const tag = String(record._tag ?? "RigError")
    const hint = typeof record.hint === "string" ? record.hint : undefined
    const details = errorDetails(structured)
    const mergedDetails = hint ? { hint, ...details } : details

    return this.write("ERROR", `${tag}: ${errorSummary(structured)}`, mergedDetails)
  }

  table(rows: readonly Record<string, unknown>[]): Effect.Effect<void> {
    return this.write("TABLE", JSON.stringify(rows))
  }

  private write(
    level: LogLevel,
    message: string,
    details?: Record<string, unknown>,
  ): Effect.Effect<void> {
    const lines = [`[${new Date().toISOString()}] [${level}] ${message}`, ...detailsLines(details)]
    return this.fileSystem.append(this.filePath, `${lines.join("\n")}\n`).pipe(Effect.orDie)
  }
}

export const FileLoggerLive = (path: string): Layer.Layer<Logger, never, FileSystem> =>
  Layer.effect(
    Logger,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem
      return new FileLogger(fileSystem, path)
    }),
  )
