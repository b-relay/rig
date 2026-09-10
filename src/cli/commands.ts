import { Command, InvalidArgumentError } from "commander";
import { resolve } from "node:path";
import type { RuntimeCommand } from "../daemon/protocol";
import { RigError } from "../domain/errors";
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
    const child = command
      .command(action)
      .description(
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
  command
    .command("rename")
    .description("Rename a Project after its Targets are stopped.")
    .argument("<name>", "New Project identity")
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
    .argument("<path>", "New repository path")
    .option("--project <name>", "Registered Project identity")
    .action(async (path: string, options: ScopeOptions) =>
      execute({
        action: "repoint",
        repoPath: cwd,
        newPath: resolve(cwd, path),
        ...projectScope(options),
      }),
    );
  return command;
}
export function terminalCommand(name: string, output: UserOutput): Command {
  return new Command(name)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => output.write(text),
      writeErr: () => {},
    });
}
function projectScope(options: ScopeOptions): { project?: string } {
  return options.project ? { project: options.project } : {};
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
      .argument("[target]", "local, live, or preview")
      .argument("[branch]", "Preview Branch or name")
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
        if (options.destroy && target !== "preview")
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
    .description("Deploy a Branch to a Stable Target or Preview.");
  deploy.action(() => {
    deploy.help();
  });
  for (const target of ["live", "preview"] as const) {
    const child = deploy
      .command(target)
      .description(
        target === "live"
          ? "Deploy the Production Branch."
          : "Deploy a Branch as a Preview.",
      )
      .argument(
        "[branch]",
        "Source Branch (defaults to Production for live, current Branch for preview)",
      )
      .option("--project <name>", "Registered Project identity")
      .option("--force", "Redeploy even when the selected Commit is unchanged")
      .option("--no-up", "Prepare the deployment without starting it")
      .option("--json", "Render the final domain result as JSON");
    if (target === "preview")
      child.option("--deployment <name>", "Explicit Preview name");
    child.action(
      async (
        branch: string | undefined,
        options: ScopeOptions & {
          force?: boolean;
          up?: boolean;
          deployment?: string;
        },
      ) => {
        await execute(
          {
            action: "deploy",
            repoPath: cwd,
            target,
            ...projectScope(options),
            ...(branch ? { branch } : {}),
            ...(options.force ? { force: true } : {}),
            ...(options.up === false ? { noUp: true } : {}),
            ...(options.deployment ? { deployment: options.deployment } : {}),
          },
          { json: options.json },
        );
      },
    );
  }
}
function addLogsCommand(
  command: Command,
  cwd: string,
  execute: ExecuteCommand,
): void {
  command
    .command("logs")
    .description("Read recent Target logs, including stopped Targets.")
    .argument("[target]", "local, live, or preview")
    .argument("[branch]", "Preview Branch or name")
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
  proxy?: string;
  uses?: string;
  managed?: string;
  managedCommand?: string;
  managedPort?: number;
  managedHealth?: string;
  installed?: string;
  installedEntrypoint?: string;
  installedBuild?: string;
  installedName?: string;
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
    .option("--path <path>", "Repository to initialize", ".")
    .option(
      "--production-branch <branch>",
      "Production Branch for the live Target",
    )
    .option(
      "--create-git",
      "Explicitly initialize Git when the directory is not a repository",
    )
    .option("--domain <domain>", "Base domain for configured routes")
    .option("--proxy <component>", "Proxy upstream component")
    .option(
      "--uses <plugins>",
      "Comma-separated sqlite, postgres, or convex components",
    )
    .option("--managed <name>", "Managed component name")
    .option("--managed-command <command>", "Managed component command")
    .option(
      "--managed-port <port>",
      "Managed component localhost port",
      positiveInteger,
    )
    .option("--managed-health <check>", "Managed component health check")
    .option("--installed <name>", "Installed component name")
    .option("--installed-entrypoint <path>", "Installed executable entrypoint")
    .option(
      "--installed-build <command>",
      "Build command for the installed executable",
    )
    .option("--installed-name <name>", "Installed executable name")
    .action(async (options: InitOptions) => execute(initRequest(cwd, options)));
}
function initRequest(cwd: string, options: InitOptions): RuntimeCommand {
  const uses = options.uses?.split(",").map((value) => value.trim());
  if (uses?.some((value) => !["sqlite", "postgres", "convex"].includes(value)))
    throw new RigError(
      "USAGE",
      "Choose sqlite, postgres, or convex for --uses.",
      "Run rig init --help.",
    );
  const managedRequested =
    options.managed ||
    options.managedCommand ||
    options.managedPort ||
    options.managedHealth;
  const installedRequested =
    options.installed ||
    options.installedEntrypoint ||
    options.installedBuild ||
    options.installedName;
  if (managedRequested && (!options.managed || !options.managedCommand))
    throw new RigError(
      "USAGE",
      "Managed components require --managed and --managed-command.",
      "Run rig init --help.",
    );
  if (
    installedRequested &&
    (!options.installed || !options.installedEntrypoint)
  )
    throw new RigError(
      "USAGE",
      "Installed components require --installed and --installed-entrypoint.",
      "Run rig init --help.",
    );
  if (options.managedPort && options.managedPort > 65535)
    throw new RigError(
      "USAGE",
      "A port must be between 1 and 65535.",
      "Correct --managed-port.",
    );
  if (options.managed && options.managed === options.installed)
    throw new RigError(
      "USAGE",
      "Component names must be distinct.",
      "Choose different managed and installed names.",
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
    ...(options.proxy ? { proxy: options.proxy } : {}),
    ...(uses ? { uses: uses as ("sqlite" | "postgres" | "convex")[] } : {}),
    ...(options.managed && options.managedCommand
      ? {
          managed: {
            name: options.managed,
            command: options.managedCommand,
            ...(options.managedPort ? { port: options.managedPort } : {}),
            ...(options.managedHealth ? { health: options.managedHealth } : {}),
          },
        }
      : {}),
    ...(options.installed && options.installedEntrypoint
      ? {
          installed: {
            name: options.installed,
            entrypoint: options.installedEntrypoint,
            ...(options.installedBuild
              ? { build: options.installedBuild }
              : {}),
            ...(options.installedName
              ? { installName: options.installedName }
              : {}),
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
  if (target === undefined) {
    if (branch || options.deployment)
      throw new RigError(
        "USAGE",
        "A Target kind is required.",
        "Pass local, live, or preview.",
      );
    return { action, repoPath: cwd, ...projectScope(options) };
  }
  if (
    !["local", "live", "preview"].includes(target) ||
    (target === "preview" && !branch && !options.deployment) ||
    (target !== "preview" && (branch || options.deployment))
  )
    throw new RigError(
      "USAGE",
      "Choose local, live, or preview <branch>.",
      `Run rig ${action} --help.`,
    );
  return {
    action,
    repoPath: cwd,
    target: target as RuntimeCommand["target"],
    ...(branch ? { branch } : {}),
    ...(options.deployment ? { deployment: options.deployment } : {}),
    ...projectScope(options),
  };
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
