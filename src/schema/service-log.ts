import { join } from "node:path"
import { z } from "zod"

export const StructuredLogStreamSchema = z
  .enum(["stdout", "stderr"])
  .describe("Output stream that produced the service log line.")

export const StructuredServiceLogEntrySchema = z
  .object({
    timestamp: z
      .string()
      .datetime({ offset: true })
      .describe("UTC ISO-8601 timestamp captured when the line was written to the structured log."),
    service: z
      .string()
      .min(1)
      .describe("Service name that produced the log line."),
    stream: StructuredLogStreamSchema,
    message: z
      .string()
      .describe("Single log line message without a trailing newline."),
  })
  .describe("Structured per-line service log entry recorded for historical log replay.")

export type StructuredServiceLogEntry = z.infer<typeof StructuredServiceLogEntrySchema>

export const logDirForWorkspace = (workspacePath: string): string =>
  join(workspacePath, ".rig", "logs")

export const rawServiceLogPath = (logDir: string, serviceName: string): string =>
  join(logDir, `${serviceName}.log`)

export const structuredServiceLogPath = (logDir: string, serviceName: string): string =>
  join(logDir, `${serviceName}.log.jsonl`)

export const rawServiceLogPathForWorkspace = (workspacePath: string, serviceName: string): string =>
  rawServiceLogPath(logDirForWorkspace(workspacePath), serviceName)

export const structuredServiceLogPathForWorkspace = (
  workspacePath: string,
  serviceName: string,
): string =>
  structuredServiceLogPath(logDirForWorkspace(workspacePath), serviceName)

export const serializeStructuredServiceLogEntry = (
  entry: StructuredServiceLogEntry,
): string => `${JSON.stringify(entry)}\n`

export const parseStructuredServiceLogEntries = (
  content: string,
): readonly StructuredServiceLogEntry[] =>
  content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const parsedJson = (() => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })()

      if (!parsedJson) {
        return []
      }

      const parsed = StructuredServiceLogEntrySchema.safeParse(parsedJson)
      return parsed.success ? [parsed.data] : []
    })
