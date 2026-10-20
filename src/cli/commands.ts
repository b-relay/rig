import { Command, InvalidArgumentError, Option } from "commander";
import { resolve } from "node:path";
import {
  backupSelector,
  logComponentName,
  previewName,
  projectName,
  type RuntimeCommand,
} from "../daemon/protocol";
import { RigError } from "../domain/errors";
import { reported } from "./failure";
import { PREVIEW_SELECTOR } from "../config/schema";
import { terminalText } from "./terminal-text";
import { rigCommand, type RigCommandPath } from "../domain/rig-command";
import { generatedPreviewName } from "../domain/target-selector";
import { RIG_BUILD } from "../domain/version";
import type { LocalCommands, UserOutput } from "./types";
import { addMonitorCommand, type MonitorWindowInput } from "./monitor-command";
import { addLogsCommand } from "./logs-command";
import { addActivityCommand } from "./activity-command";
import { addDnsCommands, type DnsCommandDependencies } from "./dns-command";

export type ExecuteCommand = (
  request: RuntimeCommand,
  /** `yes` answers a confirmation the command would ask for (rig backup restore). `window` is the window `rig monitor`
   * was given as typed, which a watch resolves again at every refresh so a duration moves with the clock. */
  options?: {
    json?: boolean;
    /** rig logs: print long lines whole instead of shortened. */
    full?: boolean;
    follow?: boolean;
    yes?: boolean;
    window?: MonitorWindowInput;
  },
) => Promise<void>;
interface ScopeOptions {
  project?: string;
  json?: boolean;
  deployment?: string;
  destroy?: boolean;
  kill?: boolean;
}

/** The command grammar owns usage validation; runtime policy stays behind the client. */
export function createRigCommand(
  cwd: string,
  output: UserOutput,
  execute: ExecuteCommand,
  /** The clock relative `rig logs` and `rig monitor` times count back from. */
  now: () => Date = () => new Date(),
  local?: LocalCommands,
  /** What `rig dns set` and `delete` plan with: rigd's DNS read, and the terminal to confirm at. */
  dns?: Pick<DnsCommandDependencies, "read" | "interaction">,
): Command {
  const command = terminalCommand("rig", output).description(
    "Manage Projects and their Targets on this Host.",
  );
  for (const action of ["list", "status", "doctor", "config"] as const) {
    const child = command.command(action).description(
      {
        list: "List registered Projects.",
        status: "Observe all Targets for one Project.",
        doctor: "Check Host and optional Project health.",
        config: "Inspect validated Project configuration.",
      }[action],
    );
    if (action !== "list")
      child.option("--project <name>", "Registered Project identity");
    child
      .option("--json", "Print the report as JSON")
      .action(async (options: ScopeOptions) =>
        execute(
          { action, repoPath: cwd, ...projectScope(options) },
          { json: options.json },
        ),
      );
  }
  addActivityCommand(command, {
    cwd,
    execute,
    now,
    projectScope,
    positiveInteger,
    nonEmpty,
  });
  addLifecycleCommands(command, cwd, execute);
  addDeployCommands(command, cwd, execute);
  addRunCommand(command, cwd, execute);
  addBackupCommands(command, cwd, execute);
  addInitCommand(command, cwd, execute);
  addMonitorCommand(command, { execute, projectScope, now }, cwd);
  addLogsCommand(command, {
    execute,
    now,
    targetRequest: (target, branch, options, flags) =>
      targetRequest("logs", target, branch, cwd, options, {
        path: "logs",
        flags,
      }),
    nonEmpty,
    positiveInteger,
  });
  addProxyCommands(command, cwd, execute, output, local);
  addDnsCommands(command, {
    cwd,
    execute,
    output,
    read:
      dns?.read ??
      (async () => {
        throw new RigError(
          "COMMAND_UNAVAILABLE",
          "rig dns is unavailable here.",
          "Run it from a terminal on the Host.",
        );
      }),
    ...(dns?.interaction ? { interaction: dns.interaction } : {}),
  });
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
      "Remove a stopped Project's registration and withdraw its routes; its repository is untouched, and its Tools stay installed for the next Target that publishes the same name. Refused, changing nothing, when a route cannot be withdrawn.",
    )
    .argument("<name>", "Registered Project identity", nonEmpty)
    .action(async (project: string) =>
      execute({ action: "forget", repoPath: cwd, project }),
    );
  return command;
}
/** `rig proxy`: Rig's own Caddy (ADR 0014). */
function addProxyCommands(
  command: Command,
  cwd: string,
  execute: ExecuteCommand,
  output: UserOutput,
  local: LocalCommands | undefined,
): void {
  const unavailable = (name: string) =>
    new RigError(
      "COMMAND_UNAVAILABLE",
      `rig proxy ${name} is unavailable here.`,
      "Run it from a terminal on the Host.",
    );
  const proxy = command
    .command("proxy")
    .description(
      "Show the Caddy Rig runs for this Host: its job and every hostname it serves, each Target's and your own proxy.routes.",
    )
    .option("--json", "Render the report as JSON")
    .action(async (options: { json?: boolean }) =>
      execute({ action: "proxy", repoPath: cwd }, { json: options.json }),
    );
  // --json belongs to rig proxy and rig proxy verify, the reads; commander would let the actions under it take it too.
  const noJson = (name: string) => {
    if (proxy.opts<{ json?: boolean }>().json)
      throw new RigError(
        "USAGE",
        `rig proxy ${name} takes no --json: it answers with its exit and a line saying what it did.`,
        `Run rig proxy ${name} without --json.`,
      );
  };
  proxy
    .command("reload")
    .description(
      "Apply the proxy section of Host config as it is now: proxy.routes, ports and certificate settings. rigd also applies it when it starts. Settings Rig refuses change nothing that is served: Caddy keeps the ones it last accepted, and rig proxy shows the refused ones as pending. Routes whose Target no longer exists are withdrawn first; without Rig's own Caddy that is all it does.",
    )
    .action(async () => {
      noJson("reload");
      await execute({ action: "proxy-apply", repoPath: cwd });
    });
  proxy
    .command("verify")
    .description(
      "Check every served hostname with a real TLS handshake on this Host: a trusted certificate (Mozilla's root store), from a production CA, valid for more than 7 days. Exits 1 when any hostname fails.",
    )
    .option(
      "--port <port>",
      "HTTPS port to check (default: the one Caddy last accepted, not a pending proxy.ports.https edit rig proxy shows; proxy.ports.https when none was recorded)",
      positiveInteger,
    )
    .option(
      "--wait <seconds>",
      "Keep checking the failing hostnames for up to this long",
      positiveInteger,
    )
    .option(
      "--staging-ok",
      "Accept a certificate from a staging CA, for the very name it was issued to",
    )
    .option(
      "--json",
      "Print the verdicts as JSON: { ready, hostnames, error? }; exits 1 the same way",
    )
    .action(
      async (options: {
        port?: number;
        wait?: number;
        stagingOk?: boolean;
        json?: boolean;
      }) => {
        if (!local) throw unavailable("verify");
        const verdicts = await local.proxyVerify({
          ...(options.port ? { port: options.port } : {}),
          waitSeconds: options.wait ?? 0,
          stagingOk: options.stagingOk === true,
        });
        const failed = verdicts.filter((verdict) => !verdict.ok).length;
        const problem = !verdicts.length
          ? new RigError(
              "PROXY_NOT_READY",
              "Rig's Caddy serves no hostname with a certificate.",
              "Run rigd install, then deploy or start a Target with a hostname.",
            )
          : failed
            ? new RigError(
                "PROXY_NOT_READY",
                `${failed} of ${verdicts.length} hostnames are not ready.`,
                "A new certificate can take minutes while DNS propagates: retry with --wait 600. Otherwise run rig doctor and read Caddy's log under the Rig root (caddy/caddy.log).",
              )
            : undefined;
        if (options.json || proxy.opts<{ json?: boolean }>().json) {
          // One document either way; a failure is in it, so nothing else is written and only the exit says it failed.
          output.write(
            `${JSON.stringify({
              ready: problem === undefined,
              hostnames: verdicts,
              ...(problem
                ? {
                    error: {
                      code: problem.code,
                      message: problem.message,
                      hint: problem.hint,
                    },
                  }
                : {}),
            })}\n`,
          );
          if (problem) throw reported(problem);
          return;
        }
        for (const verdict of verdicts)
          output.write(
            verdict.ok
              ? `ok    ${verdict.hostname}  ${verdict.issuer ?? ""}, until ${verdict.validTo?.slice(0, 10) ?? "?"}\n`
              : `FAIL  ${verdict.hostname}  ${verdict.problem ?? "not ready"}\n`,
          );
        if (problem) throw problem;
        output.write(`All ${verdicts.length} hostnames are ready.\n`);
      },
    );
  proxy
    .command("token")
    .description(
      "Store the DNS provider API token Caddy uses for certificates, read from standard input (for example: pbpaste | rig proxy token).",
    )
    .action(async () => {
      noJson("token");
      if (!local) throw unavailable("token");
      const path = await local.proxyToken();
      output.write(`Stored the DNS API token in ${path} (mode 600).\n`);
    });
}
/** `help [command...]` shows one command's usage or names the command that does not exist;
 * commander's implicit help command would report an unknown name silently. */
export function addHelpCommand(command: Command, executable: string): void {
  command
    .command("help")
    .description("Show help for a command.")
    .argument("[command...]", "Command path, for example backup restore")
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
/** A command group named without its subcommand (rig backup, rig dns) prints its help, as bare rig does; commander's own
 * error messages are left out, since rig reports every failure itself. */
export function terminalCommand(name: string, output: UserOutput): Command {
  return new Command(name)
    .version(RIG_BUILD, "-V, --version", "Print the version.")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => output.write(text),
      writeErr: (text) => output.write(text),
      outputError: () => {},
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
        `${action === "up" ? "Start" : action === "down" ? "Stop" : "Restart"} a Target: working unless you name stable or a preview.`,
      )
      .argument(
        "[target]",
        "working (the default), stable, or preview with a Branch",
      )
      .argument(
        "[branch]",
        "Preview Branch (a Preview deployed with its own name: --deployment <name>)",
        nonEmpty,
      )
      .option("--project <name>", "Registered Project identity")
      .option(
        "--deployment <name>",
        "A Preview by the name it was deployed with (rig deploy preview --deployment <name>), in place of its Branch",
      );
    if (action === "down")
      child.option(
        "--destroy",
        "Destroy a Preview including its owned data, logs, and source history",
      );
    if (action !== "up")
      child.option(
        "--kill",
        "Skip each Service's stop_timeout: SIGTERM, then SIGKILL after 1.5 s. Also cuts short a stop already running on this Target",
      );
    child.action(
      async (
        target: string | undefined,
        branch: string | undefined,
        options: ScopeOptions,
      ) => {
        // Without a Target, --deployment names the Preview to destroy, and targetRequest says how to select it.
        if (
          options.destroy &&
          target !== PREVIEW_SELECTOR &&
          !(target === undefined && options.deployment)
        )
          throw new RigError(
            "USAGE",
            "Only a Preview can be destroyed.",
            "Use rig down preview <branch> --destroy.",
          );
        const request = targetRequest(action, target, branch, cwd, options, {
          path: action,
          flags: [
            ...(options.destroy ? ["--destroy"] : []),
            ...(options.kill ? ["--kill"] : []),
          ],
        });
        await execute({
          ...request,
          ...(options.destroy ? { action: "destroy" as const } : {}),
          ...(options.kill ? { kill: true } : {}),
        });
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
    .description(
      "Deploy a Branch to the stable Target (the default) or a Preview.",
    )
    .argument("[target]", "stable (the default), or preview")
    .argument(
      "[branch]",
      "Source Branch (defaults to Production for stable, the current Branch for preview)",
      nonEmpty,
    )
    .option("--project <name>", "Registered Project identity")
    .option("--force", "Redeploy even when the selected Commit is unchanged")
    .option(
      "--no-up",
      "Deploy without starting; a running Target is stopped until rig up",
    )
    .option(
      "--deployment <name>",
      "Name the Preview yourself instead of the name Rig makes from its Branch; later commands select it with --deployment <name>",
    );
  deploy.action(
    async (
      target: string | undefined,
      branch: string | undefined,
      options: ScopeOptions & { force?: boolean; up?: boolean },
    ) => {
      if (target === "help") deploy.help();
      if (options.deployment && target !== PREVIEW_SELECTOR)
        throw new RigError(
          "USAGE",
          "Only a Preview takes --deployment.",
          `Use ${terminalText(
            rigCommand(
              "deploy",
              {
                project: projectScope(options).project,
                target: {
                  kind: "preview",
                  name: previewScope(options).deployment!,
                  ...(branch ? { branch } : {}),
                },
              },
              ...(options.force ? ["--force"] : []),
              ...(options.up === false ? ["--no-up"] : []),
            ),
          )}.`,
        );
      await execute({
        action: "deploy",
        repoPath: cwd,
        // In a checkout a deploy means the stable Target unless it names a Preview.
        target: target ?? "stable",
        ...projectScope(options),
        ...(branch ? { branch } : {}),
        ...(options.force ? { force: true } : {}),
        ...(options.up === false ? { noUp: true } : {}),
        ...previewScope(options),
      });
    },
  );
}
function addRunCommand(
  command: Command,
  cwd: string,
  execute: ExecuteCommand,
): void {
  command
    .command("run")
    .description(
      "Run a scheduled job now, in the stable Target unless you name working or a preview. Refused while a run of it is still going.",
    )
    .argument("<job>", "Job name under jobs in rig.yaml", nonEmpty)
    .argument(
      "[target]",
      "stable (the default), working, or preview with a Branch",
    )
    .argument(
      "[branch]",
      "Preview Branch (a Preview deployed with its own name: --deployment <name>)",
      nonEmpty,
    )
    .option("--project <name>", "Registered Project identity")
    .option(
      "--deployment <name>",
      "A Preview by the name it was deployed with (rig deploy preview --deployment <name>), in place of its Branch",
    )
    .action(
      async (
        job: string,
        target: string | undefined,
        branch: string | undefined,
        options: ScopeOptions,
      ) => {
        if (!logComponentName.safeParse(job).success)
          throw new RigError(
            "USAGE",
            `'${terminalText(job)}' is not a job name.`,
            "Pass a name from jobs in rig.yaml, such as rig run nightly-import.",
          );
        // A job is scheduled in the stable Target by default, so that is the Target rig run means unless another is named.
        const request = targetRequest(
          "run",
          target ?? (options.deployment ? undefined : "stable"),
          branch,
          cwd,
          options,
          { path: "run", job },
        );
        await execute({ ...request, job });
      },
    );
}
/** `rig backup`: a backup job's kept backups, and putting one back (ADR 0017). */
function addBackupCommands(
  command: Command,
  cwd: string,
  execute: ExecuteCommand,
): void {
  const backup = command
    .command("backup")
    .description(
      "List the backups Rig keeps for backup jobs (jobs with backup: in rig.yaml), and restore one.",
    );
  backup
    .command("list")
    .description(
      "List kept backups by Target and job, each job's newest first, with their time, size and the run that made them: every Target's, one job's (rig backup list db-backup), one job's in one Target (rig backup list db-backup stable), or one Target's (rig backup list stable). A job named like a Target is given with its Target. With no job before it, preview stable and preview working mean the job preview in that Target, not a Preview of the Branch stable or working: list such a Preview by the name rig status shows, rig backup list preview --deployment <name>.",
    )
    .argument("[job]", "Backup job name under jobs in rig.yaml")
    .argument(
      "[target]",
      "working, stable, or preview with a Branch (default: every Target)",
    )
    .argument(
      "[branch]",
      "Preview Branch (a Preview deployed with its own name: --deployment <name>)",
      nonEmpty,
    )
    .option("--project <name>", "Registered Project identity")
    .option(
      "--deployment <name>",
      "A Preview by the name it was deployed with (rig deploy preview --deployment <name>), in place of its Branch",
    )
    .option("--json", "Render the backups as JSON")
    .action(
      async (
        first: string | undefined,
        second: string | undefined,
        third: string | undefined,
        options: ScopeOptions,
      ) => {
        // A Target's name alone lists that Target's backups (rig backup list stable, rig backup list preview <branch>); a
        // job named like a Target is listed with its Target too: rig backup list stable stable, and a job named preview
        // as rig backup list preview stable or rig backup list preview preview --deployment <name>. So in these two-word
        // forms with no job before them, a Target's word after preview is that Target, not a Branch.
        const targets = ["working", "stable", PREVIEW_SELECTOR];
        const targetFirst =
          first !== undefined &&
          targets.includes(first) &&
          third === undefined &&
          (second === undefined ||
            (first === PREVIEW_SELECTOR &&
              !["working", "stable"].includes(second) &&
              !(second === PREVIEW_SELECTOR && options.deployment)));
        const [job, target, branch] = targetFirst
          ? [undefined, first, second]
          : [first, second, third];
        if (job !== undefined) assertJobName(job, "rig backup list nightly-db");
        // Without a Target every Target's backups are listed.
        const request =
          target === undefined && !branch && !options.deployment
            ? {
                action: "backups" as const,
                repoPath: cwd,
                ...projectScope(options),
              }
            : targetRequest("backups", target, branch, cwd, options, {
                path: "backup list",
                ...(job !== undefined ? { job } : {}),
                ...(options.json ? { flags: ["--json"] } : {}),
              });
        await execute(
          { ...request, ...(job !== undefined ? { job } : {}) },
          { json: options.json },
        );
      },
    );
  backup
    .command("restore")
    .description(
      "Put a backup back: runs the job's backup.restore command once, as a run of the job (same checkout, environment and env files), with $RIG_BACKUP_DIR set to the backup. In the stable Target unless you name working or a preview. Asks first unless --yes, then waits for it to end. Refused while the job or another restore of it runs. Rig does not stop the Target's Services: the restore command replaces what it restores itself (pg_restore --clean, say).",
    )
    .argument("<job>", "Backup job name under jobs in rig.yaml", nonEmpty)
    .argument(
      "<backup>",
      "Backup id from rig backup list, such as 20261011T030000Z-17, or latest",
      nonEmpty,
    )
    .argument(
      "[target]",
      "stable (the default), working, or preview with a Branch",
    )
    .argument(
      "[branch]",
      "Preview Branch (a Preview deployed with its own name: --deployment <name>)",
      nonEmpty,
    )
    .option("--project <name>", "Registered Project identity")
    .option(
      "--deployment <name>",
      "A Preview by the name it was deployed with (rig deploy preview --deployment <name>), in place of its Branch",
    )
    .option("--yes", "Restore without asking for confirmation")
    .action(
      async (
        job: string,
        id: string,
        target: string | undefined,
        branch: string | undefined,
        options: ScopeOptions & { yes?: boolean },
      ) => {
        assertJobName(job, "rig backup restore nightly-db latest");
        if (!backupSelector.safeParse(id).success)
          throw new RigError(
            "USAGE",
            `'${terminalText(id)}' is not a backup id.`,
            "Pass latest, or an id from rig backup list, such as 20261011T030000Z-17.",
          );
        // A restore is a run of the job, so it means the stable Target unless another is named, as rig run does.
        const request = targetRequest(
          "restore",
          target ?? (options.deployment ? undefined : "stable"),
          branch,
          cwd,
          options,
          {
            path: "backup restore",
            job,
            backup: id,
            ...(options.yes ? { flags: ["--yes"] } : {}),
          },
        );
        await execute(
          { ...request, job, backup: id },
          { yes: options.yes === true },
        );
      },
    );
}
/** Refuses what cannot be a job name before a request exists. */
function assertJobName(job: string, example: string): void {
  if (!logComponentName.safeParse(job).success)
    throw new RigError(
      "USAGE",
      `'${terminalText(job)}' is not a job name.`,
      `Pass a name from jobs in rig.yaml, such as ${example}.`,
    );
}
interface InitOptions extends ScopeOptions {
  path?: string;
  productionBranch?: string;
  domain?: string;
  service?: string;
  command?: string;
  port?: number;
  healthcheck?: string;
  /** Renamed to --healthcheck; refused with that hint. */
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
      "Production Branch for the stable Target",
      nonEmpty,
    )
    .option(
      "--create-git",
      "Explicitly initialize Git when the directory is not a repository",
    )
    .option(
      "--domain <domain>",
      "Domain the stable Target serves, with --service; a Preview gets <first label>-<preview name> in place of its first label",
      nonEmpty,
    )
    .option("--service <name>", "Service name", nonEmpty)
    .option("--command <command>", "Command that runs the Service", nonEmpty)
    .option(
      "--port <port>",
      "Service localhost port (assigned automatically when omitted)",
      positiveInteger,
    )
    .option(
      "--healthcheck <test>",
      "Service healthcheck test: a shell command, or a local http(s) URL",
      nonEmpty,
    )
    .addOption(new Option("--ready <check>").hideHelp())
    .option("--tool <name>", "Tool name", nonEmpty)
    .option("--bin <path>", "Executable the Tool installs", nonEmpty)
    .option("--tool-build <command>", "Command that builds the Tool", nonEmpty)
    .action(async (options: InitOptions) => execute(initRequest(cwd, options)));
}
function initRequest(cwd: string, options: InitOptions): RuntimeCommand {
  if (options.ready !== undefined)
    throw new RigError(
      "USAGE",
      "--ready is now --healthcheck.",
      "Run rig init with --healthcheck <test>.",
    );
  const serviceRequested =
    options.service || options.command || options.port || options.healthcheck;
  const toolRequested = options.tool || options.bin || options.toolBuild;
  if (serviceRequested && (!options.service || !options.command))
    throw new RigError(
      "USAGE",
      "A Service requires --service and --command.",
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
    ...(options.service && options.command
      ? {
          service: {
            name: options.service,
            command: options.command,
            ...(options.port ? { port: options.port } : {}),
            ...(options.healthcheck
              ? { healthcheck: options.healthcheck }
              : {}),
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
/** The command a usage hint retypes: its path in the grammar, the job and backup it takes before the Target, and the
 * flags the user gave that change what it does. */
interface TypedCommand {
  path: RigCommandPath;
  job?: string;
  backup?: string;
  flags?: string[];
}
function targetRequest(
  action: "up" | "down" | "restart" | "logs" | "run" | "backups" | "restore",
  target: string | undefined,
  branch: string | undefined,
  cwd: string,
  options: ScopeOptions,
  typed: TypedCommand,
): RuntimeCommand {
  const preview = previewScope(options);
  const project = projectScope(options);
  // The command as the user typed it, with the Preview selected the way the grammar takes it.
  const retyped = (selected: { name: string; branch?: string }) =>
    terminalText(
      rigCommand(
        typed.path,
        {
          project: project.project,
          ...(typed.job !== undefined ? { job: typed.job } : {}),
          ...(typed.backup !== undefined ? { backup: typed.backup } : {}),
          target: { kind: "preview", ...selected },
        },
        ...(typed.flags ?? []),
      ),
    );
  if (target === undefined) {
    if (options.deployment)
      throw new RigError(
        "USAGE",
        "A Preview is selected with preview.",
        `Use ${retyped({ name: options.deployment })}.`,
      );
    // In a checkout the working Target is the one these commands mean unless another is named.
    return { action, repoPath: cwd, target: "working", ...project };
  }
  if (
    (target === PREVIEW_SELECTOR && !branch && !options.deployment) ||
    (target !== PREVIEW_SELECTOR && (branch || options.deployment))
  )
    throw new RigError(
      "USAGE",
      "Choose working, stable, or preview <branch>.",
      `Run rig ${typed.path} --help.`,
    );
  // A Branch and --deployment can name different Previews; acting on one while the user typed the other is never safe.
  if (target === PREVIEW_SELECTOR && branch && options.deployment)
    throw new RigError(
      "USAGE",
      "Pass a Preview Branch or --deployment, not both.",
      `Use ${retyped({ name: generatedPreviewName(branch), branch })} or ${retyped({ name: options.deployment })}.`,
    );
  return {
    action,
    repoPath: cwd,
    target,
    ...(branch ? { branch } : {}),
    ...preview,
    ...project,
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
