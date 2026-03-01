export const COMMANDS = [
  "deploy",
  "init",
  "start",
  "stop",
  "restart",
  "status",
  "logs",
  "version",
  "list",
  "config",
] as const;

export type CommandName = (typeof COMMANDS)[number];

interface HelpSpec {
  readonly summary: string;
  readonly usage: string[];
  readonly examples: string[];
}

const HELP: Record<CommandName, HelpSpec> = {
  deploy: {
    summary: "Apply rig.json changes and reconcile deployment state.",
    usage: ["rig deploy <name> --dev|--prod", "rig deploy --help"],
    examples: ["rig deploy pantry --dev", "rig deploy pantry --prod"],
  },
  init: {
    summary: "Initialize a project and register its path.",
    usage: ["rig init <name> --path <project-path>", "rig init --help"],
    examples: ["rig init pantry --path ~/Projects/pantry"],
  },
  start: {
    summary: "Start all configured services for an environment.",
    usage: ["rig start <name> --dev|--prod", "rig start --help"],
    examples: ["rig start pantry --dev", "rig start pantry --prod"],
  },
  stop: {
    summary: "Stop all running services for an environment.",
    usage: ["rig stop <name> --dev|--prod", "rig stop --help"],
    examples: ["rig stop pantry --dev", "rig stop pantry --prod"],
  },
  restart: {
    summary: "Restart all services and run lifecycle hooks.",
    usage: ["rig restart <name> --dev|--prod", "rig restart --help"],
    examples: ["rig restart pantry --dev", "rig restart pantry --prod"],
  },
  status: {
    summary: "Show deployment status for one or all projects.",
    usage: ["rig status [<name>] [--dev|--prod]", "rig status --help"],
    examples: ["rig status", "rig status pantry --prod"],
  },
  logs: {
    summary: "Show service logs with optional streaming and filtering.",
    usage: [
      "rig logs <name> --dev|--prod [--follow] [--lines <n>] [--service <name>]",
      "rig logs --help",
    ],
    examples: [
      "rig logs pantry --dev --follow",
      "rig logs pantry --prod --lines 100 --service web",
    ],
  },
  version: {
    summary: "Inspect or mutate production version metadata.",
    usage: [
      "rig version <name>",
      "rig version <name> patch|minor|major|undo|list",
      "rig version --help",
    ],
    examples: ["rig version pantry", "rig version pantry patch", "rig version pantry list"],
  },
  list: {
    summary: "List registered projects and current status.",
    usage: ["rig list", "rig list --help"],
    examples: ["rig list"],
  },
  config: {
    summary: "Show rig.json reference docs and defaults.",
    usage: ["rig config", "rig config --help"],
    examples: ["rig config --help"],
  },
};

export const isCommandName = (value: string): value is CommandName =>
  (COMMANDS as readonly string[]).includes(value);

const renderSpec = (name: CommandName): string => {
  const spec = HELP[name];
  const usage = spec.usage.map((line) => `  ${line}`).join("\n");
  const examples = spec.examples.map((line) => `  ${line}`).join("\n");

  return [
    `${name.toUpperCase()}`,
    `${spec.summary}`,
    "",
    "Usage:",
    usage,
    "",
    "Examples:",
    examples,
  ].join("\n");
};

export const renderCommandHelp = (command: CommandName): string => renderSpec(command);

export const renderMainHelp = (): string => {
  const commandLines = COMMANDS
    .map((command) => `  ${command.padEnd(8)} ${HELP[command].summary}`)
    .join("\n");

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
    "  --dev|--prod   Explicit environment flag where required",
    "",
    "Examples:",
    "  rig deploy pantry --prod",
    "  rig logs pantry --dev --follow",
    "  rig version pantry patch",
    "",
    "Run `rig <command> --help` for detailed command docs.",
  ].join("\n");
};
