import * as fs from "node:fs"
import * as path from "node:path"
import { parseArgs } from "node:util"
import { Effect } from "effect"
import { z } from "zod"

import { runConfigCommand } from "../core/config-command.js"
import { runDocsCommand } from "../core/docs-command.js"
import { runConfigSetCommand } from "../core/config-set-command.js"
import { runConfigUnsetCommand } from "../core/config-unset-command.js"
import { runDeployCommand } from "../core/deploy.js"
import { runInitCommand } from "../core/init.js"
import { runListCommand } from "../core/list.js"
import { runLogsCommand } from "../core/logs.js"
import { runRestartCommand, runStartCommand, runStopCommand } from "../core/lifecycle.js"
import { runStatusCommand } from "../core/status.js"
import { runVersionCommand } from "../core/version.js"
import { Logger } from "../interfaces/logger.js"
import {
  ConfigArgsSchema,
  ConfigSetArgsSchema,
  ConfigUnsetArgsSchema,
  DeployArgsSchema,
  DocsArgsSchema,
  InitArgsSchema,
  ListArgsSchema,
  LogsArgsSchema,
  RestartArgsSchema,
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

type ResolvedProjectName =
  | { readonly name: string }
  | { readonly error: "no-rig-json" }
  | { readonly error: "no-name-field" }

type EnvName = "dev" | "prod"

const ENV_NAMES = new Set<EnvName>(["dev", "prod"])
const SEMVER_RE = /^\d+\.\d+\.\d+$/
const BUMP_NAMES = new Set(["patch", "minor", "major"])
const GLOBAL_FLAG_NAMES = new Set(["--verbose", "--json"])

const makeCliError = (
  command: string,
  message: string,
  hint: string,
  details?: Record<string, unknown>,
): CliArgumentError => new CliArgumentError(command, message, hint, details)

const isEnvName = (value: string | undefined): value is EnvName =>
  value === "dev" || value === "prod"

const isSemver = (value: string | undefined): value is string =>
  typeof value === "string" && SEMVER_RE.test(value)

const resolveProjectName = (positional: string | undefined): ResolvedProjectName => {
  const explicit = positional?.trim()
  if (explicit && explicit.length > 0) {
    return { name: explicit }
  }

  const rigJsonPath = path.join(process.cwd(), "rig.json")
  if (!fs.existsSync(rigJsonPath)) {
    return { error: "no-rig-json" }
  }

  try {
    const raw = fs.readFileSync(rigJsonPath, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { error: "no-name-field" }
    }

    const name = (parsed as Record<string, unknown>).name
    if (typeof name !== "string" || name.trim().length === 0) {
      return { error: "no-name-field" }
    }

    return { name: name.trim() }
  } catch {
    return { error: "no-name-field" }
  }
}

const projectNameError = (
  command: "deploy" | "start" | "stop" | "restart" | "status" | "logs" | "version" | "config",
  error: "no-rig-json" | "no-name-field",
  usage: string,
): CliArgumentError => {
  if (error === "no-rig-json") {
    return makeCliError(
      command,
      `No rig.json found in current directory. Specify a project name: ${usage}`,
      `Usage: ${usage}`,
    )
  }

  return makeCliError(
    command,
    'rig.json found but missing a valid "name" field.',
    `Specify a project name: ${usage}`,
  )
}

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

const readVersionFlag = (
  values: Readonly<Record<string, string | boolean | undefined>>,
): string | undefined => (typeof values.version === "string" ? values.version : undefined)

const validateProdOnlyVersionFlag = (
  command: "deploy" | "start" | "stop" | "status" | "logs",
  env: EnvName | null,
  version: string | undefined,
): RigError | undefined => {
  if (!version || env === "prod") {
    return undefined
  }

  return makeCliError(
    command,
    "The --version flag is only supported with prod.",
    "Use the prod environment when selecting a deployed version.",
    { env, version },
  )
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

    if (error._tag === "CliArgumentError") {
      if (error.command === "global") {
        yield* logger.info(`\n${renderMainHelp()}`)
      } else if (isCommandName(error.command)) {
        yield* logger.info(`\n${renderCommandHelp(error.command)}`)
      }
    }

    return 1
  })

const resolveNameAndRequiredEnv = (
  command: "deploy" | "start" | "stop" | "restart" | "logs",
  positionals: readonly string[],
  usage: string,
): { readonly namePositional?: string; readonly env: EnvName } | { readonly error: RigError } => {
  if (positionals.length === 0) {
    return {
      error: makeCliError(command, "Missing environment argument.", `Usage: ${usage}`),
    }
  }

  if (isEnvName(positionals[0])) {
    if (positionals.length > 1) {
      return {
        error: makeCliError(command, "Too many positional arguments.", `Usage: ${usage}`),
      }
    }

    return { env: positionals[0] }
  }

  if (positionals.length < 2 || !isEnvName(positionals[1])) {
    return {
      error: makeCliError(command, "Missing environment argument.", `Usage: ${usage}`),
    }
  }

  if (positionals.length > 2) {
    return {
      error: makeCliError(command, "Too many positional arguments.", `Usage: ${usage}`),
    }
  }

  return {
    namePositional: positionals[0],
    env: positionals[1],
  }
}

const resolveOptionalNameAndEnv = (
  positionals: readonly string[],
): { readonly name?: string; readonly env?: EnvName; readonly error?: RigError } => {
  if (positionals.length === 0) {
    return {}
  }

  if (positionals.length === 1) {
    if (isEnvName(positionals[0])) {
      return { env: positionals[0] }
    }

    return { name: positionals[0] }
  }

  if (positionals.length === 2 && isEnvName(positionals[1])) {
    return { name: positionals[0], env: positionals[1] }
  }

  return {
    error: makeCliError("status", "Too many positional arguments.", "Usage: rig status [name] [dev|prod] [--version <semver>]"),
  }
}

const parseLifecycleCommand = (
  command: "deploy" | "start" | "stop" | "restart",
  args: readonly string[],
) =>
  Effect.gen(function* () {
    const parsed = parseWithOptions(command, args, {
      help: { type: "boolean", short: "h" },
      ...(command !== "restart" ? { version: { type: "string" } } : {}),
      ...(command === "start" ? { foreground: { type: "boolean" } } : {}),
      ...(command === "deploy"
        ? {
            bump: { type: "string" },
            revert: { type: "string" },
          }
        : {}),
    })

    if ("error" in parsed) {
      return yield* fail(parsed.error)
    }

    if (parsed.values.help || parsed.positionals[0] === "help") {
      return yield* showCommandHelp(command)
    }

    const usage =
      command === "deploy"
        ? "rig deploy [name] <dev|prod> [--version <semver>] [--bump <patch|minor|major>] [--revert <semver>]"
        : command === "start"
          ? "rig start [name] <dev|prod> [--version <semver>] [--foreground]"
          : command === "stop"
            ? "rig stop [name] <dev|prod> [--version <semver>]"
            : "rig restart [name] <dev|prod>"

    const resolved = resolveNameAndRequiredEnv(command, parsed.positionals, usage)
    if ("error" in resolved) {
      return yield* fail(resolved.error)
    }

    const version = command !== "restart" ? readVersionFlag(parsed.values) : undefined
    if (command !== "restart") {
      const versionError = validateProdOnlyVersionFlag(command, resolved.env, version)
      if (versionError) {
        return yield* fail(versionError)
      }
    }

    const project = resolveProjectName(resolved.namePositional)
    if ("error" in project) {
      return yield* fail(projectNameError(command, project.error, usage))
    }

    if (command === "deploy") {
      const validated = validate(
        command,
        DeployArgsSchema,
        {
          name: project.name,
          env: resolved.env,
          version,
          bump: typeof parsed.values.bump === "string" ? parsed.values.bump : undefined,
          revert: typeof parsed.values.revert === "string" ? parsed.values.revert : undefined,
        },
        usage,
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
          name: project.name,
          env: resolved.env,
          version,
          foreground: parsed.values.foreground === true,
        },
        usage,
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
        {
          name: project.name,
          env: resolved.env,
          version,
        },
        usage,
      )

      if ("error" in validated) {
        return yield* fail(validated.error)
      }

      return yield* runStopCommand(validated.data)
    }

    const validated = validate(
      command,
      RestartArgsSchema,
      {
        name: project.name,
        env: resolved.env,
      },
      usage,
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
      version: { type: "string" },
    })

    if ("error" in parsed) {
      return yield* fail(parsed.error)
    }

    if (parsed.values.help || parsed.positionals[0] === "help") {
      return yield* showCommandHelp("status")
    }

    const resolved = resolveOptionalNameAndEnv(parsed.positionals)
    if (resolved.error) {
      return yield* fail(resolved.error)
    }

    const version = readVersionFlag(parsed.values)
    const versionError = validateProdOnlyVersionFlag("status", resolved.env ?? null, version)
    if (versionError) {
      return yield* fail(versionError)
    }

    if (version && !resolved.name) {
      return yield* fail(
        makeCliError(
          "status",
          "A project name is required when using --version.",
          "Usage: rig status <name> prod --version <semver>",
          { version },
        ),
      )
    }

    const payload = validate(
      "status",
      StatusArgsSchema,
      {
        name: resolved.name,
        env: resolved.env,
        version,
      },
      "rig status [name] [dev|prod] [--version <semver>]",
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
      version: { type: "string" },
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

    const usage = "rig logs [name] <dev|prod> [--version <semver>] [--follow] [--lines <n>] [--service <name>]"
    const resolved = resolveNameAndRequiredEnv("logs", parsed.positionals, usage)
    if ("error" in resolved) {
      return yield* fail(resolved.error)
    }

    const version = readVersionFlag(parsed.values)
    const versionError = validateProdOnlyVersionFlag("logs", resolved.env, version)
    if (versionError) {
      return yield* fail(versionError)
    }

    const project = resolveProjectName(resolved.namePositional)
    if ("error" in project) {
      return yield* fail(projectNameError("logs", project.error, usage))
    }

    const payload = validate(
      "logs",
      LogsArgsSchema,
      {
        name: project.name,
        env: resolved.env,
        version,
        follow: parsed.values.follow === true,
        lines: parsed.values.lines ? Number(parsed.values.lines) : 50,
        service: typeof parsed.values.service === "string" ? parsed.values.service : undefined,
      },
      usage,
    )

    if ("error" in payload) {
      return yield* fail(payload.error)
    }

    return yield* runLogsCommand(payload.data)
  })

const parseVersion = (args: readonly string[]) =>
  Effect.gen(function* () {
    const parsed = parseWithOptions("version", args, {
      help: { type: "boolean", short: "h" },
      edit: { type: "string" },
    })

    if ("error" in parsed) {
      return yield* fail(parsed.error)
    }

    if (parsed.values.help || parsed.positionals[0] === "help") {
      return yield* showCommandHelp("version")
    }

    const usage = "rig version [name] [<semver>] [--edit <semver|patch|minor|major>]"
    let namePositional: string | undefined
    let targetVersion: string | undefined

    if (parsed.positionals.length === 1) {
      if (isSemver(parsed.positionals[0])) {
        targetVersion = parsed.positionals[0]
      } else {
        namePositional = parsed.positionals[0]
      }
    } else if (parsed.positionals.length === 2) {
      if (isSemver(parsed.positionals[1])) {
        namePositional = parsed.positionals[0]
        targetVersion = parsed.positionals[1]
      } else {
        return yield* fail(makeCliError("version", "Invalid arguments.", `Usage: ${usage}`))
      }
    } else if (parsed.positionals.length > 2) {
      return yield* fail(makeCliError("version", "Invalid arguments.", `Usage: ${usage}`))
    }

    const edit = typeof parsed.values.edit === "string" ? parsed.values.edit : undefined
    if (edit && !isSemver(edit) && !BUMP_NAMES.has(edit)) {
      return yield* fail(makeCliError("version", "Invalid arguments.", `Usage: ${usage}`))
    }

    const project = resolveProjectName(namePositional)
    if ("error" in project) {
      return yield* fail(projectNameError("version", project.error, usage))
    }

    const payload = validate(
      "version",
      VersionArgsSchema,
      {
        name: project.name,
        targetVersion,
        edit,
      },
      usage,
    )

    if ("error" in payload) {
      return yield* fail(payload.error)
    }

    return yield* runVersionCommand(payload.data)
  })

const parseSimpleCommand = (command: "list", args: readonly string[]) =>
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

    const payload = validate(command, ListArgsSchema, {}, `rig ${command}`)

    if ("error" in payload) {
      return yield* fail(payload.error)
    }

    return yield* runListCommand()
  })

const parseDocs = (args: readonly string[]) =>
  Effect.gen(function* () {
    const parsed = parseWithOptions("docs", args, {
      help: { type: "boolean", short: "h" },
    })

    if ("error" in parsed) {
      return yield* fail(parsed.error)
    }

    if (parsed.values.help || parsed.positionals[0] === "help") {
      return yield* showCommandHelp("docs")
    }

    if (parsed.positionals.length > 2) {
      return yield* fail(
        makeCliError("docs", "Too many positional arguments.", "Usage: rig docs [config [<key>]]"),
      )
    }

    const payload = validate(
      "docs",
      DocsArgsSchema,
      {
        topic: parsed.positionals[0],
        key: parsed.positionals[1],
      },
      "rig docs [config [<key>]]",
    )

    if ("error" in payload) {
      return yield* fail(payload.error)
    }

    return yield* runDocsCommand(payload.data.topic, payload.data.key)
  })

const parseConfig = (args: readonly string[]) =>
  Effect.gen(function* () {
    const parsed = parseWithOptions("config", args, {
      help: { type: "boolean", short: "h" },
    })

    if ("error" in parsed) {
      return yield* fail(parsed.error)
    }

    if (parsed.values.help || parsed.positionals[0] === "help") {
      return yield* showCommandHelp("config")
    }

    if (parsed.positionals[0] === "set" || parsed.positionals[0] === "unset") {
      const isUnset = parsed.positionals[0] === "unset"
      const setPositionals = parsed.positionals.slice(1)
      const usage = isUnset ? "rig config unset [name] <key>" : "rig config set [name] <key> <value>"

      const validArity = isUnset
        ? setPositionals.length === 1 || setPositionals.length === 2
        : setPositionals.length === 2 || setPositionals.length === 3

      if (!validArity) {
        return yield* fail(
          makeCliError(
            "config",
            "Invalid arguments.",
            `Usage: ${usage}`,
          ),
        )
      }

      const key = isUnset
        ? setPositionals[setPositionals.length - 1]
        : setPositionals[setPositionals.length - 2]
      const value = isUnset ? undefined : setPositionals[setPositionals.length - 1]

      const project =
        setPositionals.length === (isUnset ? 2 : 3)
          ? resolveProjectName(setPositionals[0])
          : resolveProjectName(undefined)
      if ("error" in project) {
        return yield* fail(projectNameError("config", project.error, usage))
      }

      if (isUnset) {
        const payload = validate(
          "config",
          ConfigUnsetArgsSchema,
          {
            name: project.name,
            key,
          },
          usage,
        )

        if ("error" in payload) {
          return yield* fail(payload.error)
        }

        return yield* runConfigUnsetCommand(payload.data.name, payload.data.key)
      }

      const payload = validate(
        "config",
        ConfigSetArgsSchema,
        {
          name: project.name,
          key,
          value,
        },
        usage,
      )

      if ("error" in payload) {
        return yield* fail(payload.error)
      }

      return yield* runConfigSetCommand(payload.data.name, payload.data.key, payload.data.value)
    }

    if (parsed.positionals.length > 1) {
      return yield* fail(
        makeCliError("config", "Too many positional arguments.", "Usage: rig config [name]"),
      )
    }

    const usage = "rig config [name]"
    const project = resolveProjectName(parsed.positionals[0])
    if ("error" in project) {
      return yield* fail(projectNameError("config", project.error, usage))
    }

    const payload = validate("config", ConfigArgsSchema, { name: project.name }, usage)

    if ("error" in payload) {
      return yield* fail(payload.error)
    }

    return yield* runConfigCommand(project.name)
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
    case "docs":
      return parseDocs(args)
    case "list":
      return parseSimpleCommand(command, args)
    case "config":
      return parseConfig(args)
  }
}

export const runCli = (argv: readonly string[]) =>
  Effect.gen(function* () {
    const normalizedArgv = argv.filter((arg) => !GLOBAL_FLAG_NAMES.has(arg))
    const logger = yield* Logger

    if (normalizedArgv.length === 0) {
      yield* logger.info(renderMainHelp())
      return 0
    }

    const [head, ...rest] = normalizedArgv

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
      return yield* fail(
        makeCliError(
          "global",
          `Unknown command: ${head}`,
          "Run `rig --help` to see available commands.",
          { commands: COMMANDS },
        ),
      )
    }

    return yield* runCommand(head, rest)
  })
