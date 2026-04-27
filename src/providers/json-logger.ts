import { Effect, Layer } from "effect-v3"

import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
import type { RigError } from "../schema/errors.js"

const writeRecord = (
  record: Record<string, unknown>,
  stream: "stdout" | "stderr",
): Effect.Effect<void> =>
  Effect.sync(() => {
    process[stream].write(`${JSON.stringify(record)}\n`)
  })

const base = (level: "info" | "warn" | "success" | "error" | "table") => ({
  timestamp: new Date().toISOString(),
  level,
})

export class JsonLogger implements LoggerService {
  info(message: string, details?: Record<string, unknown>): Effect.Effect<void> {
    return writeRecord(
      {
        ...base("info"),
        message,
        details: details ?? {},
      },
      "stdout",
    )
  }

  warn(message: string, details?: Record<string, unknown>): Effect.Effect<void> {
    return writeRecord(
      {
        ...base("warn"),
        message,
        details: details ?? {},
      },
      "stdout",
    )
  }

  success(message: string, details?: Record<string, unknown>): Effect.Effect<void> {
    return writeRecord(
      {
        ...base("success"),
        message,
        details: details ?? {},
      },
      "stdout",
    )
  }

  error(structured: RigError): Effect.Effect<void> {
    return writeRecord(
      {
        ...base("error"),
        error: structured,
      },
      "stderr",
    )
  }

  table(rows: readonly Record<string, unknown>[]): Effect.Effect<void> {
    return writeRecord(
      {
        ...base("table"),
        rows,
      },
      "stdout",
    )
  }
}

export const JsonLoggerLive = Layer.succeed(Logger, new JsonLogger())
