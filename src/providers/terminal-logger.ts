import { Effect, Layer } from "effect-v3"

import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
import type { RigError } from "../schema/errors.js"

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  blue: "\u001b[34m",
  yellow: "\u001b[33m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  gray: "\u001b[90m",
} as const

const color = (value: string, text: string): string => `${value}${text}${ANSI.reset}`

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}

const formatValue = (value: unknown): string => {
  if (value === undefined) return "undefined"
  if (value === null) return "null"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value, null, 2)
}

const detailsLines = (details?: Record<string, unknown>): readonly string[] => {
  if (!details) {
    return []
  }

  return Object.keys(details)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${color(ANSI.gray, `  ${key}:`)} ${formatValue(details[key])}`)
}

const writeLine = (line: string, stream: "stdout" | "stderr") =>
  Effect.sync(() => {
    process[stream].write(`${line}\n`)
  })

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

export class TerminalLogger implements LoggerService {
  constructor(private readonly verbose = false) {}

  info(message: string, details?: Record<string, unknown>): Effect.Effect<void> {
    return Effect.all([
      writeLine(`${color(ANSI.blue, "i")} ${message}`, "stdout"),
      ...detailsLines(details).map((line) => writeLine(line, "stdout")),
    ]).pipe(Effect.asVoid)
  }

  warn(message: string, details?: Record<string, unknown>): Effect.Effect<void> {
    return Effect.all([
      writeLine(`${color(ANSI.yellow, "!")} ${message}`, "stdout"),
      ...detailsLines(details).map((line) => writeLine(line, "stdout")),
    ]).pipe(Effect.asVoid)
  }

  success(message: string, details?: Record<string, unknown>): Effect.Effect<void> {
    return Effect.all([
      writeLine(`${color(ANSI.green, "✓")} ${message}`, "stdout"),
      ...detailsLines(details).map((line) => writeLine(line, "stdout")),
    ]).pipe(Effect.asVoid)
  }

  error(structured: RigError): Effect.Effect<void> {
    const record = asRecord(structured)
    const tag = String(record._tag ?? "RigError")
    const hint = typeof record.hint === "string" ? record.hint : "No remediation hint provided."
    const details = errorDetails(structured)

    if (!this.verbose) {
      return Effect.all([
        writeLine(`${color(ANSI.red, "✗")} ${color(ANSI.bold, errorSummary(structured))}`, "stderr"),
        writeLine(`  ${color(ANSI.bold, "Hint:")} ${hint}`, "stderr"),
      ]).pipe(Effect.asVoid)
    }

    return Effect.all([
      writeLine(`${color(ANSI.red, "✗")} ${color(ANSI.bold, errorSummary(structured))}`, "stderr"),
      writeLine(`${color(ANSI.gray, "  type:")} ${tag}`, "stderr"),
      ...(hint ? [writeLine(`${color(ANSI.gray, "  hint:")} ${hint}`, "stderr")] : []),
      ...detailsLines(details).map((line) => writeLine(line, "stderr")),
    ]).pipe(Effect.asVoid)
  }

  table(rows: readonly Record<string, unknown>[]): Effect.Effect<void> {
    if (rows.length === 0) {
      return writeLine("(no results)", "stdout")
    }

    const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))))
    const widths = columns.map((column) =>
      rows.reduce((max, row) => Math.max(max, formatValue(row[column]).length), column.length),
    )

    const renderRow = (row: Record<string, unknown>): string =>
      columns
        .map((column, index) => formatValue(row[column]).padEnd(widths[index]))
        .join("  ")

    const header = columns
      .map((column, index) => color(ANSI.bold, column.padEnd(widths[index])))
      .join("  ")

    return Effect.all([
      writeLine(header, "stdout"),
      ...rows.map((row) => writeLine(renderRow(row), "stdout")),
    ]).pipe(Effect.asVoid)
  }
}

export const TerminalLoggerLive = Layer.succeed(Logger, new TerminalLogger())
