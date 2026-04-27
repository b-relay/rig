import { Effect } from "effect-v3"

import { FileSystem } from "../interfaces/file-system.js"
import { Logger } from "../interfaces/logger.js"
import { ServiceRunner } from "../interfaces/service-runner.js"
import { Workspace } from "../interfaces/workspace.js"
import {
  parseStructuredServiceLogEntries,
  rawServiceLogPathForWorkspace,
  structuredServiceLogPathForWorkspace,
  type StructuredServiceLogEntry,
} from "../schema/service-log.js"
import type { LogsArgs } from "../schema/args.js"
import { CliArgumentError } from "../schema/errors.js"
import { loadProjectConfig, loadProjectConfigAtPath, resolveEnvironment } from "./config.js"
import { requireActiveProdWorkspace, validateActiveProdWorkspaceIfPresent } from "./prod-state.js"

const FOLLOW_POLL_MS = 250

type LogStreamState = {
  readonly content: string
  readonly pending: string
}

const missingServiceError = (
  name: string,
  env: "dev" | "prod",
  service: string,
  available: readonly string[],
) =>
  new CliArgumentError(
    "logs",
    `Service '${service}' is not defined for project '${name}' (${env}).`,
    "Choose a service listed in rig.json or omit --service to stream all services.",
    { name, env, service, availableServices: available },
  )

const structuredInterleaveUnavailableError = (
  name: string,
  env: "dev" | "prod",
  services: readonly string[],
) =>
  new CliArgumentError(
    "logs",
    `Cannot interleave historical logs for project '${name}' (${env}) because structured log history is unavailable for: ${services.join(", ")}.`,
    "Specify --service for one service, or restart those services to begin structured log capture.",
    { name, env, services },
  )

const sleep = (ms: number) =>
  Effect.tryPromise({
    try: () => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    catch: () => new Error(`Failed while waiting ${ms}ms for log polling.`),
  }).pipe(Effect.orDie)

const splitLines = (content: string): readonly string[] =>
  content.replace(/\r\n/g, "\n").split("\n")

const initialStreamState = (content: string): LogStreamState => {
  const normalized = content.replace(/\r\n/g, "\n")

  if (normalized.endsWith("\n")) {
    return {
      content,
      pending: "",
    }
  }

  const parts = normalized.split("\n")

  return {
    content,
    pending: parts.at(-1) ?? "",
  }
}

const emitLines = (
  lines: readonly string[],
  serviceName: string,
  prefixService: boolean,
) =>
  Effect.gen(function* () {
    const logger = yield* Logger

    for (const line of lines) {
      if (line.length === 0) {
        continue
      }

      yield* logger.info(prefixService ? `${serviceName} | ${line}` : line)
    }
  })

const emitSnapshot = (
  output: string,
  serviceName: string,
  prefixService: boolean,
) => {
  const lines = splitLines(output)
  const visibleLines = lines.at(-1) === "" ? lines.slice(0, -1) : lines

  return visibleLines.length > 0
    ? emitLines(visibleLines, serviceName, prefixService)
    : Effect.gen(function* () {
        const logger = yield* Logger
        yield* logger.info(prefixService ? `${serviceName} | (no logs)` : `(no logs for ${serviceName})`)
      })
}

const emitStructuredEntries = (
  entries: readonly StructuredServiceLogEntry[],
  prefixService: boolean,
) =>
  Effect.gen(function* () {
    const logger = yield* Logger

    for (const entry of entries) {
      if (entry.message.length === 0) {
        continue
      }

      yield* logger.info(prefixService ? `${entry.service} | ${entry.message}` : entry.message)
    }
  })

const diffStream = (
  previous: LogStreamState,
  content: string,
): { readonly state: LogStreamState; readonly lines: readonly string[] } => {
  const reset = content.length < previous.content.length || !content.startsWith(previous.content)
  const delta = reset ? content : content.slice(previous.content.length)
  const combined = `${reset ? "" : previous.pending}${delta}`.replace(/\r\n/g, "\n")
  const parts = combined.split("\n")
  const endsWithNewline = combined.endsWith("\n")
  const pending = endsWithNewline ? "" : (parts.pop() ?? "")

  return {
    state: {
      content,
      pending,
    },
    lines: endsWithNewline ? parts.slice(0, -1) : parts,
  }
}

const sortStructuredEntries = (
  entries: readonly StructuredServiceLogEntry[],
): readonly StructuredServiceLogEntry[] =>
  [...entries].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp) ||
    left.service.localeCompare(right.service),
  )

const tailStructuredEntries = (
  entries: readonly StructuredServiceLogEntry[],
  lines: number,
): readonly StructuredServiceLogEntry[] => {
  const count = Math.max(0, lines)
  if (count === 0) {
    return []
  }

  return entries.slice(-count)
}

const readIfExists = (path: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem
    const exists = yield* fileSystem.exists(path).pipe(
      Effect.catchAll(() => Effect.succeed(false)),
    )

    if (!exists) {
      return null
    }

    return yield* fileSystem.read(path).pipe(
      Effect.catchAll(() => Effect.succeed("")),
    )
  })

export const runLogsCommand = (args: LogsArgs) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem
    const serviceRunner = yield* ServiceRunner
    const workspace = yield* Workspace

    if (args.env === "prod") {
      yield* validateActiveProdWorkspaceIfPresent("logs", args.name)
      if (!args.version) {
        yield* requireActiveProdWorkspace("logs", args.name)
      }
    }

    const workspacePath =
      args.env === "prod"
        ? yield* workspace.resolve(args.name, "prod", args.version)
        : yield* workspace.resolve(args.name, args.env)
    const loaded =
      args.env === "prod"
        ? yield* loadProjectConfigAtPath(args.name, workspacePath)
        : yield* loadProjectConfig(args.name)
    const environment = yield* resolveEnvironment(loaded.configPath, loaded.config, args.env)
    const availableServices = environment.services.map((service) => service.name)

    if (args.service && !availableServices.includes(args.service)) {
      return yield* Effect.fail(
        missingServiceError(args.name, args.env, args.service, availableServices),
      )
    }

    const targets =
      args.service
        ? [args.service]
        : availableServices.length === 1
          ? [availableServices[0]]
          : availableServices
    const prefixService = targets.length > 1

    if (targets.length === 1 && !args.follow) {
      const serviceName = targets[0]
      const output = yield* serviceRunner.logs(serviceName, {
        lines: args.lines,
        follow: false,
        service: args.service,
        workspacePath,
      })

      yield* emitSnapshot(output, serviceName, false)
      return 0
    }

    if (targets.length > 1) {
      const structuredContents = new Map<string, string>()
      const missingStructured: string[] = []

      for (const serviceName of targets) {
        const structuredPath = structuredServiceLogPathForWorkspace(workspacePath, serviceName)
        const content = yield* readIfExists(structuredPath)

        if (content === null) {
          missingStructured.push(serviceName)
          continue
        }

        structuredContents.set(serviceName, content)
      }

      if (missingStructured.length > 0) {
        return yield* Effect.fail(
          structuredInterleaveUnavailableError(args.name, args.env, missingStructured),
        )
      }

      const snapshotEntries = sortStructuredEntries(
        Array.from(structuredContents.values()).flatMap((content) =>
          parseStructuredServiceLogEntries(content),
        ),
      )

      if (snapshotEntries.length > 0) {
        yield* emitStructuredEntries(tailStructuredEntries(snapshotEntries, args.lines), true)
      }

      if (!args.follow) {
        return 0
      }

      const streamStates = new Map<string, LogStreamState>()
      for (const [serviceName, content] of structuredContents.entries()) {
        streamStates.set(serviceName, initialStreamState(content))
      }

      while (true) {
        yield* sleep(FOLLOW_POLL_MS)

        const appendedEntries: StructuredServiceLogEntry[] = []

        for (const serviceName of targets) {
          const structuredPath = structuredServiceLogPathForWorkspace(workspacePath, serviceName)
          const content = yield* fileSystem.read(structuredPath).pipe(
            Effect.catchAll(() => Effect.succeed("")),
          )
          const previous = streamStates.get(serviceName) ?? initialStreamState("")
          const next = diffStream(previous, content)
          streamStates.set(serviceName, next.state)

          if (next.lines.length === 0) {
            continue
          }

          appendedEntries.push(
            ...parseStructuredServiceLogEntries(next.lines.join("\n")),
          )
        }

        if (appendedEntries.length > 0) {
          yield* emitStructuredEntries(sortStructuredEntries(appendedEntries), true)
        }
      }
    }

    const serviceName = targets[0]
    const structuredPath = structuredServiceLogPathForWorkspace(workspacePath, serviceName)
    const rawPath = rawServiceLogPathForWorkspace(workspacePath, serviceName)
    const structuredContent = yield* readIfExists(structuredPath)

    if (structuredContent !== null) {
      const snapshotEntries = parseStructuredServiceLogEntries(structuredContent)

      if (snapshotEntries.length > 0) {
        yield* emitStructuredEntries(tailStructuredEntries(snapshotEntries, args.lines), false)
      }

      const streamStates = new Map<string, LogStreamState>([
        [serviceName, initialStreamState(structuredContent)],
      ])

      while (true) {
        yield* sleep(FOLLOW_POLL_MS)

        const content = yield* fileSystem.read(structuredPath).pipe(
          Effect.catchAll(() => Effect.succeed("")),
        )
        const previous = streamStates.get(serviceName) ?? initialStreamState("")
        const next = diffStream(previous, content)
        streamStates.set(serviceName, next.state)

        if (next.lines.length > 0) {
          yield* emitStructuredEntries(
            sortStructuredEntries(parseStructuredServiceLogEntries(next.lines.join("\n"))),
            false,
          )
        }
      }
    }

    const output = yield* serviceRunner.logs(serviceName, {
      lines: args.lines,
      follow: false,
      service: args.service,
      workspacePath,
    })
    yield* emitSnapshot(output, serviceName, false)

    const initialRawContent = yield* readIfExists(rawPath)
    const streamStates = new Map<string, LogStreamState>([
      [serviceName, initialStreamState(initialRawContent ?? "")],
    ])

    while (true) {
      yield* sleep(FOLLOW_POLL_MS)

      const content = yield* fileSystem.read(rawPath).pipe(
        Effect.catchAll(() => Effect.succeed("")),
      )
      const previous = streamStates.get(serviceName) ?? initialStreamState("")
      const next = diffStream(previous, content)
      streamStates.set(serviceName, next.state)

      if (next.lines.length > 0) {
        yield* emitLines(next.lines, serviceName, false)
      }
    }
  })
