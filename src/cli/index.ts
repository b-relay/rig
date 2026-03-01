import { parseArgs } from "node:util"
import { Effect } from "effect"
import { z } from "zod"

import { Logger } from "../interfaces/logger.js"
import { CliArgumentError, type RigError } from "../schema/errors.js"
import { COMMANDS, type CommandName, isCommandName, renderCommandHelp, renderMainHelp } from "./help.js"

const VERSION_ACTIONS = ["show", "patch", "minor", "major", "undo", "list"] as const

type ParseOption = { type: "boolean" | "string"; short?: string }

const makeCliError = (
  command: string,
  message: string,
  hint: string,
  details?: Record<string, unknown>,
): RigError => new CliArgumentError(command, message, hint, details)

const parseWithOptions = <T extends Record<string, ParseOption>>(
  command: string,
  args: readonly string[],
  options: T,
):
  | {
      readonly values: {
        readonly [K in keyof T]?: T[K]["type"] extends "boolean" ? boolean : string
      }
      readonly positionals: readonly string[]
    }
  | { readonly error: RigError } => {
  try {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options,
    })

    return {
      values: parsed.values as {
        readonly [K in keyof T]?: T[K]["type"] extends "boolean" ? boolean : string
      },
      positionals: parsed.positionals,
    }
  } catch (cause) {
    return {
      error: makeCliError(
        command,
        "Invalid command arguments.",
        `Run 'rig ${command} --help' to see supported options.`,
        { cause: cause instanceof Error ? cause.message : String(cause) },
      ),
    }
  }
}

const resolveEnv = (
  command: string,
  flags: { readonly dev?: boolean; readonly prod?: boolean },
  required: boolean,
): { readonly env: "dev" | "prod" | null; readonly error?: RigError } => {
  const dev = flags.dev === true
  const prod = flags.prod === true

  if (dev && prod) {
    return {
      env: null,
      error: makeCliError(command, "Conflicting environment flags.", "Pass exactly one of --dev or --prod."),
    }
  }

  if (!dev && !prod) {
    if (required) {
      return {
        env: null,
        error: makeCliError(command, "Missing environment flag.", "Pass exactly one of --dev or --prod."),
      }
    }

    return { env: null }
  }

  return { env: dev ? "dev" : "prod" }
}

const showCommandHelp = (command: CommandName) =>
  Effect.gen(function* () {
    const logger = yield* Logger
    yield* logger.info(renderCommandHelp(command))
    return 0
  })

const runScaffoldHandler = (command: CommandName, details: Record<string, unknown>) =>
  Effect.gen(function* () {
    const logger = yield* Logger
    yield* logger.info(`${command} command scaffold ready.`, details)
    return 0
  })

const fail = (error: RigError) =>
  Effect.gen(function* () {
    const logger = yield* Logger
    yield* logger.error(error)
    return 1
  })

const parseLifecycleCommand = (
  command: "deploy" | "start" | "stop" | "restart",
  args: readonly string[],
) =>
  Effect.gen(function* () {
    const parsed = parseWithOptions(command, args, {
      help: { type: "boolean", short: "h" },
      dev: { type: "boolean" },
      prod: { type: "boolean" },
    })

    if ("error" in parsed) {
      return yield* fail(parsed.error)
    }

    if (parsed.values.help || parsed.positionals[0] === "help") {
      return yield* showCommandHelp(command)
    }

    if (parsed.positionals.length !== 1) {
      return yield* fail(
        makeCliError(command, "Invalid positional arguments.", `Usage: rig ${command} <name> --dev|--prod`),
      )
    }

    const name = z.string().min(1).safeParse(parsed.positionals[0])
    if (!name.success) {
      return yield* fail(
        makeCliError(command, "Missing project name.", `Usage: rig ${command} <name> --dev|--prod`),
      )
    }

    const env = resolveEnv(command, parsed.values, true)
    if (env.error) {
      return yield* fail(env.error)
    }

    return yield* runScaffoldHandler(command, {
      name: name.data,
      env: env.env,
    })
  })

const parseInit = (args: readonly string[]) =>
  Effect.gen(function* () {
    const parsed = parseWithOptions("init", args, {
      help: { type: "boolean", short: "h" },
      path: { type: "string" },
    })

    if ("error" in parsed) {
      return yield* fail(parsed.error)
    }

    if (parsed.values.help || parsed.positionals[0] === "help") {
      return yield* showCommandHelp("init")
    }

    const payload = z
      .object({
        name: z.string().min(1),
        path: z.string().min(1),
      })
      .safeParse({
        name: parsed.positionals[0],
        path: parsed.values.path,
      })

    if (!payload.success || parsed.positionals.length > 1) {
      return yield* fail(
        makeCliError("init", "Invalid arguments.", "Usage: rig init <name> --path <project-path>"),
      )
    }

    return yield* runScaffoldHandler("init", payload.data)
  })

const parseStatus = (args: readonly string[]) =>
  Effect.gen(function* () {
    const parsed = parseWithOptions("status", args, {
      help: { type: "boolean", short: "h" },
      dev: { type: "boolean" },
      prod: { type: "boolean" },
    })

    if ("error" in parsed) {
      return yield* fail(parsed.error)
    }

    if (parsed.values.help || parsed.positionals[0] === "help") {
      return yield* showCommandHelp("status")
    }

    if (parsed.positionals.length > 1) {
      return yield* fail(
        makeCliError("status", "Too many positional arguments.", "Usage: rig status [<name>] [--dev|--prod]"),
      )
    }

    const env = resolveEnv("status", parsed.values, false)
    if (env.error) {
      return yield* fail(env.error)
    }

    return yield* runScaffoldHandler("status", {
      name: parsed.positionals[0] ?? null,
      env: env.env,
    })
  })

const parseLogs = (args: readonly string[]) =>
  Effect.gen(function* () {
    const parsed = parseWithOptions("logs", args, {
      help: { type: "boolean", short: "h" },
      dev: { type: "boolean" },
      prod: { type: "boolean" },
      follow: { type: "boolean" },
      lines: { type: "string" },
      service: { type: "string" },
    })

    if ("error" in parsed) {
      return yield* fail(parsed.error)
    }

    if (parsed.values.help || parsed.positionals[0] === "help") {
      return yield* showCommandHelp("logs")
    }

    const payload = z
      .object({
        name: z.string().min(1),
        follow: z.boolean().default(false),
        lines: z.coerce.number().int().positive().default(50),
        service: z.string().min(1).optional(),
      })
      .safeParse({
        name: parsed.positionals[0],
        follow: parsed.values.follow,
        lines: parsed.values.lines ?? "50",
        service: parsed.values.service,
      })

    if (!payload.success || parsed.positionals.length > 1) {
      return yield* fail(
        makeCliError(
          "logs",
          "Invalid arguments.",
          "Usage: rig logs <name> --dev|--prod [--follow] [--lines <n>] [--service <name>]",
        ),
      )
    }

    const env = resolveEnv("logs", parsed.values, true)
    if (env.error) {
      return yield* fail(env.error)
    }

    return yield* runScaffoldHandler("logs", {
      ...payload.data,
      env: env.env,
    })
  })

const parseVersion = (args: readonly string[]) =>
  Effect.gen(function* () {
    const parsed = parseWithOptions("version", args, {
      help: { type: "boolean", short: "h" },
    })

    if ("error" in parsed) {
      return yield* fail(parsed.error)
    }

    if (parsed.values.help || parsed.positionals[0] === "help") {
      return yield* showCommandHelp("version")
    }

    const payload = z
      .object({
        name: z.string().min(1),
        action: z.enum(VERSION_ACTIONS).default("show"),
      })
      .safeParse({
        name: parsed.positionals[0],
        action: parsed.positionals[1] ?? "show",
      })

    if (!payload.success || parsed.positionals.length > 2) {
      return yield* fail(
        makeCliError(
          "version",
          "Invalid arguments.",
          "Usage: rig version <name> [patch|minor|major|undo|list]",
        ),
      )
    }

    return yield* runScaffoldHandler("version", payload.data)
  })

const parseSimpleCommand = (command: "list" | "config", args: readonly string[]) =>
  Effect.gen(function* () {
    const parsed = parseWithOptions(command, args, {
      help: { type: "boolean", short: "h" },
    })

    if ("error" in parsed) {
      return yield* fail(parsed.error)
    }

    if (parsed.values.help || parsed.positionals[0] === "help") {
      return yield* showCommandHelp(command)
    }

    if (parsed.positionals.length > 0) {
      return yield* fail(
        makeCliError(command, "Unexpected positional arguments.", `Usage: rig ${command}`),
      )
    }

    return yield* runScaffoldHandler(command, {})
  })

const runCommand = (command: CommandName, args: readonly string[]) => {
  switch (command) {
    case "deploy":
    case "start":
    case "stop":
    case "restart":
      return parseLifecycleCommand(command, args)
    case "init":
      return parseInit(args)
    case "status":
      return parseStatus(args)
    case "logs":
      return parseLogs(args)
    case "version":
      return parseVersion(args)
    case "list":
    case "config":
      return parseSimpleCommand(command, args)
  }
}

export const runCli = (argv: readonly string[]) =>
  Effect.gen(function* () {
    const logger = yield* Logger

    if (argv.length === 0) {
      yield* logger.info(renderMainHelp())
      return 0
    }

    const [head, ...rest] = argv

    if (head === "-h" || head === "--help") {
      yield* logger.info(renderMainHelp())
      return 0
    }

    if (head === "help") {
      if (rest.length > 0 && isCommandName(rest[0])) {
        yield* logger.info(renderCommandHelp(rest[0]))
        return 0
      }

      yield* logger.info(renderMainHelp())
      return 0
    }

    if (!isCommandName(head)) {
      yield* logger.error(
        makeCliError(
          "global",
          `Unknown command: ${head}`,
          "Run `rig --help` to see available commands.",
          { commands: COMMANDS },
        ),
      )
      return 1
    }

    return yield* runCommand(head, rest)
  })
