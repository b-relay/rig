import { Command, InvalidArgumentError } from "commander";
import { resolve } from "node:path";
import {
  previewName,
  projectName,
  type RuntimeCommand,
} from "../daemon/protocol";
import { RigError } from "../domain/errors";
import { PREVIEW_SELECTOR } from "../config/schema";
import { terminalText } from "./terminal-text";
import { RIG_VERSION } from "../domain/version";
import type { UserOutput } from "./types";

export type ExecuteCommand = (
  request: RuntimeCommand,
  options?: { json?: boolean; follow?: boolean },
) => Promise<void>;
interface ScopeOptions {
  project?: string;
  json?: boolean;
  deployment?: string;
  destroy?: boolean;
}

/** The command grammar owns usage validation; runtime policy stays behind the client. */
export function createRigCommand(
  cwd: string,
  output: UserOutput,
  execute: ExecuteCommand,
): Command {
  const command = terminalCommand("rig", output).description(
    "Manage Projects and their Targets on this Host.",
  );
  for (const action of [
    "list",
    "status",
    "doctor",
    "config",
    "activity",
  ] as const) {
    const child = command.command(action).description(
      {
        list: "List registered Projects.",
        status: "Observe all Targets for one Project.",
        doctor: "Check Host and optional Project health.",
        config: "Inspect validated Project configuration.",
        activity: "Read recent Rig activity.",
      }[action],
    );
    if (!["list", "activity"].includes(action))
      child.option("--project <name>", "Registered Project identity");
    if (action === "status")
      child.option("--json", "Render the observed report as JSON");
    if (action === "activity")
      child
        .argument(
          "[operation]",
          "Show one Operation by the id a failed command printed",
        )
        .action(async (operation: string | undefined, options: ScopeOptions) =>
          execute(
            {
              action,
              repoPath: cwd,
              ...projectScope(options),
              ...(operation ? { operation } : {}),
            },
            { json: options.json },
          ),
        );
    else
      child.action(async (options: ScopeOptions) =>
        execute(
          { action, repoPath: cwd, ...projectScope(options) },
          { json: options.json },
        ),
      );
  }
  addLifecycleCommands(command, cwd, execute);
  addDeployCommands(command, cwd, execute);
  addInitCommand(command, cwd, execute);
  addLogsCommand(command, cwd, execute);
  addHelpCommand(command, "rig");
  command
    .command("rename")
    .description("Rename a Project after its Targets are stopped.")
    .argument("<name>", "New Project identity", nonEmpty)
    .option("--project <name>", "Current registered Project identity")
    .action(async (newName: string, options: ScopeOptions) =>
      execute({
        action: "rename",
        repoPath: cwd,
        newName,
        ...projectScope(options),
      }),
    );
  command
    .command("repoint")
    .description("Register a new repository path for a stopped Project.")
    .argument("<path>", "New repository path", nonEmpty)
    .option("--project <name>", "Registered Project identity")
    .action(async (path: string, options: ScopeOptions) =>
      execute({
        action: "repoint",
        repoPath: cwd,
        newPath: resolve(cwd, path),
        ...projectScope(options),
      }),
    );
  command
    .command("forget")
    .description(
      "Remove a stopped Project's registration; its repository is untouched.",
    )
    .argument("<name>", "Registered Project identity", nonEmpty)
    .action(async (project: string) =>
      execute({ action: "forget", repoPath: cwd, project }),
    );
  return command;
}
/** `help [command...]` shows one command's usage or names the command that does not exist;
 * commander's implicit help command would report an unknown name silently. */
export function addHelpCommand(command: Command, executable: string): void {
  command
    .command("help")
    .description("Show help for a command.")
    .argument("[command...]", "Command path, for example deploy preview")
    .action((path: string[]) => {
      let current = command;
      for (const name of path) {
        const next = subcommand(current, name);
        if (!next)
          throw new RigError(
            "USAGE",
            `Unknown command '${terminalText(name)}'.`,
            `Run ${executable} --help.`,
          );
        current = next;
      }
      current.help();
    });
}
/** The subcommand path the arguments name, so a usage error can point at that command's help. */
export function commandPath(
  command: Command,
  args: readonly string[],
): string[] {
  const path: string[] = [];
  let current = command;
  for (const arg of args) {
    const next = subcommand(current, arg);
    if (!next) break;
    path.push(next.name());
    current = next;
  }
  return path;
}
function subcommand(command: Command, name: string): Command | undefined {
  return command.commands.find(
    (candidate) =>
      candidate.name() === name || candidate.aliases().includes(name),
  );
}
export function terminalCommand(name: string, output: UserOutput): Command {
  return new Command(name)
    .version(RIG_VERSION, "-V, --version", "Print the version.")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => output.write(text),
      writeErr: () => {},
    });
}
function projectScope(options: ScopeOptions): { project?: string } {
  if (options.project === undefined) return {};
  if (!projectName.safeParse(options.project).success)
    throw new RigError(
      "USAGE",
      `The --project name is ${
        options.project.length
          ? `${options.project.length} characters long`
          : "empty"
      }; Project names have 1 to 128 characters.`,
      "Pass the registered Project name shown by rig list.",
    );
  return { project: options.project };
}
/** A Preview name the daemon would accept; anything else is named here, before a request exists. */
function previewScope(options: Pick<ScopeOptions, "deployment">): {
  deployment?: string;
} {
  if (options.deployment === undefined) return {};
  if (!previewName.safeParse(options.deployment).success)
    throw new RigError(
      "USAGE",
      options.deployment.length
        ? `The --deployment name '${terminalText(options.deployment)}' is not a valid Preview name.`
        : "The --deployment name is empty.",
      "Use letters, digits, '_' or '-', starting with a letter or digit.",
    );
  return { deployment: options.deployment };
}

function addLifecycleCommands(
  command: Command,
  cwd: string,
  execute: ExecuteCommand,
): void {
  for (const action of ["up", "down", "restart"] as const) {
    const child = command
      .command(action)
      .description(
        `${action === "up" ? "Start" : action === "down" ? "Stop" : "Restart"} a recorded Target.`,
      )
      .argument(
        "[target]",
        "Target name (local and live unless rig.yaml renames them) or preview",
      )
      .argument("[branch]", "Preview Branch or name", nonEmpty)
      .option("--project <name>", "Registered Project identity")
      .option("--json", "Render the final domain result as JSON")
      .option("--deployment <name>", "Explicit Preview name");
    if (action === "down")
      child.option(
        "--destroy",
        "Destroy a Preview including its owned data, logs, and source history",
      );
    child.action(
      async (
        target: string | undefined,
        branch: string | undefined,
        options: ScopeOptions,
      ) => {
        if (options.destroy && target !== PREVIEW_SELECTOR)
          throw new RigError(
            "USAGE",
            "Only a Preview can be destroyed.",
            "Use rig down preview <branch> --destroy.",
          );
        const request = targetRequest(action, target, branch, cwd, options);
        await execute(
          {
            ...request,
            ...(options.destroy ? { action: "destroy" as const } : {}),
          },
          { json: options.json },
        );
      },
    );
  }
}
function addDeployCommands(
  command: Command,
  cwd: string,
  execute: ExecuteCommand,
): void {
  const deploy = command
    .command("deploy")
    .description("Deploy a Branch to the Stable Target or a Preview.")
    .argument(
      "[target]",
      "The Stable Target's name (live unless rig.yaml renames it) or preview",
    )
    .argument(
      "[branch]",
      "Source Branch (defaults to Production for the Stable Target, current Branch for preview)",
      nonEmpty,
    )
    .option("--project <name>", "Registered Project identity")
    .option("--force", "Redeploy even when the selected Commit is unchanged")
    .option(
      "--no-up",
      "Deploy without starting; a running Target is stopped until rig up",
    )
    .option("--deployment <name>", "Explicit Preview name")
    .option("--json", "Render the final domain result as JSON");
  deploy.action(
    async (
      target: string | undefined,
      branch: string | undefined,
      options: ScopeOptions & { force?: boolean; up?: boolean },
    ) => {
      if (target === undefined || target === "help") deploy.help();
      if (options.deployment && target !== PREVIEW_SELECTOR)
        throw new RigError(
          "USAGE",
          "Only a Preview takes --deployment.",
          "Use rig deploy preview --deployment <name>.",
        );
      await execute(
        {
          action: "deploy",
          repoPath: cwd,
          target,
          ...projectScope(options),
          ...(branch ? { branch } : {}),
          ...(options.force ? { force: true } : {}),
          ...(options.up === false ? { noUp: true } : {}),
          ...previewScope(options),
        },
        { json: options.json },
      );
    },
  );
}
function addLogsCommand(
  command: Command,
  cwd: string,
  execute: ExecuteCommand,
): void {
  command
    .command("logs")
    .description("Read recent Target logs, including stopped Targets.")
    .argument(
      "[target]",
      "Target name (local and live unless rig.yaml renames them) or preview",
    )
    .argument("[branch]", "Preview Branch or name", nonEmpty)
    .option("--project <name>", "Registered Project identity")
    .option("--deployment <name>", "Explicit Preview name")
    .option("--follow", "Follow new output until interrupted")
    .option("--lines <count>", "Number of recent entries", positiveInteger, 50)
    .action(
      async (
        target: string | undefined,
        branch: string | undefined,
        options: ScopeOptions & { lines: number; follow?: boolean },
      ) => {
        if (options.lines > 10000)
          throw new RigError(
            "USAGE",
            "Request at most 10000 recent log entries.",
            "Reduce --lines.",
          );
        await execute(
          {
            ...targetRequest("logs", target, branch, cwd, options),
            lines: options.lines,
          },
          { follow: options.follow },
        );
      },
    );
}
interface InitOptions extends ScopeOptions {
  path?: string;
  productionBranch?: string;
  domain?: string;
  service?: string;
  run?: string;
  port?: number;
  ready?: string;
  tool?: string;
  bin?: string;
  toolBuild?: string;
  createGit?: boolean;
}
function addInitCommand(
  command: Command,
  cwd: string,
  execute: ExecuteCommand,
): void {
  command
    .command("init")
    .description("Initialize YAML configuration and register a Project.")
    .option(
      "--project <name>",
      "Project identity (defaults to existing config or repository name)",
    )
    .option("--path <path>", "Repository to initialize", nonEmpty, ".")
    .option(
      "--production-branch <branch>",
      "Production Branch for the Stable Target",
      nonEmpty,
    )
    .option(
      "--create-git",
      "Explicitly initialize Git when the directory is not a repository",
    )
    .option(
      "--domain <domain>",
      "Domain the Stable Target serves; Previews get subdomains under it",
      nonEmpty,
    )
    .option("--service <name>", "Service name", nonEmpty)
    .option("--run <command>", "Command that runs the Service", nonEmpty)
    .option(
      "--port <port>",
      "Service localhost port (assigned automatically when omitted)",
      positiveInteger,
    )
    .option("--ready <check>", "Service readiness check", nonEmpty)
    .option("--tool <name>", "Tool name", nonEmpty)
    .option("--bin <path>", "Executable the Tool installs", nonEmpty)
    .option("--tool-build <command>", "Command that builds the Tool", nonEmpty)
    .action(async (options: InitOptions) => execute(initRequest(cwd, options)));
}
function initRequest(cwd: string, options: InitOptions): RuntimeCommand {
  const serviceRequested =
    options.service || options.run || options.port || options.ready;
  const toolRequested = options.tool || options.bin || options.toolBuild;
  if (serviceRequested && (!options.service || !options.run))
    throw new RigError(
      "USAGE",
      "A Service requires --service and --run.",
      "Run rig init --help.",
    );
  if (toolRequested && (!options.tool || !options.bin))
    throw new RigError(
      "USAGE",
      "A Tool requires --tool and --bin.",
      "Run rig init --help.",
    );
  if (options.port && options.port > 65535)
    throw new RigError(
      "USAGE",
      "A port must be between 1 and 65535.",
      "Correct --port.",
    );
  if (options.service && options.service === options.tool)
    throw new RigError(
      "USAGE",
      "A Tool cannot share a Service's name.",
      "Choose different --service and --tool names.",
    );
  return {
    action: "init",
    repoPath: resolve(cwd, options.path ?? "."),
    ...projectScope(options),
    ...(options.productionBranch
      ? { productionBranch: options.productionBranch }
      : {}),
    ...(options.createGit ? { createGit: true } : {}),
    ...(options.domain ? { domain: options.domain } : {}),
    ...(options.service && options.run
      ? {
          service: {
            name: options.service,
            run: options.run,
            ...(options.port ? { port: options.port } : {}),
            ...(options.ready ? { ready: options.ready } : {}),
          },
        }
      : {}),
    ...(options.tool && options.bin
      ? {
          tool: {
            name: options.tool,
            bin: options.bin,
            ...(options.toolBuild ? { build: options.toolBuild } : {}),
          },
        }
      : {}),
  };
}
function targetRequest(
  action: "up" | "down" | "restart" | "logs",
  target: string | undefined,
  branch: string | undefined,
  cwd: string,
  options: ScopeOptions,
): RuntimeCommand {
  const preview = previewScope(options);
  if (target === undefined) {
    if (branch || options.deployment)
      throw new RigError(
        "USAGE",
        "A Target is required.",
        "Pass a Target name or preview.",
      );
    return { action, repoPath: cwd, ...projectScope(options) };
  }
  if (
    (target === PREVIEW_SELECTOR && !branch && !options.deployment) ||
    (target !== PREVIEW_SELECTOR && (branch || options.deployment))
  )
    throw new RigError(
      "USAGE",
      "Choose a Target name or preview <branch>.",
      `Run rig ${action} --help.`,
    );
  // A Branch and --deployment can name different Previews; acting on one while the user typed the other is never safe.
  if (target === PREVIEW_SELECTOR && branch && options.deployment)
    throw new RigError(
      "USAGE",
      "Pass a Preview Branch or --deployment, not both.",
      `Use rig ${action} preview <branch> or rig ${action} preview --deployment <name>.`,
    );
  return {
    action,
    repoPath: cwd,
    target,
    ...(branch ? { branch } : {}),
    ...preview,
    ...projectScope(options),
  };
}
/** An empty value would otherwise be dropped by a truthiness check and silently mean "default". */
function nonEmpty(value: string): string {
  if (value.trim() === "") throw new InvalidArgumentError("It is empty.");
  return value;
}
function positiveInteger(value: string): number {
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1
  )
    throw new InvalidArgumentError("Use a positive whole number.");
  return Number(value);
}
