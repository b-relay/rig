import { parseArgs } from "node:util"
import { Effect } from "effect"
import { z } from "zod"

import { runConfigCommand } from "../core/config-command.js"
import { runDeployCommand } from "../core/deploy.js"
import { runInitCommand } from "../core/init.js"
import { runListCommand } from "../core/list.js"
import { runRestartCommand, runStartCommand, runStopCommand } from "../core/lifecycle.js"
import { runLogsCommand } from "../core/logs.js"
import { runSetupCommand } from "../core/setup.js"
import { runStatusCommand } from "../core/status.js"
import { runVersionCommand } from "../core/version.js"
import { Logger } from "../interfaces/logger.js"
import {
  ConfigArgsSchema,
  DeployArgsSchema,
  InitArgsSchema,
  ListArgsSchema,
  LogsArgsSchema,
  RestartArgsSchema,
  SetupArgsSchema,
  StartArgsSchema,
  StatusArgsSchema,
  StopArgsSchema,
  VersionArgsSchema,
} from "../schema/args.js"
import { CliArgumentError, type RigError } from "../schema/errors.js"
import { COMMANDS, type CommandName, isCommandName, renderCommandHelp, renderMainHelp } from "./help.js"

type ParseOption = { type: "boolean" | "string"; short?: string }

type ParsedArgs = {
  readonly values: Readonly<Record<string, string | boolean | undefined>>
  readonly positionals: readonly string[]
}

const makeCliError = (
  command: string,
  message: string,
  hint: string,
  details?: Record<string, unknown>,
): CliArgumentError => new CliArgumentError(command, message, hint, details)

const parseWithOptions = (
  command: string,
  args: readonly string[],
  options: Record<string, ParseOption>,
): ParsedArgs | { readonly error: RigError } => {
  try {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options,
    })

    return {
      values: parsed.values,
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

const validate = <T>(
  command: string,
  schema: z.ZodType<T>,
  input: unknown,
  usage: string,
): { readonly data: T } | { readonly error: RigError } => {
  const parsed = schema.safeParse(input)

  if (!parsed.success) {
    return {
      error: makeCliError(command, "Invalid arguments.", `Usage: ${usage}`, {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          code: issue.code,
          message: issue.message,
        })),
      }),
    }
  }

  return { data: parsed.data }
}

const resolveEnv = (
  command: string,
  values: Readonly<Record<string, string | boolean | undefined>>,
  required: boolean,
): { readonly env: "dev" | "prod" | null; readonly error?: RigError } => {
  const dev = values.dev === true
  const prod = values.prod === true

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
      ...(command === "start" ? { foreground: { type: "boolean" } } : {}),
    })

    if ("error" in parsed) {
      return yield* fail(parsed.error)
    }

    if (parsed.values.help || parsed.positionals[0] === "help") {
      return yield* showCommandHelp(command)
    }

    const env = resolveEnv(command, parsed.values, true)
    if (env.error) {
      return yield* fail(env.error)
    }

    if (command === "deploy") {
      const validated = validate(
        command,
        DeployArgsSchema,
        { name: parsed.positionals[0], env: env.env },
        "rig deploy <name> --dev|--prod",
      )

      if ("error" in validated) {
        return yield* fail(validated.error)
      }

      return yield* runDeployCommand(validated.data)
    }

    if (command === "start") {
      const validated = validate(
        command,
        StartArgsSchema,
        {
          name: parsed.positionals[0],
          env: env.env,
          foreground: parsed.values.foreground === true,
        },
        "rig start <name> --dev|--prod [--foreground]",
      )

      if ("error" in validated) {
        return yield* fail(validated.error)
      }

      return yield* runStartCommand(validated.data)
    }

    if (command === "stop") {
      const validated = validate(
        command,
        StopArgsSchema,
        { name: parsed.positionals[0], env: env.env },
        "rig stop <name> --dev|--prod",
      )

      if ("error" in validated) {
        return yield* fail(validated.error)
      }

      return yield* runStopCommand(validated.data)
    }

    const validated = validate(
      command,
      RestartArgsSchema,
      { name: parsed.positionals[0], env: env.env },
      "rig restart <name> --dev|--prod",
    )

    if ("error" in validated) {
      return yield* fail(validated.error)
    }

    return yield* runRestartCommand(validated.data)
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

    const payload = validate(
      "init",
      InitArgsSchema,
      {
        name: parsed.positionals[0],
        path: parsed.values.path,
      },
      "rig init <name> --path <project-path>",
    )

    if ("error" in payload || parsed.positionals.length > 1) {
      return yield* fail(
        "error" in payload
          ? payload.error
          : makeCliError("init", "Invalid arguments.", "Usage: rig init <name> --path <project-path>"),
      )
    }

    return yield* runInitCommand(payload.data)
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

    const payload = validate(
      "status",
      StatusArgsSchema,
      {
        name: parsed.positionals[0],
        env: env.env ?? undefined,
      },
      "rig status [<name>] [--dev|--prod]",
    )

    if ("error" in payload) {
      return yield* fail(payload.error)
    }

    return yield* runStatusCommand(payload.data)
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

    const env = resolveEnv("logs", parsed.values, true)
    if (env.error) {
      return yield* fail(env.error)
    }

    const payload = validate(
      "logs",
      LogsArgsSchema,
      {
        name: parsed.positionals[0],
        env: env.env,
        follow: parsed.values.follow === true,
        lines: parsed.values.lines ? Number(parsed.values.lines) : 50,
        service: typeof parsed.values.service === "string" ? parsed.values.service : undefined,
      },
      "rig logs <name> --dev|--prod [--follow] [--lines <n>] [--service <name>]",
    )

    if ("error" in payload || parsed.positionals.length > 1) {
      return yield* fail(
        "error" in payload
          ? payload.error
          : makeCliError(
              "logs",
              "Invalid arguments.",
              "Usage: rig logs <name> --dev|--prod [--follow] [--lines <n>] [--service <name>]",
            ),
      )
    }

    return yield* runLogsCommand(payload.data)
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

    const payload = validate(
      "version",
      VersionArgsSchema,
      {
        name: parsed.positionals[0],
        action: parsed.positionals[1] ?? "show",
      },
      "rig version <name> [patch|minor|major|undo|list]",
    )

    if ("error" in payload || parsed.positionals.length > 2) {
      return yield* fail(
        "error" in payload
          ? payload.error
          : makeCliError(
              "version",
              "Invalid arguments.",
              "Usage: rig version <name> [patch|minor|major|undo|list]",
            ),
      )
    }

    return yield* runVersionCommand(payload.data)
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

    const schema = command === "list" ? ListArgsSchema : ConfigArgsSchema
    const payload = validate(command, schema, {}, `rig ${command}`)

    if ("error" in payload) {
      return yield* fail(payload.error)
    }

    return command === "list" ? yield* runListCommand() : yield* runConfigCommand()
  })

const parseSetup = (args: readonly string[]) =>
  Effect.gen(function* () {
    const parsed = parseWithOptions("setup", args, {
      help: { type: "boolean", short: "h" },
    })

    if ("error" in parsed) {
      return yield* fail(parsed.error)
    }

    if (parsed.values.help || parsed.positionals[0] === "help") {
      return yield* showCommandHelp("setup")
    }

    if (parsed.positionals.length > 0) {
      return yield* fail(
        makeCliError("setup", "Unexpected positional arguments.", "Usage: rig setup"),
      )
    }

    const payload = validate("setup", SetupArgsSchema, {}, "rig setup")
    if ("error" in payload) {
      return yield* fail(payload.error)
    }

    return yield* runSetupCommand()
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
    case "setup":
      return parseSetup(args)
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
