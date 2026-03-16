export const COMMANDS = [
  "deploy",
  "init",
  "start",
  "stop",
  "restart",
  "status",
  "logs",
  "version",
  "docs",
  "list",
  "config",
] as const

export type CommandName = (typeof COMMANDS)[number]

interface HelpSpec {
  readonly summary: string
  readonly usage: string[]
  readonly examples: string[]
  readonly notes?: string[]
}

const HELP: Record<CommandName, HelpSpec> = {
  deploy: {
    summary: "Apply rig.json changes and reconcile deployment state.",
    usage: [
      "rig deploy [name] <dev|prod> [--version <semver>] [--bump <patch|minor|major>] [--revert <semver>]",
      "rig deploy --help",
    ],
    examples: [
      "rig deploy pantry dev",
      "rig deploy pantry prod",
      "rig deploy pantry prod --bump minor",
      "rig deploy pantry prod --version 1.2.3",
      "rig deploy pantry prod --revert 1.2.3",
    ],
    notes: [
      "`--version` is supported on prod only.",
      "`--bump`, `--version`, and `--revert` are mutually exclusive.",
    ],
  },
  init: {
    summary: "Initialize a project and register its path.",
    usage: ["rig init <name> --path <project-path>", "rig init --help"],
    examples: ["rig init pantry --path ~/Projects/pantry"],
  },
  start: {
    summary: "Start all configured services for an environment.",
    usage: ["rig start [name] <dev|prod> [--version <semver>] [--foreground]", "rig start --help"],
    examples: [
      "rig start pantry dev",
      "rig start pantry prod",
      "rig start pantry prod --version 1.2.3",
      "rig start pantry prod --foreground",
    ],
    notes: ["`--version` is supported on prod only."],
  },
  stop: {
    summary: "Stop all running services for an environment.",
    usage: ["rig stop [name] <dev|prod> [--version <semver>]", "rig stop --help"],
    examples: ["rig stop pantry dev", "rig stop pantry prod", "rig stop pantry prod --version 1.2.3"],
    notes: ["`--version` is supported on prod only."],
  },
  restart: {
    summary: "Restart all services and run lifecycle hooks.",
    usage: ["rig restart [name] <dev|prod>", "rig restart --help"],
    examples: ["rig restart pantry dev", "rig restart pantry prod"],
  },
  status: {
    summary: "Show deployment status, including latest and current prod versions.",
    usage: ["rig status [name] [dev|prod] [--version <semver>]", "rig status --help"],
    examples: ["rig status", "rig status pantry", "rig status pantry prod", "rig status pantry prod --version 1.2.3"],
    notes: ["`--version` is supported on prod only and requires an explicit project name."],
  },
  logs: {
    summary: "Show service logs with optional streaming and filtering.",
    usage: [
      "rig logs [name] <dev|prod> [--version <semver>] [--follow] [--lines <n>] [--service <name>]",
      "rig logs --help",
    ],
    examples: [
      "rig logs pantry dev --follow",
      "rig logs pantry prod --lines 100 --service web",
      "rig logs pantry prod --version 1.2.3 --service web",
    ],
    notes: ["`--version` is supported on prod only."],
  },
  version: {
    summary: "Inspect release history and release details.",
    usage: [
      "rig version [name] [<semver>] [--edit <semver|patch|minor|major>]",
      "rig version --help",
    ],
    examples: [
      "rig version pantry",
      "rig version pantry 1.2.3",
      "rig version pantry 1.2.3 --edit 1.3.0",
      "rig version 1.2.3 --edit minor",
    ],
  },
  docs: {
    summary: "Browse built-in documentation topics, config schema keys, and onboarding guides.",
    usage: [
      "rig docs",
      "rig docs config",
      "rig docs config <key>",
      "rig docs onboard",
      "rig docs onboard <topic>",
      "rig docs --help",
    ],
    examples: [
      "rig docs",
      "rig docs config",
      "rig docs config environments.prod",
      "rig docs config environments.dev.services[]",
      "rig docs onboard",
      "rig docs onboard nextjs",
      "rig docs onboard convex",
    ],
  },
  list: {
    summary: "List registered projects and current prod deployment.",
    usage: ["rig list", "rig list --help"],
    examples: ["rig list"],
  },
  config: {
    summary: "Show project configuration overview.",
    usage: [
      "rig config [name]",
      "rig config set [name] <key> <value>",
      "rig config unset [name] <key>",
      "rig config --help",
    ],
    examples: [
      "rig config myapp",
      "rig config  (auto-detects from cwd)",
      "rig config set myapp description 'Core API service'",
      "rig config set domain example.com",
      "rig config unset myapp description",
    ],
    notes: [
      "Run `rig docs config` to browse the full rig.json key catalog and descriptions.",
      "`rig config set` only supports primitive values and non-array schema paths.",
      "`rig config unset` removes optional primitive keys or sets nullable primitive keys to null.",
    ],
  },
}

export const isCommandName = (value: string): value is CommandName =>
  (COMMANDS as readonly string[]).includes(value)

const renderSpec = (name: CommandName): string => {
  const spec = HELP[name]
  const usage = spec.usage.map((line) => `  ${line}`).join("\n")
  const examples = spec.examples.map((line) => `  ${line}`).join("\n")
  const notes = spec.notes?.map((line) => `  ${line}`).join("\n")

  return [
    `${name.toUpperCase()}`,
    `${spec.summary}`,
    "",
    "Usage:",
    usage,
    "",
    "Examples:",
    examples,
    ...(notes ? ["", "Notes:", notes] : []),
  ].join("\n")
}

export const renderCommandHelp = (command: CommandName): string => renderSpec(command)

export const renderMainHelp = (): string => {
  const commandLines = COMMANDS
    .map((command) => `  ${command.padEnd(8)} ${HELP[command].summary}`)
    .join("\n")

  return [
    "rig - Local Mac Deployment Manager",
    "",
    "Usage:",
    "  rig <command> [options]",
    "",
    "Commands:",
    commandLines,
    "",
    "Global Patterns:",
    "  --help, -h     Show help for command",
    "  --verbose      Show detailed error information",
    "  --json         Emit newline-delimited JSON log events",
    "  <dev|prod>     Positional environment selector for environment-scoped commands",
    "  --version      Prod-only deployed version selector for deploy/start/stop/status/logs",
    "  --bump         Prod-only release bump selector for deploy",
    "  --revert       Prod-only latest-release removal selector for deploy",
    "  --foreground   Start command only; stay attached for launchd mode",
    "",
    "Examples:",
    "  rig deploy pantry prod",
    "  rig deploy pantry prod --bump minor",
    "  rig logs pantry dev --follow",
    "",
    "Run `rig <command> --help` for detailed command docs.",
  ].join("\n")
}
